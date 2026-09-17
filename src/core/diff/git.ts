/**
 * Git plumbing: target detection, ref resolution, progressive history
 * deepening, and diff-map construction. All git invocations spawn without a
 * shell and use "--" separators before path arguments.
 */
import { spawn } from 'node:child_process';
import { LIMITS } from '../security/limits.js';
import { buildDiffMap } from './normalize.js';
import { BudgetExceededError, type BudgetTracker } from '../review/budget.js';
import type { DiffMap } from '../types.js';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export class TargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TargetError';
  }
}

const MAX_BUFFER = 64 * 1024 * 1024;

export interface GitExecutionOptions {
  budget?: BudgetTracker;
  signal?: AbortSignal;
  /** Trusted host-only ephemeral fetch credentials; never written to config. */
  env?: NodeJS.ProcessEnv;
}

export async function git(repoDir: string, args: string[], opts: GitExecutionOptions = {}): Promise<GitResult> {
  const signal = opts.budget ? opts.budget.signal(false, opts.signal) : opts.signal ?? AbortSignal.timeout(120_000);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: repoDir,
      env: { ...process.env, ...opts.env, GIT_TERMINAL_PROMPT: '0' },
      signal,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
      if (stdout.length > MAX_BUFFER) child.kill('SIGKILL');
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
      if (stderr.length > MAX_BUFFER) child.kill('SIGKILL');
    });
    child.on('error', (err) => {
      if (signal.aborted) { reject(opts.budget?.workExceeded() ? new BudgetExceededError() : err); return; }
      resolve({ code: 127, stdout, stderr: stderr + String(err) });
    });
    child.on('close', (code) => {
      if (signal.aborted) { reject(opts.budget?.workExceeded() ? new BudgetExceededError() : signal.reason); return; }
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function gitOk(repoDir: string, args: string[], opts: GitExecutionOptions = {}): Promise<GitResult> {
  const r = await git(repoDir, args, opts);
  if (r.code !== 0) throw new GitError(`git ${args[0]} failed`, r.stderr.trim());
  return r;
}

/** Resolve a rev-ish to a full commit sha, progressively deepening history. */
export async function resolveCommit(repoDir: string, rev: string, opts: GitExecutionOptions = {}): Promise<string> {
  const direct = await git(repoDir, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`], opts);
  if (direct.code === 0) return direct.stdout.trim();

  let deepens = 0;
  while (deepens < LIMITS.maxDeepenSteps) {
    const shallow = await git(repoDir, ['rev-parse', '--is-shallow-repository'], opts);
    if (shallow.code !== 0 || shallow.stdout.trim() !== 'true') break;
    const fetchArgs = ['fetch', '--no-tags'];
    if (deepens < LIMITS.maxDeepenSteps - 1) fetchArgs.push(`--deepen=${25}`);
    else fetchArgs.push('--unshallow');
    fetchArgs.push('origin');
    const f = await git(repoDir, fetchArgs, opts);
    if (f.code !== 0 && !/--unshallow/.test(f.stderr)) break;
    deepens++;
    const again = await git(repoDir, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`], opts);
    if (again.code === 0) return again.stdout.trim();
  }
  throw new GitError(
    `cannot resolve commit for "${rev}" (history not deep enough; deepen fetch failed)`,
    direct.stderr.trim(),
  );
}

