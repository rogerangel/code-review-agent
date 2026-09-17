import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempRepo, type RepoHandle } from '../helpers/repos.js';
import { git } from '../../src/core/diff/git.js';
import { buildDiff, resolveTarget } from '../../src/core/diff/git.js';
import { renderFileDiff } from '../../src/core/diff/normalize.js';

const FIXTURES = path.resolve(__dirname, '..', 'fixtures', 'repos');

const repos: RepoHandle[] = [];
afterEach(async () => {
  while (repos.length > 0) await repos.pop()!.dispose();
});

async function copyTree(src: string, dest: string): Promise<void> {
  await fs.rm(dest, { recursive: true, force: true }).catch(() => undefined);
  await fs.cp(src, dest, { recursive: true });
}

async function fixtureDiff(lang: string): Promise<{ repo: RepoHandle; diff: Awaited<ReturnType<typeof buildDiff>> }> {
  const repo = await makeTempRepo({});
  repos.push(repo);
  await copyTree(path.join(FIXTURES, lang, 'base'), path.join(repo.dir, 'work'));
  // move files to repo root
  for (const entry of await fs.readdir(path.join(repo.dir, 'work'))) {
    await fs.rename(path.join(repo.dir, 'work', entry), path.join(repo.dir, entry));
  }
  await fs.rmdir(path.join(repo.dir, 'work'));
  await git(repo.dir, ['add', '-A']);
  await git(repo.dir, ['commit', '-q', '-m', 'base']);
  await git(repo.dir, ['checkout', '-q', '-b', 'feature']);
  await copyTree(path.join(FIXTURES, lang, 'head'), path.join(repo.dir, 'headcopy'));
  for (const entry of await fs.readdir(path.join(repo.dir, 'headcopy'))) {
    await fs.cp(path.join(repo.dir, 'headcopy', entry), path.join(repo.dir, entry), { recursive: true });
  }
  await fs.rm(path.join(repo.dir, 'headcopy'), { recursive: true, force: true });
  // remove files that were deleted between base and head
  const baseFiles = await walk(path.join(FIXTURES, lang, 'base'));
  const headFiles = await walk(path.join(FIXTURES, lang, 'head'));
  for (const rel of baseFiles) {
    if (!headFiles.has(rel)) {
      await fs.rm(path.join(repo.dir, rel), { force: true }).catch(() => undefined);
    }
  }
  await git(repo.dir, ['add', '-A']);
  await git(repo.dir, ['commit', '-q', '-m', 'head']);
  const target = await resolveTarget(repo.dir, { target: 'main...feature' });
  const diff = await buildDiff(repo.dir, target);
  return { repo, diff };
}

async function walk(dir: string): Promise<Set<string>> {
  const out = new Set<string>();
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const rel = path.join(e.name);
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      for (const nested of await walk(full)) out.add(path.posix.join(e.name, nested));
    } else {
      out.add(rel);
    }
  }
  return out;
}

describe('polyglot fixture diffs', () => {
  it('typescript: modifications + new file', async () => {
    const { diff } = await fixtureDiff('typescript');
    expect(diff.files.get('src/app.ts')!.status).toBe('modified');
    expect(diff.files.get('src/app.ts')!.additions).toBe(1);
    expect(diff.files.get('README.md')!.status).toBe('modified');
    expect(diff.files.get('src/format.ts')!.status).toBe('added');
    expect([...diff.addedLines.get('src/app.ts')!]).toEqual([2]);
    expect(renderFileDiff(diff, 'src/app.ts')).toContain('+  if (typeof a');
  });

  it('python: CRLF file parses with correct added lines', async () => {
    const { diff } = await fixtureDiff('python');
    const f = diff.files.get('app.py')!;
    expect(f.status).toBe('modified');
    expect(f.additions).toBe(4);
    expect([...diff.addedLines.get('app.py')!]).toEqual([4, 5, 6, 7]);
    // CRLF must not leak into line content.
    expect(diff.hunks.get('app.py')![0]!.lines.some((l) => l.content.endsWith('\r'))).toBe(false);
  });

  it('go: rename detected with previous path', async () => {
    const { diff } = await fixtureDiff('go');
    expect(diff.files.has('util.go')).toBe(false);
    const helpers = diff.files.get('helpers.go')!;
    expect(helpers.status).toBe('renamed');
    expect(helpers.previousPath).toBe('util.go');
    expect(diff.files.has('main.go')).toBe(false); // unchanged
  });

  it('java: modification + deletion', async () => {
    const { diff } = await fixtureDiff('java');
    expect(diff.files.get('src/main/java/App.java')!.status).toBe('modified');
    expect(diff.files.get('src/main/java/Obsolete.java')!.status).toBe('deleted');
    expect(diff.files.get('src/main/java/Obsolete.java')!.additions).toBe(0);
    const text = renderFileDiff(diff, 'src/main/java/Obsolete.java')!;
    expect(text).toContain('deleted file');
    expect(text).toContain('-public class Obsolete {');
  });

  it('dotnet: modification', async () => {
    const { diff } = await fixtureDiff('dotnet');
    const f = diff.files.get('Program.cs')!;
    expect(f.status).toBe('modified');
    expect(f.additions).toBeGreaterThanOrEqual(3);
    expect(renderFileDiff(diff, 'Program.cs')).toContain('+    static string Version() => "v2";');
  });
});
