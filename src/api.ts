/**
 * Public programmatic API for code-review-agent.
 *
 * The normalized ReviewResult schema is identical across local and GitHub
 * sinks; see core/types.ts.
 */
export * from './core/types.js';

// pipeline
export { runReview, emptyCallCounts, type PipelineInputs } from './core/review/pipeline.js';
export { BudgetTracker, BudgetExceededError } from './core/review/budget.js';
export { type ReviewSink, LocalSink } from './core/review/sink.js';
export { GitHubSink, SupersededReviewError, buildSummaryBody, inlineMarker } from './core/review/github-sink.js';

// llm
export {
  OpenAICompatibleClient,
  LLMError,
  parseToolArgs,
  extractJsonObject,
  stepSchema,
  type ChatMessage,
  type ChatResponse,
  type ToolSpec,
  type LLMClientOptions,
} from './core/llm/client.js';
export { probeModel, decideToolMode, type ProbeResult } from './core/llm/doctor.js';

// git / diff
export {
  resolveTarget,
  buildDiff,
  resolveCommit,
  ensureRemoteBranch,
  detectDefaultBranch,
  git,
  GitError,
  TargetError,
  type GitTarget,
  type TargetArgs,
  type GitExecutionOptions,
} from './core/diff/git.js';
export {
  parseUnifiedDiff,
  parseNumstat,
  buildDiffMap,
  renderFileDiff,
} from './core/diff/normalize.js';

// repo views
export {
  makeView,
  GitRefView,
  IndexView,
  WorkTreeView,
  ViewError,
  type RepoView,
  type SearchOptions,
} from './core/repo/view.js';

// config & instructions
export {
  loadConfig,
  parseConfigDoc,
  effectiveMinSeverity,
  DEFAULT_CONFIG,
  ConfigError,
} from './core/config.js';
export { loadInstructions } from './core/instructions.js';

// filtering
export {
  classifyFile,
  classifyAll,
  DEFAULT_EXCLUDE_RULES,
  type Eligibility,
  type ExcludeKind,
} from './core/filtering/eligibility.js';

// tools
export { ToolRegistry, type Tool } from './core/tools/registry.js';
export {
  listChangedFilesTool,
  readDiffTool,
  readFileTool,
  listDirectoryTool,
  searchTool,
} from './core/tools/read-only.js';
export {
  postInlineReviewCommentTool,
  resolveBlock,
  findingFingerprint,
  runSuggestionCritic,
  type CriticVerdict,
  type BlockResolution,
} from './core/tools/post-comment.js';
export {
  answerTool,
  completeReviewBatchTool,
  validateAnswer,
  AnswerError,
  type AnswerPayload,
} from './core/tools/answer.js';
export {
  BATCH_TOOL_SPECS,
  ANSWER_TOOL_SPEC,
  BATCH_TOOL_NAMES,
  TOOL_NAMES,
} from './core/tools/schemas.js';

// planning
export {
  planBatches,
  validatePlan,
  fallbackPlan,
  type PlanResult,
  type ReviewBatch,
} from './core/planning/planner.js';

// agent
export { runBatch, type BatchRunOutcome } from './core/agent/runner.js';
export {
  batchSystemPrompt,
  batchUserPrompt,
  summarySystemPrompt,
  summaryUserPrompt,
} from './core/agent/prompts.js';

// github
export {
  GitHubClient,
  GitHubError,
  type PullInfo,
  type Permission,
  type GitHubApi,
  type ReviewCommentInfo,
  type ReviewCommentParams,
} from './core/github/client.js';

// security
export { normalizeRepoPath, classifyPath, joinRepoPath, parentDir, basename } from './core/security/paths.js';
export { LIMITS, clampResource } from './core/security/limits.js';
