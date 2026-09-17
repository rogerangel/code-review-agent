"use strict";

// src/action/gate-main.ts
var import_node_fs2 = require("fs");

// src/action/gate.ts
var AUTO_ACTIONS = /* @__PURE__ */ new Set(["opened", "reopened", "ready_for_review", "synchronize"]);
var AUTHORIZED = ["write", "maintain", "admin"];
async function decideGate(eventName, event, github) {
  const number = event.pull_request?.number ?? event.issue?.number ?? null;
  const deny = (reason, operationalError = false) => ({ approved: false, prNumber: number, reason, operationalError });
  try {
    let author;
    if (eventName === "pull_request") {
      if (!event.pull_request) return deny("gate-error: pull_request payload missing", true);
      if (!AUTO_ACTIONS.has(event.action ?? "")) return deny("event-not-eligible: action");
      if (event.pull_request.draft) return deny("draft-pull-request");
      if (event.pull_request.merged) return deny("pull-request-merged");
      author = event.action;
    } else if (eventName === "issue_comment") {
      if (event.action !== "created") return deny("event-not-eligible: only newly created comments");
      if ((event.comment?.body ?? "").trim() !== "/review") return deny("event-not-eligible: not an exact /review command");
      if (!event.issue?.pull_request) return deny("event-not-eligible: issue is not a pull request");
      author = event.comment?.user?.login;
      if (!author) return deny("gate-error: comment author unknown", true);
      const permission = await github.collaboratorPermission(author);
      if (!AUTHORIZED.includes(permission)) return { ...deny("unauthorized: " + author + ' has permission "' + permission + '"'), author };
    } else return deny("event-not-eligible: event");
    if (!number || !Number.isSafeInteger(number)) return deny("gate-error: PR number missing/invalid", true);
    const pull = await github.getPull(number);
    if (pull.draft) return deny("draft-pull-request");
    if (pull.state !== "open") return deny(pull.merged_at ? "pull-request-merged" : "pull-request-closed");
    if (!pull.head.repo || !pull.base.repo?.full_name || !pull.head.repo.full_name || !pull.head.sha || !pull.base.sha) return deny("gate-error: incomplete PR repository metadata", true);
    if (eventName === "pull_request" && pull.head.repo.full_name.toLowerCase() !== pull.base.repo.full_name.toLowerCase()) return deny("fork-pull-request-automatic-skip");
    return { approved: true, prNumber: number, reason: eventName === "pull_request" ? "automatic" : "review-command", author, pull };
  } catch (err) {
    return deny("gate-error: " + err.message, true);
  }
}

// src/core/security/limits.ts
var LIMITS = {
  /** Maximum number of review batches (planning cap). */
  maxBatches: 6,
  /** Hard cap on inline comments per run, regardless of config. */
  maxInlineCommentsHard: 12,
  /** Default inline comments per run. */
  maxInlineCommentsDefault: 6,
  /** Hard cap on run duration in minutes. */
  maxDurationMinutesHard: 120,
  /** Default run duration budget in minutes. */
  maxDurationMinutesDefault: 20,
  /** Maximum bytes read from a single file. */
  maxFileBytes: 2 * 1024 * 1024,
  /** Maximum lines read from a single file. */
  maxFileLines: 5e3,
  /** Maximum diff characters returned per file. */
  maxDiffCharsPerFile: 2e5,
  /** Maximum search results returned per call. */
  maxSearchResults: 200,
  /** Maximum instruction bytes per file. */
  maxInstructionBytesPerFile: 2e4,
  /** Maximum total instruction bytes. */
  maxInstructionBytesTotal: 1e5,
  /** Maximum agent tool steps per batch before the batch is cut off. */
  maxBatchSteps: 50,
  /** Maximum consecutive malformed tool calls before a batch fails. */
  maxMalformedToolCalls: 3,
  /** Maximum git history deepen steps before unshallow. */
  maxDeepenSteps: 25,
  /** LLM call timeout in milliseconds. */
  llmCallTimeoutMs: 10 * 60 * 1e3,
  /** GitHub API retry budget. */
  githubMaxRetries: 4,
  /** Minimum characters for a review block (avoid trivial anchors). */
  minBlockChars: 3,
  /** Maximum characters for a review block. */
  maxBlockChars: 4e3
};
function clampResource(value, defaultValue, hardMax) {
  const v = Number.isFinite(value) ? Math.trunc(value) : defaultValue;
  return Math.min(hardMax, Math.max(1, v));
}

