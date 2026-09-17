import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeLLM, reviewerScript } from '../helpers/fake-llm.js';
import { FakeGitHub } from '../helpers/fake-github.js';
import { makeBranchRepo, type RepoHandle } from '../helpers/repos.js';
import { runReview } from '../../src/core/review/pipeline.js';
import { GitHubSink } from '../../src/core/review/github-sink.js';
import { LocalSink } from '../../src/core/review/sink.js';
import { resolveTarget, buildDiff, type GitTarget } from '../../src/core/diff/git.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import type { ResolvedOptions } from '../../src/core/types.js';

const repos: RepoHandle[] = [];
afterEach(async () => {
  while (repos.length > 0) await repos.pop()!.dispose();
});

const BASE = 'export const a = 1;\n';
const HEAD = 'export const a = 1;\nexport const b = a + 1;\n';
const ADDED_LINE = 2;

function options(over: Partial<ResolvedOptions> = {}): ResolvedOptions {
  return {
    configPath: '.code-review-agent.yml',
    toolMode: 'auto',
    maxDurationMinutes: 20,
    maxInlineComments: 6,
    failOnSeverity: 'none',
    config: DEFAULT_CONFIG,
    ...over,
  };
}

async function makeRepo(params: {
  baseFiles?: Record<string, string>;
  headFiles?: Record<string, string>;
  branchName?: string;
} = {}): Promise<RepoHandle> {
  const r = await makeBranchRepo({
    baseFiles: params.baseFiles ?? { 'src/a.ts': BASE },
    headFiles: params.headFiles ?? { 'src/a.ts': HEAD },
    branchName: params.branchName ?? 'feature',
  });
  repos.push(r);
  return r;
}

/**
 * Resolve the standard three-dot target, build the diff, create a fake
 * GitHub whose head matches the diff head, optionally prepare it, and run
 * the review with a GitHubSink wired to the real head sha.
 */
async function standard(inputs: {
  repo: RepoHandle;
  llm: FakeLLM;
  opts?: Partial<ResolvedOptions>;
  mode?: 'tools' | 'structured';
  /** Override the initial PR head (default: the real diff head sha). */
  fakeHeadSha?: string;
  /** Seed the fake (e.g. an existing sticky comment) before the run. */
  prepare?: (fake: FakeGitHub, headSha: string) => void | Promise<void>;
}) {
  const target: GitTarget = await resolveTarget(inputs.repo.dir, { target: 'main...feature' });
  const diff = await buildDiff(inputs.repo.dir, target);
  const fake = new FakeGitHub({ prNumber: 7, headSha: inputs.fakeHeadSha ?? diff.headSha });
  await inputs.prepare?.(fake, diff.headSha);
  const sink = new GitHubSink({ github: fake, prNumber: 7, expectedHead: diff.headSha });
  const result = await runReview({
    repoDir: inputs.repo.dir,
    target,
    options: options(inputs.opts),
    llm: inputs.llm,
    sink,
    mode: inputs.mode ?? 'tools',
  });
  return { result, diff, target, fake };
}

