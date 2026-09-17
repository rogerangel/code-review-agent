/**
 * RepoView: the only path through which review tools read repository content.
 * Three implementations exist:
 *  - GitRefView:    reads blobs as of a concrete ref (action + range targets)
 *  - IndexView:     reads the git index (staged target)
 *  - WorkTreeView:  reads the working tree (unstaged target)
 *
 * Every implementation enforces:
 *  - repo-relative normalized paths (no escapes, no absolute paths)
 *  - no symlink following
 *  - file size and line caps
 */
import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { git, GitError, type GitExecutionOptions } from '../diff/git.js';
import { LIMITS } from '../security/limits.js';
import { normalizeRepoPath } from '../security/paths.js';
import { splitLines } from '../util.js';

export interface ReadResult {
  content: string;
  totalLines: number;
  /** True when the file exceeded caps and was truncated. */
  truncated: boolean;
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

export interface SearchOptions {
  /** Restrict search to a directory (normalized, '' = root). */
  dir?: string;
  /** Treat pattern as regular expression instead of literal text. */
  regex?: boolean;
  caseSensitive?: boolean;
}

export class ViewError extends Error {
  constructor(
    message: string,
    readonly reason: 'not-found' | 'symlink' | 'too-large' | 'invalid-path' | 'io',
  ) {
    super(message);
    this.name = 'ViewError';
  }
}

export interface RepoView {
  kind: 'ref' | 'index' | 'worktree';
  label: string;
  exists(p: string): Promise<boolean>;
  isSymlink(p: string): Promise<boolean>;
  read(p: string, opts?: { startLine?: number; endLine?: number }): Promise<ReadResult>;
  listDirectory(dir: string): Promise<{ files: string[]; dirs: string[] }>;
  search(pattern: string, opts?: SearchOptions): Promise<{ results: SearchHit[]; truncated: boolean }>;
}

function norm(p: string): string {
  if (p === '' || p === '.') return '';
  const n = normalizeRepoPath(p);
  if (n === null) throw new ViewError(`invalid path "${p}"`, 'invalid-path');
  if (n.split('/').some((segment) => segment.toLowerCase() === '.git')) throw new ViewError('Git metadata is not review content', 'invalid-path');
  return n;
}

async function readWithCaps(
  producer: () => Promise<Buffer>,
  p: string,
): Promise<ReadResult> {
  const buf = await producer();
  if (buf.length > LIMITS.maxFileBytes) {
    throw new ViewError(
      `file "${p}" is ${buf.length} bytes (max ${LIMITS.maxFileBytes})`,
      'too-large',
    );
  }
  const text = buf.toString('utf8');
  const all = splitLines(text);
  if (all.length > LIMITS.maxFileLines) {
    throw new ViewError(
      `file "${p}" has ${all.length} lines (max ${LIMITS.maxFileLines})`,
      'too-large',
    );
  }
  return { content: text, totalLines: all.length, truncated: false };
}

/** Read a file with an optional 1-based inclusive line range. */
export function sliceLines(result: ReadResult, startLine?: number, endLine?: number): string {
  const lines = splitLines(result.content);
  const start = Math.max(1, startLine ?? 1);
  const end = Math.min(lines.length, endLine ?? lines.length);
  if (start > lines.length) return '';
  return lines.slice(start - 1, end).join('\n');
}

export class GitRefView implements RepoView {
  kind = 'ref' as const;
  readonly label: string;
  constructor(
    private readonly repoDir: string,
    private readonly ref: string,
    label?: string,
    private readonly execution: GitExecutionOptions = {},
  ) {
    this.label = label ?? `git ref ${ref}`;
  }

  private target(p: string): string {
    return p === '' ? this.ref : `${this.ref}:${p}`;
  }

  async exists(p: string): Promise<boolean> {
    const n = norm(p);
    const r = await git(this.repoDir, ['cat-file', '-e', this.target(n)], this.execution);
    return r.code === 0;
  }

  async isSymlink(p: string): Promise<boolean> {
    const n = norm(p);
    const dir = n.includes('/') ? n.slice(0, n.lastIndexOf('/')) : '';
    const name = n.includes('/') ? n.slice(n.lastIndexOf('/') + 1) : n;
    const r = await git(this.repoDir, ['ls-tree', this.ref, '--', `:(literal)${dir ? `${dir}/${name}` : name}`], this.execution);
    if (r.code !== 0 || !r.stdout.trim()) return false;
    const mode = r.stdout.trim().split(/\s+/)[0];
    return mode === '120000';
  }