// src/core/util.ts
var import_node_crypto = require("crypto");
function sleep(ms, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      cleanup();
      reject(new Error("aborted"));
    };
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// src/core/github/client.ts
var GitHubError = class extends Error {
  constructor(message, status, retryable = false, retryAfterMs = 0) {
    super(message);
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.name = "GitHubError";
  }
  status;
  retryable;
  retryAfterMs;
};
var GitHubClient = class {
  constructor(opts) {
    this.opts = opts;
    this.base = (opts.baseUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }
  opts;
  base;
  fetchImpl;
  signal;
  author;
  setSignal(signal) {
    this.signal = signal;
  }
  get repoPath() {
    return "/repos/" + this.opts.owner + "/" + this.opts.repo;
  }
  async api(method, path, body) {
    const maxAttempts = method === "GET" ? LIMITS.githubMaxRetries : 1;
    for (let attempt = 1; ; attempt++) {
      const signals = [AbortSignal.timeout(6e4)];
      if (this.signal) signals.push(this.signal);
      if (this.opts.budget) signals.push(this.opts.budget.signal(true));
      const signal = AbortSignal.any(signals);
      signal.throwIfAborted();
      try {
        const response = await this.fetchImpl(this.base + path, {
          method,
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            Authorization: "Bearer " + this.opts.token,
            ...body === void 0 ? {} : { "Content-Type": "application/json" }
          },
          body: body === void 0 ? void 0 : JSON.stringify(body),
          signal
        });
        if (!response.ok) {
          const rateLimited = response.status === 429 || response.status === 403 && (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after"));
          const retryAfter = Number(response.headers.get("retry-after"));
          const reset = Number(response.headers.get("x-ratelimit-reset"));
          const wait = response.headers.has("retry-after") && Number.isFinite(retryAfter) ? retryAfter * 1e3 : reset > 0 ? Math.max(0, reset * 1e3 - Date.now()) : rateLimited ? 6e4 : 250 * 2 ** (attempt - 1);
          await response.body?.cancel();
          throw new GitHubError(
            rateLimited ? "GitHub rate limit exhausted" : "GitHub API HTTP " + response.status + " for " + method + " " + path,
            response.status,
            rateLimited || response.status >= 500,
            Math.min(Math.max(0, wait), 3e5)
          );
        }
        if (response.status === 204) return void 0;
        const text = await response.text();
        if (!text) throw new GitHubError("GitHub API returned an empty response", void 0, true);
        try {
          return JSON.parse(text);
        } catch {
          throw new GitHubError("GitHub API returned non-JSON for " + method + " " + path, void 0, true);
        }
      } catch (err) {
        if (signal.aborted) throw signal.reason;
        const error = err instanceof GitHubError ? err : new GitHubError("GitHub API transport failed", void 0, true, 250 * 2 ** (attempt - 1));
        if (!error.retryable || attempt >= maxAttempts) throw error;
        await sleep(error.retryAfterMs, signal);
      }
    }
  }
  async getPull(n) {
    return this.api("GET", this.repoPath + "/pulls/" + n);
  }
  async getHeadSha(n) {
    return (await this.getPull(n)).head.sha;
  }
  async getCommentAuthor() {
    if (this.author) return this.author;
    try {
      const user = await this.api("GET", "/user");
      if (!user.login) throw new GitHubError("authenticated user response has no login");
      this.author = user.login;
    } catch (err) {
      if (!(err instanceof GitHubError) || err.status !== 403 || !this.opts.commentAuthor) throw err;
      this.author = this.opts.commentAuthor;
    }
    return this.author;
  }
  async paginate(path) {
    const out = [];
    for (let page = 1; page <= 100; page++) {
      const items = await this.api("GET", path + "?per_page=100&page=" + page);
      if (!Array.isArray(items)) throw new GitHubError("invalid GitHub pagination response");
      out.push(...items);
      if (items.length < 100) return out;
    }
    throw new GitHubError("GitHub comment pagination limit reached");
  }
  async listIssueComments(n) {
    return this.paginate(this.repoPath + "/issues/" + n + "/comments");
  }
  async listReviewComments(n) {
    return this.paginate(this.repoPath + "/pulls/" + n + "/comments");
  }
  async createIssueComment(n, body) {
    return this.requireReceipt(await this.api("POST", this.repoPath + "/issues/" + n + "/comments", { body }));
  }
  async updateIssueComment(id, body) {
    return this.requireReceipt(await this.api("PATCH", this.repoPath + "/issues/comments/" + id, { body }));
  }
  async createReviewComment(n, params) {
    return this.requireReceipt(await this.api("POST", this.repoPath + "/pulls/" + n + "/comments", params));
  }
  requireReceipt(comment) {
    if (!comment || !Number.isSafeInteger(comment.id) || comment.id <= 0 || typeof comment.html_url !== "string" || !comment.html_url) {
      throw new GitHubError("GitHub mutation returned an invalid comment receipt", void 0, true, 0);
    }
    return comment;
  }
  async collaboratorPermission(user) {
    try {
      const result = await this.api("GET", this.repoPath + "/collaborators/" + encodeURIComponent(user) + "/permission");
      const permission = result.permission.toLowerCase();
      return ["admin", "maintain", "write", "read"].includes(permission) ? permission : "none";
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) return "none";
      throw err;
    }
  }
};

