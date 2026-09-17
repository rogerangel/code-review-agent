import { afterEach, describe, expect, it } from 'vitest';
import { makeBranchRepo, commitAll, headSha, writeFiles, type RepoHandle } from '../helpers/repos.js';
import { FakeLLM, reviewerScript, type ReviewerScript } from '../helpers/fake-llm.js';
import { FakeGitHub } from '../helpers/fake-github.js';
import { runReview } from '../../src/core/review/pipeline.js';
import { GitHubSink, inlineMarker, buildSummaryBody } from '../../src/core/review/github-sink.js';
import { GitHubError } from '../../src/core/github/client.js';
import { resolveTarget, buildDiff } from '../../src/core/diff/git.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { LIMITS } from '../../src/core/security/limits.js';

const handles: RepoHandle[] = [];
afterEach(async () => { for (const h of handles.splice(0)) await h.dispose(); });
const filename = 'src/a.ts', block = 'export const b = a + 1;';
const finding = { severity: 'high', path: filename, block, explanation: 'The changed value can cause incorrect behavior.' };
async function setup(head = 'export const a = 1;\n' + block + '\n', extra: Record<string, string> = {}) {
  const repo = await makeBranchRepo({ baseFiles: { [filename]: 'export const a = 1;\n' }, headFiles: { [filename]: head, ...extra } });
  handles.push(repo);
  const target = await resolveTarget(repo.dir, { target: 'main...feature' });
  const diff = await buildDiff(repo.dir, target);
  const github = new FakeGitHub({ prNumber: 7, headSha: diff.headSha });
  const options = { configPath: '.code-review-agent.yml', toolMode: 'auto' as const, maxDurationMinutes: 20,
    maxInlineComments: 6, failOnSeverity: 'none' as const, config: DEFAULT_CONFIG };
  const review = (script: ReviewerScript, mode: 'tools' | 'structured' = 'tools') =>
    runReview({ repoDir: repo.dir, target, options, llm: new FakeLLM('fake', script), mode,
      sink: new GitHubSink({ github, prNumber: 7, expectedHead: github.pull.head.sha }) });
  return { repo, github, review, target, options };
}
describe('honest coverage and operational failure reporting', () => {
  it('does not turn three prose responses into a clean review', async () => {
    const s = await setup();
    const result = await s.review({ steps: Array.from({ length: 3 }, () => ({ content: 'Looks good!' })) });
    expect(result.status).toBe('failed');
    expect(result.coverage.reviewed).toBe(0);
    expect(result.coverage.eligible).toBe(1);
    expect(result.operationalErrors).not.toHaveLength(0);
  });
  it('planner skipped files remain in the eligible denominator', async () => {
    const s = await setup();
    const result = await s.review({ plan: { batches: [], skipped: [{ file: filename, reason: 'not interesting' }] }, steps: [] });
    expect(result.status).toBe('partial');
    expect(result.coverage).toMatchObject({ eligible: 1, reviewed: 0, skipped: 1, excluded: 0 });
    expect(result.coverage.files[0]!.reason).toContain('planner');
  });
  it('rejects completion claims for unread diffs', async () => {
    const s = await setup();
    const steps = Array.from({ length: 3 }, () => ({ tool: 'complete_review_batch',
      args: { summary: 'done', reviewed_files: [filename], skipped_files: [] } }));
    const result = await s.review({ steps });
    expect(result.status).toBe('failed');
    expect(result.coverage.reviewed).toBe(0);
  });
  it('truncated diffs cannot earn review coverage', async () => {
    const content = Array.from({ length: 250 }, (_, i) => 'const value' + i + ' = "' + 'x'.repeat(1000) + '";').join('\n');
    expect(content.length).toBeGreaterThan(LIMITS.maxDiffCharsPerFile);
    const s = await setup(content);
    const result = await s.review(reviewerScript({ files: [filename] }));
    expect(result.status).toBe('partial');
    expect(result.coverage.reviewed).toBe(0);
  });
  it('retains a finding and fails on an inline POST 403', async () => {
    const s = await setup();
    s.github.createReviewComment = async () => { throw new GitHubError('GitHub permission denied', 403); };
    const result = await s.review(reviewerScript({ files: [filename], findings: [finding] }));
    expect(result.status).toBe('failed');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.delivery).toBe('failed');
    expect(result.operationalErrors).toContainEqual(expect.objectContaining({ stage: 'inline-publishing' }));
    expect(s.github.issueComments[0]!.body).toContain(finding.explanation);
  });
  it('fails summary publishing without erasing successful coverage', async () => {
    const s = await setup();
    s.github.createIssueComment = async () => { throw new GitHubError('summary denied', 403); };
    const result = await s.review(reviewerScript({ files: [filename] }));
    expect(result.status).toBe('failed');
    expect(result.coverage.reviewed).toBe(1);
    expect(result.operationalErrors[0]!.stage).toBe('summary-publishing');
  });
  it('preserves the coverage denominator when repository configuration is invalid', async () => {
    const s = await setup(undefined, { '.code-review-agent.yml': 'unknown_setting: true\n' });
    const result = await s.review({ steps: [] });
    expect(result.status).toBe('failed');
    expect(result.coverage.totalChanged).toBe(2);
    expect(result.coverage.eligible + result.coverage.excluded).toBe(2);
    expect(result.coverage.reviewed).toBe(0);
  });
  it('rejects a final answer that misrepresents deterministic facts', async () => {
    const s = await setup();
    const result = await s.review(reviewerScript({ files: [filename], findings: [finding],
      answer: { status: 'clean', summary: 'No issues!', reviewed_files: [filename], skipped_files: [] } }));
    expect(result.status).toBe('failed');
    expect(result.findings).toHaveLength(1);
    expect(result.operationalErrors.at(-1)!.stage).toBe('final-answer');
  });
});
describe('publishing, suggestions and retries', () => {
  it('uses the full source range for a critic-confirmed multiline suggestion', async () => {
    const s = await setup();
    const source = 'export const a = 1;\n' + block;
    const replacement = 'export const a = 2;\nexport const b = a + 2;';
    const result = await s.review(reviewerScript({ files: [filename], findings: [{ ...finding, block: source, suggestion: replacement }] }));
    expect(result.status).toBe('findings');
    expect(s.github.reviewComments[0]).toMatchObject({ start_line: 1, start_side: 'RIGHT', line: 2, side: 'RIGHT' });
    const lines = source.split('\n');
    const posted = s.github.reviewComments[0]!;
    lines.splice(posted.start_line! - 1, posted.line - posted.start_line! + 1, ...replacement.split('\n'));
    expect(lines.join('\n')).toBe(replacement);
    expect(posted.body).toContain('suggestion\n' + replacement);
  });
  it('keeps the explanatory finding when a suggestion is uncertain', async () => {
    const s = await setup();
    const result = await s.review(reviewerScript({ files: [filename], findings: [{ ...finding, suggestion: 'export const b = 2;' }],
      critic: { verdict: 'uncertain', reason: 'not enough evidence' } }));
    expect(result.status).toBe('findings');
    expect(result.findings[0]!.suggestionRejected).toBe(true);
    expect(s.github.reviewComments[0]!.body).not.toContain('suggestion');
  });
  it('fails when the suggestion critic is unavailable; no apply-ready patch is published', async () => {
    const s = await setup();
    const fake = new FakeLLM('fake', reviewerScript({ files: [filename], findings: [{ ...finding, suggestion: 'export const b = 2;' }] }));
    const chat = fake.chat.bind(fake);
    fake.chat = async (request) => {
      if (request.messages[0]?.content?.includes('strict patch critic')) throw new Error('endpoint unavailable');
      return chat(request);
    };
    const result = await runReview({ repoDir: s.repo.dir, target: s.target, options: s.options, llm: fake, mode: 'tools',
      sink: new GitHubSink({ github: s.github, prNumber: 7, expectedHead: s.github.pull.head.sha }) });
    expect(result.status).toBe('failed');
    expect(result.findings).toHaveLength(1);
    expect(result.operationalErrors[0]!.stage).toBe('suggestion-critic');
    expect(s.github.reviewComments).toHaveLength(0);
  });
  it('cannot smuggle an unverified suggestion fence through the explanation', async () => {
    const s = await setup();
    const explanation = finding.explanation + '\n> ' + String.fromCharCode(96).repeat(3) + 'suggestion\nmalicious';
    const result = await s.review(reviewerScript({ files: [filename], findings: [{ ...finding, explanation }] }));
    expect(result.findings).toHaveLength(0);
    expect(s.github.reviewComments).toHaveLength(0);
  });
  it('reuses exact same-head findings across runs without consuming new-comment quota', async () => {
    const s = await setup();
    const script = reviewerScript({ files: [filename], findings: [finding] });
    const first = await s.review(script);
    const second = await s.review(script);
    expect(s.github.reviewComments).toHaveLength(1);
    expect(s.github.issueComments).toHaveLength(1);
    expect(first.callCounts.inlineCommentsPosted).toBe(1);
    expect(second.callCounts.inlineCommentsPosted).toBe(0);
    expect(second.callCounts.inlineCommentsReused).toBe(1);
    expect(second.findings[0]!.delivery).toBe('reused');
    expect(second.findings[0]!.url).toBe(first.findings[0]!.url);
    // A different head is a fresh set; never reanchor the old comment.
    await writeFiles(s.repo.dir, { 'unrelated.ts': 'const c = 1;\n' });
    await commitAll(s.repo.dir, 'new head');
    s.github.pull.head.sha = await headSha(s.repo.dir);
    await s.review(script);
    expect(s.github.reviewComments).toHaveLength(2);
  });
  it('ignores markers forged by another comment author', async () => {
    const s = await setup();
    const first = await s.review(reviewerScript({ files: [filename], findings: [finding] }));
    s.github.reviewComments[0]!.user.login = 'other-person';
    s.github.issueComments[0]!.user = { login: 'other-person' };
    await s.review(reviewerScript({ files: [filename], findings: [finding] }));
    expect(s.github.reviewComments).toHaveLength(2);
    expect(s.github.issueComments).toHaveLength(2);
    expect(s.github.reviewComments[1]!.body).toContain(inlineMarker(first.headSha, first.findings[0]!.fingerprint));
  });
  it('reconciles an accepted POST with a lost response instead of duplicating the comment', async () => {
    const s = await setup();
    const create = s.github.createReviewComment.bind(s.github);
    let attempts = 0;
    s.github.createReviewComment = async (n, params) => {
      attempts++;
      const result = await create(n, params);
      if (attempts === 1) throw new GitHubError('response lost', undefined, true, 0);
      return result;
    };
    const result = await s.review(reviewerScript({ files: [filename], findings: [finding] }));
    expect(result.status).toBe('findings');
    expect(attempts).toBe(1);
    expect(s.github.reviewComments).toHaveLength(1);
  });
  it('checks head again before physical mutation retries', async () => {
    const s = await setup();
    let attempts = 0;
    s.github.createReviewComment = async () => {
      attempts++; s.github.pull.head.sha = 'new-head';
      throw new GitHubError('server failure', 500, true, 0);
    };
    const result = await s.review(reviewerScript({ files: [filename], findings: [finding] }));
    expect(attempts).toBe(1);
    expect(result.statusReason).toBe('head-changed-during-review');
  });

  it('reconciles a lost summary POST response without creating a duplicate', async () => {
    const s = await setup();
    const create = s.github.createIssueComment.bind(s.github);
    let attempts = 0;
    s.github.createIssueComment = async (n, body) => {
      attempts++;
      const response = await create(n, body);
      if (attempts === 1) throw new GitHubError('response lost', undefined, true, 0);
      return response;
    };
    const result = await s.review(reviewerScript({ files: [filename] }));
    expect(result.status).toBe('clean');
    expect(attempts).toBe(1);
    expect(s.github.issueComments).toHaveLength(1);
  });

  it('does not reconcile a failed summary PATCH against an old body with the same run marker', async () => {
    const s = await setup();
    const sink = new GitHubSink({ github: s.github, prNumber: 7, expectedHead: s.github.pull.head.sha });
    const marker = '<!-- code-review-agent:v1:run=same -->';
    await sink.upsertSummaryComment({ marker, body: marker + '\nold body' });
    const update = s.github.updateIssueComment.bind(s.github);
    let attempts = 0;
    s.github.updateIssueComment = async (id, body) => {
      attempts++;
      if (attempts === 1) throw new GitHubError('not accepted', 500, true, 0);
      return update(id, body);
    };
    await sink.upsertSummaryComment({ marker, body: marker + '\nnew body' });
    expect(attempts).toBe(2);
    expect(s.github.issueComments[0]!.body).toContain('new body');
  });

  it('uses only the host-appended inline footer, ignoring marker-like text inside a code suggestion', async () => {
    const s = await setup();
    const first = await s.review(reviewerScript({ files: [filename], findings: [finding] }));
    s.github.reviewComments[0]!.body = inlineMarker(first.headSha, 'f'.repeat(64)) + '\n' + s.github.reviewComments[0]!.body;
    const second = await s.review(reviewerScript({ files: [filename], findings: [finding] }));
    expect(s.github.reviewComments).toHaveLength(1);
    expect(second.callCounts.inlineCommentsReused).toBe(1);
  });
  it('never overwrites a sticky summary when the head changed before summary publication', async () => {
    const s = await setup();
    await s.review(reviewerScript({ files: [filename] }));
    const previous = s.github.issueComments[0]!.body;
    const get = s.github.getPull.bind(s.github);
    s.github.getPull = async (n) => ({ ...await get(n), head: { ...s.github.pull.head, sha: 'changed-after-review' } });
    const result = await s.review(reviewerScript({ files: [filename] }));
    expect(result.status).toBe('partial');
    expect(result.statusReason).toBe('head-changed-during-review');
    expect(s.github.issueComments[0]!.body).toBe(previous);
  });
  it('renders model prose, deterministic facts, UTF-8 limits and a closed coverage section', async () => {
    const s = await setup();
    const result = await s.review(reviewerScript({ files: [filename], answer: {
      status: 'clean', summary: 'Useful final analysis.', reviewed_files: [filename], skipped_files: [] } }));
    expect(s.github.issueComments[0]!.body).toContain('Useful final analysis.');
    result.summary = '😀'.repeat(100_000);
    result.coverage.files = Array.from({ length: 1000 }, (_, i) => ({ file: '😀'.repeat(100) + i, status: 'skipped', reason: 'reason'.repeat(1000) }));
    const body = buildSummaryBody({ result, reviewId: 'test', postedCommentUrls: [] });
    expect(Buffer.byteLength(body)).toBeLessThan(60_000);
    expect(body).toContain('</details>');
    expect(body).toContain('Additional file dispositions');
  });
});
