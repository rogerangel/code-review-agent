import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFiles, makeTempRepo, makeBranchRepo, type RepoHandle } from '../helpers/repos.js';
import { FakeLLM, reviewerScript, type ReviewerScript } from '../helpers/fake-llm.js';
import { FakeGitHub } from '../helpers/fake-github.js';
import { resolveTarget, buildDiff } from '../../src/core/diff/git.js';
import { WorkTreeView } from '../../src/core/repo/view.js';
import { LIMITS } from '../../src/core/security/limits.js';
import { runReview } from '../../src/core/review/pipeline.js';
import { BudgetTracker } from '../../src/core/review/budget.js';
import { LocalSink } from '../../src/core/review/sink.js';
import { GitHubSink } from '../../src/core/review/github-sink.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { buildProgram } from '../../src/cli/index.js';
import { createProgressReporter } from '../../src/cli/progress.js';
import type { ReviewProgressEvent } from '../../src/core/types.js';

const repos: RepoHandle[] = [];
afterEach(async () => { vi.useRealTimers(); for (const repo of repos.splice(0)) await repo.dispose(); });
const options = { configPath: '.code-review-agent.yml', toolMode: 'auto' as const, maxDurationMinutes: 20,
  maxInlineComments: 6, failOnSeverity: 'none' as const, config: DEFAULT_CONFIG };
async function setup(files = ['a.ts', 'b.ts']) {
  const baseFiles = Object.fromEntries(files.map((file) => [file, 'export const a = 1;\n']));
  const headFiles = Object.fromEntries(files.map((file) => [file, 'export const a = 1;\nexport const b = a + 1;\n']));
  const repo = await makeBranchRepo({ baseFiles, headFiles }); repos.push(repo);
  const target = await resolveTarget(repo.dir, { target: 'main...feature' });
  const checkpoint: ReviewerScript = { plan: { batches: [{ files }], skipped: [] }, steps: [
    { tool: 'read_diff', args: { path: files[0] } },
    { tool: 'complete_review_file', args: { path: files[0], summary: 'No actionable findings.' } },
    { tool: 'read_diff', args: { path: files[1] ?? files[0] } },
  ] };
  return { repo, target, checkpoint };
}

describe('Git-aware worktree discovery', () => {
  it('ignores build artifacts, retains tracked ignored paths and untracked source, and allows explicit context reads', async () => {
    const repo = await makeTempRepo({ 'a.ts': 'needle', 'vendor/tracked.ts': 'needle' }); repos.push(repo);
    await writeFiles(repo.dir, { '.gitignore': 'node_modules/\n.next/\nvendor/\n',
      'node_modules/bundle.js': 'needle', '.next/output.js': 'needle', 'vendor/ignored.ts': 'needle',
      'src/new file.ts': 'needle', 'src/unusual\tü.ts': 'needle' });
    const view = new WorkTreeView(repo.dir);
    const search = await view.search('needle');
    expect(search.truncated).toBe(false);
    expect(search.results.map((hit) => hit.path).sort()).toEqual(['a.ts', 'src/new file.ts', 'src/unusual\tü.ts', 'vendor/tracked.ts'].sort());
    const list = await view.listDirectory('');
    expect(list.dirs).toEqual(['src', 'vendor']);
    expect((await view.read('node_modules/bundle.js')).content).toBe('needle');
  });
  it('marks skipped oversized files as incomplete while continuing to search other source files', async () => {
    const repo = await makeTempRepo({ 'a.ts': 'x'.repeat(LIMITS.maxFileBytes + 1), 'z.ts': 'needle' }); repos.push(repo);
    const result = await new WorkTreeView(repo.dir).search('needle');
    expect(result.truncated).toBe(true);
    expect(result.results.map((hit) => hit.path)).toEqual(['z.ts']);
  });
});

