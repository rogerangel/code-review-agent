/** One wall-clock budget, including preflight and final delivery. */
declare class BudgetExceededError extends Error {
    constructor();
}
declare class BudgetTracker {
    readonly deadline: number;
    readonly startedAt: number;
    readonly finalizationReserveMs: number;
    constructor(startedAt: number, maxDurationMinutes: number);
    /** Remaining milliseconds, floored at 0. */
    remaining(now?: number): number;
    exceeded(now?: number): boolean;
    workRemaining(now?: number): number;
    workExceeded(now?: number): boolean;
    signal(finalization?: boolean, parent?: AbortSignal): AbortSignal;
    /** Bounds adapters that do not themselves honor AbortSignal, too. */
    run<T>(fn: (signal: AbortSignal) => Promise<T>, finalization?: boolean, parent?: AbortSignal): Promise<T>;
    elapsed(now?: number): number;
    get totalMs(): number;
}

type LlmPhase = 'probe' | 'planning' | 'review' | 'suggestion-critic' | 'summary';
type TemplateScalar = string | number | boolean | null;
interface GenerationOptions {
    maxOutputTokens?: number;
    thinkingTokenBudget?: number;
    chatTemplateKwargs?: Record<string, TemplateScalar>;
    temperature?: number;
    topP?: number;
    topK?: number;
    presencePenalty?: number;
}
declare function validateGenerationOptions(options?: GenerationOptions): GenerationOptions;
declare function parseGenerationOptions(raw?: string): GenerationOptions;
/** Called by the host, before both real clients and programmatic adapters. */
declare function applyGenerationPolicy(request: ChatRequest, options?: GenerationOptions): ChatRequest;

/**
 * Model-neutral OpenAI-compatible chat client.
 *
 * Works against vLLM (and any OpenAI-compatible endpoint, including local
 * hosts reached over Tailscale). Handles:
 *  - native tool calling (tool_calls) with defensive argument parsing
 *  - JSON-schema structured output (vLLM guided decoding) as a fallback
 *  - reasoning separation: `reasoning` / `reasoning_content` are never replayed into the
 *    transcript and never mixed into tool arguments
 *
 * The API key is held only in this module and in outgoing headers; it is
 * never interpolated into prompts, logs, or results.
 */
interface ToolSpec {
    name: string;
    description: string;
    /** JSON schema for the tool arguments. */
    parameters: Record<string, unknown>;
}
interface ModelToolCall {
    id: string;
    name: string;
    /** Raw JSON string as returned by the model. */
    arguments: string;
}
interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null;
    tool_calls?: ModelToolCall[];
    tool_call_id?: string;
    name?: string;
}
interface ChatResponse {
    content: string | null;
    toolCalls: ModelToolCall[];
    /** Model reasoning, kept out of the transcript by the caller. */
    reasoning?: string;
    finishReason?: string;
    usage?: {
        promptTokens?: number;
        completionTokens?: number;
        reasoningTokens?: number;
        cachedPromptTokens?: number;
    };
}
interface ChatRequest {
    messages: ChatMessage[];
    tools?: ToolSpec[];
    toolChoice?: 'auto' | 'none' | {
        function: {
            name: string;
        };
    };
    /** When set, response_format json_schema is used and `tools` must be omitted. */
    jsonSchema?: {
        name: string;
        schema: Record<string, unknown>;
    };
    temperature?: number;
    maxTokens?: number;
    /** Host-only metadata, never serialized to the inference API. */
    phase?: LlmPhase;
    thinkingTokenBudget?: number;
    chatTemplateKwargs?: Record<string, TemplateScalar>;
    topP?: number;
    topK?: number;
    presencePenalty?: number;
    signal?: AbortSignal;
}
/**
 * Structural LLM interface used by the pipeline, tools, and planner.
 * OpenAICompatibleClient implements it; tests and (later) adapters can too.
 */
interface LlmClient {
    readonly model: string;
    chat(req: ChatRequest): Promise<ChatResponse>;
}
declare class LLMError extends Error {
    readonly status?: number | undefined;
    constructor(message: string, status?: number | undefined);
}
interface LLMClientOptions {
    baseUrl: string;
    model: string;
    apiKey?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    budget?: BudgetTracker;
}
declare class OpenAICompatibleClient implements LlmClient {
    private readonly opts;
    /** Chat completions endpoint (safe to log; contains no credentials). */
    readonly endpoint: string;
    private readonly modelsUrl;
    private readonly fetchImpl;
    readonly model: string;
    constructor(opts: LLMClientOptions);
    private headers;
    listModels(signal?: AbortSignal): Promise<string[]>;
    chat(req: ChatRequest): Promise<ChatResponse>;
    private requestJson;
}
/**
 * Parse model tool-call arguments defensively. Returns null on malformed JSON.
 */
declare function parseToolArgs(rawArgs: string): Record<string, unknown> | null;
/**
 * Extract a JSON object from a model's free-form content (structured fallback
 * and critic parsing). Tolerates leading prose and trailing punctuation.
 */
declare function extractJsonObject(text: string): Record<string, unknown> | null;
/**
 * Build the JSON schema used in structured-output fallback mode: one step
 * per call, naming the tool to invoke and its arguments.
 */
declare function stepSchema(toolNames: string[]): Record<string, unknown>;

/**
 * Review sinks: where inline comments and the sticky summary go.
 *
 * GitHubSink posts immediately through the GitHub review-comment API.
 * LocalSink records findings in the local result (same normalized schema),
 * so local CLI mode and GitHub mode produce identical ReviewResult shapes.
 */

