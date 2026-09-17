import { describe, expect, it } from 'vitest';
import { decideGate, type GateEvent } from '../../src/action/gate.js';
import { FakeGitHub } from '../helpers/fake-github.js';

function pullEvent(over: Partial<GateEvent['pull_request']> = {}, action = 'opened'): GateEvent {
  return {
    action,
    pull_request: {
      number: 42,
      draft: false,
      merged: false,
      head: { repo: { fork: false } },
      ...over,
    },
  };
}

function commentEvent(params: {
  body?: string;
  login?: string;
  isPr?: boolean;
  permission?: 'admin' | 'maintain' | 'write' | 'read' | 'none';
} = {}): GateEvent {
  const p = { body: '/review', login: 'octo', isPr: true, permission: 'write' as const, ...params };
  return {
    action: 'created',
    issue: { number: 42, pull_request: p.isPr ? { url: 'x' } : undefined },
    comment: { body: p.body, user: { login: p.login } },
  };
}

function makeFake(over: { draft?: boolean; state?: string } = {}): FakeGitHub {
  const fake = new FakeGitHub({ prNumber: 42, headSha: 'abc' });
  if (over.draft) fake.pull.draft = over.draft;
  if (over.state) (fake.pull as { state: string }).state = over.state;
  return fake;
}

describe('decideGate: pull_request events', () => {
  it('approves opened/reopened/ready_for_review/synchronize on a normal PR', async () => {
    const fake = makeFake();
    for (const action of ['opened', 'reopened', 'ready_for_review', 'synchronize']) {
      const d = await decideGate('pull_request', pullEvent({}, action), fake);
      expect(d.approved).toBe(true);
      expect(d.prNumber).toBe(42);
      expect(d.reason).toBe('automatic');
    }
  });

  it('rejects other actions (closed, edited, ...)', async () => {
    const fake = makeFake();
    const d = await decideGate('pull_request', pullEvent({}, 'closed'), fake);
    expect(d.approved).toBe(false);
    expect(d.reason).toContain('event-not-eligible');
    const d2 = await decideGate('pull_request', pullEvent({}, 'labeled'), fake);
    expect(d2.approved).toBe(false);
  });

  it('rejects draft PRs', async () => {
    const d = await decideGate('pull_request', pullEvent({ draft: true }), makeFake());
    expect(d.approved).toBe(false);
    expect(d.reason).toBe('draft-pull-request');
  });

  it('rejects merged PRs', async () => {
    const d = await decideGate('pull_request', pullEvent({ merged: true }), makeFake());
    expect(d.approved).toBe(false);
    expect(d.reason).toBe('pull-request-merged');
  });

  it('skips automatic review of fork PRs', async () => {
    const fake = makeFake();
    fake.pull.head.repo!.full_name = 'other/repo';
    const d = await decideGate(
      'pull_request',
      pullEvent({ head: { repo: { fork: true } } }),
      fake,
    );
    expect(d.approved).toBe(false);
    expect(d.reason).toBe('fork-pull-request-automatic-skip');
  });

  it('rejects when the pull_request payload is missing', async () => {
    const d = await decideGate('pull_request', { action: 'opened' }, makeFake());
    expect(d.approved).toBe(false);
    expect(d.reason).toContain('gate-error');
  });

  it('allows a same-repository branch even when the repository itself is a fork', async () => {
    const fake = makeFake();
    fake.pull.head.repo!.fork = true;
    expect((await decideGate('pull_request', pullEvent({ head: { repo: { fork: true } } }), fake)).approved).toBe(true);
  });
});

