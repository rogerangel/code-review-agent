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

export const listChangedFilesTool: Tool = {
  spec: specOf(TOOL_NAMES.listChangedFiles),
  async execute(_args, ctx): Promise<ToolResult> {
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
    return { ok: true, result: { count: rows.length, files: rows } };
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
    const truncated = text.length > LIMITS.maxDiffCharsPerFile;
    if (!truncated) ctx.diffReads.add(norm);
    return {
      ok: true,
      result: {
        path: norm,
        diff: truncate(text, LIMITS.maxDiffCharsPerFile),
        truncated,
      },
    };
  },
};

export const readFileTool: Tool = {
  spec: specOf(TOOL_NAMES.readFile),
  async execute(args, ctx): Promise<ToolResult> {
    const a = asArgs(args);
    const p = requireString(a, 'path');
    if (!p) return { ok: false, result: null, error: 'missing required argument "path"' };
    const start = typeof a.start_line === 'number' ? Math.trunc(a.start_line) : undefined;
    const end = typeof a.end_line === 'number' ? Math.trunc(a.end_line) : undefined;
    if (start !== undefined && end !== undefined && end < start) {
      return { ok: false, result: null, error: 'end_line must be >= start_line' };
    }
    try {
      const res = await ctx.view.read(p, { startLine: start, endLine: end });
      return {
        ok: true,
        result: {
          path: normalizeRepoPath(p) ?? p,
          content: truncate(res.content, LIMITS.maxDiffCharsPerFile),
          totalLines: res.totalLines,
          truncated: res.truncated || res.content.length > LIMITS.maxDiffCharsPerFile,
        },
      };
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
      return { ok: true, result: { path: p || '.', files: res.files, dirs: res.dirs } };
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
      return {
        ok: true,
        result: {
          count: res.results.length,
          truncated: res.truncated,
          results: res.results,
        },
      };
    } catch (err) {
      const e = err as { message?: string; name?: string };
      if (e.name === 'ViewError') return { ok: false, result: null, error: e.message };
      throw err;
    }
  },
};
