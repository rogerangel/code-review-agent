/**
 * Resource ceilings. These are immutable workflow ceilings: repository
 * configuration can never raise them.
 */

export const LIMITS = {
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
  /** Local CLI defaults can accommodate slower private inference. */
  maxDurationMinutesLocalDefault: 60,
  /** Maximum bytes read from a single file. */
  maxFileBytes: 2 * 1024 * 1024,
  /** Maximum lines read from a single file. */
  maxFileLines: 5000,
  /** Maximum diff characters returned per file. */
  maxDiffCharsPerFile: 200_000,
  /** Maximum search results returned per call. */
  maxSearchResults: 200,
  maxToolResultChars: 16_000,
  maxSearchSnippetChars: 512,
  maxReadFileLinesPerCall: 200,
  transcriptCompactChars: 120_000,
  maxTranscriptChars: 200_000,
  maxOutputTokensHard: 16_384,
  /** Maximum instruction bytes per file. */
  maxInstructionBytesPerFile: 20_000,
  /** Maximum total instruction bytes. */
  maxInstructionBytesTotal: 100_000,
  /** Maximum agent tool steps per batch before the batch is cut off. */
  maxBatchSteps: 50,
  /** Maximum consecutive malformed tool calls before a batch fails. */
  maxMalformedToolCalls: 3,
  /** Maximum git history deepen steps before unshallow. */
  maxDeepenSteps: 25,
  /** LLM call timeout in milliseconds. */
  llmCallTimeoutMs: 10 * 60 * 1000,
  /** GitHub API retry budget. */
  githubMaxRetries: 4,
  /** Minimum characters for a review block (avoid trivial anchors). */
  minBlockChars: 3,
  /** Maximum characters for a review block. */
  maxBlockChars: 4_000,
} as const;

/**
 * Clamp an operator-supplied numeric option to its allowed ceiling.
 * Repository config can never pass through here: only action inputs / CLI flags do.
 */
export function clampResource(value: number, defaultValue: number, hardMax: number): number {
  const v = Number.isFinite(value) ? Math.trunc(value) : defaultValue;
  return Math.min(hardMax, Math.max(1, v));
}
