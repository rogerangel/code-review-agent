import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeBranchRepo, type RepoHandle } from '../helpers/repos.js';
import { buildDiff, resolveTarget } from '../../src/core/diff/git.js';
import type { PlantedIssue } from '../../scripts/eval-metrics.js';

const repos: RepoHandle[] = [];
afterEach(async () => { for (const repo of repos.splice(0)) await repo.dispose(); });
async function snapshot(directory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const [filename, content] of Object.entries(await snapshot(path.join(directory, entry.name)))) files[entry.name + '/' + filename] = content;
    } else files[entry.name] = await fs.readFile(path.join(directory, entry.name), 'utf8');
  }
  return files;
}
describe('planted-bug truth sidecars', () => {
  for (const language of ['typescript', 'python', 'go', 'java', 'dotnet']) {
    it(language + ': planted anchors are actual added lines, not merely removed/context lines', async () => {
      const fixture = path.resolve('test/fixtures/eval', language);
      const repo = await makeBranchRepo({ baseFiles: await snapshot(path.join(fixture, 'base')), headFiles: await snapshot(path.join(fixture, 'head')) });
      repos.push(repo);
      const diff = await buildDiff(repo.dir, await resolveTarget(repo.dir, { target: 'main...feature' }));
      const truth = JSON.parse(await fs.readFile(path.join(fixture, 'issues.json'), 'utf8')) as { issues: PlantedIssue[] };
      expect(truth.issues).not.toHaveLength(0);
      for (const issue of truth.issues) expect(issue.lines.some((line) => diff.addedLines.get(issue.file)?.has(line))).toBe(true);
      const control = JSON.parse(await fs.readFile(path.resolve('test/fixtures/repos', language, 'issues.json'), 'utf8'));
      expect(control.kind).toBe('clean-control');
      expect(control.issues).toEqual([]);
    });
  }
});