interface ReviewSink {
    kind: 'github' | 'local';
    /** Findings accepted and posted by this sink, in post order. */
    readonly posted: Finding[];
    setSignal?(signal: AbortSignal): void;
    existingComments?(): Promise<{
        fingerprint: string;
        file: string;
        body: string;
        url?: string;
    }[]>;
    findExistingInline?(fingerprint: string): Promise<{
        url?: string;
    } | undefined>;
    /**
     * Recheck the current head before any side effect. Sinks track the
     * expected head they were built with; `expectedHead` may override it.
     */
    recheckHead(expectedHead?: string): Promise<HeadCheck>;
    /**
     * Post one inline comment. Must be called immediately when a finding is
     * accepted. Returns the posted URL (GitHub mode) or empty (local mode).
     */
    postInlineComment(f: Finding, body: string): Promise<{
        url?: string;
        reused?: boolean;
    }>;
    /**
     * Create or update the single marker-owned sticky summary comment.
     * The marker identifies ownership; any existing marker comment is updated.
     */
    upsertSummaryComment(params: {
        marker: string;
        body: string;
    }): Promise<{
        url?: string;
    }>;
    /** Called once when the run finishes. */
    finalize(result: ReviewResult): Promise<void>;
}
declare class LocalSink implements ReviewSink {
    kind: "local";
    readonly posted: Finding[];
    recheckHead(expectedHead?: string): Promise<HeadCheck>;
    postInlineComment(f: Finding): Promise<{
        url?: string;
    }>;
    upsertSummaryComment(): Promise<{
        url?: string;
    }>;
    finalize(): Promise<void>;
}

interface GitResult {
    code: number;
    stdout: string;
    stderr: string;
}
declare class GitError extends Error {
    readonly detail?: string | undefined;
    constructor(message: string, detail?: string | undefined);
}
declare class TargetError extends Error {
    constructor(message: string);
}
interface GitExecutionOptions {
    budget?: BudgetTracker;
    signal?: AbortSignal;
    /** Trusted host-only ephemeral fetch credentials; never written to config. */
    env?: NodeJS.ProcessEnv;
}
declare function git(repoDir: string, args: string[], opts?: GitExecutionOptions): Promise<GitResult>;
/** Resolve a rev-ish to a full commit sha, progressively deepening history. */
declare function resolveCommit(repoDir: string, rev: string, opts?: GitExecutionOptions): Promise<string>;
/** Ensure a remote branch ref is present locally, fetching if needed. */
declare function ensureRemoteBranch(repoDir: string, branch: string, opts?: GitExecutionOptions): Promise<string>;
/** Detect the repository default branch. */
declare function detectDefaultBranch(repoDir: string, opts?: GitExecutionOptions): Promise<string>;
interface GitTarget {
    kind: 'range' | 'three-dot' | 'staged' | 'unstaged' | 'last-commit' | 'branch-vs-main';
    /** Human label for results and prompts. */
    label: string;
    /** Git rev-ish for the base side (undefined for staged/unstaged). */
    baseRev?: string;
    /** Git rev-ish for the head side (undefined for staged/unstaged). */
    headRev?: string;
    /** Which RepoView the review tools should read from. */
    viewKind: 'ref' | 'index' | 'worktree';
    /** Resolved head ref for ref views. */
    viewRef?: string;
}
interface TargetArgs {
    /** Positional target: "A..B", "A...B", or a single ref. */
    target?: string;
    staged?: boolean;
    unstaged?: boolean;
    lastCommit?: boolean;
}
/**
 * Resolve a CLI/CI target into a concrete GitTarget.
 * - "A..B"  : base A, head B
 * - "A...B" : base merge-base(A,B), head B
 * - --staged / --unstaged / --last-commit
 * - single ref: branch-vs-main (merge-base(default, ref) .. ref)
 * - no args: current branch vs default branch
 */
declare function resolveTarget(repoDir: string, args: TargetArgs, opts?: GitExecutionOptions): Promise<GitTarget>;
interface BuildDiffOptions extends GitExecutionOptions {
    /**
     * Ensure a remote branch ref is present and return the rev-ish to use.
     * Defaults to fetching origin/<branch> into refs/remotes/origin/<branch>.
     */
    ensureBranch?: (repoDir: string, branch: string) => Promise<string>;
}
/**
 * Build the normalized DiffMap for a target. Resolves both sides to concrete
 * SHAs, deepening history as needed, and never executes repository content.
 */
declare function buildDiff(repoDir: string, target: GitTarget, opts?: BuildDiffOptions): Promise<DiffMap>;

