/** Immediate agent-directed publishing with host-enforced anchoring and retries. */
import { GitHubError, type GitHubApi, type ReviewCommentInfo } from '../github/client.js';
import { REVIEW_MARKER_PREFIX, REVIEW_MARKER_SUFFIX, type Finding, type HeadCheck, type ReviewResult } from '../types.js';
import { LIMITS } from '../security/limits.js';
import { sleep, truncate, truncateUtf8 } from '../util.js';
import { BudgetExceededError, type BudgetTracker } from './budget.js';
import type { ReviewSink } from './sink.js';

export class SupersededReviewError extends Error {
  constructor() { super('PR head moved or PR is no longer open/non-draft'); this.name = 'SupersededReviewError'; }
}
export interface GitHubSinkOptions {
  github: GitHubApi;
  prNumber: number;
  expectedHead: string;
  budget?: BudgetTracker;
}
// Only the host-appended footer owns the comment, never markup inside a suggestion.
const INLINE_MARKER = /<!-- code-review-agent:v1:inline:head=([^\s>]+) fingerprint=([a-f0-9]{64}) -->\s*$/;
export function inlineMarker(head: string, fingerprint: string): string {
  return '<!-- code-review-agent:v1:inline:head=' + head + ' fingerprint=' + fingerprint + ' -->';
}

export class GitHubSink implements ReviewSink {
  kind = 'github' as const;
  readonly posted: Finding[] = [];
  private existing: Map<string, ReviewCommentInfo> | null = null;
  private author?: string;
  private signal?: AbortSignal;

  constructor(private readonly opts: GitHubSinkOptions) {}
  setSignal(signal: AbortSignal): void { this.signal = signal; this.opts.github.setSignal?.(signal); }

  async recheckHead(): Promise<HeadCheck> {
    try {
      const pr = await this.opts.github.getPull(this.opts.prNumber);
      return { ok: true, currentHead: pr.head.sha,
        stale: pr.head.sha !== this.opts.expectedHead || pr.state !== 'open' || pr.draft };
    } catch (err) {
      return { ok: false, currentHead: this.opts.expectedHead, stale: false, error: (err as Error).message };
    }
  }
  private async assertCurrent(): Promise<void> {
    this.signal?.throwIfAborted();
    if (this.opts.budget?.exceeded()) throw new BudgetExceededError();
    const check = await this.recheckHead();
    if (!check.ok) throw new GitHubError('cannot recheck PR head: ' + check.error);
    if (check.stale) throw new SupersededReviewError();
    this.signal?.throwIfAborted();
  }
  private async owned(comment: { user?: { login?: string } }): Promise<boolean> {
    this.author ??= await this.opts.github.getCommentAuthor();
    return comment.user?.login?.toLowerCase() === this.author.toLowerCase();
  }
  private async loadExisting(refresh = false): Promise<Map<string, ReviewCommentInfo>> {
    if (this.existing && !refresh) return this.existing;
    this.author ??= await this.opts.github.getCommentAuthor();
    const comments = await this.opts.github.listReviewComments(this.opts.prNumber);
    const existing = new Map<string, ReviewCommentInfo>();
    for (const comment of comments) {
      const marker = INLINE_MARKER.exec(comment.body ?? '');
      if (marker?.[1] === this.opts.expectedHead &&
          (comment.original_commit_id ?? comment.commit_id) === this.opts.expectedHead &&
          await this.owned(comment)) existing.set(marker[2]!, comment);
    }
    this.existing = existing;
    return existing;
  }
  async existingComments(): Promise<{ fingerprint: string; file: string; body: string; url?: string }[]> {
    return [...(await this.loadExisting()).entries()].map(([fingerprint, c]) => ({
      fingerprint, file: c.path, body: truncate(c.body, 2000), url: c.html_url,
    }));
  }
  async findExistingInline(fingerprint: string): Promise<{ url?: string } | undefined> {
    const comment = (await this.loadExisting(true)).get(fingerprint);
    return comment ? { url: comment.html_url } : undefined;
  }

