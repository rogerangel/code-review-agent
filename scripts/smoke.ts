/** No live GitHub/LLM calls. Both Node Actions must work without node_modules. */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'cra-smoke-'));
function run(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  return execFileSync(command, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 120_000 });
}
try {
  const isolated = path.join(temporary, 'isolated');
  await fs.mkdir(isolated);
  await fs.copyFile(path.join(root, 'dist/action.cjs'), path.join(isolated, 'action.cjs'));
  await fs.copyFile(path.join(root, 'gate-action/dist/gate.cjs'), path.join(isolated, 'gate.cjs'));
  const event = path.join(isolated, 'event.json');
  await fs.writeFile(event, '{}');
  for (const bundle of ['action', 'gate']) {
    const output = path.join(isolated, bundle + '-outputs');
    const env = {
      GITHUB_REPOSITORY: 'owner/repo', GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: event,
      GITHUB_WORKSPACE: isolated, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: path.join(isolated, bundle + '-summary'),
      INPUT_GITHUB_TOKEN: 'smoke-only', INPUT_MAX_DURATION_MINUTES: '20',
    };
    run('node', [path.join(isolated, bundle + '.cjs')], isolated, env);
    assert.match(await fs.readFile(output, 'utf8'), /status=skipped/);
  }
  console.log('PASS: isolated worker and gate need no external npm dependencies.');
  const packed = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temporary], root)) as { filename: string }[];
  const installDir = path.join(temporary, 'installed');
  await fs.mkdir(installDir);
  // CI's npm ci warms this cache. No package scripts or live service calls.
  run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', installDir,
    path.join(temporary, packed[0]!.filename)], installDir);
  const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
  assert.equal(run('node', [path.join(installDir, 'node_modules/code-review-agent/dist/cli.js'), '--version'], installDir).trim(), version);
  assert.match(run('node', [path.join(installDir, 'node_modules/code-review-agent/dist/cli.js'), '--help'], installDir), /doctor/);
  run('node', ['--input-type=module', '-e',
    'import {runReview,BudgetTracker,GitHubSink} from "code-review-agent"; if(![runReview,BudgetTracker,GitHubSink].every(x=>typeof x==="function"))process.exit(1)'], installDir);
  console.log('PASS: packed, installed CLI and API exports.');
} finally {
  // Explicit directory from mkdtemp; no workspace or user data is removed.
  await fs.rm(temporary, { recursive: true, force: true });
}