interface ReadResult {
    content: string;
    totalLines: number;
    /** True when the file exceeded caps and was truncated. */
    truncated: boolean;
}
interface SearchHit {
    path: string;
    line: number;
    text: string;
}
interface SearchOptions {
    /** Restrict search to a directory (normalized, '' = root). */
    dir?: string;
    /** Treat pattern as regular expression instead of literal text. */
    regex?: boolean;
    caseSensitive?: boolean;
}
declare class ViewError extends Error {
    readonly reason: 'not-found' | 'symlink' | 'too-large' | 'invalid-path' | 'io';
    constructor(message: string, reason: 'not-found' | 'symlink' | 'too-large' | 'invalid-path' | 'io');
}
interface RepoView {
    kind: 'ref' | 'index' | 'worktree';
    label: string;
    exists(p: string): Promise<boolean>;
    isSymlink(p: string): Promise<boolean>;
    read(p: string, opts?: {
        startLine?: number;
        endLine?: number;
    }): Promise<ReadResult>;
    listDirectory(dir: string): Promise<{
        files: string[];
        dirs: string[];
    }>;
    search(pattern: string, opts?: SearchOptions): Promise<{
        results: SearchHit[];
        truncated: boolean;
    }>;
}
declare class GitRefView implements RepoView {
    private readonly repoDir;
    private readonly ref;
    private readonly execution;
    kind: "ref";
    readonly label: string;
    constructor(repoDir: string, ref: string, label?: string, execution?: GitExecutionOptions);
    private target;
    exists(p: string): Promise<boolean>;
    isSymlink(p: string): Promise<boolean>;
    read(p: string, opts?: {
        startLine?: number;
        endLine?: number;
    }): Promise<ReadResult>;
    listDirectory(dir: string): Promise<{
        files: string[];
        dirs: string[];
    }>;
    search(pattern: string, opts?: SearchOptions): Promise<{
        results: SearchHit[];
        truncated: boolean;
    }>;
}
declare class WorkTreeView implements RepoView {
    private readonly root;
    private readonly execution;
    kind: "worktree";
    readonly label: string;
    private discovery?;
    constructor(root: string, label?: string, execution?: GitExecutionOptions);
    private discoveryFiles;
    private checkBudget;
    private abs;
    private safeAbs;
    exists(p: string): Promise<boolean>;
    isSymlink(p: string): Promise<boolean>;
    read(p: string, opts?: {
        startLine?: number;
        endLine?: number;
    }): Promise<ReadResult>;
    listDirectory(dir: string): Promise<{
        files: string[];
        dirs: string[];
    }>;
    search(pattern: string, opts?: SearchOptions): Promise<{
        results: SearchHit[];
        truncated: boolean;
    }>;
}
declare class IndexView implements RepoView {
    private readonly repoDir;
    private readonly execution;
    kind: "index";
    readonly label = "git index (staged)";
    constructor(repoDir: string, execution?: GitExecutionOptions);
    exists(p: string): Promise<boolean>;
    isSymlink(p: string): Promise<boolean>;
    read(p: string, opts?: {
        startLine?: number;
        endLine?: number;
    }): Promise<ReadResult>;
    listDirectory(dir: string): Promise<{
        files: string[];
        dirs: string[];
    }>;
    search(pattern: string, opts?: SearchOptions): Promise<{
        results: SearchHit[];
        truncated: boolean;
    }>;
}
declare function makeView(kind: 'ref' | 'index' | 'worktree', repoDir: string, ref?: string, execution?: GitExecutionOptions): RepoView;

/**
 * Shared domain types for code-review-agent.
 *
 * These types define the normalized result schema produced by both local (CLI)
 * and GitHub (Action) modes. Both modes MUST produce the same shape.
 */
type Severity = 'low' | 'medium' | 'high' | 'critical';
declare const SEVERITIES: readonly Severity[];
declare const SEVERITY_RANK: Record<Severity, number>;
type ReviewStatus = 'clean' | 'findings' | 'partial' | 'skipped' | 'failed';
/**
 * tool_mode:
 *  - auto: probe the model for reliable tool calling; fall back to structured output
 *  - tools: require native tool calling
 *  - structured: force JSON-schema structured output (no native tools)
 */
