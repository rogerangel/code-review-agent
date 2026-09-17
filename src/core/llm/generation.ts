/** Operator-owned generation controls. Repository content cannot set these. */
import { LIMITS } from '../security/limits.js';
import type { ChatRequest } from './client.js';

export type LlmPhase = 'probe' | 'planning' | 'review' | 'suggestion-critic' | 'summary';
export type TemplateScalar = string | number | boolean | null;
export interface GenerationOptions {
  maxOutputTokens?: number;
  thinkingTokenBudget?: number;
  chatTemplateKwargs?: Record<string, TemplateScalar>;
  temperature?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
}

const keys = {
  max_output_tokens: 'maxOutputTokens', thinking_token_budget: 'thinkingTokenBudget',
  chat_template_kwargs: 'chatTemplateKwargs', temperature: 'temperature',
  top_p: 'topP', top_k: 'topK', presence_penalty: 'presencePenalty',
} as const;
function fail(): never { throw new Error('invalid llm_options: use only documented generation settings and valid values'); }
const allowedKeys = new Set<string>(Object.values(keys));
const plain = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

export function validateGenerationOptions(options: GenerationOptions = {}): GenerationOptions {
  if (!plain(options) || Object.keys(options).some((key) => !allowedKeys.has(key))) fail();
  const range = (n: unknown, min: number, max: number, integer = false) =>
    n === undefined || (typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max && (!integer || Number.isInteger(n)));
  if (!range(options.maxOutputTokens, 1, LIMITS.maxOutputTokensHard, true) ||
      !range(options.thinkingTokenBudget, 1, LIMITS.maxOutputTokensHard, true) ||
      !range(options.temperature, 0, 2) || !range(options.topP, Number.MIN_VALUE, 1) ||
      !range(options.topK, -1, 1_000_000, true) || !range(options.presencePenalty, -2, 2)) fail();
  if (options.chatTemplateKwargs !== undefined) {
    if (!plain(options.chatTemplateKwargs) || Object.entries(options.chatTemplateKwargs).some(([key, value]) =>
      ['__proto__', 'constructor', 'prototype'].includes(key) ||
      !(value === null || ['string', 'boolean'].includes(typeof value) || (typeof value === 'number' && Number.isFinite(value))))) fail();
  }
  if (JSON.stringify(options).length > LIMITS.maxToolResultChars) fail();
  return { ...options, ...(options.chatTemplateKwargs ? { chatTemplateKwargs: { ...options.chatTemplateKwargs } } : {}) } as GenerationOptions;
}

export function parseGenerationOptions(raw = '{}'): GenerationOptions {
  let value: unknown;
  try { value = JSON.parse(raw || '{}'); } catch { fail(); }
  if (!plain(value)) fail();
  const options: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (!Object.hasOwn(keys, key)) fail();
    options[keys[key as keyof typeof keys]] = val;
  }
  return validateGenerationOptions(options as GenerationOptions);
}

const caps: Record<LlmPhase, number> = { probe: 512, planning: 1024, review: 2048, 'suggestion-critic': 1024, summary: 1536 };

/** Called by the host, before both real clients and programmatic adapters. */
export function applyGenerationPolicy(request: ChatRequest, options: GenerationOptions = {}): ChatRequest {
  const phase = request.phase ?? 'review';
  const cap = phase === 'review' ? options.maxOutputTokens ?? caps.review : Math.min(caps[phase], options.maxOutputTokens ?? caps[phase]);
  const maxTokens = Math.min(request.maxTokens ?? cap, cap);
  const thinking = options.thinkingTokenBudget ?? request.thinkingTokenBudget;
  if (thinking !== undefined && maxTokens < 2) throw new Error('thinking budget requires a completion cap of at least 2 tokens');
  return {
    ...request, phase, maxTokens,
    ...(thinking !== undefined ? { thinkingTokenBudget: Math.min(thinking, Math.floor(maxTokens / 2), phase === 'review' ? thinking : phase === 'probe' ? 128 : 256) } : {}),
    ...(options.chatTemplateKwargs ? { chatTemplateKwargs: { ...request.chatTemplateKwargs, ...options.chatTemplateKwargs } } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.topP !== undefined ? { topP: options.topP } : {}),
    ...(options.topK !== undefined ? { topK: options.topK } : {}),
    ...(options.presencePenalty !== undefined ? { presencePenalty: options.presencePenalty } : {}),
  };
}
