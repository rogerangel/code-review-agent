import { describe, expect, it } from 'vitest';
import { normalizeRepoPath, classifyPath, joinRepoPath, parentDir, basename } from '../../src/core/security/paths.js';

describe('normalizeRepoPath', () => {
  it('normalizes backslashes and dot segments', () => {
    expect(normalizeRepoPath('src\\app.ts')).toBe('src/app.ts');
    expect(normalizeRepoPath('src/./app.ts')).toBe('src/app.ts');
    expect(normalizeRepoPath('a/b/c.md')).toBe('a/b/c.md');
  });

  it('rejects escapes and absolute paths', () => {
    expect(normalizeRepoPath('../x')).toBeNull();
    expect(normalizeRepoPath('a/../../b')).toBeNull();
    expect(normalizeRepoPath('/etc/passwd')).toBeNull();
    expect(normalizeRepoPath('C:\\Windows\\x')).toBeNull();
    expect(normalizeRepoPath('a\0b')).toBeNull();
    expect(normalizeRepoPath('a\nb')).toBeNull();
    expect(normalizeRepoPath('')).toBeNull();
    expect(normalizeRepoPath('.')).toBeNull();
    expect(normalizeRepoPath('a/b/..')).toBeNull();
  });

  it('accepts a leading-dot directory inside the repo', () => {
    expect(normalizeRepoPath('.github/workflows/ci.yml')).toBe('.github/workflows/ci.yml');
  });
});

describe('classifyPath', () => {
  it('classifies', () => {
    expect(classifyPath('src/a.ts')).toBe('ok');
    expect(classifyPath('../x')).toBe('escape');
    expect(classifyPath('/etc/passwd')).toBe('escape');
    expect(classifyPath('')).toBe('root');
    expect(classifyPath('a\nb')).toBe('invalid');
  });
});

describe('path helpers', () => {
  it('joinRepoPath', () => {
    expect(joinRepoPath('src', 'a.ts')).toBe('src/a.ts');
    expect(joinRepoPath('', 'a.ts')).toBe('a.ts');
    expect(joinRepoPath('src', '../x')).toBeNull();
  });
  it('parentDir / basename', () => {
    expect(parentDir('a/b/c.ts')).toBe('a/b');
    expect(parentDir('c.ts')).toBe('');
    expect(basename('a/b/c.ts')).toBe('c.ts');
    expect(basename('c.ts')).toBe('c.ts');
  });
});