type ToolMode = 'auto' | 'tools' | 'structured';
type FailOnSeverity = 'none' | 'medium' | 'high' | 'critical';
type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';
interface ChangedFile {
    /** Normalized repo-relative path (forward slashes), at the head side. */
    path: string;
    status: FileStatus;
    /** Previous path for renames. */
    previousPath?: string;
    additions: number;
    deletions: number;
    isBinary: boolean;
    /** Total lines in the head version (0 for deleted files). */
    lines: number;
}
interface DiffLine {
    kind: 'add' | 'delete' | 'context';
    /** Line content without the leading +/-/space marker. */
    content: string;
    /** 1-based line number in the new file, or null for deleted lines. */
    newLine: number | null;
    /** 1-based line number in the old file, or null for added lines. */
    oldLine: number | null;
}
interface DiffHunk {
    header: string;
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    lines: DiffLine[];
}
interface DiffMap {
    baseSha: string;
    headSha: string;
    /** Ordered map of repo-relative path -> changed file metadata. */
    files: Map<string, ChangedFile>;
    /** Ordered map of repo-relative path -> hunks (new-file side). */
    hunks: Map<string, DiffHunk[]>;
    /** Set of new-file line numbers (1-based) that are additions, per path. */
    addedLines: Map<string, Set<number>>;
}
interface Finding {
    /** Short stable id shown in summaries. */
    id: string;
    /** Stable fingerprint (sha256), carried in a hidden HTML comment marker. */
    fingerprint: string;
    severity: Severity;
    /** Normalized repo-relative path. */
    file: string;
    /** 1-based inclusive line range on the new (head) side. */
    startLine: number;
    endLine: number;
    /** Exact source block the finding anchors to. */
    block: string;
    message: string;
    /** Replacement code, only present when the suggestion critic confirmed it. */
    suggestion?: string;
    /** True when a suggestion was offered but the critic rejected/uncertain. */
    suggestionRejected?: boolean;
    /** URL of the posted inline comment (GitHub mode) when posted. */
    url?: string;
    /** Index of the batch that produced this finding. */
    batchIndex: number;
    delivery: 'posted' | 'reused' | 'local' | 'summary_only' | 'failed';
}
interface OperationalError {
    stage: string;
    code: string;
    message: string;
    findingId?: string;
}
type FileCoverageStatus = 'reviewed' | 'skipped';
interface FileCoverage {
    file: string;
    status: FileCoverageStatus;
    /** Skip reason for excluded/skipped files. */
    reason?: string;
    /** Batch index assigned to this file, when reviewed. */
    batch?: number;
}
interface Coverage {
    totalChanged: number;
    eligible: number;
    reviewed: number;
    skipped: number;
    excluded: number;
    /** Complete list of changed files with their disposition. */
    files: FileCoverage[];
}
interface CallCounts {
    llmCalls: number;
    toolCalls: number;
    inlineCommentsPosted: number;
    inlineCommentsRejected: number;
    inlineCommentsReused: number;
    agentResponses: number;
    validAgentResponses: number;
}
interface ReviewResult {
    schema: 'code-review-agent.result/v1';
    status: ReviewStatus;
    /** Machine-readable reason, when status is skipped/partial/failed. */
    statusReason?: string;
    target: string;
    baseSha: string;
    headSha: string;
    model: string;
    findings: Finding[];
    coverage: Coverage;
    summary: string;
    operationalErrors: OperationalError[];
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    callCounts: CallCounts;
    /** URL of the sticky summary comment (GitHub mode). */
    summaryCommentUrl?: string;
    /** Numeric diagnostics only; never prompts, reasoning text or configuration values. */
    performance?: PerformanceDiagnostics;
}
interface LlmCallMetric {
    index: number;
    phase: LlmPhase;
    batchIndex?: number;
    durationMs: number;
    maxOutputTokens: number;
    thinkingTokenBudget?: number;
    promptTokens?: number;
    completionTokens?: number;
    reasoningTokens?: number;
    cachedPromptTokens?: number;
    reasoningChars?: number;
    finishReason?: string;
    outcome: 'completed' | 'truncated' | 'error' | 'aborted';
}
interface PerformanceDiagnostics {
    llmCalls: LlmCallMetric[];
    transcriptCompactions: number;
    toolResultChars: number;
}
type ReviewProgressEvent = {
    type: 'call-start';
    index: number;
    phase: LlmCallMetric['phase'];
    batchIndex?: number;
    elapsedMs: number;
} | {
    type: 'call-end';
    metric: LlmCallMetric;
    elapsedMs: number;
} | {
    type: 'file-completed';
    file: string;
    batchIndex: number;
    elapsedMs: number;
} | {
    type: 'transcript-compacted';
    count: number;
    elapsedMs: number;
};
interface RepoConfig {
    /** Review focus areas (freeform strings fed into the prompt). */
    focus: string[];
    /** Include globs; an explicit include opts files back in past default exclusions. */
    include: string[];
    /** Exclude globs; always beat includes. */
    exclude: string[];
    /** Instruction files (repo-relative) appended to the reviewer prompt. */
    instructions: string[];
    /** Minimum severity eligible for inline posting. Default medium. */
    minSeverity: Severity;
    /** Whether suggestions may be proposed (and critic-verified). Default true. */
    suggestions: boolean;
}
interface ResolvedOptions {
    configPath: string;
    toolMode: ToolMode;
    maxDurationMinutes: number;
    maxInlineComments: number;
    failOnSeverity: FailOnSeverity;
    config: RepoConfig;
}
interface ToolCall {
    name: string;
    args: unknown;
    /** Raw JSON string as returned by the model (kept for diagnostics). */
    rawArgs: string;
}
interface ToolResult {
    ok: boolean;
    /** Result payload, serialized into the model transcript. */
    result: unknown;
    /** Human/model-readable error when ok=false. */
    error?: string;
    protocolError?: boolean;
}
/** Context handed to every tool execution. */
interface ToolContext {
    reviewId: string;
    diff: DiffMap;
    view: RepoView;
    options: ResolvedOptions;
    config: RepoConfig;
    instructions: InstructionBlock[];
    budget: BudgetTracker;
    counters: CallCounts;
    sink: ReviewSink;
    llm: LlmClient;
    /** Post-inline-comment guard state (caps, fingerprints, head checks). */
    postState: PostState;
    /** Abort signal for the whole review. */
    signal: AbortSignal;
    /** Aborts the whole review (e.g. when the head moves mid-run). */
    abortReview: () => void;
    findings: Finding[];
    operationalErrors: OperationalError[];
    diffReads: Set<string>;
    diffReadPages?: Map<string, Set<number>>;
    /** Explicit per-file checkpoints survive an interrupted batch. */
    fileCompletions?: Map<string, {
        summary: string;
        batchIndex: number;
    }>;
    performance?: PerformanceDiagnostics;
    onProgress?: (event: ReviewProgressEvent) => void;
    generation?: GenerationOptions;
    batchFiles: string[];
    batchCompletion?: {
        reviewedFiles: string[];
        skippedFiles: {
            file: string;
            reason: string;
        }[];
    };
}
interface PostState {
    posted: number;
    postedFingerprints: Set<string>;
    /** Index of the batch currently running (stamped on findings). */
    batchIndex: number;
}
interface InstructionBlock {
    /** Source label, e.g. "AGENTS.md (repo root)" or ".code-review-agent/review.md". */
    source: string;
    content: string;
}
/** Head recheck outcome before any side effect. */
interface HeadCheck {
    ok: boolean;
    currentHead: string;
    /** True when the head differs from the pinned SHA or the PR is closed/draft. */
    stale: boolean;
    error?: string;
}
declare const REVIEW_MARKER_PREFIX = "<!-- code-review-agent:v1:run=";
declare const REVIEW_MARKER_SUFFIX = " -->";

interface PipelineInputs {
    repoDir: string;
    target: GitTarget;
    options: ResolvedOptions;
    llm: LlmClient;
    sink: ReviewSink;
    mode: 'tools' | 'structured';
    reviewId?: string;
    runUrl?: string;
    ensureBranch?: (repoDir: string, branch: string) => Promise<string>;
    budget?: BudgetTracker;
    gitOptions?: GitExecutionOptions;
    prContext?: {
        title: string;
        description: string;
    };
    generation?: GenerationOptions;
    onProgress?: (event: ReviewProgressEvent) => void;
    /** Runs inside the same deadline/result handling, using the counted, bounded client. */
    prepare?: (llm: LlmClient) => Promise<{
        mode?: 'tools' | 'structured';
        target?: GitTarget;
    }>;
}
declare function emptyCallCounts(): CallCounts;
declare function runReview(inputs: PipelineInputs): Promise<ReviewResult>;

