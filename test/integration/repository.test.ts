import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeBranchRepo, makeTempRepo, writeFiles, commitAll, type RepoHandle } from '../helpers/repos.js';
import { GitRefView, IndexView, WorkTreeView } from '../../src/core/repo/view.js';
import { git, buildDiff, resolveTarget } from '../../src/core/diff/git.js';

const repos: RepoHandle[] = [];
const temporary: string[] = [];
afterEach(async () => {
  for (const repo of repos.splice(0)) await repo.dispose();
  for (const dir of temporary.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
async function repo() {
  const handle = await makeTempRepo({
    'root.ts': 'export const ROOT = 1;\n',
    'src/space ü:thing.ts': 'first\nneedle VALUE\nthird\n',
    'src/nested/file.py': 'needle in nested\n',
  });
  repos.push(handle);
  return handle;
}
describe('repository snapshot tools', () => {
  for (const kind of ['ref', 'index', 'worktree'] as const) {
    it(kind + ': root and nested lists, exact paths, numeric search lines and case folding', async () => {
      const r = await repo();
      const view = kind === 'ref' ? new GitRefView(r.dir, 'HEAD') : kind === 'index' ? new IndexView(r.dir) : new WorkTreeView(r.dir);
      expect(await view.listDirectory('')).toEqual({ files: ['root.ts'], dirs: ['src'] });
      expect(await view.listDirectory('src')).toEqual({ files: ['space ü:thing.ts'], dirs: ['nested'] });
      expect((await view.read('src/space ü:thing.ts')).content).toContain('needle VALUE');
      const hits = await view.search('value', { dir: 'src', caseSensitive: false });
      expect(hits.results).toEqual([{ path: 'src/space ü:thing.ts', line: 2, text: 'needle VALUE' }]);
      await expect(view.read('.git/config')).rejects.toMatchObject({ reason: 'invalid-path' });
      expect((await view.search('repositoryformatversion')).results).toHaveLength(0);
    });
  }
  it('blocks parent-directory symlinks for read/list/search, not only final-component links', async () => {
    const r = await repo();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cra-outside-'));
    temporary.push(outside);
    await fs.writeFile(path.join(outside, 'secret.ts'), 'outside sentinel');
    await fs.symlink(outside, path.join(r.dir, 'linked'));
    const view = new WorkTreeView(r.dir);
    await expect(view.read('linked/secret.ts')).rejects.toMatchObject({ reason: 'symlink' });
    await expect(view.listDirectory('linked')).rejects.toMatchObject({ reason: 'symlink' });
    await expect(view.search('sentinel', { dir: 'linked' })).rejects.toMatchObject({ reason: 'symlink' });
    expect((await view.search('sentinel')).results).toHaveLength(0);
    expect(await view.exists('linked/secret.ts')).toBe(false);
  });
  it('never reads symlink blob contents in ref or index views', async () => {
    const r = await repo();
    await fs.symlink('root.ts', path.join(r.dir, 'link.ts'));
    await commitAll(r.dir, 'add link');
    for (const view of [new GitRefView(r.dir, 'HEAD'), new IndexView(r.dir)]) {
      expect(await view.isSymlink('link.ts')).toBe(true);
      await expect(view.read('link.ts')).rejects.toMatchObject({ reason: 'symlink' });
      expect((await view.listDirectory('')).files).not.toContain('link.ts');
    }
  });
});
describe('real Git diff semantics', () => {
  it('preserves space/Unicode/colon paths and rename/deletion/binary/mode-only dispositions', async () => {
    const r = await makeBranchRepo({
      baseFiles: { 'space ü:name.ts': 'const value = 1;\n', 'old.ts': 'renamed content\n'.repeat(10), 'deleted.py': 'old = 1\n', 'mode.sh': 'true\n', 'binary.bin': 'old\0data' },
      headFiles: { 'space ü:name.ts': 'const value = 2;\n', 'binary.bin': 'new\0data' },
    });
    repos.push(r);
    await fs.rename(path.join(r.dir, 'old.ts'), path.join(r.dir, 'new ü.ts'));
    await fs.rm(path.join(r.dir, 'deleted.py'));
    await git(r.dir, ['update-index', '--chmod=+x', 'mode.sh']);
    await git(r.dir, ['add', '-A']);
    // Ensure executable-bit change even on platforms with core.fileMode=false.
    await git(r.dir, ['update-index', '--chmod=+x', 'mode.sh']);
    await git(r.dir, ['commit', '-q', '-m', 'rename delete mode']);
    const diff = await buildDiff(r.dir, await resolveTarget(r.dir, { target: 'main...feature' }));
    expect([...diff.files.keys()].sort()).toEqual(['binary.bin', 'deleted.py', 'mode.sh', 'new ü.ts', 'space ü:name.ts'].sort());
    expect(diff.files.get('new ü.ts')).toMatchObject({ status: 'renamed', previousPath: 'old.ts' });
    expect(diff.files.get('deleted.py')?.status).toBe('deleted');
    expect(diff.files.get('binary.bin')?.isBinary).toBe(true);
    expect(diff.files.get('mode.sh')).toMatchObject({ additions: 0, deletions: 0 });
    expect(diff.addedLines.get('space ü:name.ts')?.has(1)).toBe(true);
  });
  it('branch-vs-default uses merge-base, excluding independent base-branch changes', async () => {
    const r = await makeBranchRepo({ baseFiles: { 'shared.ts': 'base\n' }, headFiles: { 'feature.ts': 'feature\n' } });
    repos.push(r);
    await git(r.dir, ['checkout', '-q', 'main']);
    await writeFiles(r.dir, { 'base-only.ts': 'base branch only\n' });
    await commitAll(r.dir, 'base diverged');
    await git(r.dir, ['checkout', '-q', 'feature']);
    const diff = await buildDiff(r.dir, await resolveTarget(r.dir, { target: 'feature' }));
    expect([...diff.files.keys()]).toEqual(['feature.ts']);
  });
  it('deepens a shallow clone even when both endpoint commits already resolve', async () => {
    const source = await makeBranchRepo({ baseFiles: { 'shared.ts': 'base\n' }, headFiles: { 'feature.ts': 'feature\n' } });
    repos.push(source);
    await git(source.dir, ['checkout', '-q', 'main']);
    await writeFiles(source.dir, { 'base-only.ts': 'base\n' });
    await commitAll(source.dir, 'diverged main');
    await git(source.dir, ['checkout', '-q', 'feature']);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cra-shallow-'));
    temporary.push(dir);
    const origin = path.join(dir, 'origin.git'), clone = path.join(dir, 'clone');
    expect((await git(dir, ['clone', '-q', '--bare', source.dir, origin])).code).toBe(0);
    expect((await git(dir, ['clone', '-q', '--depth=1', '--no-single-branch', 'file://' + origin, clone])).code).toBe(0);
    expect((await git(clone, ['rev-parse', '--is-shallow-repository'])).stdout.trim()).toBe('true');
    expect((await git(clone, ['merge-base', 'origin/main', 'HEAD'])).code).toBe(1);
    const diff = await buildDiff(clone, await resolveTarget(clone, { target: 'origin/main...HEAD' }));
    expect([...diff.files.keys()]).toEqual(['feature.ts']);
    expect((await git(clone, ['merge-base', 'origin/main', 'HEAD'])).code).toBe(0);
  });
  it('never executes configured external diff or textconv helpers', async () => {
    const r = await makeBranchRepo({ baseFiles: { 'a.ts': 'old\n' }, headFiles: { 'a.ts': 'new\n', '.gitattributes': '*.ts diff=evil\n' } });
    repos.push(r);
    const sentinel = path.join(r.dir, 'executed');
    await git(r.dir, ['config', 'diff.external', 'touch ' + sentinel]);
    await git(r.dir, ['config', 'diff.evil.textconv', 'touch ' + sentinel]);
    const diff = await buildDiff(r.dir, await resolveTarget(r.dir, { target: 'main...feature' }));
    expect(diff.files.get('a.ts')?.additions).toBe(1);
    await expect(fs.stat(sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
