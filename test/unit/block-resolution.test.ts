import { describe, expect, it } from 'vitest';
import {
  findingFingerprint,
  resolveBlock,
} from '../../src/core/tools/post-comment.js';

const FILE = [
  'function one() {',
  '  return 1;',
  '}',
  'function two() {',
  '  return 2;',
  '}',
  'const dup = "shared line";',
  'const dup = "shared line";',
  'export function main() {',
  '  const x = 42;',
  '  return x;',
  '}',
].join('\n');

const LINES = FILE.split('\n');

describe('resolveBlock', () => {
  it('resolves a unique single-line block', () => {
    const r = resolveBlock(LINES, 'function one() {');
    expect(r).toEqual({ startLine: 1, endLine: 1 });
  });

  it('resolves a multiline block', () => {
    const r = resolveBlock(LINES, 'function two() {\n  return 2;\n}');
    expect(r).toEqual({ startLine: 4, endLine: 6 });
  });

  it('rejects a block that occurs twice (ambiguous)', () => {
    const r = resolveBlock(LINES, 'const dup = "shared line";');
    expect(r).toEqual({ error: 'block-ambiguous' });
  });

  it('rejects a block that is not present', () => {
    const r = resolveBlock(LINES, 'this does not exist at all');
    expect(r).toEqual({ error: 'block-not-found' });
  });

  it('tolerates trailing whitespace differences when exact match fails', () => {
    const r = resolveBlock(LINES, 'function one() {   ');
    expect(r).toEqual({ startLine: 1, endLine: 1 });
  });

  it('rejects blocks that are too small', () => {
    expect(resolveBlock(LINES, '  ')).toEqual({ error: 'block-too-small' });
    expect(resolveBlock(LINES, 'ab')).toEqual({ error: 'block-too-small' });
  });

  it('rejects blocks that are too large', () => {
    const big = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n');
    expect(resolveBlock(LINES, big)).toEqual({ error: 'block-too-large' });
  });

  it('resolves a block at the end of file without trailing newline', () => {
    const lines = ['alpha', 'beta', 'gamma'];
    expect(resolveBlock(lines, 'gamma')).toEqual({ startLine: 3, endLine: 3 });
  });
});

describe('findingFingerprint', () => {
  it('is stable when the block has trailing whitespace and the message case differs', () => {
    const a = findingFingerprint({
      path: 'src/x.ts',
      block: 'const y = 1;\n',
      severity: 'high',
      explanation: 'Off by one',
    });
    const b = findingFingerprint({
      path: 'src/x.ts',
      block: 'const y = 1;   \n\n',
      severity: 'high',
      explanation: 'Off  by one',
    });
    // block lines are trimmed; message is lowercased and whitespace-collapsed.
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs when location, severity, or message differ', () => {
    const base = { path: 'src/x.ts', block: 'const y = 1;', severity: 'high' as const, explanation: 'Bug' };
    expect(findingFingerprint({ ...base })).not.toBe(
      findingFingerprint({ ...base, path: 'src/other.ts' }),
    );
    expect(findingFingerprint({ ...base })).not.toBe(
      findingFingerprint({ ...base, severity: 'medium' }),
    );
    expect(findingFingerprint({ ...base })).not.toBe(
      findingFingerprint({ ...base, explanation: 'Different problem' }),
    );
  });
});
