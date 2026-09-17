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
import {
  extractJsonObject,
  parseToolArgs,
  stepSchema,
  type ChatMessage,
  type LlmClient,
} from '../llm/client.js';
import { LIMITS } from '../security/limits.js';
import type { ToolContext } from '../types.js';
import type { ToolRegistry } from '../tools/registry.js';
import { TOOL_NAMES } from '../tools/schemas.js';
import { compactTranscript } from './transcript.js';
import { applyGenerationPolicy } from '../llm/generation.js';

export interface BatchRunOutcome {
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

export interface RunBatchParams {
  llm: LlmClient;
  registry: ToolRegistry;
  ctx: ToolContext;
  systemPrompt: string;
  userPrompt: string;
  mode: 'tools' | 'structured';
}

const MAX_NUDGE = 2;

export async function runBatch(params: RunBatchParams): Promise<BatchRunOutcome> {
  const { llm, registry, ctx, mode } = params;
  let llmCalls = 0;
  let steps = 0;
  let malformedStreak = 0;
  let nudges = 0;
  let truncatedStreak = 0;

  const messages: ChatMessage[] = [
    { role: 'system', content: params.systemPrompt },
    { role: 'user', content: params.userPrompt },
  ];
  const toolNames = [
    ...registry.names().filter((n) => n !== TOOL_NAMES.completeReviewBatch),
    TOOL_NAMES.completeReviewBatch,
  ];

  const toolResultPayload = (name: string, r: { ok: boolean; result?: unknown; error?: string }) => {
    let payload = JSON.stringify({ tool: name, ok: r.ok, ...(r.error ? { error: r.error } : { result: r.result }) });
    if (payload.length > LIMITS.maxToolResultChars) payload = JSON.stringify({ tool: name, ok: false, error: 'result exceeded the bounded context limit; request a smaller range' });
    if (ctx.performance) ctx.performance.toolResultChars += payload.length;
    return payload;
  };

  for (;;) {
    if (ctx.signal.aborted) {
      return { completed: false, batchSummary: '', llmCalls, steps, abort: true, error: 'aborted' };
    }
    if (ctx.budget.workExceeded()) {
      return {
        completed: false,
        batchSummary: '',
        llmCalls,
        steps,
        budgetExhausted: true,
        error: 'budget exhausted',
      };
    }
    if (steps >= LIMITS.maxBatchSteps) {
      return {
        completed: false,
        batchSummary: '',
        llmCalls,
        steps,
        error: `batch step limit (${LIMITS.maxBatchSteps}) reached`,
      };
    }
    if (!compactTranscript(messages, registry.specs(toolNames), ctx)) {
      return { completed: false, batchSummary: '', llmCalls, steps, error: 'bounded transcript limit reached' };
    }
    steps++;
    llmCalls++;
    ctx.counters.agentResponses++;

    let resp;
    try {
      resp =
        mode === 'tools'
          ? await llm.chat(applyGenerationPolicy({
              messages,
              tools: registry.specs(toolNames),
              temperature: 0.2,
              phase: 'review',
            }, ctx.generation))
          : await llm.chat(applyGenerationPolicy({
              messages,
              jsonSchema: { name: 'step', schema: stepSchema(toolNames) },
              temperature: 0.2,
              phase: 'review',
            }, ctx.generation));
    } catch (err) {
      if ((err as Error).name === 'BudgetExceededError' || ((err as Error).name === 'AbortError' && ctx.budget.workExceeded())) return { completed: false, batchSummary: '', llmCalls, steps, budgetExhausted: true };
      return {
        completed: false,
        batchSummary: '',
        llmCalls,
        steps,
        error: `LLM call failed: ${(err as Error).message}`,
        operationalFailure: true,
      };
    }

    // Never execute even a syntactically valid prefix of a truncated tool response.
    if (resp.finishReason === 'length') {
      truncatedStreak++;
      if (truncatedStreak > 1) return { completed: false, batchSummary: '', llmCalls, steps, error: 'output-budget-exhausted' };
      messages.push({ role: 'user', content: 'Your previous response exceeded the output budget and NO tools from it were executed. Return only one concise tool step, without prose. Keep summaries brief.' });
      continue;
    }
    truncatedStreak = 0;

    // ---- native tool-calling mode ----
    if (mode === 'tools') {
      if (resp.toolCalls.length === 0) {
        nudges++;
        if (nudges > MAX_NUDGE) {
          // Cut the batch off; treat model prose as the batch summary.
          return {
            completed: false,
            batchSummary: '',
            llmCalls,
            steps,
            error: 'model stopped calling tools; batch cut off',
            operationalFailure: true,
          };
        }
        messages.push({ role: 'assistant', content: resp.content });
        messages.push({
          role: 'user',
          content:
            'Continue using tools: call read_diff/read_file as needed, post verified findings, and finish with complete_review_batch.',
        });
        continue;
      }
      if (resp.toolCalls.every((call) => {
        const args = parseToolArgs(call.arguments);
        return args !== null && registry.validArguments(call.name, args);
      })) ctx.counters.validAgentResponses++;
      messages.push({
        role: 'assistant',
        content: resp.content,
        tool_calls: resp.toolCalls.map((t) => ({
          id: t.id,
          name: t.name,
          arguments: t.arguments,
        })),
      });
      for (const call of resp.toolCalls) {
        if (ctx.signal.aborted) return { completed: false, batchSummary: '', llmCalls, steps, abort: true };
        const parsed: Record<string, unknown> | null = parseToolArgs(call.arguments);
        if (parsed === null) {
          malformedStreak++;
          ctx.counters.toolCalls++;
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.name,
            content: JSON.stringify({
              ok: false,
              error: 'malformed arguments; respond with a valid JSON object matching the tool schema',
            }),
          });
          if (malformedStreak >= LIMITS.maxMalformedToolCalls) {
            return {
              completed: false,
              batchSummary: '',
              llmCalls,
              steps,
              error: 'too many malformed tool calls',
              operationalFailure: true,
            };
          }
          continue;
        }
        ctx.counters.toolCalls++;
        const result = await registry.execute(call.name, parsed, ctx);
        if (ctx.operationalErrors.length) return { completed: false, batchSummary: '', llmCalls, steps, operationalFailure: true, error: ctx.operationalErrors.at(-1)!.message };
        const completionCall = call.name === TOOL_NAMES.completeReviewBatch || call.name === TOOL_NAMES.completeReviewFile;
        malformedStreak = result.protocolError || (completionCall && !result.ok) ? malformedStreak + 1 : 0;
        if (malformedStreak >= LIMITS.maxMalformedToolCalls) return { completed: false, batchSummary: '', llmCalls, steps, operationalFailure: true, error: 'too many invalid tool calls' };
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.name,
          content: toolResultPayload(call.name, result),
        });
        if (ctx.signal.aborted) return { completed: false, batchSummary: '', llmCalls, steps, abort: true };
        if (call.name === TOOL_NAMES.completeReviewBatch && result.ok) {
          return {
            completed: true,
            completion: ctx.batchCompletion,
            batchSummary: extractSummary(parsed, result),
            llmCalls,
            steps,
          };
        }
      }
      continue;
    }

    // ---- structured-output mode ----
    const obj = extractJsonObject(resp.content ?? '');
    if (!obj || typeof obj.tool !== 'string' || !obj.args || typeof obj.args !== 'object' || Array.isArray(obj.args)) {
      malformedStreak++;
      ctx.counters.toolCalls++;
      messages.push({ role: 'assistant', content: resp.content });
      messages.push({
        role: 'user',
        content:
          'Invalid step: expected a JSON object {"tool": <name>, "args": <object>}. Respond with the next valid tool step.',
      });
      if (malformedStreak >= LIMITS.maxMalformedToolCalls) {
        return {
          completed: false,
          batchSummary: '',
          llmCalls,
          steps,
          error: 'too many malformed structured steps',
          operationalFailure: true,
        };
      }
      continue;
    }
    const name = obj.tool;
    const args = (typeof obj.args === 'object' && obj.args !== null ? obj.args : {}) as Record<
      string,
      unknown
    >;
    ctx.counters.toolCalls++;
    if (registry.validArguments(name, args)) ctx.counters.validAgentResponses++;
    messages.push({ role: 'assistant', content: resp.content });
    const result = await registry.execute(name, args, ctx);
    if (ctx.operationalErrors.length) return { completed: false, batchSummary: '', llmCalls, steps, operationalFailure: true, error: ctx.operationalErrors.at(-1)!.message };
    const completionCall = name === TOOL_NAMES.completeReviewBatch || name === TOOL_NAMES.completeReviewFile;
    malformedStreak = result.protocolError || (completionCall && !result.ok) ? malformedStreak + 1 : 0;
    if (malformedStreak >= LIMITS.maxMalformedToolCalls) return { completed: false, batchSummary: '', llmCalls, steps, operationalFailure: true, error: 'too many invalid structured steps' };
    messages.push({
      role: 'user',
      content: `TOOL_RESULT: ${toolResultPayload(name, result)}\nRespond with the next tool step.`,
    });
    if (ctx.signal.aborted) return { completed: false, batchSummary: '', llmCalls, steps, abort: true };
    if (name === TOOL_NAMES.completeReviewBatch && result.ok) {
      return {
        completed: true,
        completion: ctx.batchCompletion,
        batchSummary: extractSummary(args, result),
        llmCalls,
        steps,
      };
    }
  }
  return { completed: false, batchSummary: '', llmCalls, steps, error: 'loop exited' };
}

function extractSummary(args: Record<string, unknown>, result: { result?: unknown }): string {
  if (typeof args.summary === 'string') return args.summary.slice(0, 2000);
  if (typeof result.result === 'string') return result.result.slice(0, 2000);
  return '(no summary)';
}
