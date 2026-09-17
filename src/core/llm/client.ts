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

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON schema for the tool arguments. */
  parameters: Record<string, unknown>;
}

export interface ModelToolCall {
  id: string;
  name: string;
  /** Raw JSON string as returned by the model. */
  arguments: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ModelToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ChatResponse {
  content: string | null;
  toolCalls: ModelToolCall[];
  /** Model reasoning, kept out of the transcript by the caller. */
  reasoning?: string;
  finishReason?: string;
  usage?: { promptTokens?: number; completionTokens?: number; reasoningTokens?: number; cachedPromptTokens?: number };
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  toolChoice?: 'auto' | 'none' | { function: { name: string } };
  /** When set, response_format json_schema is used and `tools` must be omitted. */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  temperature?: number;
  maxTokens?: number;
  /** Host-only metadata, never serialized to the inference API. */
  phase?: import('./generation.js').LlmPhase;
  thinkingTokenBudget?: number;
  chatTemplateKwargs?: Record<string, import('./generation.js').TemplateScalar>;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  signal?: AbortSignal;
}

/** Wire shape of an OpenAI-compatible chat completion response. */
export interface WireToolCallFunction {
  name?: string;
  arguments?: unknown;
}

export interface WireToolCall {
  id?: string;
  function?: WireToolCallFunction;
}

export interface WireMessage {
  role?: string;
  content?: string | null;
  tool_calls?: WireToolCall[];
  /** Some providers (e.g. Qwen via vLLM) return chain-of-thought here. */
  reasoning_content?: string;
  reasoning?: string;
}

export interface WireChoice {
  message?: WireMessage;
  finish_reason?: string;
}

export interface WireUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
  prompt_tokens_details?: { cached_tokens?: number };
}

export interface WireChatCompletion {
  choices?: WireChoice[];
  usage?: WireUsage;
}

/**
 * Structural LLM interface used by the pipeline, tools, and planner.
 * OpenAICompatibleClient implements it; tests and (later) adapters can too.
 */
export interface LlmClient {
  readonly model: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
}

export class LLMError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LLMError';
  }
}

export interface LLMClientOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  budget?: import('../review/budget.js').BudgetTracker;
}

export class OpenAICompatibleClient implements LlmClient {
  /** Chat completions endpoint (safe to log; contains no credentials). */
  readonly endpoint: string;
  private readonly modelsUrl: string;
  private readonly fetchImpl: typeof fetch;

  readonly model: string;

  constructor(private readonly opts: LLMClientOptions) {
    const address = new URL(opts.baseUrl);
    if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password || address.search || address.hash) {
      throw new LLMError('base URL must be HTTP(S) without credentials, query, or fragment');
    }
    let base = opts.baseUrl.trim().replace(/\/+$/, '');
    if (!/\/v1$/.test(base)) base = `${base}/v1`;
    this.endpoint = `${base}/chat/completions`;
    this.modelsUrl = `${base}/models`;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.model = opts.model;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    const key = this.opts.apiKey ?? 'EMPTY';
    h.Authorization = `Bearer ${key}`;
    return h;
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const res = await this.requestJson<{ data?: { id: string }[] }>(this.modelsUrl, {}, signal);
    return (res.data ?? []).map((m) => m.id);
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: this.opts.model,
      messages: req.messages.map((message) => ({
        ...message,
        ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call) => ({
          id: call.id, type: 'function',
          function: { name: call.name, arguments: call.arguments },
        })) } : {}),
      })),
      stream: false,
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (req.thinkingTokenBudget !== undefined) body.thinking_token_budget = req.thinkingTokenBudget;
    if (req.chatTemplateKwargs !== undefined) body.chat_template_kwargs = req.chatTemplateKwargs;
    if (req.topP !== undefined) body.top_p = req.topP;
    if (req.topK !== undefined) body.top_k = req.topK;
    if (req.presencePenalty !== undefined) body.presence_penalty = req.presencePenalty;
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = typeof req.toolChoice === 'object'
        ? { type: 'function', function: req.toolChoice.function }
        : req.toolChoice ?? 'auto';
    }
    if (req.jsonSchema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: req.jsonSchema.name, schema: req.jsonSchema.schema },
      };
    }
    const res = await this.requestJson<WireChatCompletion>(this.endpoint, body, req.signal);
    const choice = res.choices?.[0];
    if (!choice) throw new LLMError('model returned no choices');
    const msg: WireMessage = choice.message ?? {};
    const toolCalls: ModelToolCall[] = [];
    for (const tc of msg.tool_calls ?? []) {
      toolCalls.push({
        id: tc.id ?? `call_${toolCalls.length}`,
        name: tc.function?.name ?? '',
        arguments:
          typeof tc.function?.arguments === 'string'
            ? tc.function.arguments
            : JSON.stringify(tc.function?.arguments ?? {}),
      });
    }
    return {
      content: typeof msg.content === 'string' ? msg.content : null,
      toolCalls,
      reasoning: typeof msg.reasoning === 'string' ? msg.reasoning : typeof msg.reasoning_content === 'string' ? msg.reasoning_content : undefined,
      finishReason: choice.finish_reason,
      usage: res.usage
        ? {
            promptTokens: tokenCount(res.usage.prompt_tokens),
            completionTokens: tokenCount(res.usage.completion_tokens),
            reasoningTokens: tokenCount(res.usage.completion_tokens_details?.reasoning_tokens),
            cachedPromptTokens: tokenCount(res.usage.prompt_tokens_details?.cached_tokens),
          }
        : undefined,
    };
  }

  private async requestJson<T>(url: string, body: unknown, parent?: AbortSignal): Promise<T> {
    const timeoutMs = this.opts.timeoutMs ?? 10 * 60 * 1000;
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (parent) signals.push(parent);
    if (this.opts.budget) signals.push(this.opts.budget.signal(true));
    const signal = AbortSignal.any(signals);
    signal.throwIfAborted();
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: url === this.modelsUrl ? 'GET' : 'POST',
        headers: this.headers(),
        body: url === this.modelsUrl ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (err) {
      const name = (err as Error)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new LLMError(`LLM request timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
      throw new LLMError('LLM endpoint unreachable');
    }
    if (!res.ok) {
      const status = res.status;
      await res.body?.cancel().catch(() => undefined);
      if (status === 401 || status === 403) {
        throw new LLMError(`LLM authentication failed (HTTP ${status})`, status);
      }
      // Error bodies can echo prompts or secrets: retain only the status.
      throw new LLMError(`LLM HTTP ${status}`, status);
    }
    const text = await safeReadBody(res);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new LLMError('LLM returned non-JSON response');
    }
  }
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

async function safeReadBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/**
 * Parse model tool-call arguments defensively. Returns null on malformed JSON.
 */
export function parseToolArgs(rawArgs: string): Record<string, unknown> | null {
  if (!rawArgs || rawArgs.trim() === '') return {};
  try {
    const v = JSON.parse(rawArgs);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Extract a JSON object from a model's free-form content (structured fallback
 * and critic parsing). Tolerates leading prose and trailing punctuation.
 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  if (!text) return null;
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          const v = JSON.parse(text.slice(start, i + 1));
          return typeof v === 'object' && v !== null && !Array.isArray(v) ? v : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Build the JSON schema used in structured-output fallback mode: one step
 * per call, naming the tool to invoke and its arguments.
 */
export function stepSchema(toolNames: string[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      tool: { type: 'string', enum: toolNames },
      args: { type: 'object', additionalProperties: true },
    },
    required: ['tool', 'args'],
    additionalProperties: false,
  };
}