  private async mutate<T>(write: () => Promise<T>, reconcile: () => Promise<T | undefined>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      await this.assertCurrent();
      try { return await write(); }
      catch (err) {
        if (!(err instanceof GitHubError) || !err.retryable) throw err;
        const existing = await reconcile();
        if (existing !== undefined) return existing;
        if (attempt >= LIMITS.githubMaxRetries) throw err;
        await sleep(err.retryAfterMs, this.signal);
      }
    }
  }

  async postInlineComment(f: Finding, body: string): Promise<{ url?: string; reused?: boolean }> {
    const previous = await this.findExistingInline(f.fingerprint);
    if (previous) { await this.assertCurrent(); this.posted.push({ ...f, url: previous.url, delivery: 'reused' }); return { ...previous, reused: true }; }
    const commentBody = body + '\n\n' + inlineMarker(this.opts.expectedHead, f.fingerprint);
    if (Buffer.byteLength(commentBody) > 60_000) throw new GitHubError('inline comment exceeds GitHub body limit');
    const posted = await this.mutate(
      () => this.opts.github.createReviewComment(this.opts.prNumber, {
        commit_id: this.opts.expectedHead, path: f.file, line: f.endLine, side: 'RIGHT',
        ...(f.startLine < f.endLine ? { start_line: f.startLine, start_side: 'RIGHT' as const } : {}),
        body: commentBody,
      }),
      async () => {
        const found = (await this.loadExisting(true)).get(f.fingerprint);
        return found?.html_url ? { id: found.id, html_url: found.html_url } : undefined;
      },
    );
    this.existing!.set(f.fingerprint, { id: posted.id, html_url: posted.html_url, body: commentBody,
      commit_id: this.opts.expectedHead, path: f.file, user: { login: this.author } });
    this.posted.push({ ...f, url: posted.html_url, delivery: 'posted' });
    return { url: posted.html_url };
  }

  private async findSummary(marker?: string, expectedBody?: string): Promise<{ id: number; html_url?: string } | undefined> {
    const comments = await this.opts.github.listIssueComments(this.opts.prNumber);
    for (const comment of comments) {
      if ((comment.body ?? '').startsWith(marker || REVIEW_MARKER_PREFIX) &&
          (expectedBody === undefined || comment.body === expectedBody) && await this.owned(comment)) return comment;
    }
    return undefined;
  }
  async upsertSummaryComment(params: { marker: string; body: string }): Promise<{ url?: string }> {
    await this.assertCurrent();
    if (Buffer.byteLength(params.body) > 60_000) throw new GitHubError('summary exceeds GitHub body limit');
    const existing = await this.findSummary();
    if (existing) {
      const updated = await this.mutate(
        () => this.opts.github.updateIssueComment(existing.id, params.body),
        async () => {
          const current = await this.findSummary(params.marker, params.body);
          return current?.id === existing.id ? current : undefined;
        },
      );
      return { url: updated.html_url };
    }
    const created = await this.mutate(
      () => this.opts.github.createIssueComment(this.opts.prNumber, params.body),
      () => this.findSummary(params.marker, params.body),
    );
    return { url: created.html_url };
  }
  async finalize(): Promise<void> {}
}

export function buildSummaryBody(params: {
  result: ReviewResult; reviewId: string; runUrl?: string; postedCommentUrls: string[];
}): string {
  const { result, reviewId, runUrl } = params;
  const coverage = result.coverage;
  const lines = [
    REVIEW_MARKER_PREFIX + reviewId + REVIEW_MARKER_SUFFIX,
    '## Code review agent', '',
    '**Status:** ' + result.status,
    ...(result.statusReason ? ['**Reason:** ' + truncate(result.statusReason, 1000)] : []),
    '**Head:** ' + result.headSha, '**Base:** ' + result.baseSha,
    '**Model:** ' + truncateUtf8(result.model, 200),
    '**Duration:** ' + Math.round(result.durationMs / 1000) + 's',
    '**Coverage:** ' + coverage.reviewed + '/' + coverage.eligible + ' eligible files reviewed, ' +
      coverage.excluded + ' excluded, ' + coverage.skipped + ' skipped',
    '**Findings:** ' + result.findings.length, '',
    truncateUtf8(result.summary, 8000).replace(/<!-- code-review-agent:[\s\S]*?-->/g, ''), '',
  ];
  if (result.findings.length) {
    lines.push('### Findings', '');
    for (const finding of result.findings.slice(0, 30)) {
      lines.push('- [' + finding.severity + '] ' + escapeMd(truncateUtf8(finding.file, 300)) + ':' + finding.startLine +
        '-' + finding.endLine + ' (' + finding.delivery + '): ' + truncateUtf8(finding.message, 500) +
        (finding.url ? ' — ' + truncateUtf8(finding.url, 300) : ''));
    }
    if (result.findings.length > 30) lines.push('- Additional findings are included in the normalized result.');
    lines.push('');
  }
  if (result.operationalErrors.length) {
    lines.push('### Delivery / operational errors', '');
    for (const error of result.operationalErrors.slice(0, 10)) lines.push('- ' + truncateUtf8(error.stage, 100) + ': ' + truncateUtf8(error.message, 500));
    lines.push('');
  }
  lines.push('<details>', '<summary>File coverage</summary>', '', '| File | Disposition |', '| --- | --- |');
  let bytes = Buffer.byteLength(lines.join('\n'));
  let shown = 0;
  for (const file of coverage.files) {
    const row = '| ' + escapeMd(truncateUtf8(file.file, 1000)) + ' | ' + escapeMd(truncateUtf8(file.status === 'reviewed' ?
      'reviewed (batch ' + file.batch + ')' : 'skipped — ' + file.reason, 1000)) + ' |';
    bytes += Buffer.byteLength(row) + 1;
    if (bytes > 48_000) break;
    lines.push(row); shown++;
  }
  if (shown < coverage.files.length) lines.push('', 'Additional file dispositions are available in coverage_json.');
  lines.push('', '</details>', '', ...(runUrl ? ['Run: ' + truncateUtf8(runUrl, 1000), ''] : []),
    '_Advisory review produced by code-review-agent. Findings are not merge decisions._');
  return lines.join('\n');
}
function escapeMd(value: string): string { return value.replace(/[|\r\n]/g, ' ').replace(/\x60/g, "'"); }