describe('decideGate: issue_comment /review events', () => {
  it('approves exact /review from a write collaborator', async () => {
    const fake = makeFake();
    fake.permissions.set('octo', 'write');
    const d = await decideGate('issue_comment', commentEvent(), fake);
    expect(d.approved).toBe(true);
    expect(d.reason).toBe('review-command');
    expect(d.author).toBe('octo');
  });

  it('approves maintain and admin collaborators', async () => {
    const fake = makeFake();
    fake.permissions.set('octo', 'maintain');
    expect((await decideGate('issue_comment', commentEvent(), fake)).approved).toBe(true);
    fake.permissions.set('octo', 'admin');
    expect((await decideGate('issue_comment', commentEvent(), fake)).approved).toBe(true);
  });

  it('rejects read-only collaborators', async () => {
    const fake = makeFake();
    fake.permissions.set('octo', 'read');
    const d = await decideGate('issue_comment', commentEvent(), fake);
    expect(d.approved).toBe(false);
    expect(d.reason).toContain('unauthorized');
    expect(d.reason).toContain('read');
  });

  it('rejects non-collaborators', async () => {
    const fake = makeFake();
    fake.permissions.set('stranger', 'none');
    const d = await decideGate('issue_comment', commentEvent({ login: 'stranger' }), fake);
    expect(d.approved).toBe(false);
    expect(d.reason).toContain('unauthorized');
  });

  it('rejects non-exact command bodies', async () => {
    const fake = makeFake();
    for (const body of ['', '/Review', '/review please', '/review\nmore', '/reviewx', '  /review  x']) {
      const d = await decideGate('issue_comment', commentEvent({ body }), fake);
      expect(d.approved, `body ${JSON.stringify(body)}`).toBe(false);
    }
  });

  it('accepts /review with surrounding whitespace only', async () => {
    const fake = makeFake();
    fake.permissions.set('octo', 'write');
    const d = await decideGate('issue_comment', commentEvent({ body: '  /review\n' }), fake);
    expect(d.approved).toBe(true);
  });

  it('rejects comments on plain issues (not PRs)', async () => {
    const d = await decideGate('issue_comment', commentEvent({ isPr: false }), makeFake());
    expect(d.approved).toBe(false);
    expect(d.reason).toContain('not a pull request');
  });

  it('rejects when the comment author is unknown', async () => {
    const d = await decideGate(
      'issue_comment',
      { action: 'created', issue: { number: 42, pull_request: {} }, comment: { body: '/review' } },
      makeFake(),
    );
    expect(d.approved).toBe(false);
    expect(d.reason).toContain('gate-error');
  });

  it('rejects draft or closed PRs via the API', async () => {
    const fakeDraft = makeFake({ draft: true });
    fakeDraft.permissions.set('octo', 'write');
    const d1 = await decideGate('issue_comment', commentEvent(), fakeDraft);
    expect(d1.approved).toBe(false);
    expect(d1.reason).toBe('draft-pull-request');

    const fakeClosed = makeFake({ state: 'closed' });
    fakeClosed.permissions.set('octo', 'write');
    const d2 = await decideGate('issue_comment', commentEvent(), fakeClosed);
    expect(d2.approved).toBe(false);
    expect(d2.reason).toBe('pull-request-closed');
  });

  it('fails closed when the API throws', async () => {
    const broken = {
      getPull: async () => {
        throw new Error('boom');
      },
      collaboratorPermission: async () => 'write' as const,
    };
    const d = await decideGate('issue_comment', commentEvent(), broken);
    expect(d.approved).toBe(false);
    expect(d.reason).toContain('gate-error');
    expect(d.reason).toContain('boom');
    expect(d.operationalError).toBe(true);
  });

  it('does not authorize edited comments or fetch any repository data', async () => {
    const api = { getPull: async () => { throw new Error('unexpected API call'); }, collaboratorPermission: async () => { throw new Error('unexpected API call'); } };
    const d = await decideGate('issue_comment', { ...commentEvent(), action: 'edited' }, api);
    expect(d.approved).toBe(false);
    expect(d.operationalError).toBe(false);
  });
});

describe('decideGate: other events', () => {
  it('rejects unknown event names', async () => {
    const d = await decideGate('push', {}, makeFake());
    expect(d.approved).toBe(false);
    expect(d.reason).toContain('event-not-eligible');
  });
});