interface PullInfo {
    number: number;
    state: string;
    draft: boolean;
    title?: string;
    body?: string | null;
    head: {
        ref: string;
        sha: string;
        repo: {
            full_name: string;
            fork: boolean;
            owner: {
                login: string;
            };
        } | null;
    };
    base: {
        ref: string;
        sha: string;
        repo: {
            full_name: string;
        };
    };
    user?: {
        login: string;
    };
    merged_at?: string | null;
}
interface IssueCommentInfo {
    id: number;
    body: string;
    user?: {
        login?: string;
    };
    created_at?: string;
    html_url?: string;
}
interface ReviewCommentInfo extends IssueCommentInfo {
    path: string;
    commit_id: string;
    original_commit_id?: string;
    line?: number | null;
}
interface ReviewCommentParams {
    commit_id: string;
    path: string;
    line: number;
    side: 'LEFT' | 'RIGHT';
    start_line?: number;
    start_side?: 'LEFT' | 'RIGHT';
    body: string;
}
type Permission = 'admin' | 'maintain' | 'write' | 'read' | 'none';
interface GitHubApi {
    getPull(n: number): Promise<PullInfo>;
    getHeadSha(n: number): Promise<string>;
    getCommentAuthor(): Promise<string>;
    listIssueComments(n: number): Promise<IssueCommentInfo[]>;
    listReviewComments(n: number): Promise<ReviewCommentInfo[]>;
    createIssueComment(n: number, body: string): Promise<IssueCommentInfo>;
    updateIssueComment(id: number, body: string): Promise<IssueCommentInfo>;
    createReviewComment(n: number, params: ReviewCommentParams): Promise<{
        id: number;
        html_url: string;
    }>;
    collaboratorPermission(user: string): Promise<Permission>;
    setSignal?(signal: AbortSignal): void;
}
interface GitHubClientOptions {
    token: string;
    owner: string;
    repo: string;
    fetchImpl?: typeof fetch;
    baseUrl?: string;
    budget?: BudgetTracker;
    /** Expected bot login for installation tokens, which cannot call GET /user. */
    commentAuthor?: string;
}
declare class GitHubError extends Error {
    readonly status?: number | undefined;
    readonly retryable: boolean;
    readonly retryAfterMs: number;
    constructor(message: string, status?: number | undefined, retryable?: boolean, retryAfterMs?: number);
}
declare class GitHubClient implements GitHubApi {
    private readonly opts;
    private readonly base;
    private readonly fetchImpl;
    private signal?;
    private author?;
    constructor(opts: GitHubClientOptions);
    setSignal(signal: AbortSignal): void;
    private get repoPath();
    api<T>(method: string, path: string, body?: unknown): Promise<T>;
    getPull(n: number): Promise<PullInfo>;
    getHeadSha(n: number): Promise<string>;
    getCommentAuthor(): Promise<string>;
    private paginate;
    listIssueComments(n: number): Promise<IssueCommentInfo[]>;
    listReviewComments(n: number): Promise<ReviewCommentInfo[]>;
    createIssueComment(n: number, body: string): Promise<IssueCommentInfo>;
    updateIssueComment(id: number, body: string): Promise<IssueCommentInfo>;
    createReviewComment(n: number, params: ReviewCommentParams): Promise<{
        id: number;
        html_url: string;
    }>;
    private requireReceipt;
    collaboratorPermission(user: string): Promise<Permission>;
}

/** Immediate agent-directed publishing with host-enforced anchoring and retries. */

declare class SupersededReviewError extends Error {
    constructor();
}
interface GitHubSinkOptions {
    github: GitHubApi;
    prNumber: number;
    expectedHead: string;
    budget?: BudgetTracker;
}
declare function inlineMarker(head: string, fingerprint: string): string;
declare class GitHubSink implements ReviewSink {
    private readonly opts;
    kind: "github";
    readonly posted: Finding[];
    private existing;
    private author?;
    private signal?;
    constructor(opts: GitHubSinkOptions);
    setSignal(signal: AbortSignal): void;
    recheckHead(): Promise<HeadCheck>;
    private assertCurrent;
    private owned;
    private loadExisting;
    existingComments(): Promise<{
        fingerprint: string;
        file: string;
        body: string;
        url?: string;
    }[]>;
    findExistingInline(fingerprint: string): Promise<{
        url?: string;
    } | undefined>;
    private mutate;
    postInlineComment(f: Finding, body: string): Promise<{
        url?: string;
        reused?: boolean;
    }>;
    private findSummary;
    upsertSummaryComment(params: {
        marker: string;
        body: string;
    }): Promise<{
        url?: string;
    }>;
    finalize(): Promise<void>;
}
declare function buildSummaryBody(params: {
    result: ReviewResult;
    reviewId: string;
    runUrl?: string;
    postedCommentUrls: string[];
}): string;

/**
 * Model probing: verifies endpoint reachability, model discovery,
 * structured output, reasoning separation, and tool-call behavior.
 * Used by the `doctor` CLI command and by `auto` tool-mode selection.
 */

