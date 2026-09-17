import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { parse } from 'yaml';

describe('deferred and guarded releases', () => {
  it('keeps npm private and has no active publishing job', async () => {
    const manifest = JSON.parse(await fs.readFile('package.json', 'utf8'));
    const workflow = parse(await fs.readFile('.github/workflows/ci.yml', 'utf8'));
    expect(manifest.private).toBe(true);
    expect(manifest.repository.url).toBe('git+https://github.com/rogerangel/code-review-agent.git');
    expect(Object.keys(workflow.jobs)).toEqual(['verify']);
    expect(workflow.jobs.verify.steps.some((step: { run?: string }) => step.run?.includes('npm publish'))).toBe(false);
    expect(workflow.jobs.verify.steps.some((step: { run?: string }) => step.run === 'npm run check:dist')).toBe(true);
    expect(workflow.jobs.verify.steps.some((step: { run?: string }) => step.run === 'npm run smoke')).toBe(true);
  });
  it('avoids reserved workflow secrets and preserves the default token fallback', async () => {
    const workflow = parse(await fs.readFile('.github/workflows/code-review-agent.yml', 'utf8'));
    expect(workflow.on.workflow_call.secrets.repository_token.required).toBe(false);
    for (const name of Object.keys(workflow.on.workflow_call.secrets)) {
      expect(name.toUpperCase()).not.toMatch(/^GITHUB_/);
    }
    const bindings = [...workflow.jobs.gate.steps, ...workflow.jobs.review.steps]
      .flatMap((step: { with?: { token?: string; github_token?: string } }) => {
        const token = step.with?.token ?? step.with?.github_token;
        return token ? [token] : [];
      });
    expect(bindings).toHaveLength(5);
    expect(bindings.every((token) => token === '${{ secrets.repository_token || github.token }}')).toBe(true);
    const callerGuide = await fs.readFile('docs/caller-workflow.md', 'utf8');
    expect(callerGuide).toContain('# repository_token: ${{ secrets.CR_AGENT_TOKEN }}');
    expect(callerGuide).not.toContain('# github_token:');
  });
  it('rejects mutable/mismatched tags and accepts the manifest version without publishing', async () => {
    for (const [tag, code] of [['v1', 1], ['v0.2.0', 1], ['v0.1.0', 0]] as const) {
      const run = spawnSync('node', ['--import', 'tsx', 'scripts/check-release.ts', tag], { encoding: 'utf8', timeout: 10_000 });
      expect(run.status, run.stderr).toBe(code);
      if (code === 0) expect(run.stdout).toContain('publication remains disabled');
    }
  });
});
