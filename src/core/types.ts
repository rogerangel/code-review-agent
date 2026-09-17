/**
 * Shared domain types for code-review-agent.
 *
 * These types define the normalized result schema produced by both local (CLI)
 * and GitHub (Action) modes. Both modes MUST produce the same shape.
 */

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export const SEVERITIES: readonly Severity[] = ['low', 'medium', 'high', 'critical'];

export const SEVERITY_RANK: Record<Severity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export type ReviewStatus = 'clean' | 'findings' | 'partial' | 'skipped' | 'failed';

/**
 * tool_mode:
 *  - auto: probe the model for reliable tool calling; fall back to structured output
 *  - tools: require native tool calling
 *  - structured: force JSON-schema structured output (no native tools)
 */
export type ToolMode = 'auto' | 'tools' | 'structured';

export type FailOnSeverity = 'none' | 'medium' | 'high' | 'critical';

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface ChangedFile {
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

export interface DiffLine {
  kind: 'add' | 'delete' | 'context';
  /** Line content without the leading +/-/space marker. */
  content: string;
  /** 1-based line number in the new file, or null for deleted lines. */
  newLine: number | null;
  /** 1-based line number in the old file, or null for added lines. */
  oldLine: number | null;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface DiffMap {
  baseSha: string;
  headSha: string;
  /** Ordered map of repo-relative path -> changed file metadata. */
  files: Map<string, ChangedFile>;
  /** Ordered map of repo-relative path -> hunks (new-file side). */
  hunks: Map<string, DiffHunk[]>;
  /** Set of new-file line numbers (1-based) that are additions, per path. */
  addedLines: Map<string, Set<number>>;
}

export interface Finding {
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

export interface OperationalError {
  stage: string;
  code: string;
  message: string;
  findingId?: string;
}

export type FileCoverageStatus = 'reviewed' | 'skipped';

export interface FileCoverage {
  file: string;
  status: FileCoverageStatus;
  /** Skip reason for excluded/skipped files. */
  reason?: string;
  /** Batch index assigned to this file, when reviewed. */
  batch?: number;
}

export interface Coverage {
  totalChanged: number;
  eligible: number;
  reviewed: number;
  skipped: number;
  excluded: number;
  /** Complete list of changed files with their disposition. */
  files: FileCoverage[];
}

export interface CallCounts {
  llmCalls: number;
  toolCalls: number;
  inlineCommentsPosted: number;
  inlineCommentsRejected: number;
  inlineCommentsReused: number;
  agentResponses: number;
  validAgentResponses: number;
}

export interface ReviewResult {
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
}

export interface RepoConfig {
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

export interface ResolvedOptions {
  configPath: string;
  toolMode: ToolMode;
  maxDurationMinutes: number;
  maxInlineComments: number;
  failOnSeverity: FailOnSeverity;
  config: RepoConfig;
}

export interface ToolCall {
  name: string;
  args: unknown;
  /** Raw JSON string as returned by the model (kept for diagnostics). */
  rawArgs: string;
}

export interface ToolResult {
  ok: boolean;
  /** Result payload, serialized into the model transcript. */
  result: unknown;
  /** Human/model-readable error when ok=false. */
  error?: string;
  protocolError?: boolean;
}

/** Context handed to every tool execution. */
export interface ToolContext {
  reviewId: string;
  diff: DiffMap;
  view: import('./repo/view.js').RepoView;
  options: ResolvedOptions;
  config: RepoConfig;
  instructions: InstructionBlock[];
  budget: import('./review/budget.js').BudgetTracker;
  counters: CallCounts;
  sink: import('./review/sink.js').ReviewSink;
  llm: import('./llm/client.js').LlmClient;
  /** Post-inline-comment guard state (caps, fingerprints, head checks). */
  postState: PostState;
  /** Abort signal for the whole review. */
  signal: AbortSignal;
  /** Aborts the whole review (e.g. when the head moves mid-run). */
  abortReview: () => void;
  findings: Finding[];
  operationalErrors: OperationalError[];
  diffReads: Set<string>;
  batchFiles: string[];
  batchCompletion?: { reviewedFiles: string[]; skippedFiles: { file: string; reason: string }[] };
}

export interface PostState {
  posted: number;
  postedFingerprints: Set<string>;
  /** Index of the batch currently running (stamped on findings). */
  batchIndex: number;
}

export interface InstructionBlock {
  /** Source label, e.g. "AGENTS.md (repo root)" or ".code-review-agent/review.md". */
  source: string;
  content: string;
}

/** Head recheck outcome before any side effect. */
export interface HeadCheck {
  ok: boolean;
  currentHead: string;
  /** True when the head differs from the pinned SHA or the PR is closed/draft. */
  stale: boolean;
  error?: string;
}

export const REVIEW_MARKER_PREFIX = '<!-- code-review-agent:v1:run=';
export const REVIEW_MARKER_SUFFIX = ' -->';
