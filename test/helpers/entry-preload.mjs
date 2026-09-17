/** Test-only mock HTTP boundary for spawned entrypoints. Never used by production. */
import { readFileSync, appendFileSync } from 'node:fs';
import process from 'node:process';
const scenario = JSON.parse(readFileSync(process.env.CRA_TEST_SCENARIO, 'utf8'));
let batchStep = 0;
const issues = [], inline = [];
const json = (data, status = 200) => globalThis.Response.json(data, { status });
const call = (name, args) => json({ choices: [{ message: { content: null, tool_calls: [
  { id: 'c' + (++batchStep), type: 'function', function: { name, arguments: JSON.stringify(args) } },
] } }] });
const prose = (content) => json({ choices: [{ message: { content } }] });
globalThis.fetch = async (input, options = {}) => {
  const url = String(input), method = options.method ?? 'GET';
  const body = options.body ? JSON.parse(options.body) : undefined;
  appendFileSync(process.env.CRA_TEST_HTTP_LOG, JSON.stringify({ url, method, body }) + '\n');
  if (url.startsWith('https://api.test')) {
    if (url.includes('/collaborators/')) return json({ permission: scenario.permission ?? 'write' });
    if (/\/pulls\/7$/.test(url)) return json(scenario.pull);
    if (url.endsWith('/user')) return json({ login: 'github-actions[bot]' });
    if (url.includes('/pulls/7/comments')) {
      if (method === 'GET') return json(inline);
      if (scenario.inlineError) return json({ message: 'denied' }, scenario.inlineError);
      const c = { ...body, id: inline.length + 1, html_url: 'https://github.com/o/r/pull/7#c1', user: { login: 'github-actions[bot]' } };
      inline.push(c);
      return json(c, 201);
    }
    if (url.includes('/issues/7/comments')) {
      if (method === 'GET') return json(issues);
      const c = { ...body, id: issues.length + 1, html_url: 'https://github.com/o/r/issues/7#summary', user: { login: 'github-actions[bot]' } };
      issues.push(c);
      return json(c, 201);
    }
  }
  if (url.startsWith('http://llm.test')) {
    if (url.endsWith('/models')) return json({ data: [{ id: 'test-model' }] });
    if (scenario.llmError) return json({ error: 'secret echo' }, scenario.llmError);
    if (body.messages?.[0]?.content === 'Reply with OK only.') return prose('OK');
    if (body.response_format?.json_schema?.name === 'person') return prose('{"name":"Ada","age":36}');
    if (body.tool_choice?.function?.name === 'get_weather') return call('get_weather', { city: 'Paris' });
    if (body.tool_choice === 'none') return prose('It is 17 C.');
    if (body.tools?.some((tool) => tool.function.name === 'plan_review_batches')) return call('plan_review_batches', {
      batches: [{ files: ['src/a.ts'], notes: 'review a' }], skipped: [],
    });
    if (body.tools?.some((tool) => tool.function.name === 'answer')) return call('answer', {
      status: 'findings', summary: 'The introduced arithmetic issue should be addressed.', reviewed_files: ['src/a.ts'], skipped_files: [],
    });
    const transcript = JSON.stringify(body.messages);
    if (!transcript.includes('"name":"read_diff"')) return call('read_diff', { path: 'src/a.ts' });
    if (!transcript.includes('"name":"post_inline_review_comment"')) return call('post_inline_review_comment', {
      severity: 'high', path: 'src/a.ts', block: 'export const b = a + 1;', explanation: 'This arithmetic change can cause incorrect behavior.',
    });
    return call('complete_review_batch', { summary: 'done', reviewed_files: ['src/a.ts'], skipped_files: [] });
  }
  throw new Error('unexpected mocked request: ' + method + ' ' + url);
};
