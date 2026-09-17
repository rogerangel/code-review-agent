import { describe, expect, it } from 'vitest';
import { applyGenerationPolicy, parseGenerationOptions, validateGenerationOptions, type LlmPhase } from '../../src/core/llm/generation.js';

describe('operator generation settings', () => {
  it('normalizes the allowlisted wire names and leaves neutral endpoints neutral', () => {
    expect(parseGenerationOptions()).toEqual({});
    expect(parseGenerationOptions('{"max_output_tokens":3072,"thinking_token_budget":1024,"chat_template_kwargs":{"enable_thinking":true},"temperature":1,"top_p":0.95,"top_k":20,"presence_penalty":0}'))
      .toEqual({ maxOutputTokens: 3072, thinkingTokenBudget: 1024, chatTemplateKwargs: { enable_thinking: true }, temperature: 1, topP: 0.95, topK: 20, presencePenalty: 0 });
    const request = applyGenerationPolicy({ messages: [] });
    expect(request.maxTokens).toBe(2048);
    expect(request).not.toHaveProperty('thinkingTokenBudget');
    expect(request).not.toHaveProperty('chatTemplateKwargs');
  });
  it.each([
    'not JSON', 'null', '[]', '{"model":"SECRET"}', '{"messages":[]}', '{"max_output_tokens":0}',
    '{"max_output_tokens":16385}', '{"thinking_token_budget":1.5}', '{"temperature":3}',
    '{"top_p":0}', '{"top_k":1.2}', '{"presence_penalty":3}', '{"chat_template_kwargs":{"nested":{}}}',
    '{"chat_template_kwargs":{"constructor":true}}', '{"__proto__":{"temperature":1}}',
  ])('rejects malformed/disallowed settings without echoing values: %s', (raw) => {
    expect(() => parseGenerationOptions(raw)).toThrow('invalid llm_options');
    try { parseGenerationOptions(raw); } catch (err) { expect((err as Error).message).not.toContain('SECRET'); }
  });
  it('validates typed API options, including non-finite numbers and oversized strings', () => {
    expect(() => validateGenerationOptions({ temperature: NaN })).toThrow();
    expect(() => validateGenerationOptions({ chatTemplateKwargs: { key: 'SECRET'.repeat(4000) } })).toThrow();
    expect(() => validateGenerationOptions(Object.create({ temperature: 1 }))).toThrow();
  });
  it.each([
    ['probe', 512, 128], ['planning', 1024, 256], ['review', 2048, 1024],
    ['suggestion-critic', 1024, 256], ['summary', 1536, 256],
  ] as [LlmPhase, number, number][])('bounds the %s phase', (phase, output, thinking) => {
    const request = applyGenerationPolicy({ messages: [], phase }, { thinkingTokenBudget: 1024 });
    expect(request.maxTokens).toBe(output);
    expect(request.thinkingTokenBudget).toBe(thinking);
  });
  it('operator settings beat phase sampling defaults and never raise other phase ceilings', () => {
    const profile = { maxOutputTokens: 8192, thinkingTokenBudget: 4096, temperature: 1, topP: 0.95, topK: 20 };
    expect(applyGenerationPolicy({ messages: [], phase: 'review', temperature: 0.2 }, profile))
      .toMatchObject({ maxTokens: 8192, thinkingTokenBudget: 4096, temperature: 1, topP: 0.95, topK: 20 });
    expect(applyGenerationPolicy({ messages: [], phase: 'planning', maxTokens: 8000 }, profile).maxTokens).toBe(1024);
    expect(applyGenerationPolicy({ messages: [], phase: 'review' }, { maxOutputTokens: 100, thinkingTokenBudget: 1024 }))
      .toMatchObject({ maxTokens: 100, thinkingTokenBudget: 50 });
  });
  it('rejects a one-token completion cap when explicit thinking cannot leave room for output', () => {
    expect(() => applyGenerationPolicy({ messages: [] }, { maxOutputTokens: 1, thinkingTokenBudget: 1 })).toThrow('at least 2 tokens');
    expect(applyGenerationPolicy({ messages: [] }, { maxOutputTokens: 1 }).maxTokens).toBe(1);
  });
});
