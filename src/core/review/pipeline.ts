/** Shared Action/CLI pipeline. Acceptance, coverage and delivery are separate facts. */
import { randomUUID } from 'node:crypto';
import { buildDiff, git, type GitTarget, type GitExecutionOptions } from '../diff/git.js';
import { loadConfig } from '../config.js';
import { loadInstructions } from '../instructions.js';
import { classifyAll } from '../filtering/eligibility.js';
import { makeView } from '../repo/view.js';
import { BudgetTracker, BudgetExceededError } from './budget.js';
import type { ReviewSink } from './sink.js';
import { buildSummaryBody, SupersededReviewError } from './github-sink.js';
import { planBatches } from '../planning/planner.js';
import { runBatch } from '../agent/runner.js';
import { batchSystemPrompt, batchUserPrompt, summarySystemPrompt, summaryUserPrompt } from '../agent/prompts.js';
import { ToolRegistry } from '../tools/registry.js';
import { listChangedFilesTool, readDiffTool, readFileTool, listDirectoryTool, searchTool } from '../tools/read-only.js';
import { postInlineReviewCommentTool } from '../tools/post-comment.js';
import { completeReviewBatchTool, answerTool, validateAnswer, type AnswerPayload } from '../tools/answer.js';
import { ANSWER_TOOL_SPEC } from '../tools/schemas.js';
import { extractJsonObject, parseToolArgs, type LlmClient, type ChatMessage } from '../llm/client.js';
import { REVIEW_MARKER_PREFIX, REVIEW_MARKER_SUFFIX, type CallCounts, type Coverage, type FileCoverage,
  type Finding, type OperationalError, type ReviewResult, type ReviewStatus, type ToolContext, type DiffMap } from '../types.js';
import { truncate } from '../util.js';

export interface PipelineInputs {
  repoDir: string;
  target: GitTarget;
  options: import('../types.js').ResolvedOptions;
  llm: LlmClient;
  sink: ReviewSink;
  mode: 'tools' | 'structured';
  reviewId?: string;
  runUrl?: string;
  ensureBranch?: (repoDir: string, branch: string) => Promise<string>;
  budget?: BudgetTracker;
  gitOptions?: GitExecutionOptions;
  prContext?: { title: string; description: string };
  /** Runs inside the same deadline/result handling, using the counted, bounded client. */
  prepare?: (llm: LlmClient) => Promise<{ mode?: 'tools' | 'structured'; target?: GitTarget }>;
}
export function emptyCallCounts(): CallCounts {
  return { llmCalls: 0, toolCalls: 0, inlineCommentsPosted: 0, inlineCommentsRejected: 0,
    inlineCommentsReused: 0, agentResponses: 0, validAgentResponses: 0 };
}

