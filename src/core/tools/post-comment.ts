/**
 * post_inline_review_comment
 *
 * Pipeline (cheap to expensive):
 *   1. argument shape + severity floor (medium hard floor, config may raise)
 *   2. per-run cap (default 6, workflow ceiling)
 *   3. fingerprint dedup (hidden; retries of the same finding are rejected)
 *   4. path normalization + membership in the changed-file map
 *   5. block resolution against the current head: exact, unique occurrence
 *   6. changed-line relevance (the block must overlap an added line)
 *   7. PR head recheck (GitHub mode) — a moved head aborts the run
 *   8. suggestion critic (only when a suggestion is offered)
 *   9. immediate post through the sink
 */
import { effectiveMinSeverity } from '../config.js';
import { renderFileDiff } from '../diff/normalize.js';
import { LIMITS } from '../security/limits.js';
import { normalizeRepoPath } from '../security/paths.js';
import { normalizeForFingerprint, sha256, splitLines } from '../util.js';
import {
  SEVERITIES,
  SEVERITY_RANK,
  type Finding,
  type Severity,
  type ToolContext,
  type ToolResult,
} from '../types.js';
import { extractJsonObject } from '../llm/client.js';
import { SupersededReviewError } from '../review/github-sink.js';
import { BudgetExceededError } from '../review/budget.js';
import { asArgs, requireString, type Tool } from './registry.js';
import { BATCH_TOOL_SPECS, TOOL_NAMES } from './schemas.js';

export interface BlockResolution {
  startLine: number;
  endLine: number;
}

export type BlockResolutionError =
  | 'block-too-small'
  | 'block-too-large'
  | 'block-not-found'
  | 'block-ambiguous';

/**
 * Resolve an exact source block to a unique line range within file lines.
 * Tries an exact match first, then a trailing-whitespace-tolerant match.
 */
export function resolveBlock(
  fileLines: string[],
  block: string,
): BlockResolution | { error: BlockResolutionError } {
  const blockLines = splitLines(block);
  // Trim leading/trailing blank lines from the block (model noise).
  while (blockLines.length > 0 && blockLines[0]!.trim() === '') blockLines.shift();
  while (blockLines.length > 0 && blockLines[blockLines.length - 1]!.trim() === '') blockLines.pop();
  if (blockLines.length === 0) return { error: 'block-too-small' };
  const joined = blockLines.join('\n');
  if (joined.length < LIMITS.minBlockChars) return { error: 'block-too-small' };
  if (joined.length > LIMITS.maxBlockChars) return { error: 'block-too-large' };

  const occurrences = (allowTrailingWs: boolean): number[] => {
    const target = blockLines.map((l) => (allowTrailingWs ? l.replace(/\s+$/g, '') : l));
    const out: number[] = [];
    const n = target.length;
    for (let i = 0; i + n <= fileLines.length; i++) {
      let match = true;
      for (let j = 0; j < n; j++) {
        const actual = fileLines[i + j] ?? '';
        const want = target[j]!;
        const ok = allowTrailingWs ? actual.replace(/\s+$/g, '') === want : actual === want;
        if (!ok) {
          match = false;
          break;
        }
      }
      if (match) out.push(i);
    }
    return out;
  };

  let occ = occurrences(false);
  if (occ.length === 0) occ = occurrences(true);
  if (occ.length === 0) return { error: 'block-not-found' };
  if (occ.length > 1) return { error: 'block-ambiguous' };
  const start = occ[0]!;
  return { startLine: start + 1, endLine: start + blockLines.length };
}

/** Compute the hidden finding fingerprint. */
export function findingFingerprint(params: {
  path: string;
  block: string;
  severity: Severity;
  explanation: string;
}): string {
  const blockNorm = splitLines(params.block)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join('\n');
  return sha256(
    [params.path, blockNorm, params.severity, normalizeForFingerprint(params.explanation)].join('\u0000'),
  );
}

