/** Minimal credential-isolated GitHub REST transport. Mutation retries belong to sinks. */
import { LIMITS } from '../security/limits.js';
import { sleep } from '../util.js';
import type { BudgetTracker } from '../review/budget.js';

export interface PullInfo {
  number: number;
  state: string;
  draft: boolean;
  title?: string;
  body?: string | null;
  head: { ref: string; sha: string; repo: { full_name: string; fork: boolean; owner: { login: string } } | null };
  base: { ref: string; sha: string; repo: { full_name: string } };
  user?: { login: string };
  merged_at?: string | null;
}
export interface IssueCommentInfo {
  id: number;
  body: string;
  user?: { login?: string };
  created_at?: string;
  html_url?: string;
}
export interface ReviewCommentInfo extends IssueCommentInfo {
  path: string;
  commit_id: string;
  original_commit_id?: string;
  line?: number | null;
}
export interface ReviewCommentParams {
  commit_id: string;
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  start_line?: number;
  start_side?: 'LEFT' | 'RIGHT';
  body: string;
}
export type Permission = 'admin' | 'maintain' | 'write' | 'read' | 'none';

export interface GitHubApi {
  getPull(n: number): Promise<PullInfo>;
  getHeadSha(n: number): Promise<string>;
  getCommentAuthor(): Promise<string>;
  listIssueComments(n: number): Promise<IssueCommentInfo[]>;
  listReviewComments(n: number): Promise<ReviewCommentInfo[]>;
  createIssueComment(n: number, body: string): Promise<IssueCommentInfo>;
  updateIssueComment(id: number, body: string): Promise<IssueCommentInfo>;
  createReviewComment(n: number, params: ReviewCommentParams): Promise<{ id: number; html_url: string }>;
  collaboratorPermission(user: string): Promise<Permission>;
  setSignal?(signal: AbortSignal): void;
}
export interface GitHubClientOptions {
  token: string;
  owner: string;
  repo: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  budget?: BudgetTracker;
  /** Expected bot login for installation tokens, which cannot call GET /user. */
  commentAuthor?: string;
}
export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
    readonly retryAfterMs = 0,
  ) { super(message); this.name = 'GitHubError'; }
}

export class GitHubClient implements GitHubApi {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private signal?: AbortSignal;
  private author?: string;

  constructor(private readonly opts: GitHubClientOptions) {
    this.base = (opts.baseUrl ?? 'https://api.github.com').replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }
  setSignal(signal: AbortSignal): void { this.signal = signal; }
  private get repoPath(): string { return '/repos/' + this.opts.owner + '/' + this.opts.repo; }

  async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const maxAttempts = method === 'GET' ? LIMITS.githubMaxRetries : 1;
    for (let attempt = 1; ; attempt++) {
      const signals = [AbortSignal.timeout(60_000)];
      if (this.signal) signals.push(this.signal);
      if (this.opts.budget) signals.push(this.opts.budget.signal(true));
      const signal = AbortSignal.any(signals);
      signal.throwIfAborted();
      try {
        const response = await this.fetchImpl(this.base + path, {
          method,
          headers: {
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            Authorization: 'Bearer ' + this.opts.token,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal,
        });
        if (!response.ok) {
          const rateLimited = response.status === 429 || (response.status === 403 &&
            (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')));
          const retryAfter = Number(response.headers.get('retry-after'));
          const reset = Number(response.headers.get('x-ratelimit-reset'));
          const wait = response.headers.has('retry-after') && Number.isFinite(retryAfter) ? retryAfter * 1000 :
            reset > 0 ? Math.max(0, reset * 1000 - Date.now()) : rateLimited ? 60_000 : 250 * 2 ** (attempt - 1);
          await response.body?.cancel();
          throw new GitHubError(
            rateLimited ? 'GitHub rate limit exhausted' : 'GitHub API HTTP ' + response.status + ' for ' + method + ' ' + path,
            response.status, rateLimited || response.status >= 500, Math.min(Math.max(0, wait), 300_000),
          );
        }
        if (response.status === 204) return undefined as T;
        const text = await response.text();
        if (!text) throw new GitHubError('GitHub API returned an empty response', undefined, true);
        try { return JSON.parse(text) as T; }
        catch { throw new GitHubError('GitHub API returned non-JSON for ' + method + ' ' + path, undefined, true); }
      } catch (err) {
        if (signal.aborted) throw signal.reason;
        const error = err instanceof GitHubError ? err : new GitHubError('GitHub API transport failed', undefined, true, 250 * 2 ** (attempt - 1));
        if (!error.retryable || attempt >= maxAttempts) throw error;
        await sleep(error.retryAfterMs, signal);
      }
    }
  }

  async getPull(n: number): Promise<PullInfo> { return this.api('GET', this.repoPath + '/pulls/' + n); }
  async getHeadSha(n: number): Promise<string> { return (await this.getPull(n)).head.sha; }

  async getCommentAuthor(): Promise<string> {
    if (this.author) return this.author;
    try {
      const user = await this.api<{ login: string }>('GET', '/user');
      if (!user.login) throw new GitHubError('authenticated user response has no login');
      this.author = user.login;
    } catch (err) {
      if (!(err instanceof GitHubError) || err.status !== 403 || !this.opts.commentAuthor) throw err;
      this.author = this.opts.commentAuthor;
    }
    return this.author;
  }

  private async paginate<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    // Stop with an error rather than silently claiming complete deduplication.
    for (let page = 1; page <= 100; page++) {
      const items = await this.api<T[]>('GET', path + '?per_page=100&page=' + page);
      if (!Array.isArray(items)) throw new GitHubError('invalid GitHub pagination response');
      out.push(...items);
      if (items.length < 100) return out;
    }
    throw new GitHubError('GitHub comment pagination limit reached');
  }
  async listIssueComments(n: number): Promise<IssueCommentInfo[]> {
    return this.paginate(this.repoPath + '/issues/' + n + '/comments');
  }
  async listReviewComments(n: number): Promise<ReviewCommentInfo[]> {
    return this.paginate(this.repoPath + '/pulls/' + n + '/comments');
  }
  async createIssueComment(n: number, body: string): Promise<IssueCommentInfo> {
    return this.requireReceipt(await this.api<IssueCommentInfo>('POST', this.repoPath + '/issues/' + n + '/comments', { body }));
  }
  async updateIssueComment(id: number, body: string): Promise<IssueCommentInfo> {
    return this.requireReceipt(await this.api<IssueCommentInfo>('PATCH', this.repoPath + '/issues/comments/' + id, { body }));
  }
  async createReviewComment(n: number, params: ReviewCommentParams): Promise<{ id: number; html_url: string }> {
    return this.requireReceipt(await this.api<{ id: number; html_url: string }>('POST', this.repoPath + '/pulls/' + n + '/comments', params));
  }
  private requireReceipt<T extends { id: number; html_url?: string }>(comment: T): T {
    if (!comment || !Number.isSafeInteger(comment.id) || comment.id <= 0 || typeof comment.html_url !== 'string' || !comment.html_url) {
      throw new GitHubError('GitHub mutation returned an invalid comment receipt', undefined, true, 0);
    }
    return comment;
  }
  async collaboratorPermission(user: string): Promise<Permission> {
    try {
      const result = await this.api<{ permission: string }>('GET', this.repoPath + '/collaborators/' + encodeURIComponent(user) + '/permission');
      const permission = result.permission.toLowerCase();
      return ['admin', 'maintain', 'write', 'read'].includes(permission) ? permission as Permission : 'none';
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) return 'none';
      throw err;
    }
  }
}
