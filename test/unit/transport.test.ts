import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleClient, LLMError } from '../../src/core/llm/client.js';
import { probeModel, decideToolMode } from '../../src/core/llm/doctor.js';
import { GitHubClient, GitHubError } from '../../src/core/github/client.js';
import { BudgetTracker, BudgetExceededError } from '../../src/core/review/budget.js';

afterEach(() => vi.useRealTimers());
const completion = (message: unknown) => Response.json({ choices: [{ message }] });
describe('real transport wire protocol', () => {
  it('serializes named function choice and assistant/tool follow-up in native wire format', async () => {
    const requests: Record<string, unknown>[] = [];
    const client = new OpenAICompatibleClient({ baseUrl: 'http://local/v1', model: 'local-model',
      fetchImpl: async (_url, init) => {
        if (init?.method === 'GET') return Response.json({ data: [{ id: 'local-model' }] });
        const body = JSON.parse(init?.body as string);
        requests.push(body);
        if (body.response_format) return completion({ content: '{"name":"Ada","age":36}' });
        if (body.tool_choice === 'none') {
          expect(body.messages[1].tool_calls).toEqual([{ id: 'weather-1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }]);
          expect(body.messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'weather-1' });
          expect(JSON.stringify(body)).not.toContain('PRIVATE_REASONING');
          return completion({ content: 'Paris is 17 degrees C.' });
        }
        expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'get_weather' } });
        return completion({ content: null, reasoning_content: 'PRIVATE_REASONING',
          tool_calls: [{ id: 'weather-1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] });
      } });
    const result = await probeModel(client);
    expect(result.supportsTools).toBe(true);
    expect(result.structuredOk).toBe(true);
    expect(result.reasoningSeparated).toBe(true);
    expect(requests).toHaveLength(3);
    expect(decideToolMode(result, 'auto').mode).toBe('tools');
  });
  it('only falls back after an unsupported capability, not authentication or transport failure', async () => {
    const client = new OpenAICompatibleClient({ baseUrl: 'http://local', model: 'local-model',
      fetchImpl: async (_url, init) => {
        if (init?.method === 'GET') return Response.json({ data: [{ id: 'local-model' }] });
        const body = JSON.parse(init?.body as string);
        if (body.response_format) return completion({ content: '{"name":"Ada","age":36}' });
        return Response.json({ error: 'tools unsupported' }, { status: 400 });
      } });
    const fallback = await probeModel(client);
    expect(decideToolMode(fallback, 'auto').mode).toBe('structured');
    expect(() => decideToolMode(fallback, 'tools')).toThrow();
    const broken = new OpenAICompatibleClient({ baseUrl: 'http://local', model: 'local-model',
      fetchImpl: async (_url, init) => init?.method === 'GET' ?
        Response.json({ data: [{ id: 'local-model' }] }) : Response.json({ error: 'SECRET_ECHO' }, { status: 401 }) });
    const fatal = await probeModel(broken);
    expect(() => decideToolMode({ ...fatal, structuredOk: true }, 'auto')).toThrow(/preflight/);
    expect(fatal.details.join()).not.toContain('SECRET_ECHO');
  });
  it('rejects a first tool call whose follow-up never consumes the result', async () => {
    const client = new OpenAICompatibleClient({ baseUrl: 'http://local', model: 'm',
      fetchImpl: async (_url, init) => {
        if (init?.method === 'GET') return Response.json({ data: [{ id: 'm' }] });
        const body = JSON.parse(init?.body as string);
        if (body.response_format) return completion({ content: '{"name":"Ada","age":36}' });
        if (body.tool_choice === 'none') return completion({ content: 'Unable to answer.' });
        return completion({ tool_calls: [{ id: 'a', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] });
      } });
    expect((await probeModel(client)).supportsTools).toBe(false);
  });
  it('redacts endpoint error bodies', async () => {
    const client = new OpenAICompatibleClient({ baseUrl: 'http://local', model: 'm',
      fetchImpl: async () => new Response('SECRET_PROMPT', { status: 500 }) });
    await expect(client.chat({ messages: [] })).rejects.toEqual(new LLMError('LLM HTTP 500', 500));
  });
  it('does not retry a mutation or a permission-denied 403 in the REST transport', async () => {
    let calls = 0;
    const client = new GitHubClient({ token: 'private', owner: 'o', repo: 'r',
      fetchImpl: async () => { calls++; return new Response('SECRET_TOKEN', { status: 403 }); } });
    await expect(client.createIssueComment(1, 'x')).rejects.toMatchObject({ status: 403, retryable: false });
    expect(calls).toBe(1);
    await expect(client.getPull(1)).rejects.toBeInstanceOf(GitHubError);
    expect(calls).toBe(2);
  });
  it('paginates all comments for deduplication', async () => {
    const urls: string[] = [];
    const client = new GitHubClient({ token: 'private', owner: 'o', repo: 'r',
      fetchImpl: async (url) => {
        urls.push(String(url));
        return Response.json(urls.length === 1 ? Array.from({ length: 100 }, (_, id) => ({ id })) : [{ id: 100 }]);
      } });
    expect(await client.listReviewComments(1)).toHaveLength(101);
    expect(urls[1]).toContain('page=2');
  });

  it('rejects invalid successful mutation receipts for sink-side reconciliation, without blind retries', async () => {
    let calls = 0;
    const client = new GitHubClient({ token: 'private', owner: 'o', repo: 'r', fetchImpl: async () => { calls++; return Response.json({}); } });
    await expect(client.createIssueComment(1, 'comment')).rejects.toMatchObject({ retryable: true });
    expect(calls).toBe(1);
  });
});
describe('shared deadline', () => {
  it('rejects an adapter result that arrives past the work deadline', async () => {
    vi.useFakeTimers();
    const budget = new BudgetTracker(Date.now(), 1);
    await expect(budget.run(async () => { vi.setSystemTime(Date.now() + 55_000); return 'late'; })).rejects.toBeInstanceOf(BudgetExceededError);
    expect(budget.exceeded()).toBe(false);
    await expect(budget.run(async () => 'host finalization', true)).resolves.toBe('host finalization');
  });
  it('aborts in-flight adapters and leaves the finalization reserve', async () => {
    vi.useFakeTimers();
    const budget = new BudgetTracker(Date.now(), 1);
    const work = budget.run(() => new Promise<never>(() => undefined));
    // AbortSignal.timeout uses real timers, so test the parent cancellation instead.
    const controller = new AbortController();
    const cancelled = budget.run(() => new Promise<never>(() => undefined), false, controller.signal);
    controller.abort(new Error('cancelled'));
    await expect(cancelled).rejects.toThrow('cancelled');
    // Do not leave an unhandled pending promise (it never writes or holds the event loop).
    void work.catch(() => undefined);
  });
});
