/**
 * complete_review_batch and answer tools.
 *
 * complete_review_batch ends a batch. answer is the required final answer of
 * the summary agent: it must be called exactly once, and its payload is
 * validated against the deterministic coverage computed by the pipeline.
 */
import { asArgs, requireString, type Tool } from './registry.js';
import { ANSWER_TOOL_SPEC, TOOL_NAMES } from './schemas.js';
import { BATCH_TOOL_SPECS } from './schemas.js';
import type { ToolResult } from '../types.js';

const specOf = (name: string) =>
  BATCH_TOOL_SPECS.find((s) => s.name === name) as (typeof BATCH_TOOL_SPECS)[number];

export interface AnswerPayload {
  status: 'clean' | 'findings' | 'partial';
  summary: string;
  reviewedFiles: string[];
  skippedFiles: { file: string; reason: string }[];
}

export const completeReviewBatchTool: Tool = {
  spec: specOf(TOOL_NAMES.completeReviewBatch),
  async execute(args, ctx): Promise<ToolResult> {
    const a = asArgs(args);
    const summary = requireString(a, 'summary') ?? '';
    if (summary.trim().length === 0) {
      return { ok: false, result: null, error: '"summary" is required to complete the batch' };
    }
    const reviewed = a.reviewed_files;
    const skipped = a.skipped_files;
    if (!Array.isArray(reviewed) || !reviewed.every((f) => typeof f === 'string') || !Array.isArray(skipped)) return { ok: false, result: null, error: 'reviewed_files and skipped_files are required arrays' };
    const skips: { file: string; reason: string }[] = [];
    for (const item of skipped) {
      if (!item || typeof item !== 'object' || typeof item.file !== 'string' || typeof item.reason !== 'string' || !item.reason.trim()) return { ok: false, result: null, error: 'skipped_files entries need a file and non-empty reason' };
      skips.push({ file: item.file, reason: item.reason });
    }
    const all = [...reviewed, ...skips.map((s) => s.file)];
    if (new Set(all).size !== all.length || all.length !== ctx.batchFiles.length || all.some((f) => !ctx.batchFiles.includes(f))) return { ok: false, result: null, error: 'account for every assigned file exactly once; no unknown or duplicate files' };
    if (reviewed.some((f) => !ctx.diffReads.has(f))) return { ok: false, result: null, error: 'read every complete, non-truncated diff before claiming it reviewed; otherwise skip it with a reason' };
    ctx.batchCompletion = { reviewedFiles: reviewed, skippedFiles: skips };
    return { ok: true, result: { completed: true, ...ctx.batchCompletion } };
  },
};

export class AnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnswerError';
  }
}

/**
 * Validate an answer payload against deterministic coverage facts.
 * Returns null when valid, or an AnswerError describing the problem.
 */
export function validateAnswer(
  payload: AnswerPayload,
  facts: {
    eligibleFiles: string[];
    reviewedFiles: Set<string>;
    findingsCount: number;
    /** True when the run hit its time budget before full coverage. */
    budgetExhausted: boolean;
  },
): AnswerError | null {
  const allowed = ['clean', 'findings', 'partial'];
  if (!allowed.includes(payload.status)) {
    return new AnswerError(`status must be one of ${allowed.join(', ')}`);
  }
  if (!payload.summary || payload.summary.trim().length < 10) {
    return new AnswerError('summary must be a meaningful prose summary');
  }
  const reviewed = new Set(payload.reviewedFiles);
  const skipped = new Set(payload.skippedFiles.map((s) => s.file));
  if (reviewed.size !== payload.reviewedFiles.length || skipped.size !== payload.skippedFiles.length) return new AnswerError('duplicate file dispositions');
  if ([...reviewed, ...skipped].some((f) => !facts.eligibleFiles.includes(f))) return new AnswerError('unknown file disposition');
  if (reviewed.size !== facts.reviewedFiles.size || [...reviewed].some((f) => !facts.reviewedFiles.has(f))) return new AnswerError('reviewed_files does not match actual completed coverage');
  for (const s of payload.skippedFiles) {
    if (!s.reason || s.reason.trim().length === 0) {
      return new AnswerError(`skipped file "${s.file}" lacks a reason`);
    }
  }
  // Every eligible file must be exactly accounted for.
  for (const f of facts.eligibleFiles) {
    const inReviewed = reviewed.has(f);
    const inSkipped = skipped.has(f);
    if (inReviewed === inSkipped) {
      return new AnswerError(
        inReviewed
          ? `file "${f}" is listed both reviewed and skipped`
          : `file "${f}" is neither reviewed nor skipped; every eligible file needs a disposition`,
      );
    }
  }
  // Status must match the deterministic facts.
  if (payload.status === 'clean') {
    if (facts.findingsCount > 0) {
      return new AnswerError('status "clean" is not possible when findings were posted');
    }
    if (skipped.size > 0 || facts.budgetExhausted) {
      return new AnswerError('status "clean" requires full eligible-file coverage without skipped files');
    }
  }
  if (payload.status === 'partial') {
    if (skipped.size === 0 && !facts.budgetExhausted && facts.reviewedFiles.size === facts.eligibleFiles.length) {
      return new AnswerError('status "partial" is not possible when full coverage was achieved; use "findings" or "clean"');
    }
  }
  if (payload.status === 'findings' && facts.findingsCount === 0) {
    return new AnswerError('status "findings" requires at least one posted finding');
  }
  if (payload.status === 'findings' && skipped.size > 0) return new AnswerError('status findings requires full coverage');
  if (facts.budgetExhausted && payload.status !== 'partial') {
    return new AnswerError('budget was exhausted; status must be "partial" (never clean or findings)');
  }
  return null;
}

export const answerTool: Tool = {
  spec: ANSWER_TOOL_SPEC,
  async execute(args, ctx): Promise<ToolResult> {
    void ctx;
    const a = asArgs(args);
    const status = requireString(a, 'status');
    if (!status) return { ok: false, result: null, error: 'missing required argument "status"' };
    const summary = requireString(a, 'summary');
    if (!summary) return { ok: false, result: null, error: 'missing required argument "summary"' };
    const reviewedFiles = a.reviewed_files;
    const skippedRaw = a.skipped_files;
    if (!Array.isArray(reviewedFiles) || !reviewedFiles.every((x) => typeof x === 'string')) {
      return { ok: false, result: null, error: '"reviewed_files" must be an array of file paths' };
    }
    const skippedFiles: { file: string; reason: string }[] = [];
    if (skippedRaw !== undefined) {
      if (!Array.isArray(skippedRaw)) {
        return { ok: false, result: null, error: '"skipped_files" must be an array' };
      }
      for (const s of skippedRaw) {
        if (typeof s !== 'object' || s === null) {
          return { ok: false, result: null, error: '"skipped_files" entries must be objects' };
        }
        const file = (s as Record<string, unknown>).file;
        const reason = (s as Record<string, unknown>).reason;
        if (typeof file !== 'string' || typeof reason !== 'string') {
          return { ok: false, result: null, error: '"skipped_files" entries need string "file" and "reason"' };
        }
        skippedFiles.push({ file, reason });
      }
    }
    return {
      ok: true,
      result: {
        accepted: true,
        answer: {
          status,
          summary,
          reviewed_files: reviewedFiles,
          skipped_files: skippedFiles,
        },
      },
    };
  },
};