describe.each(['tools', 'structured'] as const)('file checkpoints in %s mode', (mode) => {
  it('preserves completed-file credit when a later call crosses the work deadline', async () => {
    const s = await setup();
    vi.useFakeTimers({ toFake: ['Date'] });
    const started = Date.now(), budget = new BudgetTracker(started, 1);
    const llm = new FakeLLM('m', s.checkpoint);
    const chat = llm.chat.bind(llm);
    let reviewCalls = 0;
    llm.chat = async (request) => {
      if (request.phase === 'review' && ++reviewCalls === 3) vi.setSystemTime(started + 55_000);
      return chat(request);
    };
    const result = await runReview({ repoDir: s.repo.dir, target: s.target, options: { ...options, maxDurationMinutes: 1 }, budget, llm, mode, sink: new LocalSink() });
    expect(result.status).toBe('partial');
    expect(result.statusReason).toBe('time-budget-exhausted');
    expect(result.coverage).toMatchObject({ eligible: 2, reviewed: 1, skipped: 1 });
    expect(result.coverage.files.find((f) => f.file === 'a.ts')?.status).toBe('reviewed');
    expect(result.performance?.llmCalls.at(-1)?.outcome).toBe('aborted');
  });
  it('preserves credit on a later operational error without disguising the failure', async () => {
    const s = await setup();
    const llm = new FakeLLM('m', s.checkpoint), chat = llm.chat.bind(llm);
    let reviewCalls = 0;
    llm.chat = async (request) => {
      if (request.phase === 'review' && ++reviewCalls === 3) throw new Error('endpoint unavailable');
      return chat(request);
    };
    const result = await runReview({ repoDir: s.repo.dir, target: s.target, options, llm, mode, sink: new LocalSink() });
    expect(result.status).toBe('failed');
    expect(result.coverage.reviewed).toBe(1);
  });
  it('discards all tools in truncated responses, retries once, and reports partial', async () => {
    const s = await setup(['a.ts']);
    const llm = new FakeLLM('m', reviewerScript({ files: ['a.ts'] })), chat = llm.chat.bind(llm);
    llm.chat = async (request) => {
      if (request.phase !== 'review') return chat(request);
      const args = { severity: 'high', path: 'a.ts', block: 'export const b = a + 1;', explanation: 'A real issue would have an impact.' };
      return { finishReason: 'length', reasoning: 'PRIVATE_REASONING',
        content: mode === 'structured' ? JSON.stringify({ tool: 'post_inline_review_comment', args }) : null,
        toolCalls: mode === 'tools' ? [{ id: 'truncated', name: 'post_inline_review_comment', arguments: JSON.stringify(args) }] : [],
        usage: { completionTokens: 2048 } };
    };
    const result = await runReview({ repoDir: s.repo.dir, target: s.target, options, llm, mode, sink: new LocalSink() });
    expect(result.status).toBe('partial');
    expect(result.findings).toHaveLength(0);
    expect(result.callCounts.toolCalls).toBe(0);
    expect(result.performance?.llmCalls.filter((call) => call.outcome === 'truncated')).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_REASONING');
  });
});

