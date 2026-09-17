import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeBranchRepo, type RepoHandle } from '../helpers/repos.js';
import { git, resolveCommit } from '../../src/core/diff/git.js';
import { parse } from 'yaml';

const handles: RepoHandle[] = [], resultFiles: string[] = [];
afterEach(async () => {
  for (const r of handles.splice(0)) await r.dispose();
  for (const file of resultFiles.splice(0)) await fs.rm(file, { force: true });
});
async function action(permission: string, options: { inlineError?: number; stale?: boolean; llmOptions?: string } = {}) {
  const repo = await makeBranchRepo({
    baseFiles: { 'src/a.ts': 'export const a = 1;\n', 'action.yml': 'runs:\n  using: node24\n  main: evil.cjs\n', 'evil.cjs': 'throw new Error("MALICIOUS_CALLER_EXECUTED");' },
    headFiles: { 'src/a.ts': 'export const a = 1;\nexport const b = a + 1;\n' },
  });
  handles.push(repo);
  const head = await resolveCommit(repo.dir, 'HEAD'), base = await resolveCommit(repo.dir, 'main');
  await git(repo.dir, ['remote', 'add', 'origin', 'https://github.com/owner/repo.git']);
  await git(repo.dir, ['update-ref', 'refs/remotes/origin/main', base]);
  const scenario = { permission, inlineError: options.inlineError, pull: {
    number: 7, state: 'open', draft: false, title: 'Untrusted PR title', body: 'PR data',
    head: { sha: head, ref: 'feature', repo: { full_name: 'fork/repo', fork: true, owner: { login: 'octo' } } },
    base: { sha: base, ref: 'main', repo: { full_name: 'owner/repo' } },
  } };
  await fs.writeFile(path.join(repo.dir, 'scenario.json'), JSON.stringify(scenario));
  await fs.writeFile(path.join(repo.dir, 'event.json'), JSON.stringify({ action: 'created',
    issue: { number: 7, pull_request: {} }, comment: { body: '/review', user: { login: 'octo' } } }));
  const log = path.join(repo.dir, 'http.jsonl'), output = path.join(repo.dir, 'outputs');
  const child = spawnSync('node', ['--import', path.resolve('test/helpers/entry-preload.mjs'), path.resolve('dist/action.cjs')], {
    cwd: repo.dir, encoding: 'utf8', timeout: 30_000, env: { ...process.env,
      CRA_TEST_SCENARIO: path.join(repo.dir, 'scenario.json'), CRA_TEST_HTTP_LOG: log,
      GITHUB_REPOSITORY: 'owner/repo', GITHUB_WORKSPACE: repo.dir, GITHUB_API_URL: 'https://api.test',
      GITHUB_EVENT_PATH: path.join(repo.dir, 'event.json'), GITHUB_EVENT_NAME: 'issue_comment',
      GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: path.join(repo.dir, 'summary.md'),
      INPUT_GITHUB_TOKEN: 'test-only', INPUT_LLM_BASE_URL: 'http://llm.test/v1', INPUT_LLM_MODEL: 'test-model',
      INPUT_EXPECTED_HEAD_SHA: options.stale ? 'different-head' : head, INPUT_REPOSITORY_PATH: '.',
      INPUT_FAIL_ON_SEVERITY: 'none', INPUT_TOOL_MODE: 'auto',
      INPUT_LLM_OPTIONS: options.llmOptions ?? '{}',
    },
  });
  if (child.error) throw child.error;
  const outputs = await fs.readFile(output, 'utf8');
  const resultPath = /^result_path=(.+)$/m.exec(outputs)![1]!;
  resultFiles.push(resultPath);
  const result = JSON.parse(await fs.readFile(resultPath, 'utf8'));
  const requests = (await fs.readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { child, outputs, result, requests };
}
describe('standalone Node Action boundaries', () => {
  it('denies unauthorized /review before model discovery or inference', async () => {
    const run = await action('read');
    expect(run.child.status).toBe(0);
    expect(run.result.status).toBe('skipped');
    expect(run.requests.some((r) => r.url.startsWith('http://llm.test'))).toBe(false);
  });
  it('authorizes a fork snapshot, uses trusted executable code and completes a native tool round trip', async () => {
    const run = await action('write');
    expect(run.child.status, run.child.stderr).toBe(0);
    expect(run.result.status).toBe('findings');
    expect(run.result.coverage.reviewed).toBe(1);
    expect(run.result.callCounts.inlineCommentsPosted).toBe(1);
    expect(run.child.stderr).not.toContain('MALICIOUS_CALLER_EXECUTED');
    expect(run.requests.filter((r) => r.method === 'POST' && r.url.includes('/pulls/7/comments'))).toHaveLength(1);
    expect(run.outputs).toContain('operational_errors_json=[]');
    const replay = run.requests.find((r) => r.body?.tool_choice === 'none');
    expect(replay.body.messages[1].tool_calls[0]).toMatchObject({ type: 'function', function: { name: 'get_weather' } });
  });
  it('emits failed normalized outputs and nonzero exit on publishing permission failures', async () => {
    const run = await action('write', { inlineError: 403 });
    expect(run.child.status).toBe(1);
    expect(run.outputs).toContain('status=failed');
    expect(run.result.findings[0].delivery).toBe('failed');
    expect(run.result.operationalErrors[0].stage).toBe('inline-publishing');
  });
  it('supersedes a mismatched gate-pinned head before contacting the LLM', async () => {
    const run = await action('write', { stale: true });
    expect(run.child.status).toBe(0);
    expect(run.result.status).toBe('partial');
    expect(run.requests.some((r) => r.url.startsWith('http://llm.test'))).toBe(false);
  });
  it('forwards operator generation settings to probes and capped inference without changing the GitHub duration default', async () => {
    const run = await action('write', { llmOptions: JSON.stringify({ max_output_tokens: 4096, thinking_token_budget: 1024,
      chat_template_kwargs: { enable_thinking: true }, temperature: 1, top_p: 0.95, top_k: 20, presence_penalty: 0.2 }) });
    expect(run.child.status, run.child.stderr).toBe(0);
    const calls = run.requests.filter((r) => r.url.endsWith('/chat/completions'));
    expect(calls.every((r) => r.body.temperature === 1 && r.body.top_p === 0.95 && r.body.top_k === 20 && r.body.presence_penalty === 0.2)).toBe(true);
    expect(calls.every((r) => r.body.chat_template_kwargs.enable_thinking === true && r.body.thinking_token_budget <= r.body.max_tokens / 2)).toBe(true);
    const review = calls.find((r) => r.body.tools?.some((tool: { function: { name: string } }) => tool.function.name === 'read_diff'));
    expect(review.body).toMatchObject({ max_tokens: 4096, thinking_token_budget: 1024 });
    const metadata = parse(await fs.readFile('action.yml', 'utf8'));
    expect(String(metadata.inputs.max_duration_minutes.default)).toBe('20');
    expect(metadata.inputs.llm_options.default).toBe('{}');
  });
});
describe('reusable workflow executable source and permissions', () => {
  it('checks out trusted reviewer code separately from caller data and gates tailnet access', async () => {
    const workflow = parse(await fs.readFile('.github/workflows/code-review-agent.yml', 'utf8'));
    const gate = workflow.jobs.gate, review = workflow.jobs.review;
    expect(gate.steps.find((s: { id?: string }) => s.id === 'gate').uses).toBe('./reviewer/gate-action');
    expect(gate.steps[1].with.repository).toBe('${{ inputs.reviewer_repository }}');
    const checkouts = review.steps.filter((s: { uses?: string }) => s.uses?.startsWith('actions/checkout@'));
    expect(checkouts.map((s: { with: { path: string } }) => s.with.path)).toEqual(['reviewer', 'review-target']);
    expect(checkouts[0].with.ref).toBe('${{ inputs.reviewer_ref }}');
    expect(checkouts.every((s: { with: { 'persist-credentials': boolean } }) => s.with['persist-credentials'] === false)).toBe(true);
    const tailscale = review.steps.find((s: { uses?: string }) => s.uses?.startsWith('tailscale/github-action@'));
    expect(tailscale.if).toBe("steps.snapshot.outputs.current == 'true'");
    expect(Object.keys(tailscale.with)).toEqual(['oauth-client-id', 'audience', 'tags']);
    expect(review.if).toBe("needs.gate.outputs.approved == 'true'");
    expect(review.permissions['id-token']).toBe('write');
    expect(review.permissions['issues']).toBe('write');
    expect(review.steps.find((s: { id?: string }) => s.id === 'review').uses).toBe('./reviewer');
    expect(workflow.on.workflow_call.secrets.llm_api_key).toBeDefined();
    expect(workflow.on.workflow_call.outputs.coverage_json.value).toContain('jobs.review.outputs.coverage_json');
    expect(workflow.on.workflow_call.inputs.llm_options.default).toBe('{}');
    expect(review.steps.find((s: { id?: string }) => s.id === 'review').with.llm_options).toBe('${{ inputs.llm_options }}');
    expect(workflow.on.workflow_call.inputs.max_duration_minutes.default).toBe(20);
    for (const step of [...gate.steps, ...review.steps]) if (step.uses && !step.uses.startsWith('./')) expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
  });
});

describe('CLI entrypoint', () => {
  for (const llmError of [undefined, 401]) {
    it(llmError ? 'emits normalized failed JSON on preflight errors' : 'runs from a subdirectory with pure JSON stdout and a matching output file', async () => {
      const repo = await makeBranchRepo({ baseFiles: { 'src/a.ts': 'export const a = 1;\n' }, headFiles: { 'src/a.ts': 'export const a = 1;\nexport const b = a + 1;\n' } });
      handles.push(repo);
      await fs.writeFile(path.join(repo.dir, 'scenario.json'), JSON.stringify({ llmError }));
      const output = path.join(repo.dir, 'result.json');
      const child = spawnSync('node', ['--import', path.resolve('test/helpers/entry-preload.mjs'), path.resolve('dist/cli.js'),
        'review', 'main...feature', '--format', 'json', '--output', output], {
        cwd: path.join(repo.dir, 'src'), encoding: 'utf8', timeout: 30_000, env: { ...process.env,
          CRA_TEST_SCENARIO: path.join(repo.dir, 'scenario.json'), CRA_TEST_HTTP_LOG: path.join(repo.dir, 'http.jsonl'),
          CRA_LLM_BASE_URL: 'http://llm.test/v1', CRA_LLM_MODEL: 'test-model',
        },
      });
      expect(child.status, child.stderr).toBe(llmError ? 1 : 0);
      const result = JSON.parse(child.stdout);
      expect(result.status).toBe(llmError ? 'failed' : 'findings');
      expect(JSON.parse(await fs.readFile(output, 'utf8'))).toEqual(result);
      expect(child.stderr).not.toMatch(/\[review\] (llm|completed|compaction)/);
      if (!llmError) expect(result.findings[0].delivery).toBe('local');
    });
  }
  for (const flagOverride of [false, true]) {
    it(flagOverride ? 'gives --llm-options precedence over the environment and suppresses progress with --quiet' : 'applies CRA_LLM_OPTIONS in the packaged CLI', async () => {
      const repo = await makeBranchRepo({ baseFiles: { 'src/a.ts': 'export const a = 1;\n' }, headFiles: { 'src/a.ts': 'export const a = 1;\nexport const b = a + 1;\n' } });
      handles.push(repo);
      await fs.writeFile(path.join(repo.dir, 'scenario.json'), '{}');
      const log = path.join(repo.dir, 'http.jsonl');
      const args = ['--import', path.resolve('test/helpers/entry-preload.mjs'), path.resolve('dist/cli.js'), 'review', 'main...feature', '--quiet'];
      if (flagOverride) args.push('--llm-options', '{"max_output_tokens":4096,"temperature":1}');
      const child = spawnSync('node', args, { cwd: repo.dir, encoding: 'utf8', timeout: 30_000, env: { ...process.env,
        CRA_TEST_SCENARIO: path.join(repo.dir, 'scenario.json'), CRA_TEST_HTTP_LOG: log,
        CRA_LLM_BASE_URL: 'http://llm.test/v1', CRA_LLM_MODEL: 'test-model',
        CRA_LLM_OPTIONS: '{"max_output_tokens":1024,"temperature":0.7}',
      } });
      expect(child.status, child.stderr).toBe(0);
      expect(child.stderr).toBe('');
      const calls = (await fs.readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      const review = calls.find((r) => r.body?.tools?.some((tool: { function: { name: string } }) => tool.function.name === 'read_diff'));
      expect(review.body).toMatchObject({ max_tokens: flagOverride ? 4096 : 1024, temperature: flagOverride ? 1 : 0.7 });
      expect(child.stdout).toContain('code-review-agent');
    });
  }
});
