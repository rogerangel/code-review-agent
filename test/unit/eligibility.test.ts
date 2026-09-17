import { describe, expect, it } from 'vitest';
import { classifyAll, classifyFile } from '../../src/core/filtering/eligibility.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import type { RepoConfig } from '../../src/core/types.js';

const cfg = (over: Partial<RepoConfig> = {}): RepoConfig => ({
  ...DEFAULT_CONFIG,
  ...over,
});

describe('classifyFile', () => {
  it('excludes lock files by default', () => {
    expect(classifyFile('package-lock.json', false, cfg()).eligible).toBe(false);
    expect(classifyFile('package-lock.json', false, cfg()).kind).toBe('lock-file');
    expect(classifyFile('vendor/gems/poetry.lock', false, cfg()).eligible).toBe(false);
    expect(classifyFile('Cargo.lock', false, cfg()).eligible).toBe(false);
  });

  it('excludes vendored and generated paths by default', () => {
    expect(classifyFile('node_modules/foo/index.js', false, cfg()).kind).toBe('vendored');
    expect(classifyFile('vendor/rails/lib.rb', false, cfg()).kind).toBe('vendored');
    expect(classifyFile('dist/bundle.js', false, cfg()).kind).toBe('generated');
    expect(classifyFile('src/dist/app.js', false, cfg()).kind).toBe('generated');
    expect(classifyFile('out/app.css', false, cfg()).kind).toBe('generated');
    expect(classifyFile('src/a.min.js', false, cfg()).kind).toBe('generated');
    expect(classifyFile('src/a.js.map', false, cfg()).kind).toBe('generated');
    expect(classifyFile('gen/Api.generated.cs', false, cfg()).kind).toBe('generated');
    expect(classifyFile('proto/user.pb.go', false, cfg()).kind).toBe('generated');
  });

  it('always excludes binary files', () => {
    const r = classifyFile('src/logo.png', true, cfg());
    expect(r.eligible).toBe(false);
    expect(r.kind).toBe('binary');
  });

  it('includes ordinary source files', () => {
    expect(classifyFile('src/app.ts', false, cfg()).eligible).toBe(true);
    expect(classifyFile('pkg/module.py', false, cfg()).eligible).toBe(true);
    expect(classifyFile('cmd/server/main.go', false, cfg()).eligible).toBe(true);
    expect(classifyFile('src/main/java/App.java', false, cfg()).eligible).toBe(true);
    expect(classifyFile('Program.cs', false, cfg()).eligible).toBe(true);
  });

  it('config exclude always wins', () => {
    const c = cfg({ exclude: ['src/**'] });
    expect(classifyFile('src/app.ts', false, c).kind).toBe('config-exclude');
    // even when an include would match
    const c2 = cfg({ include: ['src/**'], exclude: ['src/**'] });
    expect(classifyFile('src/app.ts', false, c2).kind).toBe('config-exclude');
  });

  it('non-empty include acts as a whitelist', () => {
    const c = cfg({ include: ['src/**/*.ts'] });
    expect(classifyFile('src/app.ts', false, c).eligible).toBe(true);
    expect(classifyFile('docs/readme.md', false, c).kind).toBe('include-filter');
  });

  it('explicit include opts files back in past default exclusions', () => {
    const c = cfg({ include: ['**/Cargo.lock'] });
    expect(classifyFile('Cargo.lock', false, c).eligible).toBe(true);
    const c2 = cfg({ include: ['dist/**'] });
    expect(classifyFile('dist/bundle.js', false, c2).eligible).toBe(true);
  });
});

describe('classifyAll', () => {
  it('classifies every file', () => {
    const m = classifyAll(
      [
        { path: 'src/a.ts', isBinary: false },
        { path: 'yarn.lock', isBinary: false },
        { path: 'img/b.png', isBinary: true },
      ],
      cfg(),
    );
    expect(m.get('src/a.ts')!.eligible).toBe(true);
    expect(m.get('yarn.lock')!.eligible).toBe(false);
    expect(m.get('img/b.png')!.eligible).toBe(false);
  });
});