export async function runReview(inputs: PipelineInputs): Promise<ReviewResult> {
  const reviewId = inputs.reviewId ?? randomUUID();
  const budget = inputs.budget ?? new BudgetTracker(Date.now(), inputs.options.maxDurationMinutes);
  const counters = emptyCallCounts();
  const abort = new AbortController();
  const findings: Finding[] = [];
  const errors: OperationalError[] = [];
  const reviewed = new Set<string>();
  const batchSummaries: string[] = [];
  const coverage: FileCoverage[] = [], eligible: string[] = [];
  let diff: DiffMap | undefined;
  let target = inputs.target, mode = inputs.mode;
  let stage = 'preflight', budgetExhausted = false, headChanged = false;
  let ctx: ToolContext | undefined;
  const llm: LlmClient = {
    model: inputs.llm.model,
    chat: (request) => {
      counters.llmCalls++;
      const parent = request.signal ? AbortSignal.any([request.signal, abort.signal]) : abort.signal;
      return budget.run((signal) => inputs.llm.chat({ ...request, signal }), false, parent);
    },
  };
  const gitOptions = { ...inputs.gitOptions, budget };
  const markSkipped = (file: string, reason: string) => {
    const row = coverage.find((c) => c.file === file);
    if (row && row.status !== 'reviewed') row.reason = reason;
  };

  try {
    const prepared = await inputs.prepare?.(llm);
    mode = prepared?.mode ?? mode;
    target = prepared?.target ?? target;
    stage = 'git-context';
    const root = await git(inputs.repoDir, ['rev-parse', '--show-toplevel'], gitOptions);
    if (root.code !== 0) throw new Error('not inside a Git working tree');
    const repoDir = root.stdout.trim();
    diff = await buildDiff(repoDir, target, { ...gitOptions, ensureBranch: inputs.ensureBranch });
    // Before configuration succeeds, unknown files remain eligible/unreviewed.
    // A malformed config must not erase the changed-file denominator.
    for (const file of [...diff.files.values()].sort((a, b) => a.path.localeCompare(b.path))) {
      eligible.push(file.path);
      coverage.push({ file: file.path, status: 'skipped', reason: 'not-reviewed' });
    }
    const view = makeView(target.viewKind, repoDir, diff.headSha, gitOptions);
    stage = 'configuration';
    const config = await loadConfig(view, inputs.options.configPath);
    const instructions = await loadInstructions(view, [...diff.files.keys()], config);
    const classified = classifyAll([...diff.files.values()].map((f) => ({ path: f.path, isBinary: f.isBinary })), config);
    eligible.length = 0;
    for (const row of coverage) {
      const classification = classified.get(row.file)!;
      if (classification.eligible) eligible.push(row.file);
      row.reason = classification.eligible ? 'not-reviewed' : classification.reason;
    }
    if (eligible.length) {
      inputs.sink.setSignal?.(budget.signal(false, abort.signal));
      stage = 'existing-comments';
      const existing = await budget.run(() => inputs.sink.existingComments?.() ?? Promise.resolve([]));
      stage = 'planning';
      const plan = await planBatches({ llm, mode, files: eligible.map((p) => diff!.files.get(p)!) });
      for (const skip of plan.skipped) markSkipped(skip.file, 'planner: ' + skip.reason);
      const registry = new ToolRegistry().register(listChangedFilesTool).register(readDiffTool)
        .register(readFileTool).register(listDirectoryTool).register(searchTool)
        .register(postInlineReviewCommentTool).register(completeReviewBatchTool);
      ctx = {
        reviewId, diff, view, options: inputs.options, config, instructions, budget, counters,
        sink: inputs.sink, llm, findings, operationalErrors: errors, diffReads: new Set(), batchFiles: [],
        postState: { posted: 0, postedFingerprints: new Set(), batchIndex: 0 },
        signal: abort.signal, abortReview: () => { headChanged = true; abort.abort(); },
      };
      for (const batch of plan.batches) {
        stage = 'batch';
        if (headChanged) break;
        if (budget.workExceeded()) { budgetExhausted = true; break; }
        ctx.postState.batchIndex = batch.index;
        ctx.batchFiles = batch.files;
        ctx.batchCompletion = undefined;
        ctx.diffReads = new Set();
        const outcome = await runBatch({
          llm, registry, ctx, mode,
          systemPrompt: batchSystemPrompt({ config, options: inputs.options, instructions }),
          userPrompt: batchUserPrompt({
            batchFiles: batch.files.map((p) => diff!.files.get(p)!),
            batchIndex: batch.index, totalBatches: plan.batches.length, notes: batch.notes,
          }) + '\n\nUntrusted PR/context data:\n' + JSON.stringify({
            pull_request: inputs.prContext ? { title: truncate(inputs.prContext.title, 1000), description: truncate(inputs.prContext.description, 8000) } : undefined,
            existing_same_head_comments: existing.slice(0, 12),
          }),
        });
        if (outcome.completed && outcome.completion) {
          for (const file of outcome.completion.reviewedFiles) {
            const row = coverage.find((c) => c.file === file)!;
            row.status = 'reviewed'; row.reason = undefined; row.batch = batch.index; reviewed.add(file);
          }
          for (const skip of outcome.completion.skippedFiles) markSkipped(skip.file, skip.reason);
          batchSummaries.push(outcome.batchSummary);
        } else {
          const reason = outcome.abort ? 'head-changed' : outcome.budgetExhausted ? 'budget-exhausted' : 'batch-failed: ' + outcome.error;
          for (const file of batch.files) markSkipped(file, reason);
        }
        if (outcome.operationalFailure) {
          if (!errors.length) errors.push({ stage, code: 'agent-failed', message: outcome.error ?? 'agent protocol failed' });
          break;
        }
        if (outcome.abort || headChanged) { headChanged = true; break; }
        if (outcome.budgetExhausted) { budgetExhausted = true; break; }
      }
    }
  } catch (err) {
    if (err instanceof SupersededReviewError || headChanged) headChanged = true;
    else if (err instanceof BudgetExceededError || ((err as Error).name === 'AbortError' && budget.workExceeded())) budgetExhausted = true;
    else errors.push({ stage, code: 'operational-failure', message: (err as Error).message });
  }

  for (const row of coverage) {
    if (row.reason === 'not-reviewed') row.reason = headChanged ? 'head-changed' :
      budgetExhausted ? 'budget-exhausted' : errors.length ? 'operational-failure' : 'not-reviewed';
  }
  const getCoverage = (): Coverage => {
    const excluded = coverage.filter((f) => !eligible.includes(f.file)).length;
    return { totalChanged: diff?.files.size ?? 0, eligible: eligible.length, reviewed: reviewed.size,
      skipped: eligible.length - reviewed.size, excluded, files: coverage };
  };
  const getStatus = (): ReviewStatus => errors.length ? 'failed' : headChanged || budgetExhausted ? 'partial' :
    eligible.length === 0 ? 'skipped' : reviewed.size !== eligible.length ? 'partial' : findings.length ? 'findings' : 'clean';
  let status = getStatus();
  let summary = 'Reviewed ' + reviewed.size + '/' + eligible.length + ' eligible files; ' + findings.length + ' accepted findings.';
  if (!diff?.files.size && !errors.length && !budgetExhausted) summary = 'No changes to review.';
  else if (!eligible.length && !errors.length && !budgetExhausted) summary = 'No eligible files to review; all changed files are excluded.';
  if (batchSummaries.length) summary += '\n\n' + batchSummaries.join('\n\n');
  if (errors.length) summary += '\n\nReview could not be completed: ' + errors.map((e) => e.message).join('; ');

  if (ctx && !headChanged && !budgetExhausted && !errors.length && eligible.length) {
    stage = 'final-answer';
    try {
      const facts = {
        eligibleFiles: eligible, reviewedFiles: reviewed, findingsCount: findings.length, budgetExhausted,
      };
      const answer = await runSummaryAgent(llm, mode, ctx, status as AnswerPayload['status'], facts, coverage, batchSummaries);
      summary = answer.summary;
    } catch (err) {
      if (err instanceof BudgetExceededError || ((err as Error).name === 'AbortError' && budget.workExceeded())) budgetExhausted = true;
      else errors.push({ stage, code: 'final-answer-failed', message: (err as Error).message });
    }
    status = getStatus();
  }

  const result: ReviewResult = {
    schema: 'code-review-agent.result/v1', status,
    target: target.label, baseSha: diff?.baseSha ?? 'unknown', headSha: diff?.headSha ?? 'unknown',
    model: inputs.llm.model, findings, coverage: getCoverage(), summary, operationalErrors: errors,
    startedAt: new Date(budget.startedAt).toISOString(), finishedAt: new Date().toISOString(),
    durationMs: budget.elapsed(), callCounts: counters,
  };
  const updateStatus = () => {
    result.status = getStatus();
    result.statusReason = errors.length ? 'operational-failure' : headChanged ? 'head-changed-during-review' :
      budgetExhausted ? 'time-budget-exhausted' : result.status === 'partial' ? 'incomplete-coverage' :
      result.status === 'skipped' ? diff?.files.size ? 'no-eligible-files' : 'no-changed-files' : undefined;
  };
  updateStatus();
  if (diff?.files.size && !headChanged && !budget.exceeded()) {
    try {
      inputs.sink.setSignal?.(budget.signal(true));
      const body = buildSummaryBody({ result, reviewId, runUrl: inputs.runUrl,
        postedCommentUrls: findings.flatMap((f) => f.url ? [f.url] : []) });
      const published = await budget.run(() => inputs.sink.upsertSummaryComment({
        marker: REVIEW_MARKER_PREFIX + reviewId + REVIEW_MARKER_SUFFIX, body,
      }), true);
      result.summaryCommentUrl = published.url;
    } catch (err) {
      if (err instanceof SupersededReviewError) headChanged = true;
      else if (err instanceof BudgetExceededError || budget.exceeded()) budgetExhausted = true;
      else errors.push({ stage: 'summary-publishing', code: 'publish-failed', message: (err as Error).message });
    }
  } else if (budget.exceeded()) budgetExhausted = true;
  updateStatus();
  try {
    if (!budget.exceeded()) await budget.run(() => inputs.sink.finalize(result), true);
  } catch (err) {
    if (err instanceof BudgetExceededError || budget.exceeded()) budgetExhausted = true;
    else errors.push({ stage: 'finalization', code: 'finalize-failed', message: (err as Error).message });
  }
  updateStatus();
  result.finishedAt = new Date().toISOString();
  result.durationMs = budget.elapsed();
  return result;
}

