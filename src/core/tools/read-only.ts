/**
 * Junie-style read-only repository tools:
 *   list_changed_files, read_diff, read_file, list_directory, search
 *
 * All access flows through the RepoView, which enforces path confinement,
 * no-symlink-following, and size caps.
 */
import { renderFileDiff } from '../diff/normalize.js';
import { LIMITS } from '../security/limits.js';
import { normalizeRepoPath } from '../security/paths.js';
import { truncate } from '../util.js';
import { classifyAll } from '../filtering/eligibility.js';
import type { ToolResult } from '../types.js';
import { asArgs, requireString, type Tool } from './registry.js';
import { BATCH_TOOL_SPECS, TOOL_NAMES } from './schemas.js';

const specOf = (name: string) =>
  BATCH_TOOL_SPECS.find((s) => s.name === name) as (typeof BATCH_TOOL_SPECS)[number];

// Reserve room for the runner's tool-name envelope, too.
const fits = (result: unknown) => JSON.stringify({ ok: true, result }).length + 128 <= LIMITS.maxToolResultChars;
const bounded = (result: unknown): ToolResult => fits(result) ? { ok: true, result } :
  { ok: false, result: null, error: 'tool metadata exceeds the bounded result limit; use a narrower path' };
const offsetOf = (args: Record<string, unknown>) => typeof args.offset === 'number' && Number.isSafeInteger(args.offset) && args.offset >= 0 ? args.offset : 0;

function listPage<T>(rows: T[], offset: number, result: (page: T[], next?: number) => unknown): ToolResult {
  if (offset > rows.length) return { ok: false, result: null, error: 'offset exceeds available entries' };
  const page: T[] = [];
  for (let i = offset; i < rows.length; i++) {
    page.push(rows[i]!);
    if (!fits(result(page, i + 1 < rows.length ? i + 1 : undefined))) { page.pop(); break; }
  }
  if (!page.length && offset < rows.length) return { ok: false, result: null, error: 'one entry exceeds the bounded result limit' };
  return bounded(result(page, offset + page.length < rows.length ? offset + page.length : undefined));
}

export const listChangedFilesTool: Tool = {
  spec: specOf(TOOL_NAMES.listChangedFiles),
  async execute(args, ctx): Promise<ToolResult> {
    const elig = classifyAll(
      [...ctx.diff.files.values()].map((f) => ({ path: f.path, isBinary: f.isBinary })),
      ctx.config,
    );
    const rows = [...ctx.diff.files.values()].map((f) => ({
      path: f.path,
      status: f.status,
      ...(f.previousPath ? { previousPath: f.previousPath } : {}),
      additions: f.additions,
      deletions: f.deletions,
      binary: f.isBinary,
      eligible: elig.get(f.path)?.eligible ?? false,
      ...(elig.get(f.path) && !(elig.get(f.path)?.eligible)
        ? { skipReason: elig.get(f.path)?.reason }
        : {}),
    }));
    const offset = offsetOf(args);
    return listPage(rows, offset, (files, next) => ({ count: rows.length, offset, files, has_more: next !== undefined, ...(next !== undefined ? { next_offset: next } : {}) }));
  },
};

export const readDiffTool: Tool = {
  spec: specOf(TOOL_NAMES.readDiff),
  async execute(args, ctx): Promise<ToolResult> {
    const a = asArgs(args);
    const p = requireString(a, 'path');
    if (!p) return { ok: false, result: null, error: 'missing required argument "path"' };
    const norm = normalizeRepoPath(p);
    if (!norm) {
      return { ok: false, result: null, error: `invalid or escaping path "${p}"` };
    }
    if (!ctx.diff.files.has(norm)) {
      return { ok: false, result: null, error: `"${norm}" is not a changed file in this target` };
    }
    const text = renderFileDiff(ctx.diff, norm);
    if (text === null) {
      return { ok: false, result: null, error: `no diff available for "${norm}"` };
    }
    const tooLarge = text.length > LIMITS.maxDiffCharsPerFile;
    const lines = truncate(text, LIMITS.maxDiffCharsPerFile).split('\n');
    const offset = offsetOf(a);
    if (offset >= lines.length) return { ok: false, result: null, error: 'offset exceeds available diff lines' };
    const page: string[] = [];
    const payload = (end: number, truncated = tooLarge) => ({ path: norm, diff: page.join('\n'), offset,
      total_lines: lines.length, truncated, has_more: end < lines.length, ...(end < lines.length ? { next_offset: end } : {}) });
    for (let i = offset; i < lines.length; i++) {
      page.push(lines[i]!);
      if (!fits(payload(i + 1))) { page.pop(); break; }
    }
    let shortened = false;
    if (!page.length) { page.push(truncate(lines[offset]!, 1500)); shortened = true; }
    const end = offset + page.length;
    const output = bounded(payload(end, tooLarge || shortened));
    if (output.ok && !tooLarge && !shortened) {
      ctx.diffReadPages ??= new Map();
      const delivered = ctx.diffReadPages.get(norm) ?? new Set<number>();
      for (let i = offset; i < end; i++) delivered.add(i);
      ctx.diffReadPages.set(norm, delivered);
      if (delivered.size === lines.length) ctx.diffReads.add(norm);
    }
    return output;
  },
};

