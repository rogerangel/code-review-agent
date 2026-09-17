import { afterEach, describe, expect, it } from 'vitest';
import { git } from '../../src/core/diff/git.js';
import {
  buildDiff,
  detectDefaultBranch,
  resolveTarget,
  TargetError,
} from '../../src/core/diff/git.js';
import { makeBranchRepo, makeTempRepo, type RepoHandle } from '../helpers/repos.js';

const repos: RepoHandle[] = [];
async function track<T extends Promise<RepoHandle>>(p: T): Promise<RepoHandle> {
  const r = await p;
  repos.push(r);
  return r;
}

afterEach(async () => {
  while (repos.length > 0) await repos.pop()!.dispose();
});

describe('target detection', () => {
  it('resolves branch-vs-main for a feature branch', async () => {
    const repo = await track(
      makeBranchRepo({
        baseFiles: { 'src/a.ts': 'export const a = 1;\n' },
        headFiles: { 'src/a.ts': 'export const a = 2;\n' },
        branchName: 'feature',
      }),
    );
    const target = await resolveTarget(repo.dir, {});
    expect(target.kind).toBe('branch-vs-main');
    expect(target.label).toBe('main...feature');
    const diff = await buildDiff(repo.dir, target);
    expect(diff.files.has('src/a.ts')).toBe(true);
    expect(diff.files.get('src/a.ts')!.additions).toBe(1);
    expect(diff.baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(diff.headSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('resolves explicit two-dot ranges', async () => {
    const repo = await track(
      makeBranchRepo({
        baseFiles: { 'f.txt': 'one\n' },
        headFiles: { 'f.txt': 'one\ntwo\n' },
      }),
    );
    const head = (await git(repo.dir, ['rev-parse', 'HEAD'])).stdout.trim();
    const base = (await git(repo.dir, ['rev-parse', 'HEAD~1'])).stdout.trim();
    const target = await resolveTarget(repo.dir, { target: `${base}..${head}` });
    expect(target.kind).toBe('range');
    const diff = await buildDiff(repo.dir, target);
    expect(diff.files.has('f.txt')).toBe(true);
    expect([...diff.addedLines.get('f.txt')!]).toEqual([2]);
  });

  it('resolves three-dot ranges via merge-base', async () => {
    // main diverges from feature; three-dot must diff from merge-base.
    const repo = await makeTempRepo({ 'f.txt': 'v1\n' });
    repos.push(repo);
    await git(repo.dir, ['checkout', '-q', '-b', 'feature']);
    await git(repo.dir, ['commit', '-q', '--allow-empty', '-m', 'diverge']);
    await git(repo.dir, ['checkout', '-q', 'main']);
    await git(repo.dir, ['commit', '-q', '--allow-empty', '-m', 'diverge main']);
    await git(repo.dir, ['checkout', '-q', 'feature']);
    await git(repo.dir, ['add', '-A']).catch(() => undefined);
    // modify only on feature
    const fs = await import('node:fs/promises');
    await fs.writeFile(`${repo.dir}/f.txt`, 'v1\nv2\n', 'utf8');
    await git(repo.dir, ['add', 'f.txt']);
    await git(repo.dir, ['commit', '-q', '-m', 'change on feature']);
    const head = (await git(repo.dir, ['rev-parse', 'HEAD'])).stdout.trim();
    const target = await resolveTarget(repo.dir, { target: `main...${head}` });
    expect(target.kind).toBe('three-dot');
    const diff = await buildDiff(repo.dir, target);
    expect(diff.files.has('f.txt')).toBe(true);
    // merge-base excluded the empty main commit; additions start at line 2
    expect([...diff.addedLines.get('f.txt')!]).toEqual([2]);
  });

  it('resolves last-commit', async () => {
    const repo = await track(
      makeBranchRepo({
        baseFiles: { 'x.txt': 'a\n' },
        headFiles: { 'x.txt': 'a\nb\n' },
      }),
    );
    const target = await resolveTarget(repo.dir, { lastCommit: true });
    expect(target.kind).toBe('last-commit');
    const diff = await buildDiff(repo.dir, target);
    expect(diff.files.has('x.txt')).toBe(true);
  });

  it('resolves staged and unstaged targets', async () => {
    const repo = await makeTempRepo({ 'y.txt': 'a\n' });
    repos.push(repo);
    const fs = await import('node:fs/promises');
    await fs.writeFile(`${repo.dir}/y.txt`, 'a\nb\n', 'utf8');
    await git(repo.dir, ['add', 'y.txt']);
    const stagedTarget = await resolveTarget(repo.dir, { staged: true });
    expect(stagedTarget.kind).toBe('staged');
    const stagedDiff = await buildDiff(repo.dir, stagedTarget);
    expect(stagedDiff.files.has('y.txt')).toBe(true);
    expect(stagedDiff.files.get('y.txt')!.additions).toBe(1);

    await fs.writeFile(`${repo.dir}/y.txt`, 'a\nb\nc\n', 'utf8');
    const unstagedTarget = await resolveTarget(repo.dir, { unstaged: true });
    const unstagedDiff = await buildDiff(repo.dir, unstagedTarget);
    expect(unstagedDiff.files.get('y.txt')!.additions).toBe(1);
    expect([...unstagedDiff.addedLines.get('y.txt')!]).toEqual([3]);
  });

  it('rejects when current branch is the default branch', async () => {
    const repo = await makeTempRepo({ 'z.txt': 'z\n' });
    repos.push(repo);
    await expect(resolveTarget(repo.dir, {})).rejects.toThrowError(TargetError);
  });

  it('rejects malformed ranges', async () => {
    const repo = await makeTempRepo({ 'z.txt': 'z\n' });
    repos.push(repo);
    await expect(resolveTarget(repo.dir, { target: 'a..' })).rejects.toThrowError(TargetError);
    await expect(resolveTarget(repo.dir, { target: '..b' })).rejects.toThrowError(TargetError);
  });

  it('detects the default branch', async () => {
    const repo = await makeTempRepo({ 'z.txt': 'z\n' });
    expect(await detectDefaultBranch(repo.dir)).toBe('main');
  });
});