async function runSummaryAgent(
  llm: LlmClient, mode: 'tools' | 'structured', ctx: ToolContext, status: AnswerPayload['status'],
  facts: Parameters<typeof validateAnswer>[1], coverage: FileCoverage[], batchSummaries: string[],
): Promise<AnswerPayload> {
  const messages: ChatMessage[] = [
    { role: 'system', content: summarySystemPrompt() },
    { role: 'user', content: summaryUserPrompt({
      eligibleFiles: facts.eligibleFiles, reviewedFiles: [...facts.reviewedFiles],
      skippedFiles: coverage.filter((f) => facts.eligibleFiles.includes(f.file) && f.status === 'skipped')
        .map((f) => ({ file: f.file, reason: f.reason ?? 'not-reviewed' })),
      findings: ctx.findings, batchSummaries, budgetExhausted: facts.budgetExhausted,
    }) },
  ];
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await llm.chat({
      messages, temperature: 0,
      ...(mode === 'tools' ? { tools: [ANSWER_TOOL_SPEC], toolChoice: { function: { name: 'answer' } } } :
        { jsonSchema: { name: 'answer', schema: ANSWER_TOOL_SPEC.parameters } }),
    });
    const call = response.toolCalls[0];
    const raw = mode === 'tools' ?
      response.toolCalls.length === 1 && call?.name === 'answer' ? parseToolArgs(call.arguments) : null :
      extractJsonObject(response.content ?? '');
    let error = 'expected exactly one valid answer';
    if (raw) {
      const tool = await answerTool.execute(raw, ctx);
      if (tool.ok) {
        const payload: AnswerPayload = { status: raw.status as AnswerPayload['status'], summary: raw.summary as string,
          reviewedFiles: raw.reviewed_files as string[], skippedFiles: raw.skipped_files as AnswerPayload['skippedFiles'] };
        const validation = validateAnswer(payload, facts);
        if (!validation && payload.status === status) return payload;
        error = validation?.message ?? 'status does not match deterministic facts';
      } else error = tool.error ?? error;
    }
    messages.push({ role: 'assistant', content: response.content, ...(response.toolCalls.length ? { tool_calls: response.toolCalls } : {}) });
    if (mode === 'tools' && response.toolCalls.length) {
      for (const tool of response.toolCalls) messages.push({ role: 'tool', tool_call_id: tool.id, content: JSON.stringify({ ok: false, error }) });
    }
    messages.push({ role: 'user', content: 'Answer rejected: ' + error + '. Call answer with status ' + status + ' and the exact coverage facts.' });
  }
  throw new Error('summary agent produced no valid final answer after three attempts');
}