export const readFileTool: Tool = {
  spec: specOf(TOOL_NAMES.readFile),
  async execute(args, ctx): Promise<ToolResult> {
    const a = asArgs(args);
    const p = requireString(a, 'path');
    if (!p) return { ok: false, result: null, error: 'missing required argument "path"' };
    const start = typeof a.start_line === 'number' ? Math.trunc(a.start_line) : 1;
    const requestedEnd = typeof a.end_line === 'number' ? Math.trunc(a.end_line) : start + LIMITS.maxReadFileLinesPerCall - 1;
    if (start < 1 || requestedEnd < start) {
      return { ok: false, result: null, error: 'end_line must be >= start_line' };
    }
    try {
      const endLine = Math.min(requestedEnd, start + LIMITS.maxReadFileLinesPerCall - 1);
      const res = await ctx.view.read(p, { startLine: start, endLine });
      // An empty string may represent a real blank line, not an empty file.
      const lines = start <= Math.min(endLine, res.totalLines) ? res.content.split('\n') : [];
      const page: string[] = [];
      const payload = (shortened = false) => {
        const end = page.length ? start + page.length - 1 : Math.min(start - 1, res.totalLines);
        return { path: normalizeRepoPath(p) ?? p, content: page.join('\n'), totalLines: res.totalLines,
          start_line: start, end_line: end, truncated: res.truncated || shortened,
          has_more: end < res.totalLines, ...(end < res.totalLines ? { next_start_line: end + 1 } : {}) };
      };
      for (const line of lines) { page.push(line); if (!fits(payload())) { page.pop(); break; } }
      const shortened = !page.length && lines.length > 0;
      if (shortened) page.push(truncate(lines[0]!, 1500));
      return bounded(payload(shortened));
    } catch (err) {
      const e = err as { message?: string; name?: string };
      if (e.name === 'ViewError') {
        return { ok: false, result: null, error: e.message };
      }
      throw err;
    }
  },
};

export const listDirectoryTool: Tool = {
  spec: specOf(TOOL_NAMES.listDirectory),
  async execute(args, ctx): Promise<ToolResult> {
    const a = asArgs(args);
    const p = requireString(a, 'path') ?? '';
    try {
      const res = await ctx.view.listDirectory(p);
      const rows = [...res.dirs.map((name) => ({ name, kind: 'dir' })), ...res.files.map((name) => ({ name, kind: 'file' }))];
      const offset = offsetOf(a);
      return listPage(rows, offset, (page, next) => ({ path: p || '.', offset,
        files: page.filter((row) => row.kind === 'file').map((row) => row.name), dirs: page.filter((row) => row.kind === 'dir').map((row) => row.name),
        has_more: next !== undefined, ...(next !== undefined ? { next_offset: next } : {}) }));
    } catch (err) {
      const e = err as { message?: string; name?: string };
      if (e.name === 'ViewError') return { ok: false, result: null, error: e.message };
      throw err;
    }
  },
};

export const searchTool: Tool = {
  spec: specOf(TOOL_NAMES.search),
  async execute(args, ctx): Promise<ToolResult> {
    const a = asArgs(args);
    const pattern = requireString(a, 'pattern');
    if (!pattern || pattern.length === 0) {
      return { ok: false, result: null, error: 'missing required argument "pattern"' };
    }
    if (pattern.length > 400) {
      return { ok: false, result: null, error: 'pattern too long (max 400 chars)' };
    }
    const dir = requireString(a, 'dir') ?? '';
    try {
      const res = await ctx.view.search(pattern, {
        dir,
        regex: a.regex === true,
      });
      const results: { path: string; line: number; text: string; textTruncated?: boolean }[] = [];
      let truncated = res.truncated;
      for (const hit of res.results) {
        const match = a.regex === true ? hit.text.search(new RegExp(pattern)) : hit.text.indexOf(pattern);
        const begin = Math.max(0, match - Math.floor(LIMITS.maxSearchSnippetChars / 2));
        results.push({ ...hit, text: hit.text.slice(begin, begin + LIMITS.maxSearchSnippetChars),
          ...(hit.text.length > LIMITS.maxSearchSnippetChars ? { textTruncated: true } : {}) });
        if (!fits({ count: results.length, truncated, results })) { results.pop(); truncated = true; break; }
      }
      return bounded({ count: results.length, truncated, results });
    } catch (err) {
      const e = err as { message?: string; name?: string };
      if (e.name === 'ViewError') return { ok: false, result: null, error: e.message };
      throw err;
    }
  },
};
