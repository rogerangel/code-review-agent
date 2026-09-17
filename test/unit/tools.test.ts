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
import { completeReviewBatchTool, answerTool } from '../../src/core/tools/answer.js';
import { ToolRegistry } from '../../src/core/tools/registry.js';
import { BATCH_TOOL_SPECS, ANSWER_TOOL_SPEC } from '../../src/core/tools/schemas.js';
import { WorkTreeView, type SearchHit } from '../../src/core/repo/view.js';
import { BudgetTracker } from '../../src/core/review/budget.js';
import { LocalSink } from '../../src/core/review/sink.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import type { DiffMap, ToolContext } from '../../src/core/types.js';
import { emptyCallCounts } from '../../src/core/review/pipeline.js';

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
