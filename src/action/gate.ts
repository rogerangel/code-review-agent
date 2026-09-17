/** Shared event/authorization decision. No entrypoint side effects when imported. */
import type { GitHubApi, Permission, PullInfo } from '../core/github/client.js';
export const AUTO_ACTIONS = new Set(['opened', 'reopened', 'ready_for_review', 'synchronize']);
export const AUTHORIZED: Permission[] = ['write', 'maintain', 'admin'];
export interface GateEvent {
  action?: string;
  pull_request?: { number: number; draft?: boolean; merged?: boolean; head?: { repo?: { fork?: boolean; full_name?: string } }; base?: { repo?: { full_name?: string } } };
  issue?: { number: number; pull_request?: unknown; state?: string };
  comment?: { body?: string; user?: { login?: string } };
}
export interface GateDecision {
  approved: boolean;
  prNumber: number | null;
  reason: string;
  author?: string;
  operationalError?: boolean;
  pull?: PullInfo;
}
export async function decideGate(
  eventName: string, event: GateEvent, github: Pick<GitHubApi, 'getPull' | 'collaboratorPermission'>,
): Promise<GateDecision> {
  const number = event.pull_request?.number ?? event.issue?.number ?? null;
  const deny = (reason: string, operationalError = false): GateDecision => ({ approved: false, prNumber: number, reason, operationalError });
  try {
    let author: string | undefined;
    if (eventName === 'pull_request') {
      if (!event.pull_request) return deny('gate-error: pull_request payload missing', true);
      if (!AUTO_ACTIONS.has(event.action ?? '')) return deny('event-not-eligible: action');
      if (event.pull_request.draft) return deny('draft-pull-request');
      if (event.pull_request.merged) return deny('pull-request-merged');
      author = event.action;
    } else if (eventName === 'issue_comment') {
      if (event.action !== 'created') return deny('event-not-eligible: only newly created comments');
      if ((event.comment?.body ?? '').trim() !== '/review') return deny('event-not-eligible: not an exact /review command');
      if (!event.issue?.pull_request) return deny('event-not-eligible: issue is not a pull request');
      author = event.comment?.user?.login;
      if (!author) return deny('gate-error: comment author unknown', true);
      const permission = await github.collaboratorPermission(author);
      if (!AUTHORIZED.includes(permission)) return { ...deny('unauthorized: ' + author + ' has permission "' + permission + '"'), author };
    } else return deny('event-not-eligible: event');
    if (!number || !Number.isSafeInteger(number)) return deny('gate-error: PR number missing/invalid', true);
    const pull = await github.getPull(number);
    if (pull.draft) return deny('draft-pull-request');
    if (pull.state !== 'open') return deny(pull.merged_at ? 'pull-request-merged' : 'pull-request-closed');
    if (!pull.head.repo || !pull.base.repo?.full_name || !pull.head.repo.full_name || !pull.head.sha || !pull.base.sha) return deny('gate-error: incomplete PR repository metadata', true);
    if (eventName === 'pull_request' && pull.head.repo.full_name.toLowerCase() !== pull.base.repo.full_name.toLowerCase()) return deny('fork-pull-request-automatic-skip');
    return { approved: true, prNumber: number, reason: eventName === 'pull_request' ? 'automatic' : 'review-command', author, pull };
  } catch (err) { return deny('gate-error: ' + (err as Error).message, true); }
}