describe('generation fallbacks and numeric diagnostics', () => {
  it('uses deterministic planning and a validated deterministic final answer on truncation', async () => {
    const s = await setup(['a.ts']);
    const llm = new FakeLLM('m', reviewerScript({ files: ['a.ts'] })), chat = llm.chat.bind(llm);
    llm.chat = async (request) => request.phase === 'planning' || request.phase === 'summary' ?
      { finishReason: 'length', content: '{"status":"clean"}', toolCalls: [] } : chat(request);
    const result = await runReview({ repoDir: s.repo.dir, target: s.target, options, llm, mode: 'tools', sink: new LocalSink() });
    expect(result.status).toBe('clean');
    expect(result.coverage.reviewed).toBe(1);
    expect(result.summary).toContain('Final model summary exceeded its output budget');
    expect(result.performance?.llmCalls.filter((call) => call.outcome === 'truncated')).toHaveLength(2);
  });
  it('keeps a finding but withholds a truncated suggestion verdict', async () => {
    const s = await setup(['a.ts']);
    const llm = new FakeLLM('m', reviewerScript({ files: ['a.ts'], findings: [{ severity: 'high', path: 'a.ts', block: 'export const b = a + 1;',
      explanation: 'The changed expression causes incorrect behavior.', suggestion: 'export const b = 2;' }] })), chat = llm.chat.bind(llm);
    llm.chat = async (request) => request.phase === 'suggestion-critic' ?
      { finishReason: 'length', content: '{"verdict":"confirmed"}', toolCalls: [] } : chat(request);
    const result = await runReview({ repoDir: s.repo.dir, target: s.target, options, llm, mode: 'tools', sink: new LocalSink() });
    expect(result.status).toBe('findings');
    expect(result.findings[0]).toMatchObject({ suggestionRejected: true });
    expect(result.findings[0]?.suggestion).toBeUndefined();
  });
  it('retains checkpoints when the PR head moves and no later comment is posted', async () => {
    const s = await setup();
    const diff = await buildDiff(s.repo.dir, s.target);
    const github = new FakeGitHub({ prNumber: 7, headSha: diff.headSha });
    s.checkpoint.steps.push({ tool: 'post_inline_review_comment', args: { severity: 'high', path: 'b.ts', block: 'export const b = a + 1;', explanation: 'A changed expression has an actionable defect.' } });
    const result = await runReview({ repoDir: s.repo.dir, target: s.target, options, llm: new FakeLLM('m', s.checkpoint), mode: 'tools',
      sink: new GitHubSink({ github, prNumber: 7, expectedHead: diff.headSha }),
      onProgress: (event) => { if (event.type === 'file-completed') github.pull.head.sha = 'f'.repeat(40); } });
    expect(result.statusReason).toBe('head-changed-during-review');
    expect(result.coverage.reviewed).toBe(1);
    expect(github.reviewComments).toHaveLength(0);
  });
  it('reports numeric usage and safely ignores throwing/mutating observers', async () => {
    const s = await setup(['a.ts']);
    const llm = new FakeLLM('m', reviewerScript({ files: ['a.ts'] })), chat = llm.chat.bind(llm);
    const events: ReviewProgressEvent[] = [];
    llm.chat = async (request) => ({ ...await chat(request), reasoning: 'PRIVATE_REASONING', finishReason: 'PRIVATE_FINISH_REASON', usage: { completionTokens: 100, reasoningTokens: 80 } });
    const result = await runReview({ repoDir: s.repo.dir, target: s.target, options, llm, mode: 'tools', sink: new LocalSink(),
      generation: { thinkingTokenBudget: 1024, chatTemplateKwargs: { enable_thinking: true } },
      onProgress: (event) => { events.push(event); if (event.type === 'call-end') event.metric.maxOutputTokens = -1; throw new Error('observer error'); } });
    expect(result.status).toBe('clean');
    expect(result.performance?.llmCalls.every((call) => call.maxOutputTokens > 0 && call.promptTokens === undefined && call.finishReason === 'unknown')).toBe(true);
    expect(JSON.stringify(result.performance)).not.toContain('PRIVATE');
    expect(events.some((event) => event.type === 'call-start')).toBe(true);
    expect(llm.calls.find((call) => call.request.phase === 'review')?.request.thinkingTokenBudget).toBe(1024);
  });
  it('reviews nine files with a simulated 12-token/s model and explicit file checkpoints', async () => {
    const files = Array.from({ length: 9 }, (_, i) => `file-${i}.ts`);
    const s = await setup(files);
    const llm = new FakeLLM('m', { plan: { batches: [{ files }], skipped: [] }, steps: [
      ...files.flatMap((path) => [{ tool: 'read_diff', args: { path } }, { tool: 'complete_review_file', args: { path, summary: 'No actionable findings.' } }]),
      { tool: 'complete_review_batch', args: { summary: 'No actionable findings.', reviewed_files: files, skipped_files: [] } },
    ] }), chat = llm.chat.bind(llm);
    vi.useFakeTimers({ toFake: ['Date'] });
    llm.chat = async (request) => { vi.setSystemTime(Date.now() + 150 / 12 * 1000); return { ...await chat(request), usage: { completionTokens: 150 } }; };
    const result = await runReview({ repoDir: s.repo.dir, target: s.target, options: { ...options, maxDurationMinutes: 60 }, llm, mode: 'tools', sink: new LocalSink() });
    expect(result.status).toBe('clean');
    expect(result.coverage).toMatchObject({ eligible: 9, reviewed: 9, skipped: 0 });
    expect(result.durationMs).toBeLessThan(60 * 60_000);
  });
});

describe('CLI defaults and progress', () => {
  it('sets 60 minutes only on the CLI review command', () => {
    expect(buildProgram().commands.find((cmd) => cmd.name() === 'review')?.opts().maxDurationMinutes).toBe('60');
  });
  it('emits a non-blocking heartbeat and stops after completion/close', () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const reporter = createProgressReporter(true, (line) => lines.push(line));
    reporter.onProgress({ type: 'call-start', index: 1, phase: 'review', elapsedMs: 0 });
    vi.advanceTimersByTime(30_000);
    expect(lines.at(-1)).toContain('still running (30s)');
    reporter.close();
    const count = lines.length;
    vi.advanceTimersByTime(60_000);
    expect(lines).toHaveLength(count);
  });
});
