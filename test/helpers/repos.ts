/**
 * Temp git repository helpers for integration tests.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git } from '../../src/core/diff/git.js';

export interface RepoHandle {
  dir: string;
  dispose: () => Promise<void>;
}

export async function makeTempRepo(files: Record<string, string>): Promise<RepoHandle> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cra-test-'));
  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
  await writeFiles(dir, files);
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', 'initial']);
  return {
    dir,
    dispose: async () => {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

export async function writeFiles(
  dir: string,
  files: Record<string, string | null>,
): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    if (content === null) {
      await fs.rm(abs, { force: true }).catch(() => undefined);
      continue;
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }
}

export async function commitAll(dir: string, message: string): Promise<void> {
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', message, '--allow-empty']);
}

export async function branch(dir: string, name: string): Promise<void> {
  await git(dir, ['checkout', '-q', '-b', name]);
}

export async function headSha(dir: string): Promise<string> {
  const r = await git(dir, ['rev-parse', 'HEAD']);
  return r.stdout.trim();
}

export async function makeBranchRepo(params: {
  baseFiles: Record<string, string>;
  headFiles: Record<string, string>;
  branchName?: string;
}): Promise<RepoHandle> {
  const repo = await makeTempRepo(params.baseFiles);
  await branch(repo.dir, params.branchName ?? 'feature');
  await writeFiles(repo.dir, params.headFiles);
  await commitAll(repo.dir, 'change');
  return repo;
}