/** Ensure a remote branch ref is present locally, fetching if needed. */
export async function ensureRemoteBranch(repoDir: string, branch: string, opts: GitExecutionOptions = {}): Promise<string> {
  if ((await git(repoDir, ['check-ref-format', `refs/heads/${branch}`], opts)).code !== 0) throw new GitError('invalid branch name');
  const local = await git(repoDir, [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/remotes/origin/${branch}^{commit}`,
  ], opts);
  if (local.code === 0) return `refs/remotes/origin/${branch}`;
  await gitOk(repoDir, ['fetch', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], opts);
  return `refs/remotes/origin/${branch}`;
}

/** Detect the repository default branch. */
export async function detectDefaultBranch(repoDir: string, opts: GitExecutionOptions = {}): Promise<string> {
  const sym = await git(repoDir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], opts);
  if (sym.code === 0) {
    const v = sym.stdout.trim();
    if (v.startsWith('origin/')) return v.slice('origin/'.length);
  }
  for (const candidate of ['main', 'master']) {
    const r = await git(repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}^{commit}`], opts);
    if (r.code === 0) return candidate;
    const remote = await git(repoDir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${candidate}^{commit}`], opts);
    if (remote.code === 0) return candidate;
  }
  throw new TargetError('cannot detect default branch (no origin/HEAD, main, or master)');
}

export interface GitTarget {
  kind: 'range' | 'three-dot' | 'staged' | 'unstaged' | 'last-commit' | 'branch-vs-main';
  /** Human label for results and prompts. */
  label: string;
  /** Git rev-ish for the base side (undefined for staged/unstaged). */
  baseRev?: string;
  /** Git rev-ish for the head side (undefined for staged/unstaged). */
  headRev?: string;
  /** Which RepoView the review tools should read from. */
  viewKind: 'ref' | 'index' | 'worktree';
  /** Resolved head ref for ref views. */
  viewRef?: string;
}

export interface TargetArgs {
  /** Positional target: "A..B", "A...B", or a single ref. */
  target?: string;
  staged?: boolean;
  unstaged?: boolean;
  lastCommit?: boolean;
}

/**
 * Resolve a CLI/CI target into a concrete GitTarget.
 * - "A..B"  : base A, head B
 * - "A...B" : base merge-base(A,B), head B
 * - --staged / --unstaged / --last-commit
 * - single ref: branch-vs-main (merge-base(default, ref) .. ref)
 * - no args: current branch vs default branch
 */
export async function resolveTarget(repoDir: string, args: TargetArgs, opts: GitExecutionOptions = {}): Promise<GitTarget> {
  if ([!!args.target, !!args.staged, !!args.unstaged, !!args.lastCommit].filter(Boolean).length > 1) throw new TargetError('choose only one review target');
  const t = args.target?.trim();
  if (t && (t.includes('..'))) {
    const threeDot = t.includes('...');
    const sep = threeDot ? '...' : '..';
    const idx = t.indexOf(sep);
    const a = t.slice(0, idx).trim();
    const b = t.slice(idx + sep.length).trim();
    if (!a || !b) throw new TargetError(`malformed revision range "${t}"`);
    return {
      kind: threeDot ? 'three-dot' : 'range',
      label: t,
      baseRev: a,
      headRev: b,
      viewKind: 'ref',
    };
  }
  if (args.staged) {
    return { kind: 'staged', label: 'staged (index vs HEAD)', viewKind: 'index' };
  }
  if (args.unstaged) {
    return { kind: 'unstaged', label: 'unstaged (worktree vs index)', viewKind: 'worktree' };
  }
  if (args.lastCommit) {
    return {
      kind: 'last-commit',
      label: 'HEAD~1..HEAD',
      baseRev: 'HEAD~1',
      headRev: 'HEAD',
      viewKind: 'ref',
    };
  }
  const headRef = t ?? (await currentBranch(repoDir, opts));
  const defaultBranch = await detectDefaultBranch(repoDir, opts);
  if (headRef === defaultBranch) {
    throw new TargetError(
      `current branch "${headRef}" is the default branch; pass an explicit range (A..B) or --staged/--unstaged/--last-commit`,
    );
  }
  return {
    kind: 'branch-vs-main',
    label: `${defaultBranch}...${headRef}`,
    baseRev: defaultBranch,
    headRev: headRef,
    viewKind: 'ref',
  };
}

async function currentBranch(repoDir: string, opts: GitExecutionOptions = {}): Promise<string> {
  const r = await git(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD'], opts);
  if (r.code !== 0) throw new TargetError('cannot determine current branch');
  const v = r.stdout.trim();
  if (v === 'HEAD') throw new TargetError('detached HEAD; pass an explicit revision range');
  return v;
}

export interface BuildDiffOptions extends GitExecutionOptions {
  /**
   * Ensure a remote branch ref is present and return the rev-ish to use.
   * Defaults to fetching origin/<branch> into refs/remotes/origin/<branch>.
   */
  ensureBranch?: (repoDir: string, branch: string) => Promise<string>;
}

/**
 * Build the normalized DiffMap for a target. Resolves both sides to concrete
 * SHAs, deepening history as needed, and never executes repository content.
 */
export async function buildDiff(repoDir: string, target: GitTarget, opts: BuildDiffOptions = {}): Promise<DiffMap> {
  let diffArgs: string[];
  let numstatArgs: string[];
  let baseSha = await resolveCommit(repoDir, 'HEAD', opts);
  let headSha = baseSha;

  switch (target.kind) {
    case 'staged':
      diffArgs = ['diff', '--cached', '-M', '--no-color', '-U3'];
      numstatArgs = ['diff', '--cached', '-M', '--numstat'];
      break;
    case 'unstaged':
      diffArgs = ['diff', '-M', '--no-color', '-U3'];
      numstatArgs = ['diff', '-M', '--numstat'];
      break;
    default: {
      if (!target.baseRev || !target.headRev) throw new GitError('internal: missing base/head revs');
      let base = target.baseRev;
      if (target.kind === 'branch-vs-main' && target.baseRev) {
        const fn = opts.ensureBranch ?? ((dir: string, branch: string) => defaultEnsureBranch(dir, branch, opts));
        base = await fn(repoDir, target.baseRev);
      }
      const baseCommit = await resolveCommit(repoDir, base, opts);
      const headCommit = await resolveCommit(repoDir, target.headRev, opts);
      baseSha = baseCommit;
      headSha = headCommit;
      if (target.kind === 'three-dot' || target.kind === 'branch-vs-main') {
        baseSha = await mergeBase(repoDir, baseCommit, headCommit, opts);
      }
      diffArgs = ['diff', '-M', '--no-color', '-U3', baseSha, headSha];
      numstatArgs = ['diff', '-M', '--numstat', baseSha, headSha];
      break;
    }
  }

  diffArgs.splice(1, 0, '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/');
  numstatArgs.splice(1, 0, '--no-ext-diff', '--no-textconv', '-z');
  const nameArgs = numstatArgs.map((a) => a === '--numstat' ? '--name-status' : a);
  const diff = await gitOk(repoDir, diffArgs, opts);
  const numstat = await gitOk(repoDir, numstatArgs, opts);
  const names = await gitOk(repoDir, nameArgs, opts);
  return buildDiffMap(baseSha, headSha, diff.stdout, numstat.stdout, names.stdout);
}

async function mergeBase(repoDir: string, base: string, head: string, opts: GitExecutionOptions): Promise<string> {
  for (let step = 0; step <= LIMITS.maxDeepenSteps; step++) {
    const mb = await git(repoDir, ['merge-base', base, head], opts);
    if (mb.code === 0) return mb.stdout.trim();
    const shallow = await git(repoDir, ['rev-parse', '--is-shallow-repository'], opts);
    if (shallow.stdout.trim() !== 'true' || step === LIMITS.maxDeepenSteps) throw new GitError('cannot compute merge-base', mb.stderr.trim());
    await gitOk(repoDir, ['fetch', '--no-tags', step === LIMITS.maxDeepenSteps - 1 ? '--unshallow' : '--deepen=25', 'origin'], opts);
  }
  throw new GitError('cannot compute merge-base');
}

async function defaultEnsureBranch(repoDir: string, branch: string, opts: GitExecutionOptions = {}): Promise<string> {
  // Prefer a local branch; fall back to fetching origin/<branch>.
  const local = await git(repoDir, ['rev-parse', '--verify', '--quiet', '--end-of-options', `refs/heads/${branch}^{commit}`], opts);
  if (local.code === 0) return `refs/heads/${branch}`;
  const remote = await git(repoDir, ['rev-parse', '--verify', '--quiet', '--end-of-options', `refs/remotes/origin/${branch}^{commit}`], opts);
  if (remote.code === 0) return `refs/remotes/origin/${branch}`;
  try {
    return await ensureRemoteBranch(repoDir, branch, opts);
  } catch (err) {
    throw new GitError(
      `branch "${branch}" not found locally or on origin (and fetch failed)`,
      (err as Error).message,
    );
  }
}
