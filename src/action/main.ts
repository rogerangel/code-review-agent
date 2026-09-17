/** Trusted Node Action entry; PR code is data, never executable action code. */
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readInput, setOutput, setSummary } from './io.js';
import { decideGate, type GateEvent } from './gate.js';
import { GitHubClient } from '../core/github/client.js';
import { GitHubSink, SupersededReviewError } from '../core/review/github-sink.js';
import { OpenAICompatibleClient } from '../core/llm/client.js';
import { probeModel, decideToolMode } from '../core/llm/doctor.js';
import { runReview, emptyCallCounts } from '../core/review/pipeline.js';
import { BudgetTracker } from '../core/review/budget.js';
import { ensureRemoteBranch, git } from '../core/diff/git.js';
import { clampResource, LIMITS } from '../core/security/limits.js';
import { DEFAULT_CONFIG } from '../core/config.js';
import { SEVERITY_RANK, type FailOnSeverity, type ReviewResult, type ToolMode } from '../core/types.js';

let budget = new BudgetTracker(Date.now(), 20);
function emptyResult(status: ReviewResult['status'], reason: string, operational = false): ReviewResult {
  return { schema: 'code-review-agent.result/v1', status, statusReason: reason, target: 'GitHub pull request',
    baseSha: 'unknown', headSha: 'unknown', model: readInput('llm_model'), findings: [],
    coverage: { totalChanged: 0, eligible: 0, reviewed: 0, skipped: 0, excluded: 0, files: [] },
    summary: reason, operationalErrors: operational ? [{ stage: 'action-preflight', code: 'preflight-failed', message: reason }] : [],
    startedAt: new Date(budget.startedAt).toISOString(), finishedAt: new Date().toISOString(),
    durationMs: budget.elapsed(), callCounts: emptyCallCounts() };
}
async function main(): Promise<ReviewResult> {
  const maxDurationMinutes = clampResource(Number(readInput('max_duration_minutes') || 20), 20, 120);
  budget = new BudgetTracker(budget.startedAt, maxDurationMinutes);
  const repoFull = process.env.GITHUB_REPOSITORY ?? '';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoFull)) throw new Error('missing/invalid GITHUB_REPOSITORY');
  const [owner, repo] = repoFull.split('/') as [string, string];
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const token = readInput('github_token') || process.env.GITHUB_TOKEN || '';
  if (!eventPath || !token) throw new Error('missing GitHub event/token');
  const event = JSON.parse(readFileSync(eventPath, 'utf8')) as GateEvent;
  const github = new GitHubClient({ token, owner, repo, budget,
    baseUrl: process.env.GITHUB_API_URL,
    commentAuthor: readInput('github_comment_author') || 'github-actions[bot]' });
  github.setSignal(budget.signal());
  const gate = await decideGate(process.env.GITHUB_EVENT_NAME ?? '', event, github);
  if (!gate.approved) {
    if (budget.workExceeded()) return emptyResult('partial', 'time-budget-exhausted');
    return emptyResult(gate.operationalError ? 'failed' : 'skipped', gate.reason, gate.operationalError);
  }
  const pr = gate.pull!;
  const baseUrl = readInput('llm_base_url'), model = readInput('llm_model');
  const toolMode = (readInput('tool_mode') || 'auto') as ToolMode;
  const failOnSeverity = (readInput('fail_on_severity') || 'none') as FailOnSeverity;
  if (!baseUrl || !model) throw new Error('llm_base_url and llm_model are required');
  if (!['auto', 'tools', 'structured'].includes(toolMode)) throw new Error('invalid tool_mode');
  if (!['none', 'medium', 'high', 'critical'].includes(failOnSeverity)) throw new Error('invalid fail_on_severity');
  const expectedHead = readInput('expected_head_sha') || pr.head.sha;
  if (expectedHead !== pr.head.sha) throw new SupersededReviewError();
  const repoDir = path.resolve(process.env.GITHUB_WORKSPACE ?? process.cwd(), readInput('repository_path') || '.');
  const serverUrl = (process.env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/$/, '');
  const gitOptions = { budget, env: {
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'http.' + serverUrl + '/.extraheader',
    GIT_CONFIG_VALUE_0: 'AUTHORIZATION: basic ' + Buffer.from('x-access-token:' + token).toString('base64'),
    GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: '',
  } };
  const llm = new OpenAICompatibleClient({ baseUrl, model, apiKey: readInput('llm_api_key') || undefined, budget });
  return runReview({
    repoDir, budget, gitOptions,
    target: { kind: 'three-dot', label: 'PR #' + pr.number, baseRev: pr.base.sha, headRev: expectedHead, viewKind: 'ref' },
    options: { configPath: readInput('config_path') || '.code-review-agent.yml', toolMode, maxDurationMinutes,
      maxInlineComments: clampResource(Number(readInput('max_inline_comments') || 6), 6, LIMITS.maxInlineCommentsHard),
      failOnSeverity, config: DEFAULT_CONFIG },
    llm, mode: 'structured',
    sink: new GitHubSink({ github, prNumber: pr.number, expectedHead, budget }),
    prContext: { title: pr.title ?? '', description: pr.body ?? '' },
    runUrl: process.env.GITHUB_RUN_ID ? serverUrl + '/' + repoFull + '/actions/runs/' + process.env.GITHUB_RUN_ID : undefined,
    prepare: async (boundedLlm) => {
      const snapshot = await git(repoDir, ['rev-parse', 'HEAD'], gitOptions);
      if (snapshot.code !== 0) throw new Error('PR snapshot is not a Git checkout');
      if (snapshot.stdout.trim() !== expectedHead) throw new SupersededReviewError();
      const remote = await git(repoDir, ['remote', 'get-url', 'origin'], gitOptions);
      if (remote.code !== 0 || remote.stdout.trim().replace(/\.git\/?$/, '').replace(/\/$/, '') !== serverUrl + '/' + repoFull) throw new Error('PR snapshot origin must be the base repository HTTPS URL');
      await ensureRemoteBranch(repoDir, pr.base.ref, gitOptions);
      const probe = await probeModel({ model, chat: boundedLlm.chat,
        listModels: () => budget.run((signal) => llm.listModels(signal)) });
      return { mode: decideToolMode(probe, toolMode).mode };
    },
  });
}
async function outputs(result: ReviewResult): Promise<void> {
  const resultPath = path.join(tmpdir(), 'code-review-agent-result-' + Date.now() + '.json');
  await writeFile(resultPath, JSON.stringify(result, null, 2), 'utf8');
  setOutput('status', result.status);
  setOutput('findings_count', String(result.findings.length));
  setOutput('reviewed_head_sha', result.headSha === 'unknown' ? '' : result.headSha);
  setOutput('summary_comment_url', result.summaryCommentUrl ?? '');
  setOutput('coverage_json', JSON.stringify(result.coverage));
  setOutput('operational_errors_json', JSON.stringify(result.operationalErrors));
  setOutput('inline_comments_reused', String(result.callCounts.inlineCommentsReused));
  setOutput('result_path', resultPath);
  setSummary(['## Code review agent', '', '**Status:** ' + result.status,
    '**Reason:** ' + (result.statusReason ?? 'completed'), '**Head:** ' + result.headSha,
    '**Coverage:** ' + result.coverage.reviewed + '/' + result.coverage.eligible,
    '**Accepted findings:** ' + result.findings.length,
    '**New inline comments:** ' + result.callCounts.inlineCommentsPosted,
    '**Reused inline comments:** ' + result.callCounts.inlineCommentsReused,
    '**Duration:** ' + Math.round(result.durationMs / 1000) + 's',
    '**Calls:** ' + result.callCounts.llmCalls + ' LLM, ' + result.callCounts.toolCalls + ' tools',
    ...(result.summaryCommentUrl ? ['Summary: ' + result.summaryCommentUrl] : []),
    ...result.operationalErrors.map((e) => '- ' + e.stage + ': ' + e.message),
    '', 'Raw prompts, model reasoning, and repository snapshots are not uploaded.'].join('\n'));
}
main().catch((err) => emptyResult(err instanceof SupersededReviewError || budget.workExceeded() ? 'partial' : 'failed',
  err instanceof SupersededReviewError ? 'head-changed-during-review' : budget.workExceeded() ? 'time-budget-exhausted' : err.message,
  !(err instanceof SupersededReviewError) && !budget.workExceeded())).then(async (result) => {
  await outputs(result);
  const threshold = (readInput('fail_on_severity') || 'none') as FailOnSeverity;
  const severityFailure = threshold !== 'none' && result.findings.some((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[threshold]);
  if (result.status === 'failed' || severityFailure) {
    console.error('::error::Code review ' + (result.status === 'failed' ? 'operational failure' : 'severity threshold exceeded'));
    process.exitCode = 1;
  }
}).catch(() => { console.error('::error::Cannot persist code-review-agent outputs'); process.exitCode = 1; });