function formatBody(params: {
  severity: Severity;
  explanation: string;
  suggestion?: string;
}): string {
  const lines: string[] = [];
  lines.push(`**[${params.severity}]** ${params.explanation.trim()}`);
  if (params.suggestion !== undefined) {
    lines.push('');
    lines.push('Suggested replacement:');
    lines.push('');
    const fence = String.fromCharCode(96).repeat(Math.max(3, ...[...params.suggestion.matchAll(/[\x60]+/g)].map((m) => m[0].length + 1)));
    lines.push(fence + 'suggestion');
    lines.push(params.suggestion.replace(/\n+$/, ''));
    lines.push(fence);
  }
  return lines.join('\n');
}

export interface CriticVerdict {
  verdict: 'confirmed' | 'rejected' | 'uncertain';
  reason: string;
}

/**
 * Focused critic call for apply-ready suggestions. Returns 'uncertain'
 * on any ambiguity, so an unverified patch is never posted as a suggestion.
 */
export async function runSuggestionCritic(
  ctx: ToolContext,
  params: { path: string; block: string; explanation: string; suggestion: string; diff: string },
): Promise<CriticVerdict> {
  const system =
    'You are a strict patch critic for a code review. You are given a code block, the ' +
    "reviewer's explanation, the suggested replacement, and the surrounding diff. " +
    'Decide whether the suggested replacement: (1) replaces the block exactly, (2) is ' +
    'syntactically valid for the file language, (3) actually fixes the described issue, and ' +
    '(4) introduces no new defect (security, correctness, resource, or API misuse). ' +
    'Be conservative: if anything is uncertain, say "uncertain". ' +
    'Respond with ONLY a JSON object: {"verdict":"confirmed"|"rejected"|"uncertain","reason":"..."}';
  const user = [
    `File: ${params.path}`,
    '',
    'Block (current code):',
    '```',
    params.block,
    '```',
    '',
    'Explanation:',
    params.explanation,
    '',
    'Suggested replacement:',
    '```',
    params.suggestion,
    '```',
    '',
    'Diff context:',
    '```diff',
    params.diff,
    '```',
  ].join('\n');

    if (ctx.budget.workExceeded()) throw new BudgetExceededError();
    const resp = await ctx.llm.chat({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0,
    });
    const obj = extractJsonObject(resp.content ?? '');
    const verdict = obj?.verdict;
    if (verdict === 'confirmed' || verdict === 'rejected' || verdict === 'uncertain') {
      return {
        verdict,
        reason: typeof obj?.reason === 'string' ? obj.reason.slice(0, 300) : '',
      };
    }
    throw new Error('suggestion critic returned an invalid verdict');
}

const specOf = (name: string) =>
  BATCH_TOOL_SPECS.find((s) => s.name === name) as (typeof BATCH_TOOL_SPECS)[number];