interface ProbeResult {
    /** Endpoint reachable and models list served. */
    reachable: boolean;
    /** The requested model id appears in the model list (or chat worked). */
    discovered: boolean;
    /** Native tool calling produced a valid tool call. */
    supportsTools: boolean;
    /** JSON-schema structured output produced a valid object. */
    structuredOk: boolean;
    /**
     * Reasoning separation: when the model emits a normalized reasoning field, the
     * visible content is not contaminated with tool-call JSON.
     */
    reasoningSeparated: boolean | null;
    details: string[];
    fatalError?: string;
}
declare function probeModel(client: Pick<OpenAICompatibleClient, 'model' | 'chat' | 'listModels'>, generation?: GenerationOptions): Promise<ProbeResult>;
/** Decide the tool mode to use for a review given a probe. */
declare function decideToolMode(probe: ProbeResult, requested: 'auto' | 'tools' | 'structured'): {
    mode: 'tools' | 'structured';
    reason: string;
};

/**
 * Pure parser for git unified diff output (no git required).
 * Handles renames, additions, deletions, binaries, quoted paths,
 * and multi-hunk files. This is the deterministic core of the diff map.
 */

interface ParsedSection {
    oldPath: string;
    newPath: string;
    status: FileStatus;
    previousPath?: string;
    isBinary: boolean;
    hunks: DiffHunk[];
}
/**
 * Parse full `git diff -M --no-color` output into per-file sections.
 */
declare function parseUnifiedDiff(text: string): ParsedSection[];
/**
 * Parse `git diff -M --numstat` output. Binary rows use `-` counts.
 * Renames appear as `old => new` or `prefix{old => new}suffix`.
 */
declare function parseNumstat(text: string): Map<string, {
    additions: number;
    deletions: number;
    isBinary: boolean;
    from?: string;
}>;
/** Assemble a full DiffMap from raw diff text + numstat. */
declare function buildDiffMap(baseSha: string, headSha: string, diffText: string, numstatText: string, nameStatusText?: string): DiffMap;
/**
 * Render the diff text for a single file (used by the read_diff tool).
 */
declare function renderFileDiff(diff: DiffMap, path: string): string | null;

declare class ConfigError extends Error {
    constructor(message: string);
}
declare const DEFAULT_CONFIG: RepoConfig;
/** Parse and validate a raw config document. Throws ConfigError on violations. */
declare function parseConfigDoc(doc: unknown): RepoConfig;
/** Effective minimum severity: max(config value, medium hard floor). */
declare function effectiveMinSeverity(config: RepoConfig): Severity;
/**
 * Load configuration from the repository view (pinned to the reviewed head).
 * Returns the default config when the file does not exist.
 */
declare function loadConfig(view: RepoView, configPath: string): Promise<RepoConfig>;

/**
 * Collect instruction blocks for a review:
 *  - root AGENTS.md
 *  - nested AGENTS.md files in directories containing changed files
 *    (all levels from the file up to the root)
 *  - .code-review-agent/review.md
 *  - config-listed instruction files
 */
declare function loadInstructions(view: RepoView, changedPaths: string[], config: RepoConfig): Promise<InstructionBlock[]>;

type ExcludeKind = 'binary' | 'lock-file' | 'generated' | 'vendored' | 'config-exclude' | 'include-filter';
interface Eligibility {
    eligible: boolean;
    kind?: ExcludeKind;
    reason: string;
}
interface DefaultRule {
    pattern: string;
    kind: ExcludeKind;
}
declare const DEFAULT_EXCLUDE_RULES: readonly DefaultRule[];
declare function classifyFile(path: string, isBinary: boolean, config: RepoConfig): Eligibility;
/**
 * Apply eligibility to every changed file, producing per-file dispositions.
 */
declare function classifyAll(paths: {
    path: string;
    isBinary: boolean;
}[], config: RepoConfig): Map<string, Eligibility>;

/**
 * Transport-neutral tool registry. Tools are plain objects with a JSON-schema
 * spec and an executor; the runner drives them in tool-calling or
 * structured-output mode. An MCP adapter can be added later without touching
 * the tools themselves.
 */