describe('pipeline (GitHub sink)', () => {
  it('produces a clean result for a finding-free change', async () => {
    const repo = await makeRepo();
    const llm = new FakeLLM('fake-model', reviewerScript({ files: ['src/a.ts'] }));
    const { result, fake } = await standard({ repo, llm });
    expect(result.status).toBe('clean');
    expect(result.findings).toHaveLength(0);
    expect(result.coverage.totalChanged).toBe(1);
    expect(result.coverage.eligible).toBe(1);
    expect(result.coverage.reviewed).toBe(1);
    expect(fake.issueComments).toHaveLength(1);
    expect(fake.issueComments[0]!.body).toContain('## Code review agent');
    expect(fake.issueComments[0]!.body).toContain('**Status:** clean');
    expect(result.summaryCommentUrl).toBeDefined();
    expect(fake.reviewComments).toHaveLength(0);
  });

  it('posts an inline comment for a verified finding', async () => {
    const repo = await makeRepo();
    const block = 'export const b = a + 1;';
    const llm = new FakeLLM(
      'fake-model',
      reviewerScript({
        files: ['src/a.ts'],
        findings: [
          {
            severity: 'medium',
            path: 'src/a.ts',
            block,
            explanation: 'This derived value is never read and adds confusion.',
          },
        ],
      }),
    );
    const { result, diff, fake } = await standard({ repo, llm });
    expect(result.status).toBe('findings');
    expect(result.findings).toHaveLength(1);
    expect(fake.reviewComments).toHaveLength(1);
    const rc = fake.reviewComments[0]!;
    expect(rc.path).toBe('src/a.ts');
    expect(rc.side).toBe('RIGHT');
    expect(rc.commit_id).toBe(diff.headSha);
    expect(rc.line).toBe(ADDED_LINE);
    expect(rc.body).toContain('**[medium]**');
    expect(result.callCounts.inlineCommentsPosted).toBe(1);
    expect(fake.issueComments[0]!.body).toContain('**Status:** findings');
    expect(fake.issueComments[0]!.body).toContain('**Findings:** 1');
  });

  it('rejects low severity below the medium floor', async () => {
    const repo = await makeRepo();
    const llm = new FakeLLM(
      'fake-model',
      reviewerScript({
        files: ['src/a.ts'],
        findings: [
          { severity: 'low', path: 'src/a.ts', block: 'export const b = a + 1;', explanation: 'minor nit about naming style' },
        ],
      }),
    );
    const { result, fake } = await standard({ repo, llm });
    expect(fake.reviewComments).toHaveLength(0);
    expect(result.status).toBe('clean');
  });

  it('dedups repeated identical findings via fingerprint', async () => {
    const repo = await makeRepo();
    const block = 'export const b = a + 1;';
    const llm = new FakeLLM(
      'fake-model',
      reviewerScript({
        files: ['src/a.ts'],
        findings: [
          { severity: 'high', path: 'src/a.ts', block, explanation: 'Bug in the arithmetic here.' },
          // exact retry of the same finding
          { severity: 'high', path: 'src/a.ts', block, explanation: 'Bug in the arithmetic here.' },
        ],
      }),
    );
    const { result, fake } = await standard({ repo, llm });
    expect(result.findings).toHaveLength(1);
    expect(fake.reviewComments).toHaveLength(1);
    expect(result.callCounts.inlineCommentsRejected).toBeGreaterThanOrEqual(1);
  });

  it('enforces the per-run inline comment cap', async () => {
    const repo = await makeRepo({
      baseFiles: { 'src/a.ts': 'l1\n' },
      headFiles: { 'src/a.ts': 'l1\nline2\nline3\n' },
    });
    const llm = new FakeLLM(
      'fake-model',
      reviewerScript({
        files: ['src/a.ts'],
        findings: [
          { severity: 'high', path: 'src/a.ts', block: 'line2', explanation: 'First distinct real issue here.' },
          { severity: 'high', path: 'src/a.ts', block: 'line3', explanation: 'Second distinct real issue here.' },
        ],
      }),
    );
    const { result, fake } = await standard({ repo, llm, opts: { maxInlineComments: 1 } });
    expect(fake.reviewComments).toHaveLength(1);
    expect(result.findings).toHaveLength(2);
    expect(result.findings[1]!.delivery).toBe('summary_only');
    expect(result.status).toBe('findings');
  });

  it('supersedes the run as partial when the head moved before any post', async () => {
    const repo = await makeRepo();
    const llm = new FakeLLM(
      'fake-model',
      reviewerScript({
        files: ['src/a.ts'],
        findings: [{ severity: 'high', path: 'src/a.ts', block: 'export const b = a + 1;', explanation: 'Issue found now.' }],
      }),
    );
    const { result, fake } = await standard({
      repo,
      llm,
      fakeHeadSha: 'ffff'.repeat(10), // PR head already moved
    });
    expect(result.status).toBe('partial');
    expect(result.statusReason).toBe('head-changed-during-review');
    expect(fake.reviewComments).toHaveLength(0);
    expect(fake.issueComments).toHaveLength(0);
  });

  it('retains posted comments and reports partial when the head moves later', async () => {
    const repo = await makeRepo({
      baseFiles: { 'src/a.ts': 'l1\n' },
      headFiles: { 'src/a.ts': 'l1\nline2\nline3\n' },
    });
    const llm = new FakeLLM(
      'fake-model',
      reviewerScript({
        files: ['src/a.ts'],
        findings: [
          { severity: 'high', path: 'src/a.ts', block: 'line2', explanation: 'First issue found here.' },
          { severity: 'high', path: 'src/a.ts', block: 'line3', explanation: 'Second issue found here.' },
        ],
      }),
    );
    const target = await resolveTarget(repo.dir, { target: 'main...feature' });
    const diff = await buildDiff(repo.dir, target);
    const fake = new FakeGitHub({ prNumber: 7, headSha: diff.headSha });
    // first head recheck sees the original head (post succeeds); the second
    // sees a moved head (abort, earlier comment retained).
    // The sink rechecks the head twice per post (before and inside the post),
    // so the first post consumes two "original head" rechecks.
    let calls = 0;
    const origGetPull = fake.getPull.bind(fake);
    fake.getPull = async (n) => {
      calls++;
      const pr = await origGetPull(n);
      if (calls >= 3) return { ...pr, head: { ...pr.head, sha: 'ffff'.repeat(10) } };
      return pr;
    };
    const sink = new GitHubSink({ github: fake, prNumber: 7, expectedHead: diff.headSha });
    const result = await runReview({
      repoDir: repo.dir,
      target,
      options: options(),
      llm,
      sink,
      mode: 'tools',
    });
    expect(result.status).toBe('partial');
    expect(result.statusReason).toBe('head-changed-during-review');
    expect(fake.reviewComments).toHaveLength(1);
    expect(result.findings).toHaveLength(2);
    expect(result.findings[1]!.delivery).toBe('summary_only');
  });

  it('produces identical normalized findings/coverage in local and GitHub modes', async () => {
    const block = 'export const b = a + 1;';
    const script = reviewerScript({
      files: ['src/a.ts'],
      findings: [{ severity: 'medium', path: 'src/a.ts', block, explanation: 'Derived value never read.' }],
    });

    const localRepo = await makeRepo();
    const localTarget = await resolveTarget(localRepo.dir, { target: 'main...feature' });
    const localResult = await runReview({
      repoDir: localRepo.dir,
      target: localTarget,
      options: options(),
      llm: new FakeLLM('fake-model', script),
      sink: new LocalSink(),
      mode: 'tools',
    });

    const ghRepo = await makeRepo();
    const ghLlm = new FakeLLM('fake-model', script);
    const ghTarget = await resolveTarget(ghRepo.dir, { target: 'main...feature' });
    const ghDiff = await buildDiff(ghRepo.dir, ghTarget);
    const fake = new FakeGitHub({ prNumber: 7, headSha: ghDiff.headSha });
    const ghResult = await runReview({
      repoDir: ghRepo.dir,
      target: ghTarget,
      options: options(),
      llm: ghLlm,
      sink: new GitHubSink({ github: fake, prNumber: 7, expectedHead: ghDiff.headSha }),
      mode: 'tools',
    });

    const normalize = (r: typeof localResult) => ({
      schema: r.schema,
      status: r.status,
      findings: r.findings.map((f) => ({
        severity: f.severity,
        file: f.file,
        startLine: f.startLine,
        endLine: f.endLine,
        message: f.message,
      })),
      coverage: {
        totalChanged: r.coverage.totalChanged,
        eligible: r.coverage.eligible,
        reviewed: r.coverage.reviewed,
        skipped: r.coverage.skipped,
        excluded: r.coverage.excluded,
        files: r.coverage.files.map((c) => ({ file: c.file, status: c.status })),
      },
    });
    expect(normalize(ghResult)).toEqual(normalize(localResult));
    expect(normalize(ghResult).status).toBe('findings');
  });

  it('works in structured-output mode', async () => {
    const repo = await makeRepo();
    const llm = new FakeLLM(
      'fake-model',
      reviewerScript({
        files: ['src/a.ts'],
        findings: [{ severity: 'medium', path: 'src/a.ts', block: 'export const b = a + 1;', explanation: 'Derived value never read.' }],
      }),
    );
    const { result, fake } = await standard({ repo, llm, mode: 'structured' });
    expect(result.status).toBe('findings');
    expect(result.findings).toHaveLength(1);
    expect(fake.reviewComments).toHaveLength(1);
  });

  it('fails on a second-batch protocol error without losing earlier findings', async () => {
    const repo = await makeRepo({
      baseFiles: { 'src/a.ts': BASE, 'src/b.ts': 'const b = 1;\n' },
      headFiles: { 'src/a.ts': HEAD, 'src/b.ts': 'const b = 2;\n' },
    });
    const llm = new FakeLLM(
      'fake-model',
      {
        plan: {
          batches: [{ files: ['src/a.ts'] }, { files: ['src/b.ts'] }],
          skipped: [],
        },
        steps: [
          { tool: 'read_diff', args: { path: 'src/a.ts' } },
          { tool: 'post_inline_review_comment', args: { severity: 'high', path: 'src/a.ts', block: 'export const b = a + 1;', explanation: 'First issue found here.' } },
          { tool: 'complete_review_batch', args: { summary: 'a done', reviewed_files: ['src/a.ts'], skipped_files: [] } },
          // second batch: three malformed steps -> batch failure
          { raw: 'not json at all' },
          { raw: 'still not json' },
          { raw: 'and not json' },
        ],
      },
    );
    const { result, fake } = await standard({ repo, llm });
    expect(result.status).toBe('failed');
    expect(result.operationalErrors).not.toHaveLength(0);
    expect(fake.reviewComments).toHaveLength(1);
    const bRow = result.coverage.files.find((f) => f.file === 'src/b.ts')!;
    expect(bRow.status).toBe('skipped');
    expect(bRow.reason).toContain('batch-failed');
  });

  it('posts the suggestion only when the critic confirms it', async () => {
    const repo = await makeRepo();
    const suggestion = 'export const b = 2;';
    const llm = new FakeLLM(
      'fake-model',
      reviewerScript({
        files: ['src/a.ts'],
        findings: [
          { severity: 'high', path: 'src/a.ts', block: 'export const b = a + 1;', explanation: 'Derive the value directly instead.', suggestion },
        ],
        critic: { verdict: 'confirmed', reason: 'correct replacement' },
      }),
    );
    const { result, fake } = await standard({ repo, llm });
    expect(result.findings[0]!.suggestion).toBe(suggestion);
    expect(fake.reviewComments[0]!.body).toContain('```suggestion');
    expect(fake.reviewComments[0]!.body).toContain(suggestion);
  });

  it('omits the suggestion block when the critic rejects it', async () => {
    const repo = await makeRepo();
    const suggestion = 'export const b = a + 1; // fixed';
    const llm = new FakeLLM(
      'fake-model',
      reviewerScript({
        files: ['src/a.ts'],
        findings: [
          { severity: 'high', path: 'src/a.ts', block: 'export const b = a + 1;', explanation: 'Derive the value directly instead.', suggestion },
        ],
        critic: { verdict: 'rejected', reason: 'still buggy' },
      }),
    );
    const { result, fake } = await standard({ repo, llm });
    expect(result.findings[0]!.suggestion).toBeUndefined();
    expect(result.findings[0]!.suggestionRejected).toBe(true);
    expect(fake.reviewComments[0]!.body).not.toContain('```suggestion');
    expect(fake.reviewComments[0]!.body).toContain('**[high]**');
  });

  it('rejects posting to an unchanged line (off-diff)', async () => {
    const repo = await makeRepo();
    const llm = new FakeLLM(
      'fake-model',
      reviewerScript({
        files: ['src/a.ts'],
        findings: [
          { severity: 'high', path: 'src/a.ts', block: 'export const a = 1;', explanation: 'Issue on an unchanged line.' },
        ],
      }),
    );
    const { result, fake } = await standard({ repo, llm });
    expect(fake.reviewComments).toHaveLength(0);
    expect(result.status).toBe('clean');
  });

  it('rejects posting to an ambiguous block', async () => {
    const repo = await makeRepo({
      baseFiles: { 'src/dup.ts': 'const x = 1;\nconst x = 1;\n' },
      headFiles: { 'src/dup.ts': 'const x = 1;\nconst x = 1;\nconst y = 2;\nconst y = 2;\n' },
    });
    const llm = new FakeLLM(
      'fake-model',
      reviewerScript({
        files: ['src/dup.ts'],
        findings: [
          { severity: 'high', path: 'src/dup.ts', block: 'const x = 1;', explanation: 'Ambiguous anchor here.' },
        ],
      }),
    );
    const { result, fake } = await standard({ repo, llm });
    expect(fake.reviewComments).toHaveLength(0);
    expect(result.status).toBe('clean');
  });

  it('skips when there are no changed files', async () => {
    const repo = await makeRepo();
    const fake = new FakeGitHub({ prNumber: 7, headSha: 'x' });
    const target: GitTarget = { kind: 'range', label: 'none', baseRev: 'HEAD', headRev: 'HEAD', viewKind: 'ref' };
    const result = await runReview({
      repoDir: repo.dir,
      target,
      options: options(),
      llm: new FakeLLM('fake-model', reviewerScript({ files: [] })),
      sink: new GitHubSink({ github: fake, prNumber: 7, expectedHead: 'x' }),
      mode: 'tools',
    });
    expect(result.status).toBe('skipped');
    expect(fake.issueComments).toHaveLength(0);
  });

  it('excludes lock files from coverage and plans', async () => {
    const repo = await makeRepo({
      baseFiles: { 'src/a.ts': BASE, 'yarn.lock': 'lock1\n' },
      headFiles: { 'src/a.ts': HEAD, 'yarn.lock': 'lock2\n' },
    });
    const llm = new FakeLLM('fake-model', reviewerScript({ files: ['src/a.ts'] }));
    const { result } = await standard({ repo, llm });
    expect(result.coverage.totalChanged).toBe(2);
    expect(result.coverage.eligible).toBe(1);
    expect(result.coverage.excluded).toBe(1);
    const lockRow = result.coverage.files.find((f) => f.file === 'yarn.lock')!;
    expect(lockRow.status).toBe('skipped');
    expect(lockRow.reason).toContain('lock-file');
    expect(result.status).toBe('clean');
  });

  it('updates the existing sticky comment instead of creating a second one', async () => {
    const repo = await makeRepo();
    const llm = new FakeLLM('fake-model', reviewerScript({ files: ['src/a.ts'] }));
    const { result, fake } = await standard({
      repo,
      llm,
      prepare: async (f) => {
        const existing = await f.createIssueComment(7, '<!-- code-review-agent:v1:run=old -->\n## Code review agent\n**Status:** clean\n');
        (f as unknown as { existingId: number }).existingId = existing.id;
      },
    });
    expect(fake.issueComments).toHaveLength(1);
    expect(fake.issueComments[0]!.body).toContain('**Status:** clean');
    expect(result.summaryCommentUrl).toBeDefined();
    // the seeded comment id is preserved (single marker comment)
    const seededId = (fake as unknown as { existingId: number }).existingId;
    expect(fake.issueComments[0]!.id).toBe(seededId);
  });
});