export const postInlineReviewCommentTool: Tool = {
  spec: specOf(TOOL_NAMES.postInlineReviewComment),
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const a = asArgs(args);
    // Count a finding the agent attempted to post but the guards rejected.
    const reject = (error: string): ToolResult => {
      ctx.counters.inlineCommentsRejected++;
      return { ok: false, result: null, error };
    };

    // 1. shape + severity floor
    const severityRaw = requireString(a, 'severity');
    if (!severityRaw || !SEVERITIES.includes(severityRaw as Severity)) {
      return {
        ok: false,
        result: null,
        error: `"severity" must be one of ${SEVERITIES.join(', ')}`,
      };
    }
    const severity = severityRaw as Severity;
    const min = effectiveMinSeverity(ctx.config);
    if (SEVERITY_RANK[severity] < SEVERITY_RANK[min]) {
      return reject(
        `severity "${severity}" is below the required minimum "${min}" for inline comments; note it in the batch summary instead`,
      );
    }
    const path = requireString(a, 'path');
    if (!path) return { ok: false, result: null, error: 'missing required argument "path"' };
    const block = requireString(a, 'block');
    if (!block) return { ok: false, result: null, error: 'missing required argument "block"' };
    const explanation = requireString(a, 'explanation');
    if (!explanation || explanation.trim().length < 8) {
      return { ok: false, result: null, error: '"explanation" must be a concise non-empty sentence' };
    }
    if (explanation.length > 4000 || /[\x60~]{3,}\s*suggestion\b/i.test(explanation) || /<!--\s*code-review-agent:/i.test(explanation)) return reject('explanation contains reserved suggestion/ownership markup or exceeds 4000 characters');
    const suggestion =
      a.suggestion === undefined || a.suggestion === null
        ? undefined
        : typeof a.suggestion === 'string'
          ? a.suggestion
          : null;
    if (suggestion === null) {
      return { ok: false, result: null, error: '"suggestion" must be a string when provided' };
    }
    if (suggestion !== undefined && suggestion.length > 16_000) return reject('suggestion exceeds 16000 characters');
    if (Buffer.byteLength(formatBody({ severity, explanation, suggestion })) > 59_500) return reject('comment body exceeds the UTF-8 delivery limit; retry with a smaller or no suggestion');
    if (suggestion !== undefined) {
      const lines = splitLines(block);
      if (!lines[0]?.trim() || !lines.at(-1)?.trim()) return reject('suggestion blocks must not contain leading or trailing blank lines; use the exact replacement range');
    }

    // 4. path confinement + changed-file membership
    const norm = normalizeRepoPath(path);
    if (!norm) {
      return reject(`invalid or escaping path "${path}"`);
    }
    const changed = ctx.diff.files.get(norm);
    if (!changed) {
      return reject(`"${norm}" is not a changed file in this target`);
    }
    if (changed.isBinary) {
      return reject(`"${norm}" is binary; inline comments are not possible`);
    }
    if (changed.status === 'deleted') {
      return reject(
        `"${norm}" was deleted; there is no head-side line to anchor to. Note the issue in the batch summary.`,
      );
    }

    // 5. block resolution against current head
    let fileLines: string[];
    try {
      const read = await ctx.view.read(norm);
      fileLines = splitLines(read.content);
    } catch (err) {
      const e = err as { message?: string; name?: string };
      if (e.name === 'ViewError') {
        return reject(`cannot read "${norm}": ${e.message}`);
      }
      throw err;
    }
    const resolution = resolveBlock(fileLines, block);
    if ('error' in resolution) {
      const messages: Record<string, string> = {
        'block-too-small': 'block is too small to anchor a review; provide a complete line or more',
        'block-too-large': 'block is too large (max 4000 chars); anchor a smaller exact block',
        'block-not-found':
          'block not found in the current head file; copy it verbatim from read_file output (check whitespace/indentation)',
        'block-ambiguous':
          'block matches multiple locations in the file; include more surrounding lines so it is unique',
      };
      return reject(`${messages[resolution.error]} (${resolution.error})`);
    }
    const { startLine, endLine } = resolution;
    if (endLine > fileLines.length) {
      return reject('block resolves outside the file range');
    }

    // 6. changed-line relevance
    const added = ctx.diff.addedLines.get(norm) ?? new Set<number>();
    let overlapsChanged = false;
    for (let ln = startLine; ln <= endLine; ln++) {
      if (added.has(ln)) {
        overlapsChanged = true;
        break;
      }
    }
    if (!overlapsChanged) {
      return reject(
        `block at lines ${startLine}-${endLine} does not overlap any changed line of "${norm}"; only changed-line findings are posted inline`,
      );
    }
    const visibleRange = (ctx.diff.hunks.get(norm) ?? []).some((hunk) => {
      const lines = new Set(hunk.lines.flatMap((line) => line.newLine === null ? [] : [line.newLine]));
      for (let line = startLine; line <= endLine; line++) if (!lines.has(line)) return false;
      return true;
    });
    if (!visibleRange) return reject('the complete block must lie within one visible RIGHT-side diff hunk');

    // 3. fingerprint dedup (hidden)
    const exactBlock = fileLines.slice(startLine - 1, endLine).join('\n');
    const fingerprint = findingFingerprint({ path: norm, block: exactBlock, severity, explanation });
    if (ctx.postState.postedFingerprints.has(fingerprint)) {
      return reject('this finding was already posted in this run; do not re-post it');
    }

    const finding: Finding = { id: fingerprint.slice(0, 12), fingerprint, severity, file: norm,
      startLine, endLine, block: exactBlock, message: explanation.trim(), batchIndex: ctx.postState.batchIndex, delivery: 'failed' };
    ctx.findings.push(finding);
    ctx.postState.postedFingerprints.add(fingerprint);
    // 7. head recheck before any side effect
    const check = await ctx.sink.recheckHead();
    if (!check.ok) {
      ctx.operationalErrors.push({ stage: 'head-check', code: 'head-check-failed', message: check.error ?? 'head recheck failed', findingId: finding.id });
      return { ok: false, result: null, error: 'head recheck failed' };
    }
    if (check.stale) {
      ctx.abortReview();
      finding.delivery = 'summary_only';
      return reject('PR head changed during review; this run is invalid and has been aborted');
    }
    const existing = await ctx.sink.findExistingInline?.(fingerprint);
    if (existing) {
      finding.delivery = 'reused'; finding.url = existing.url;
      ctx.counters.inlineCommentsReused++;
      return { ok: true, result: { posted: false, reused: true, url: existing.url ?? null } };
    }
    if (ctx.postState.posted >= ctx.options.maxInlineComments) {
      finding.delivery = 'summary_only';
      return { ok: true, result: { posted: false, delivery: 'summary_only', reason: 'inline comment cap reached; finding retained in result and summary' } };
    }

    // 8. suggestion critic
    let confirmedSuggestion: string | undefined;
    let suggestionRejected = false;
    if (suggestion !== undefined) {
      if (!ctx.config.suggestions) {
        suggestionRejected = true;
      } else {
        const diffText = renderFileDiff(ctx.diff, norm) ?? '';
        let critic: CriticVerdict;
        try { critic = await runSuggestionCritic(ctx, {
          path: norm,
          block: exactBlock,
          explanation: explanation.trim(),
          suggestion,
          diff: diffText.slice(0, LIMITS.maxDiffCharsPerFile),
        }); } catch (err) {
          if (err instanceof BudgetExceededError) { finding.delivery = 'summary_only'; throw err; }
          ctx.operationalErrors.push({ stage: 'suggestion-critic', code: 'critic-failed', message: (err as Error).message, findingId: finding.id });
          return { ok: false, result: null, error: 'suggestion critic failed; finding retained, no patch posted' };
        }
        if (critic.verdict === 'confirmed') {
          confirmedSuggestion = suggestion;
        } else {
          suggestionRejected = true;
        }
      }
    }

    // 9. post immediately
    finding.suggestion = confirmedSuggestion;
    finding.suggestionRejected = suggestionRejected;
    const body = formatBody({
      severity,
      explanation: explanation.trim(),
      ...(confirmedSuggestion !== undefined ? { suggestion: confirmedSuggestion } : {}),
    });
    try {
      const posted = await ctx.sink.postInlineComment(finding, body);
      if (posted.reused) ctx.counters.inlineCommentsReused++;
      else { ctx.counters.inlineCommentsPosted += ctx.sink.kind === 'github' ? 1 : 0; ctx.postState.posted++; }
      finding.delivery = posted.reused ? 'reused' : ctx.sink.kind === 'local' ? 'local' : 'posted';
      finding.url = posted.url;
      return {
        ok: true,
        result: {
          posted: !posted.reused,
          reused: posted.reused ?? false,
          file: norm,
          lines: [startLine, endLine],
          url: posted.url ?? null,
          suggestion: confirmedSuggestion !== undefined ? 'confirmed' : suggestionRejected ? 'omitted (critic not confirmed)' : 'none',
        },
      };
    } catch (err) {
      const e = err as { message?: string; name?: string };
      if (err instanceof SupersededReviewError) {
        ctx.abortReview();
        finding.delivery = 'summary_only';
        return { ok: false, result: null, error: 'PR head changed during posting; run aborted' };
      }
      if (err instanceof BudgetExceededError) { finding.delivery = 'summary_only'; throw err; }
      ctx.operationalErrors.push({ stage: 'inline-publishing', code: 'publish-failed', message: e.message ?? 'posting failed', findingId: finding.id });
      ctx.counters.inlineCommentsRejected++;
      return { ok: false, result: null, error: `posting failed: ${e.message ?? String(err)}` };
    }
  },
};
