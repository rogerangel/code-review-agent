import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  listChangedFilesTool,
  readDiffTool,
  readFileTool,
  listDirectoryTool,
  searchTool,
} from '../../src/core/tools/read-only.js';
import { postInlineReviewCommentTool } from '../../src/core/tools/post-comment.js';
import { completeReviewBatchTool, completeReviewFileTool, answerTool } from '../../src/core/tools/answer.js';
import { ToolRegistry } from '../../src/core/tools/registry.js';
import { BATCH_TOOL_SPECS, ANSWER_TOOL_SPEC } from '../../src/core/tools/schemas.js';
import { WorkTreeView, type SearchHit } from '../../src/core/repo/view.js';
import { BudgetTracker } from '../../src/core/review/budget.js';
import { LocalSink } from '../../src/core/review/sink.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import type { DiffMap, ToolContext } from '../../src/core/types.js';
import { emptyCallCounts } from '../../src/core/review/pipeline.js';
import { LIMITS } from '../../src/core/security/limits.js';
import { compactTranscript, transcriptSize } from '../../src/core/agent/transcript.js';
import type { ChatMessage } from '../../src/core/llm/client.js';

// Typed shapes of the read-only tool payloads (mirrors of the results the
// tools in src/core/tools/read-only.ts return, without reaching for `any`).
interface ReadFileResult {
  path: string;
  content: string;
  totalLines: number;
  truncated: boolean;
}
interface ListDirResult {
  path: string;
  files: string[];
  dirs: string[];
}
interface SearchResult {
  count: number;
  truncated: boolean;
  results: SearchHit[];
}
interface ChangedFileRow {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
  eligible: boolean;
  skipReason?: string;
}
interface ChangedFilesResult {
  count: number;
  files: ChangedFileRow[];
}
interface DiffResult {
  path: string;
  diff: string;
}

let dir = '';
const repos: string[] = [];

afterAll(async () => {
  for (const d of repos.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => undefined);
});

async function makeWorkdir(files: Record<string, string>): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'cra-tools-'));
  repos.push(d);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(d, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }
  return d;
}

function emptyDiff(): DiffMap {
  return {
    baseSha: 'b',
    headSha: 'h',
    files: new Map(),
    hunks: new Map(),
    addedLines: new Map(),
  };
}

function makeCtx(view: WorkTreeView, diff: DiffMap = emptyDiff()): ToolContext {
  return {
    reviewId: 'test',
    diff,
    view,
    options: {
      configPath: '.code-review-agent.yml',
      toolMode: 'tools' as const,
      maxDurationMinutes: 20,
      maxInlineComments: 6,
      failOnSeverity: 'none' as const,
      config: DEFAULT_CONFIG,
    },
    config: DEFAULT_CONFIG,
    instructions: [],
    budget: new BudgetTracker(Date.now(), 20),
    counters: emptyCallCounts(),
    findings: [], operationalErrors: [], diffReads: new Set(), batchFiles: [],
    sink: new LocalSink(),
    llm: { model: 'fake', chat: async () => { throw new Error('no llm in tool tests'); } },
    postState: {
      posted: 0,
      postedFingerprints: new Set<string>(),
      batchIndex: 0,
    },
    signal: new AbortController().signal,
    abortReview: () => undefined,
  };
}