  async read(p: string, opts?: { startLine?: number; endLine?: number }): Promise<ReadResult> {
    const n = norm(p);
    if (!n) throw new ViewError('expected a file path', 'invalid-path');
    if (await this.isSymlink(n)) throw new ViewError(`"${p}" is a symlink (not followed)`, 'symlink');
    const r = await git(this.repoDir, ['cat-file', 'blob', this.target(n)], this.execution);
    if (r.code !== 0) {
      const reason = /not a valid object|path .* does not exist|invalid object name/i.test(r.stderr)
        ? 'not-found'
        : 'io';
      throw new ViewError(`cannot read "${p}": ${r.stderr.trim()}`, reason);
    }
    const base = await readWithCaps(async () => Buffer.from(r.stdout, 'utf8'), n);
    if (opts?.startLine !== undefined || opts?.endLine !== undefined) {
      base.content = sliceLines(base, opts.startLine, opts.endLine);
    }
    return base;
  }

  async listDirectory(dir: string): Promise<{ files: string[]; dirs: string[] }> {
    const n = norm(dir);
    const r = await git(this.repoDir, ['ls-tree', '-z', this.target(n)], this.execution);
    if (r.code !== 0) {
      if (/does not exist|not a valid object/i.test(r.stderr))
        throw new ViewError(`directory "${dir}" not found`, 'not-found');
      throw new ViewError(`cannot list "${dir}": ${r.stderr.trim()}`, 'io');
    }
    const entries = r.stdout.split('\0').filter((e) => e.length > 0);
    const files: string[] = [];
    const dirs: string[] = [];
    for (const entry of entries) {
      const tab = entry.indexOf('\t');
      if (tab === -1) continue;
      const meta = entry.slice(0, tab).split(' ');
      const name = entry.slice(tab + 1);
      if (name.toLowerCase() === '.git' || meta[0] === '120000' || meta[0] === '160000') continue;
      if (meta[0] === '040000') dirs.push(name);
      else files.push(name);
    }
    files.sort();
    dirs.sort();
    return { files, dirs };
  }

  async search(pattern: string, opts?: SearchOptions): Promise<{ results: SearchHit[]; truncated: boolean }> {
    const n = norm(opts?.dir ?? '');
    const args = ['grep', '-n', '-I', '-z'];
    if (opts?.regex) args.push('-E');
    else args.push('-F');
    if (opts?.caseSensitive === false) args.push('-i');
    args.push('-e', pattern, this.ref, '--');
    if (n) args.push(`:(literal)${n}`);
    const r = await git(this.repoDir, args, this.execution);
    // exit 1 = no matches; that is not an error.
    if (r.code !== 0 && r.code !== 1) {
      throw new ViewError(`search failed: ${r.stderr.trim()}`, 'io');
    }
    return parseGrep(r.stdout, `${this.ref}:`);
  }
}

export class WorkTreeView implements RepoView {
  kind = 'worktree' as const;
  readonly label: string;
  constructor(
    private readonly root: string,
    label?: string,
  ) {
    this.label = label ?? 'working tree';
  }

  private abs(p: string): string {
    const n = norm(p);
    const abs = path.resolve(this.root, n);
    const rootAbs = path.resolve(this.root);
    if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
      throw new ViewError(`path "${p}" escapes repository root`, 'invalid-path');
    }
    return abs;
  }

  private async safeAbs(p: string): Promise<string> {
    const n = norm(p);
    const root = await fs.realpath(this.root);
    let current = root;
    for (const segment of n ? n.split('/') : []) {
      current = path.join(current, segment);
      const st = await fs.lstat(current);
      if (st.isSymbolicLink()) throw new ViewError(`"${p}" has a symlink component (not followed)`, 'symlink');
    }
    const canonical = await fs.realpath(current);
    if (canonical !== root && !canonical.startsWith(root + path.sep)) throw new ViewError('path escapes repository root', 'invalid-path');
    return canonical;
  }

  async exists(p: string): Promise<boolean> {
    try {
      await this.safeAbs(p);
      return true;
    } catch {
      return false;
    }
  }

