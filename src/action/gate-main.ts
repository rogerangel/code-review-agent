import { readFileSync } from 'node:fs';
import { decideGate, type GateDecision } from './gate.js';
import { GitHubClient } from '../core/github/client.js';
import { BudgetTracker } from '../core/review/budget.js';
import { readInput, setOutput } from './io.js';
import { clampResource, LIMITS } from '../core/security/limits.js';

async function main(): Promise<GateDecision> {
  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? '').split('/');
  const token = readInput('github_token') || process.env.GITHUB_TOKEN || '';
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!owner || !repo || !token || !eventPath) throw new Error('missing GitHub event/repository/token');
  const github = new GitHubClient({ token, owner, repo, budget: new BudgetTracker(Date.now(), 2) });
  return decideGate(process.env.GITHUB_EVENT_NAME ?? '', JSON.parse(readFileSync(eventPath, 'utf8')), github);
}
main().catch((error): GateDecision => ({ approved: false, prNumber: null, reason: 'gate-error: ' + error.message, operationalError: true })).then((decision) => {
  setOutput('approved', String(decision.approved));
  setOutput('pr_number', String(decision.prNumber ?? ''));
  setOutput('reason', decision.reason);
  setOutput('status', decision.approved ? '' : decision.operationalError ? 'failed' : 'skipped');
  setOutput('job_timeout_minutes', String(clampResource(Number(readInput('max_duration_minutes') || 20), 20, LIMITS.maxDurationMinutesHard) + 5));
  setOutput('head_sha', decision.pull?.head.sha ?? '');
  setOutput('base_sha', decision.pull?.base.sha ?? '');
  console.log('gate: ' + (decision.approved ? 'approved' : decision.operationalError ? 'failed' : 'skipped') + ' — ' + decision.reason);
  process.exitCode = decision.operationalError ? 1 : 0;
}).catch(() => { console.error('gate: output emission failed'); process.exitCode = 1; });