// src/core/review/budget.ts
var BudgetExceededError = class extends Error {
  constructor() {
    super("time budget exhausted");
    this.name = "BudgetExceededError";
  }
};
var BudgetTracker = class {
  deadline;
  startedAt;
  finalizationReserveMs;
  constructor(startedAt, maxDurationMinutes) {
    this.startedAt = startedAt;
    this.deadline = startedAt + maxDurationMinutes * 6e4;
    this.finalizationReserveMs = Math.min(6e4, this.totalMs * 0.1);
  }
  /** Remaining milliseconds, floored at 0. */
  remaining(now = Date.now()) {
    return Math.max(0, this.deadline - now);
  }
  exceeded(now = Date.now()) {
    return now >= this.deadline;
  }
  workRemaining(now = Date.now()) {
    return Math.max(0, this.remaining(now) - this.finalizationReserveMs);
  }
  workExceeded(now = Date.now()) {
    return this.workRemaining(now) === 0;
  }
  signal(finalization = false, parent) {
    const remaining = finalization ? this.remaining() : this.workRemaining();
    if (remaining <= 0) throw new BudgetExceededError();
    const deadline = AbortSignal.timeout(Math.max(1, Math.ceil(remaining)));
    return parent ? AbortSignal.any([deadline, parent]) : deadline;
  }
  /** Bounds adapters that do not themselves honor AbortSignal, too. */
  async run(fn, finalization = false, parent) {
    const signal = this.signal(finalization, parent);
    signal.throwIfAborted();
    let onAbort = () => void 0;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(parent?.aborted ? parent.reason : new BudgetExceededError());
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const result = await Promise.race([fn(signal), aborted]);
      if (finalization ? this.exceeded() : this.workExceeded()) throw new BudgetExceededError();
      signal.throwIfAborted();
      return result;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
  elapsed(now = Date.now()) {
    return now - this.startedAt;
  }
  get totalMs() {
    return this.deadline - this.startedAt;
  }
};

// src/action/io.ts
var import_node_fs = require("fs");
function readInput(name) {
  const key = `INPUT_${name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
  const v = process.env[key];
  return v === void 0 ? "" : v.trim();
}
function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  if (!value || !value.includes("\n")) {
    (0, import_node_fs.appendFileSync)(file, `${name}=${value}
`);
    return;
  }
  const delimiter = `ghadelimiter_${Math.random().toString(36).slice(2)}`;
  (0, import_node_fs.appendFileSync)(file, `${name}<<${delimiter}
${value}
${delimiter}
`);
}

// src/action/gate-main.ts
async function main() {
  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? "").split("/");
  const token = readInput("github_token") || process.env.GITHUB_TOKEN || "";
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!owner || !repo || !token || !eventPath) throw new Error("missing GitHub event/repository/token");
  const github = new GitHubClient({ token, owner, repo, budget: new BudgetTracker(Date.now(), 2) });
  return decideGate(process.env.GITHUB_EVENT_NAME ?? "", JSON.parse((0, import_node_fs2.readFileSync)(eventPath, "utf8")), github);
}
main().catch((error) => ({ approved: false, prNumber: null, reason: "gate-error: " + error.message, operationalError: true })).then((decision) => {
  setOutput("approved", String(decision.approved));
  setOutput("pr_number", String(decision.prNumber ?? ""));
  setOutput("reason", decision.reason);
  setOutput("status", decision.approved ? "" : decision.operationalError ? "failed" : "skipped");
  setOutput("job_timeout_minutes", String(clampResource(Number(readInput("max_duration_minutes") || 20), 20, LIMITS.maxDurationMinutesHard) + 5));
  setOutput("head_sha", decision.pull?.head.sha ?? "");
  setOutput("base_sha", decision.pull?.base.sha ?? "");
  console.log("gate: " + (decision.approved ? "approved" : decision.operationalError ? "failed" : "skipped") + " \u2014 " + decision.reason);
  process.exitCode = decision.operationalError ? 1 : 0;
}).catch(() => {
  console.error("gate: output emission failed");
  process.exitCode = 1;
});