describe('tool schemas', () => {
  it('every batch tool has name, description, and JSON schema params', () => {
    for (const spec of BATCH_TOOL_SPECS) {
      expect(spec.name).toMatch(/^[a-z_]+$/);
      expect(spec.description.length).toBeGreaterThan(10);
      expect(spec.parameters.type).toBe('object');
      expect(spec.parameters.additionalProperties).toBe(false);
    }
    expect(ANSWER_TOOL_SPEC.parameters.required).toContain('status');
  });

  it('registry rejects duplicate registrations and unknown execution', async () => {
    const reg = new ToolRegistry();
    reg.register(listChangedFilesTool);
    expect(() => reg.register(listChangedFilesTool)).toThrow();
    const r = await reg.execute('run_shell_command', {}, makeCtx(new WorkTreeView(dir || os.tmpdir())));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('unknown tool');
  });

  it('no shell/exec tool exists anywhere in the surface', () => {
    const all = new ToolRegistry()
      .register(listChangedFilesTool)
      .register(readDiffTool)
      .register(readFileTool)
      .register(listDirectoryTool)
      .register(searchTool)
      .register(postInlineReviewCommentTool)
      .register(completeReviewBatchTool)
      .register(answerTool)
      .names();
    for (const n of all) {
      expect(/(shell|exec|run_command|bash|terminal|write_file|edit_file)/.test(n)).toBe(false);
    }
  });

  it('validates schema properties as own keys, not inherited constructor/prototype names', () => {
    const registry = new ToolRegistry().register(readFileTool);
    expect(registry.validArguments('read_file', JSON.parse('{"path":"a.ts","__proto__":{"x":1}}'))).toBe(false);
    expect(registry.validArguments('read_file', { path: 'a.ts', constructor: 'not a schema property' })).toBe(false);
    expect(registry.validArguments('read_file', Object.create({ path: 'a.ts' }))).toBe(false);
  });
});

describe('read-only tools (worktree view)', () => {
  beforeAll(async () => {
    dir = await makeWorkdir({
      'src/app.ts': 'export const x = 1;\nexport const y = 2;\n',
      'src/util.py': 'def f():\n    return 1\n',
      'docs/readme.md': '# Hi\n',
    });
  });

  it('read_file returns content and total lines', async () => {
    const r = await readFileTool.execute({ path: 'src/app.ts' }, makeCtx(new WorkTreeView(dir)));
    expect(r.ok).toBe(true);
    const res = r.result as ReadFileResult;
    expect(res.totalLines).toBe(2);
    expect(res.content).toContain('export const x = 1;');
  });

  it('read_file honors line ranges', async () => {
    const r = await readFileTool.execute({ path: 'src/app.ts', start_line: 2, end_line: 2 }, makeCtx(new WorkTreeView(dir)));
    expect(r.ok).toBe(true);
    expect((r.result as ReadFileResult).content).toBe('export const y = 2;');
  });

  it('advances blank-only file pages and distinguishes empty files', async () => {
    const root = await makeWorkdir({ 'blank.txt': '\n\n', 'empty.txt': '' });
    const ctx = makeCtx(new WorkTreeView(root));
    const first = await readFileTool.execute({ path: 'blank.txt', end_line: 1 }, ctx);
    expect(first.result).toMatchObject({ content: '', totalLines: 2, end_line: 1, has_more: true, next_start_line: 2 });
    const last = await readFileTool.execute({ path: 'blank.txt', start_line: 2 }, ctx);
    expect(last.result).toMatchObject({ content: '', end_line: 2, has_more: false });
    const empty = await readFileTool.execute({ path: 'empty.txt' }, ctx);
    expect(empty.result).toMatchObject({ content: '', totalLines: 0, end_line: 0, has_more: false });
  });

  it('read_file rejects path escapes', async () => {
    const r = await readFileTool.execute({ path: '../../etc/passwd' }, makeCtx(new WorkTreeView(dir)));
    expect(r.ok).toBe(false);
    const r2 = await readFileTool.execute({ path: '/etc/passwd' }, makeCtx(new WorkTreeView(dir)));
    expect(r2.ok).toBe(false);
  });

  it('read_file rejects missing files with not-found', async () => {
    const r = await readFileTool.execute({ path: 'nope.ts' }, makeCtx(new WorkTreeView(dir)));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('not found');
  });

  it('list_directory lists files and dirs', async () => {
    const r = await listDirectoryTool.execute({ path: 'src' }, makeCtx(new WorkTreeView(dir)));
    expect(r.ok).toBe(true);
    expect((r.result as ListDirResult).files).toEqual(['app.ts', 'util.py']);
  });

  it('search finds literal text and regex', async () => {
    const literal = await searchTool.execute({ pattern: 'return 1' }, makeCtx(new WorkTreeView(dir)));
    expect((literal.result as SearchResult).count).toBeGreaterThanOrEqual(1);
    const re = await searchTool.execute({ pattern: '^export const', regex: true }, makeCtx(new WorkTreeView(dir)));
    expect((re.result as SearchResult).count).toBe(2);
  });

  it('list_changed_files reports eligibility', async () => {
    const diff: DiffMap = {
      ...emptyDiff(),
      files: new Map([
        ['src/app.ts', { path: 'src/app.ts', status: 'modified', additions: 1, deletions: 0, isBinary: false, lines: 2 }],
        ['yarn.lock', { path: 'yarn.lock', status: 'modified', additions: 1, deletions: 1, isBinary: false, lines: 10 }],
      ]),
      addedLines: new Map([['src/app.ts', new Set([2])]]),
    };
    const r = await listChangedFilesTool.execute({}, makeCtx(new WorkTreeView(dir), diff));
    const files = (r.result as ChangedFilesResult).files;
    const app = files.find((f) => f.path === 'src/app.ts')!;
    const lock = files.find((f) => f.path === 'yarn.lock')!;
    expect(app.eligible).toBe(true);
    expect(lock.eligible).toBe(false);
    expect(lock.skipReason).toContain('lock-file');
  });

  it('read_diff rejects non-changed files', async () => {
    const r = await readDiffTool.execute({ path: 'docs/readme.md' }, makeCtx(new WorkTreeView(dir)));
    expect(r.ok).toBe(false);
  });

  it('read_diff returns the diff for a changed file', async () => {
    const diff: DiffMap = {
      ...emptyDiff(),
      files: new Map([
        ['src/app.ts', { path: 'src/app.ts', status: 'modified', additions: 1, deletions: 0, isBinary: false, lines: 2 }],
      ]),
      hunks: new Map([
        [
          'src/app.ts',
          [
            {
              header: '@@ -1,1 +1,2 @@',
              oldStart: 1,
              oldCount: 1,
              newStart: 1,
              newCount: 2,
              lines: [
                { kind: 'context', content: 'export const x = 1;', newLine: 1, oldLine: 1 },
                { kind: 'add', content: 'export const y = 2;', newLine: 2, oldLine: null },
              ],
            },
          ],
        ],
      ]),
      addedLines: new Map([['src/app.ts', new Set([2])]]),
    };
    const r = await readDiffTool.execute({ path: 'src/app.ts' }, makeCtx(new WorkTreeView(dir), diff));
    expect((r.result as DiffResult).diff).toContain('+export const y = 2;');
  });
});

