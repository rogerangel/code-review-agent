/**
 * Scripted fake LLM for pipeline tests.
 *
 * Dispatches on the request shape the pipeline uses:
 *  - plan:      jsonSchema name "plan"  / tool "plan_review_batches"
 *  - summary:   jsonSchema name "answer" / tool "answer"
 *  - critic:    system prompt contains "strict patch critic"
 *  - batch:     jsonSchema name "step" / batch tools
 *
 * `steps` is a flat queue of batch steps consumed across batches in order;
 * each step is either a tool step {tool, args} or prose {content}.
 */
import { extractJsonObject, type ChatRequest, type ChatResponse, type LlmClient, type ModelToolCall } from '../../src/core/llm/client.js';

export interface StepDef {
  tool?: string;
  args?: Record<string, unknown>;
  content?: string;
  /** For structured mode: emit this exact (possibly malformed) JSON text. */
  raw?: string;
}

export interface ReviewerScript {
  plan?: unknown;
  steps: StepDef[];
  answer?: unknown;
  critic?: unknown;
  /** Advance the fake clock by this many ms on each batch LLM call. */
  advanceMsPerCall?: number;
}

export interface FakeCall {
  index: number;
  request: ChatRequest;
}

export class FakeLLM implements LlmClient {
  readonly model: string;
  readonly calls: FakeCall[] = [];
  private queue: StepDef[];
  private callNo = 0;

  constructor(
    model: string,
    private readonly script: ReviewerScript,
    private readonly onCall?: (now: () => number) => void,
  ) {
    this.model = model;
    this.queue = [...script.steps];
  }

  private nextStep(): StepDef | undefined {
    return this.queue.shift();
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.callNo++;
    this.calls.push({ index: this.callNo, request: req });
    this.onCall?.(Date.now);
    const system = req.messages.find((m) => m.role === 'system')?.content ?? '';

    // critic
    if (system.includes('strict patch critic')) {
      const v = this.script.critic ?? { verdict: 'confirmed', reason: 'ok' };
      return { content: JSON.stringify(v), toolCalls: [] };
    }
    // plan
    if (req.jsonSchema?.name === 'plan' || req.tools?.some((t) => t.name === 'plan_review_batches')) {
      const doc = this.script.plan ?? { batches: [], skipped: [] };
      if (req.jsonSchema) return { content: JSON.stringify(doc), toolCalls: [] };
      return {
        content: null,
        toolCalls: [
          {
            id: 'plan1',
            name: 'plan_review_batches',
            arguments: JSON.stringify(doc),
          },
        ],
      };
    }
    // summary answer
    if (req.jsonSchema?.name === 'answer' || req.tools?.some((t) => t.name === 'answer')) {
      const facts = extractJsonObject(req.messages.find((m) => m.role === 'user')?.content ?? '')!;
      const reviewed = facts.reviewed_files as string[];
      const skipped = facts.skipped_files as unknown[];
      const doc = this.script.answer ?? {
        status: skipped.length || facts.budget_exhausted ? 'partial' : (facts.findings_accepted as unknown[]).length ? 'findings' : 'clean',
        summary: 'Reviewed all eligible files; no findings.',
        reviewed_files: reviewed,
        skipped_files: skipped,
      };
      if (req.jsonSchema) return { content: JSON.stringify(doc), toolCalls: [] };
      return {
        content: null,
        toolCalls: [{ id: 'ans1', name: 'answer', arguments: JSON.stringify(doc) }],
      };
    }
    // batch step
    const step = this.nextStep();
    if (!step) {
      // Default: complete the batch.
      const user = req.messages.find((m) => m.role === 'user')?.content ?? '';
      const files = [...user.matchAll(/^- (.+) \(/gm)].map((m) => m[1]!);
      const reads = new Set(req.messages.flatMap((m) => {
        const data = extractJsonObject(m.content ?? '');
        const value = data?.result as { path?: string; truncated?: boolean } | undefined;
        return data?.tool === 'read_diff' && data.ok && value?.path && !value.truncated ? [value.path] : [];
      }));
      return this.renderStep({ tool: 'complete_review_batch', args: { summary: 'done (default)',
        reviewed_files: files.filter((f) => reads.has(f)), skipped_files: files.filter((f) => !reads.has(f)).map((file) => ({ file, reason: 'not read' })) } }, req);
    }
    return this.renderStep(step, req);
  }

  private renderStep(step: StepDef, req: ChatRequest): ChatResponse {
    const structured = !!req.jsonSchema;
    if (step.raw !== undefined) {
      return structured
        ? { content: step.raw, toolCalls: [] }
        : { content: null, toolCalls: [{ id: `c${this.callNo}`, name: 'complete_review_batch', arguments: step.raw }] };
    }
    if (step.content !== undefined && !step.tool) {
      return structured ? { content: step.content, toolCalls: [] } : { content: step.content, toolCalls: [] };
    }
    const tool = step.tool ?? 'complete_review_batch';
    const args = step.args ?? {};
    if (structured) {
      return { content: JSON.stringify({ tool, args }), toolCalls: [] };
    }
    const tc: ModelToolCall = {
      id: `call_${this.callNo}_${tool}`,
      name: tool,
      arguments: JSON.stringify(args),
    };
    return { content: null, toolCalls: [tc] };
  }
}

/**
 * Convenience: a reviewer script that reviews every file (read_diff first)
 * and posts the given inline findings, one per step.
 */
export function reviewerScript(params: {
  files: string[];
  findings?: {
    severity: string;
    path: string;
    block: string;
    explanation: string;
    suggestion?: string;
  }[];
  plan?: unknown;
  answer?: unknown;
  critic?: unknown;
}): ReviewerScript {
  const steps: StepDef[] = [];
  for (const f of params.files) {
    steps.push({ tool: 'read_diff', args: { path: f } });
  }
  for (const fnd of params.findings ?? []) {
    steps.push({
      tool: 'post_inline_review_comment',
      args: {
        severity: fnd.severity,
        path: fnd.path,
        block: fnd.block,
        explanation: fnd.explanation,
        ...(fnd.suggestion !== undefined ? { suggestion: fnd.suggestion } : {}),
      },
    });
  }
  steps.push({ tool: 'complete_review_batch', args: { summary: 'batch complete', reviewed_files: params.files, skipped_files: [] } });
  return {
    plan: params.plan,
    steps,
    answer: params.answer,
    critic: params.critic,
  };
}
