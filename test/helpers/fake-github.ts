/**
 * In-memory GitHub API fake for sink/gate/pipeline tests.
 */
import type {
  GitHubApi,
  IssueCommentInfo,
  Permission,
  PullInfo,
  ReviewCommentParams,
} from '../../src/core/github/client.js';

export interface FakeReviewComment {
  id: number;
  prNumber: number;
  commit_id: string;
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  body: string;
  html_url: string;
  user: { login: string };
  start_line?: number;
  start_side?: 'LEFT' | 'RIGHT';
}

export class FakeGitHub implements GitHubApi {
  pull: PullInfo;
  issueComments: IssueCommentInfo[] = [];
  reviewComments: FakeReviewComment[] = [];
  permissions = new Map<string, Permission>();
  private nextId = 1;
  private commentId = 100;

  /** When set, the next getPull returns this head sha (simulates a push). */
  pushHeadSha: string | null = null;
  /** When >0, the next createReviewComment fails once with this status. */
  failReviewCommentOnce: { status: number; retryAfterSec?: number } | null = null;

  constructor(params: { prNumber: number; headSha: string; baseRef?: string }) {
    this.pull = {
      number: params.prNumber,
      state: 'open',
      draft: false,
      head: {
        ref: 'feature',
        sha: params.headSha,
        repo: { full_name: 'owner/repo', fork: false, owner: { login: 'author' } },
      },
      base: { ref: params.baseRef ?? 'main', sha: 'base-sha', repo: { full_name: 'owner/repo' } },
      user: { login: 'author' },
    };
  }

  async getPull(n: number): Promise<PullInfo> {
    if (n !== this.pull.number) {
      throw new Error(`FakeGitHub: unexpected pull number ${n} (expected ${this.pull.number})`);
    }
    if (this.pushHeadSha) {
      const sha = this.pushHeadSha;
      this.pushHeadSha = null;
      return { ...this.pull, head: { ...this.pull.head, sha } };
    }
    return this.pull;
  }

  async getHeadSha(n: number): Promise<string> {
    return (await this.getPull(n)).head.sha;
  }
  async getCommentAuthor(): Promise<string> { return 'github-actions[bot]'; }
  async listReviewComments(): Promise<FakeReviewComment[]> { return this.reviewComments; }

  async listIssueComments(n: number): Promise<IssueCommentInfo[]> {
    if (n !== this.pull.number) {
      throw new Error(`FakeGitHub: unexpected pull number ${n} (expected ${this.pull.number})`);
    }
    return this.issueComments;
  }

  async createIssueComment(_n: number, body: string): Promise<IssueCommentInfo> {
    const c: IssueCommentInfo = {
      id: this.commentId++,
      body,
      user: { login: 'github-actions[bot]' },
      html_url: `https://github.com/owner/repo/issues/1#issuecomment-${this.commentId - 1}`,
    };
    this.issueComments.push(c);
    return c;
  }

  async updateIssueComment(id: number, body: string): Promise<IssueCommentInfo> {
    const c = this.issueComments.find((x) => x.id === id);
    if (!c) throw new Error(`no issue comment ${id}`);
    c.body = body;
    return c;
  }

  async createReviewComment(
    n: number,
    params: ReviewCommentParams,
  ): Promise<{ id: number; html_url: string }> {
    if (this.failReviewCommentOnce) {
      const fail = this.failReviewCommentOnce;
      this.failReviewCommentOnce = null;
      const err = new Error(`rate limited (HTTP ${fail.status})`);
      Object.assign(err, { name: 'GitHubError', status: fail.status });
      throw err;
    }
    const rc: FakeReviewComment = {
      id: this.nextId++,
      prNumber: n,
      commit_id: params.commit_id,
      path: params.path,
      line: params.line,
      side: params.side,
      body: params.body,
      user: { login: 'github-actions[bot]' },
      start_line: params.start_line,
      start_side: params.start_side,
      html_url: `https://github.com/owner/repo/pull/${n}/diff#rc-${this.nextId - 1}`,
    };
    this.reviewComments.push(rc);
    return { id: rc.id, html_url: rc.html_url };
  }

  async collaboratorPermission(user: string): Promise<Permission> {
    return this.permissions.get(user) ?? 'none';
  }
}