describe('bounded repository context and checkpoints', () => {
  function changed(lines: string[]): DiffMap {
    return { ...emptyDiff(), files: new Map([['a.ts', { path: 'a.ts', status: 'added', additions: lines.length, deletions: 0, isBinary: false, lines: lines.length }]]),
      hunks: new Map([['a.ts', [{ header: `@@ -0,0 +1,${lines.length} @@`, oldStart: 0, oldCount: 0, newStart: 1, newCount: lines.length,
        lines: lines.map((content, i) => ({ kind: 'add', content, oldLine: null, newLine: i + 1 })) }]]]),
      addedLines: new Map([['a.ts', new Set(lines.map((_, i) => i + 1))]]) };
  }
  it('requires all diff pages, not just the last page, to earn completion proof', async () => {
    const ctx = makeCtx(new WorkTreeView(os.tmpdir()), changed(Array.from({ length: 200 }, (_, i) => `const x${i} = "${'x'.repeat(400)}";`)));
    ctx.batchFiles = ['a.ts'];
    const last = await readDiffTool.execute({ path: 'a.ts', offset: 200 }, ctx);
    expect(last.ok).toBe(true);
    expect(ctx.diffReads.has('a.ts')).toBe(false);
    expect((await completeReviewFileTool.execute({ path: 'a.ts', summary: 'done' }, ctx)).ok).toBe(false);
    ctx.diffReadPages = new Map();
    let offset = 0, pages = 0;
    for (;;) {
      const output = await readDiffTool.execute({ path: 'a.ts', offset }, ctx);
      expect(output.ok).toBe(true);
      expect(JSON.stringify(output).length + 128).toBeLessThanOrEqual(LIMITS.maxToolResultChars);
      const page = output.result as { has_more: boolean; next_offset?: number; truncated: boolean };
      expect(page.truncated).toBe(false);
      pages++;
      if (!page.has_more) break;
      expect(ctx.diffReads.has('a.ts')).toBe(false);
      offset = page.next_offset!;
    }
    expect(pages).toBeGreaterThan(1);
    expect(ctx.diffReads.has('a.ts')).toBe(true);
    expect((await completeReviewFileTool.execute({ path: 'a.ts', summary: 'No actionable findings.' }, ctx)).ok).toBe(true);
    expect(ctx.fileCompletions?.has('a.ts')).toBe(true);
    expect((await completeReviewBatchTool.execute({ summary: 'done', reviewed_files: [], skipped_files: [{ file: 'a.ts', reason: 'skip' }] }, ctx)).ok).toBe(false);
  });
  it('never treats an oversized individual diff line as fully delivered', async () => {
    const ctx = makeCtx(new WorkTreeView(os.tmpdir()), changed(['x'.repeat(30_000)]));
    const first = await readDiffTool.execute({ path: 'a.ts' }, ctx);
    const output = await readDiffTool.execute({ path: 'a.ts', offset: (first.result as { next_offset: number }).next_offset }, ctx);
    expect((output.result as { truncated: boolean }).truncated).toBe(true);
    expect(JSON.stringify(output).length).toBeLessThan(LIMITS.maxToolResultChars);
    expect(ctx.diffReads.has('a.ts')).toBe(false);
  });
  it('bounds file reads to 200 lines with honest continuation and oversized-line metadata', async () => {
    const root = await makeWorkdir({ 'a.ts': Array.from({ length: 350 }, (_, i) => `line ${i + 1}`).join('\n'), 'huge.ts': 'x'.repeat(30_000) });
    const ctx = makeCtx(new WorkTreeView(root));
    const first = (await readFileTool.execute({ path: 'a.ts' }, ctx)).result as Record<string, unknown>;
    expect(first).toMatchObject({ start_line: 1, end_line: 200, next_start_line: 201, has_more: true, truncated: false });
    const second = (await readFileTool.execute({ path: 'a.ts', start_line: 201, end_line: 350 }, ctx)).result as Record<string, unknown>;
    expect(second).toMatchObject({ end_line: 350, has_more: false });
    const huge = await readFileTool.execute({ path: 'huge.ts' }, ctx);
    expect((huge.result as Record<string, unknown>).truncated).toBe(true);
    expect(JSON.stringify(huge).length).toBeLessThan(LIMITS.maxToolResultChars);
  });
  it('bounds search snippets around the match and marks result omission', async () => {
    const root = await makeWorkdir({ 'long.ts': 'x'.repeat(5000) + 'needle' + 'y'.repeat(5000),
      'many.ts': Array.from({ length: 100 }, () => 'needle' + 'z'.repeat(1000)).join('\n') });
    const output = await searchTool.execute({ pattern: 'needle' }, makeCtx(new WorkTreeView(root)));
    const res = output.result as { truncated: boolean; results: (SearchHit & { textTruncated?: boolean })[] };
    expect(res.truncated).toBe(true);
    expect(JSON.stringify(output).length + 128).toBeLessThanOrEqual(LIMITS.maxToolResultChars);
    for (const hit of res.results) {
      expect(hit.text.length).toBeLessThanOrEqual(512);
      expect(hit.text).toContain('needle');
      expect(hit.textTruncated).toBe(true);
    }
  });
  it('paginates directory and changed-file listings without losing entries', async () => {
    const ctx = makeCtx(new WorkTreeView(os.tmpdir()));
    ctx.view = { ...ctx.view, listDirectory: async () => ({ dirs: [], files: Array.from({ length: 400 }, (_, i) => `${i}-${'x'.repeat(100)}.ts`) }) };
    let offset = 0;
    const names: string[] = [];
    for (;;) {
      const output = await listDirectoryTool.execute({ path: '', offset }, ctx);
      const page = output.result as { files: string[]; has_more: boolean; next_offset?: number };
      names.push(...page.files);
      expect(JSON.stringify(output).length + 128).toBeLessThanOrEqual(LIMITS.maxToolResultChars);
      if (!page.has_more) break;
      offset = page.next_offset!;
    }
    expect(new Set(names).size).toBe(400);
    ctx.diff.files = new Map(names.map((path) => [path, { path, status: 'added', additions: 1, deletions: 0, isBinary: false, lines: 1 }]));
    const output = await listChangedFilesTool.execute({}, ctx);
    expect((output.result as { count: number; has_more: boolean }).count).toBe(400);
    expect((output.result as { has_more: boolean }).has_more).toBe(true);
    expect(JSON.stringify(output).length + 128).toBeLessThanOrEqual(LIMITS.maxToolResultChars);
  });
});