  async isSymlink(p: string): Promise<boolean> {
    try {
      const st = await fs.lstat(this.abs(p));
      return st.isSymbolicLink();
    } catch {
      return false;
    }
  }

  async read(p: string, opts?: { startLine?: number; endLine?: number }): Promise<ReadResult> {
    const n = norm(p);
    let abs: string;
    let st;
    try {
      abs = await this.safeAbs(n);
      st = await fs.lstat(abs);
    } catch (err) {
      if (err instanceof ViewError) throw err;
      throw new ViewError(`file "${p}" not found`, 'not-found');
    }
    if (st.isSymbolicLink()) throw new ViewError(`"${p}" is a symlink (not followed)`, 'symlink');
    if (!st.isFile()) throw new ViewError(`"${p}" is not a regular file`, 'not-found');
    if (st.size > LIMITS.maxFileBytes) throw new ViewError(`file "${p}" exceeds byte cap`, 'too-large');
    const base = await readWithCaps(async () => {
      const handle = await fs.open(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { return await handle.readFile(); } finally { await handle.close(); }
    }, n);
    if (opts?.startLine !== undefined || opts?.endLine !== undefined) {
      base.content = sliceLines(base, opts.startLine, opts.endLine);
    }
    return base;
  }

  async listDirectory(dir: string): Promise<{ files: string[]; dirs: string[] }> {
    const n = norm(dir);
    let entries;
    try {
      const abs = await this.safeAbs(n);
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch (err) {
      if (err instanceof ViewError) throw err;
      throw new ViewError(`directory "${dir}" not found`, 'not-found');
    }
    const files: string[] = [];
    const dirs: string[] = [];
    for (const e of entries) {
      if (e.name.toLowerCase() === '.git') continue;
      if (e.isSymbolicLink()) continue; // never follow symlinks
      if (e.isDirectory()) dirs.push(e.name);
      else files.push(e.name);
    }
    files.sort();
    dirs.sort();
    return { files, dirs };
  }

  async search(pattern: string, opts?: SearchOptions): Promise<{ results: SearchHit[]; truncated: boolean }> {
    const dirN = norm(opts?.dir ?? '');
    const rootAbs = await this.safeAbs(dirN);
    const literal = opts?.regex ? null : pattern;
    const re = opts?.regex
      ? new RegExp(pattern, opts?.caseSensitive === false ? 'i' : undefined)
      : null;
    const results: SearchHit[] = [];
    let truncated = false;
    let scannedFiles = 0;

    const scanDir = async (absDir: string, relDir: string, depth: number) => {
      if (truncated || depth > 12) return;
      let entries;
      try {
        // Revalidate recursive directories too, not only the caller's starting path.
        const safe = await this.safeAbs(relDir);
        if (safe !== absDir) return;
        entries = await fs.readdir(safe, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (truncated) return;
        if (e.name.toLowerCase() === '.git') continue;
        const absPath = path.join(absDir, e.name);
        const relPath = relDir === '' ? e.name : `${relDir}/${e.name}`;
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) {
          await scanDir(absPath, relPath, depth + 1);
          continue;
        }
        if (!e.isFile()) continue;
        if (scannedFiles >= 2000) {
          truncated = true;
          return;
        }
        scannedFiles++;
        try {
          const lines = splitLines((await this.read(relPath)).content);
          for (let i = 0; i < lines.length; i++) {
            const lineText = lines[i] ?? '';
            const hit = literal !== null ? (opts?.caseSensitive === false ? lineText.toLowerCase().includes(literal.toLowerCase()) : lineText.includes(literal)) : re !== null && re.test(lineText);
            if (hit) {
              results.push({ path: relPath, line: i + 1, text: lineText });
              if (results.length >= LIMITS.maxSearchResults) {
                truncated = true;
                return;
              }
            }
          }
        } catch {
          // unreadable file: skip
        }
      }
    };

    await scanDir(rootAbs, dirN, 0);
    return { results, truncated };
  }
}

export class IndexView implements RepoView {
  kind = 'index' as const;
  readonly label = 'git index (staged)';
  constructor(private readonly repoDir: string, private readonly execution: GitExecutionOptions = {}) {}

  async exists(p: string): Promise<boolean> {
    const n = norm(p);
    const r = await git(this.repoDir, ['ls-files', '--error-unmatch', '--', `:(literal)${n}`], this.execution);
    return r.code === 0;
  }

  async isSymlink(p: string): Promise<boolean> {
    const n = norm(p);
    const r = await git(this.repoDir, ['ls-files', '-s', '--', `:(literal)${n}`], this.execution);
    if (r.code !== 0 || !r.stdout.trim()) return false;
    return r.stdout.trim().split(/\s+/)[0] === '120000';
  }

  async read(p: string, opts?: { startLine?: number; endLine?: number }): Promise<ReadResult> {
    const n = norm(p);
    if (!n) throw new ViewError('expected a file path', 'invalid-path');
    if (await this.isSymlink(n)) throw new ViewError(`"${p}" is a symlink (not followed)`, 'symlink');
    const rp = await git(this.repoDir, ['rev-parse', '--verify', '--end-of-options', `:0:${n}`], this.execution);
    if (rp.code !== 0) throw new ViewError(`"${p}" is not staged`, 'not-found');
    const sha = rp.stdout.trim();
    const r = await git(this.repoDir, ['cat-file', 'blob', sha], this.execution);
    if (r.code !== 0) throw new ViewError(`cannot read staged "${p}"`, 'io');
    const base = await readWithCaps(async () => Buffer.from(r.stdout, 'utf8'), n);
    if (opts?.startLine !== undefined || opts?.endLine !== undefined) {
      base.content = sliceLines(base, opts.startLine, opts.endLine);
    }
    return base;
  }

  async listDirectory(dir: string): Promise<{ files: string[]; dirs: string[] }> {
    const n = norm(dir);
    const r = await git(this.repoDir, ['ls-files', '-z', ...(n ? ['--', `:(literal)${n}/`] : [])], this.execution);
    if (r.code !== 0) throw new ViewError(`cannot list index directory "${dir}"`, 'io');
    const files = new Set<string>();
    const dirs = new Set<string>();
    for (const line of r.stdout.split('\0')) {
      if (!line) continue;
      if (await this.isSymlink(line)) continue;
      const relative = n ? line.slice(n.length + 1) : line;
      const idx = relative.indexOf('/');
      if (idx === -1) files.add(relative);
      else dirs.add(relative.slice(0, idx));
    }
    return { files: [...files].sort(), dirs: [...dirs].sort() };
  }

  async search(pattern: string, opts?: SearchOptions): Promise<{ results: SearchHit[]; truncated: boolean }> {
    const n = norm(opts?.dir ?? '');
    const args = ['grep', '--cached', '-n', '-I', '-z', opts?.regex ? '-E' : '-F'];
    if (opts?.caseSensitive === false) args.push('-i');
    args.push('-e', pattern, '--');
    if (n) args.push(`:(literal)${n}`);
    const r = await git(this.repoDir, args, this.execution);
    if (r.code !== 0 && r.code !== 1) throw new ViewError('index search failed', 'io');
    return parseGrep(r.stdout);
  }
}

export function makeView(kind: 'ref' | 'index' | 'worktree', repoDir: string, ref?: string, execution: GitExecutionOptions = {}): RepoView {
  if (kind === 'ref') return new GitRefView(repoDir, ref ?? 'HEAD', undefined, execution);
  if (kind === 'index') return new IndexView(repoDir, execution);
  return new WorkTreeView(repoDir);
}

function parseGrep(output: string, prefix = ''): { results: SearchHit[]; truncated: boolean } {
  const results: SearchHit[] = [];
  let cursor = 0;
  while (cursor < output.length) {
    const first = output.indexOf('\0', cursor), second = output.indexOf('\0', first + 1);
    if (first < 0 || second < 0) break;
    const end = output.indexOf('\n', second + 1);
    const raw = output.slice(cursor, first);
    const name = prefix && raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
    const line = Number(output.slice(first + 1, second));
    if (normalizeRepoPath(name) && !name.split('/').some((s) => s.toLowerCase() === '.git') && Number.isInteger(line) && line > 0) {
      if (results.length >= LIMITS.maxSearchResults) return { results, truncated: true };
      results.push({ path: name, line, text: output.slice(second + 1, end < 0 ? output.length : end).replace(/\r$/, '') });
    }
    cursor = end < 0 ? output.length : end + 1;
  }
  return { results, truncated: false };
}

export { GitError };