describe('pipeline edge cases', () => {
  it('fails (not clean) when the LLM is unreachable', async () => {
    const repo = await makeRepo();
    const downLlm = {
      model: 'down',
      chat: async () => {
        throw new Error('LLM endpoint unreachable');
      },
    };
    const { result } = await standard({
      repo,
      llm: downLlm as unknown as FakeLLM,
    });
    expect(result.status).toBe('failed');
    expect(result.findings).toHaveLength(0);
  });

  it('reports time-budget exhaustion as partial, never clean', async () => {
    const repo = await makeRepo({
      baseFiles: { 'src/a.ts': BASE, 'src/b.ts': 'const b = 1;\n' },
      headFiles: { 'src/a.ts': HEAD, 'src/b.ts': 'const b = 2;\n' },
    });
    const target = await resolveTarget(repo.dir, { target: 'main...feature' });
    const diff = await buildDiff(repo.dir, target);
    const fake = new FakeGitHub({ prNumber: 7, headSha: diff.headSha });
    const sink = new GitHubSink({ github: fake, prNumber: 7, expectedHead: diff.headSha });

    // 30s budget: planning + batch 1 fit; batch 2 is blocked by the deadline.
    // Capture the base time from the (now mocked) clock so offsets are exact.
    vi.useFakeTimers();
    const baseTime = Date.now();
    let offset = 0;
    const llm = new FakeLLM(
      'fake-model',
      {
        plan: { batches: [{ files: ['src/a.ts'] }, { files: ['src/b.ts'] }], skipped: [] },
        steps: [
          { tool: 'read_diff', args: { path: 'src/a.ts' } },
          { tool: 'complete_review_batch', args: { summary: 'a done', reviewed_files: ['src/a.ts'], skipped_files: [] } },
        ],
      },
      () => {
        offset += 7_000; // first batch completes at 21s; next call crosses work deadline, not total deadline
        vi.setSystemTime(baseTime + offset);
      },
    );
    let result;
    try {
      result = await runReview({
        repoDir: repo.dir,
        target,
        options: options({ maxDurationMinutes: 0.5 }),
        llm,
        sink,
        mode: 'tools',
      });
    } finally {
      vi.useRealTimers();
    }
    expect(result.status).toBe('partial');
    expect(result.statusReason).toBe('time-budget-exhausted');
    expect(result.coverage.files.find((f) => f.file === 'src/a.ts')!.status).toBe('reviewed');
    expect(result.coverage.files.find((f) => f.file === 'src/b.ts')!.reason).toContain('budget-exhausted');
    expect(fake.issueComments[0]!.body).toContain('**Status:** partial');
  });
});