describe('deterministic transcript compaction', () => {
  it.each(['tools', 'structured'])('keeps base rules and complete recent exchanges in %s mode', (mode) => {
    const ctx = makeCtx(new WorkTreeView(os.tmpdir()));
    ctx.batchFiles = ['a.ts', 'b.ts'];
    ctx.diffReads.add('a.ts');
    ctx.fileCompletions = new Map([['a.ts', { summary: 'PRIVATE_MODEL_TEXT', batchIndex: 0 }]]);
    ctx.performance = { llmCalls: [], toolResultChars: 0, transcriptCompactions: 0 };
    const messages: ChatMessage[] = [{ role: 'system', content: 'IMMUTABLE_RULES' }, { role: 'user', content: 'INITIAL_TASK' }];
    for (let i = 0; i < 20; i++) {
      messages.push({ role: 'assistant', content: mode === 'structured' ? '{"tool":"read_file","args":{"path":"a.ts"}}' : null,
        ...(mode === 'tools' ? { tool_calls: [{ id: `call-${i}`, name: 'read_file', arguments: '{"path":"a.ts"}' }] } : {}) });
      messages.push({ role: mode === 'tools' ? 'tool' : 'user', content: `${i === 0 ? 'OLD_EVIDENCE' : ''}${'x'.repeat(10_000)}`,
        ...(mode === 'tools' ? { tool_call_id: `call-${i}` } : {}) });
    }
    expect(compactTranscript(messages, [], ctx)).toBe(true);
    expect(messages.slice(0, 2).map((m) => m.content)).toEqual(['IMMUTABLE_RULES', 'INITIAL_TASK']);
    expect(transcriptSize(messages, [])).toBeLessThan(LIMITS.transcriptCompactChars);
    expect(JSON.stringify(messages)).toContain('reread necessary evidence');
    expect(JSON.stringify(messages)).toContain('completed_files');
    expect(JSON.stringify(messages)).not.toContain('OLD_EVIDENCE');
    expect(JSON.stringify(messages)).not.toContain('PRIVATE_MODEL_TEXT');
    if (mode === 'tools') {
      const calls = messages.flatMap((m) => m.tool_calls?.map((c) => c.id) ?? []);
      const replies = messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
      expect(calls).toEqual(replies);
      expect(calls).toEqual(['call-18', 'call-19']);
    }
    expect(ctx.performance.transcriptCompactions).toBe(1);
  });
  it('refuses an oversized immutable prompt rather than dropping rules', () => {
    const ctx = makeCtx(new WorkTreeView(os.tmpdir()));
    const messages: ChatMessage[] = [{ role: 'system', content: 'x'.repeat(210_000) }, { role: 'user', content: 'task' }];
    expect(compactTranscript(messages, [], ctx)).toBe(false);
    expect(messages[0]!.content).toHaveLength(210_000);
  });
});