interface Tool {
    spec: ToolSpec;
    execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
declare class ToolRegistry {
    private readonly tools;
    register(tool: Tool): this;
    get(name: string): Tool | undefined;
    names(): string[];
    specs(names?: string[]): ToolSpec[];
    validArguments(name: string, args: unknown): boolean;
    /**
     * Execute a tool by name. Unknown tools and executor crashes are reported
     * as ok=false results (never thrown out of the runner loop).
     */
    execute(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult>;
}

declare const listChangedFilesTool: Tool;
declare const readDiffTool: Tool;
declare const readFileTool: Tool;
declare const listDirectoryTool: Tool;
declare const searchTool: Tool;

interface BlockResolution {
    startLine: number;
    endLine: number;
}
type BlockResolutionError = 'block-too-small' | 'block-too-large' | 'block-not-found' | 'block-ambiguous';
/**
 * Resolve an exact source block to a unique line range within file lines.
 * Tries an exact match first, then a trailing-whitespace-tolerant match.
 */
declare function resolveBlock(fileLines: string[], block: string): BlockResolution | {
    error: BlockResolutionError;
};
/** Compute the hidden finding fingerprint. */
declare function findingFingerprint(params: {
    path: string;
    block: string;
    severity: Severity;
    explanation: string;
}): string;
interface CriticVerdict {
    verdict: 'confirmed' | 'rejected' | 'uncertain';
    reason: string;
}
/**
 * Focused critic call for apply-ready suggestions. Returns 'uncertain'
 * on any ambiguity, so an unverified patch is never posted as a suggestion.
 */
declare function runSuggestionCritic(ctx: ToolContext, params: {
    path: string;
    block: string;
    explanation: string;
    suggestion: string;
    diff: string;
}): Promise<CriticVerdict>;
declare const postInlineReviewCommentTool: Tool;

/**
 * complete_review_batch and answer tools.
 *
 * complete_review_batch ends a batch. answer is the required final answer of
 * the summary agent: it must be called exactly once, and its payload is
 * validated against the deterministic coverage computed by the pipeline.
 */

interface AnswerPayload {
    status: 'clean' | 'findings' | 'partial';
    summary: string;
    reviewedFiles: string[];
    skippedFiles: {
        file: string;
        reason: string;
    }[];
}
declare const completeReviewFileTool: Tool;
declare const completeReviewBatchTool: Tool;
declare class AnswerError extends Error {
    constructor(message: string);
}
/**
 * Validate an answer payload against deterministic coverage facts.
 * Returns null when valid, or an AnswerError describing the problem.
 */
declare function validateAnswer(payload: AnswerPayload, facts: {
    eligibleFiles: string[];
    reviewedFiles: Set<string>;
    findingsCount: number;
    /** True when the run hit its time budget before full coverage. */
    budgetExhausted: boolean;
}): AnswerError | null;
declare const answerTool: Tool;

/**
 * JSON schemas for the Junie-shaped read-only tool surface.
 * These are transport-neutral: the same specs drive native tool calling,
 * structured-output fallback, and (later) an MCP adapter.
 */

declare const TOOL_NAMES: {
    readonly listChangedFiles: "list_changed_files";
    readonly readDiff: "read_diff";
    readonly readFile: "read_file";
    readonly listDirectory: "list_directory";
    readonly search: "search";
    readonly postInlineReviewComment: "post_inline_review_comment";
    readonly completeReviewFile: "complete_review_file";
    readonly completeReviewBatch: "complete_review_batch";
    readonly answer: "answer";
};
declare const BATCH_TOOL_SPECS: ToolSpec[];
declare const ANSWER_TOOL_SPEC: ToolSpec;
/** Tool names available to a batch agent. */
declare const BATCH_TOOL_NAMES: string[];

/**
 * Structured planning call: groups all eligible changed files into at most
 * six review batches. Every file must be assigned or carry an explicit skip
 * reason. Validation is strict; any malformed plan falls back to a
 * deterministic bin-packing planner so a review is never blocked by planning.
 */

interface ReviewBatch {
    index: number;
    files: string[];
    notes?: string;
}
interface PlanResult {
    batches: ReviewBatch[];
    /** Eligible files the planner explicitly skipped, with reasons. */
    skipped: {
        file: string;
        reason: string;
    }[];
    /** True when the deterministic fallback planner was used. */
    fallback: boolean;
}
interface PlanFile {
    path: string;
    additions: number;
    deletions: number;
    status: string;
}
/**
 * Validate a raw plan document against the eligible file set.
 * Returns a normalized PlanResult or null.
 */
declare function validatePlan(doc: unknown, eligible: string[], maxBatches?: number): PlanResult | null;
/**
 * Deterministic fallback planner: directory-cohesive greedy bin packing
 * into at most maxBatches bins, largest groups first.
 */
declare function fallbackPlan(eligible: PlanFile[], maxBatches?: number): PlanResult;
/**
 * Run the structured planning call with validation and fallback.
 */
declare function planBatches(params: {
    llm: LlmClient;
    mode: 'tools' | 'structured';
    files: PlanFile[];
    onLlmCall?: () => void;
}): Promise<PlanResult>;

/**
 * Batch agent runner: drives one review batch to completion in either
 * native tool-calling mode or structured-output mode.
 *
 * - malformed tool calls are fed back to the model with an error and
 *   counted; three consecutive malformed calls fail the batch
 * - the budget and abort signal are checked before every LLM call
 * - complete_review_batch ends the batch; a model that never calls it is
 *   cut off after a bounded number of nudge attempts
 */

interface BatchRunOutcome {
    completed: boolean;
    batchSummary: string;
    llmCalls: number;
    steps: number;
    error?: string;
    /** True when the whole review must stop (e.g. head moved). */
    abort?: boolean;
    /** True when the run budget was exhausted. */
    budgetExhausted?: boolean;
    operationalFailure?: boolean;
    completion?: ToolContext['batchCompletion'];
}
interface RunBatchParams {
    llm: LlmClient;
    registry: ToolRegistry;
    ctx: ToolContext;
    systemPrompt: string;
    userPrompt: string;
    mode: 'tools' | 'structured';
}
declare function runBatch(params: RunBatchParams): Promise<BatchRunOutcome>;

/** System prompt for a batch review agent. */
declare function batchSystemPrompt(params: {
    config: RepoConfig;
    options: ResolvedOptions;
    instructions: InstructionBlock[];
}): string;
/** User prompt for one batch. */
declare function batchUserPrompt(params: {
    batchFiles: {
        path: string;
        status: string;
        additions: number;
        deletions: number;
    }[];
    batchIndex: number;
    totalBatches: number;
    notes?: string;
}): string;
/** System prompt for the summary agent. */
declare function summarySystemPrompt(): string;
/** User prompt for the summary agent: deterministic facts. */
declare function summaryUserPrompt(params: {
    eligibleFiles: string[];
    reviewedFiles: string[];
    skippedFiles: {
        file: string;
        reason: string;
    }[];
    findings: {
        file: string;
        severity: string;
        message: string;
        url?: string;
    }[];
    batchSummaries: string[];
    budgetExhausted: boolean;
}): string;

/**
 * Path security: normalization, confinement, and classification of
 * repository-relative paths. All tool paths must pass through here.
 */
/**
 * Normalize a repo-relative path to forward slashes.
 *
 * Returns null when the path cannot be made safe:
 *  - absolute paths
 *  - NUL bytes
 *  - any segment equal to ".." (path escape)
 *  - empty or root-only paths
 */
declare function normalizeRepoPath(input: string): string | null;
/**
 * Classify a normalized repo path.
 */
declare function classifyPath(path: string): 'ok' | 'root' | 'escape' | 'invalid';
/** Join a directory (normalized, may be "" for root) with a file name. */
declare function joinRepoPath(dir: string, file: string): string | null;
declare function parentDir(path: string): string;
declare function basename(path: string): string;

/**
 * Resource ceilings. These are immutable workflow ceilings: repository
 * configuration can never raise them.
 */
declare const LIMITS: {
    /** Maximum number of review batches (planning cap). */
    readonly maxBatches: 6;
    /** Hard cap on inline comments per run, regardless of config. */
    readonly maxInlineCommentsHard: 12;
    /** Default inline comments per run. */
    readonly maxInlineCommentsDefault: 6;
    /** Hard cap on run duration in minutes. */
    readonly maxDurationMinutesHard: 120;
    /** Default run duration budget in minutes. */
    readonly maxDurationMinutesDefault: 20;
    /** Local CLI defaults can accommodate slower private inference. */
    readonly maxDurationMinutesLocalDefault: 60;
    /** Maximum bytes read from a single file. */
    readonly maxFileBytes: number;
    /** Maximum lines read from a single file. */
    readonly maxFileLines: 5000;
    /** Maximum diff characters returned per file. */
    readonly maxDiffCharsPerFile: 200000;
    /** Maximum search results returned per call. */
    readonly maxSearchResults: 200;
    readonly maxToolResultChars: 16000;
    readonly maxSearchSnippetChars: 512;
    readonly maxReadFileLinesPerCall: 200;
    readonly transcriptCompactChars: 120000;
    readonly maxTranscriptChars: 200000;
    readonly maxOutputTokensHard: 16384;
    /** Maximum instruction bytes per file. */
    readonly maxInstructionBytesPerFile: 20000;
    /** Maximum total instruction bytes. */
    readonly maxInstructionBytesTotal: 100000;
    /** Maximum agent tool steps per batch before the batch is cut off. */
    readonly maxBatchSteps: 50;
    /** Maximum consecutive malformed tool calls before a batch fails. */
    readonly maxMalformedToolCalls: 3;
    /** Maximum git history deepen steps before unshallow. */
    readonly maxDeepenSteps: 25;
    /** LLM call timeout in milliseconds. */
    readonly llmCallTimeoutMs: number;
    /** GitHub API retry budget. */
    readonly githubMaxRetries: 4;
    /** Minimum characters for a review block (avoid trivial anchors). */
    readonly minBlockChars: 3;
    /** Maximum characters for a review block. */
    readonly maxBlockChars: 4000;
};
/**
 * Clamp an operator-supplied numeric option to its allowed ceiling.
 * Repository config can never pass through here: only action inputs / CLI flags do.
 */
declare function clampResource(value: number, defaultValue: number, hardMax: number): number;

export { ANSWER_TOOL_SPEC, AnswerError, type AnswerPayload, BATCH_TOOL_NAMES, BATCH_TOOL_SPECS, type BatchRunOutcome, type BlockResolution, BudgetExceededError, BudgetTracker, type CallCounts, type ChangedFile, type ChatMessage, type ChatRequest, type ChatResponse, ConfigError, type Coverage, type CriticVerdict, DEFAULT_CONFIG, DEFAULT_EXCLUDE_RULES, type DiffHunk, type DiffLine, type DiffMap, type Eligibility, type ExcludeKind, type FailOnSeverity, type FileCoverage, type FileCoverageStatus, type FileStatus, type Finding, type GenerationOptions, GitError, type GitExecutionOptions, type GitHubApi, GitHubClient, GitHubError, GitHubSink, GitRefView, type GitTarget, type HeadCheck, IndexView, type InstructionBlock, LIMITS, type LLMClientOptions, LLMError, type LlmCallMetric, type LlmPhase, LocalSink, OpenAICompatibleClient, type OperationalError, type PerformanceDiagnostics, type Permission, type PipelineInputs, type PlanResult, type PostState, type ProbeResult, type PullInfo, REVIEW_MARKER_PREFIX, REVIEW_MARKER_SUFFIX, type RepoConfig, type RepoView, type ResolvedOptions, type ReviewBatch, type ReviewCommentInfo, type ReviewCommentParams, type ReviewProgressEvent, type ReviewResult, type ReviewSink, type ReviewStatus, SEVERITIES, SEVERITY_RANK, type SearchOptions, type Severity, SupersededReviewError, TOOL_NAMES, type TargetArgs, TargetError, type TemplateScalar, type Tool, type ToolCall, type ToolContext, type ToolMode, ToolRegistry, type ToolResult, type ToolSpec, ViewError, WorkTreeView, answerTool, applyGenerationPolicy, basename, batchSystemPrompt, batchUserPrompt, buildDiff, buildDiffMap, buildSummaryBody, clampResource, classifyAll, classifyFile, classifyPath, completeReviewBatchTool, completeReviewFileTool, decideToolMode, detectDefaultBranch, effectiveMinSeverity, emptyCallCounts, ensureRemoteBranch, extractJsonObject, fallbackPlan, findingFingerprint, git, inlineMarker, joinRepoPath, listChangedFilesTool, listDirectoryTool, loadConfig, loadInstructions, makeView, normalizeRepoPath, parentDir, parseConfigDoc, parseGenerationOptions, parseNumstat, parseToolArgs, parseUnifiedDiff, planBatches, postInlineReviewCommentTool, probeModel, readDiffTool, readFileTool, renderFileDiff, resolveBlock, resolveCommit, resolveTarget, runBatch, runReview, runSuggestionCritic, searchTool, stepSchema, summarySystemPrompt, summaryUserPrompt, validateAnswer, validateGenerationOptions, validatePlan };
