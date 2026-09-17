import { describe, expect, it } from 'vitest';
import {
  buildDiffMap,
  parseNumstat,
  parseUnifiedDiff,
  renderFileDiff,
} from '../../src/core/diff/normalize.js';

const SIMPLE = `diff --git a/src/app.ts b/src/app.ts
index 1234567..89abcde 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,5 @@
 const a = 1;
+const b = 2;
 function f() {
   return a;
 }
`;

const ADDED = `diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
`;

const DELETED = `diff --git a/gone.txt b/dev/null
deleted file mode 100644
index 1111111..0000000
--- a/gone.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-hello
-world
`;

const RENAME = `diff --git a/old.txt b/new.txt
similarity index 100%
rename from old.txt
rename to new.txt
`;

const RENAME_WITH_CHANGE = `diff --git a/lib/old.js b/lib/new.js
similarity index 80%
rename from lib/old.js
rename to lib/new.js
index 1111111..2222222 100644
--- a/lib/old.js
+++ b/lib/new.js
@@ -1,2 +1,3 @@
-export function x() {
+export function x() {
+  return 1;
 }
`;

const BINARY = `diff --git a/img/logo.png b/img/logo.png
index 3333333..4444444 100644
Binary files a/img/logo.png and b/img/logo.png differ
`;

const QUOTED = `diff --git "a/src/f\\303\\251l.ts" "b/src/f\\303\\251l.ts"
index 5555555..6666666 100644
--- "a/src/f\\303\\251l.ts"
+++ "b/src/f\\303\\251l.ts"
@@ -1 +1 @@
-old
+new
`;

const MULTILINE_CONTEXT_BLANK = `diff --git a/x.py b/x.py
index 7777777..8888888 100644
--- a/x.py
+++ b/x.py
@@ -1,4 +1,4 @@
 a
-
-b
+
+c
 d
`;

describe('parseUnifiedDiff', () => {
  it('parses a simple modified file with line numbers', () => {
    const [s] = parseUnifiedDiff(SIMPLE);
    expect(s).toBeDefined();
    expect(s!.status).toBe('modified');
    expect(s!.oldPath).toBe('src/app.ts');
    expect(s!.newPath).toBe('src/app.ts');
    expect(s!.hunks).toHaveLength(1);
    const lines = s!.hunks[0]!.lines;
    expect(lines.map((l) => l.kind)).toEqual([
      'context',
      'add',
      'context',
      'context',
      'context',
    ]);
    expect(lines[1]!.newLine).toBe(2);
    expect(lines[1]!.oldLine).toBeNull();
    expect(lines[0]!.newLine).toBe(1);
    expect(lines[0]!.oldLine).toBe(1);
    expect(lines[3]!.newLine).toBe(4);
    expect(lines[4]!.newLine).toBe(5);
    expect(lines[4]!.oldLine).toBe(4);
  });

  it('parses added files', () => {
    const [s] = parseUnifiedDiff(ADDED);
    expect(s!.status).toBe('added');
    expect(s!.newPath).toBe('new.txt');
    expect(s!.hunks[0]!.lines.map((l) => l.newLine)).toEqual([1, 2]);
    expect(s!.hunks[0]!.lines.map((l) => l.oldLine)).toEqual([null, null]);
  });

  it('parses deleted files', () => {
    const [s] = parseUnifiedDiff(DELETED);
    expect(s!.status).toBe('deleted');
    expect(s!.oldPath).toBe('gone.txt');
    expect(s!.newPath).toBe('');
    expect(s!.hunks[0]!.lines.every((l) => l.newLine === null)).toBe(true);
    expect(s!.hunks[0]!.lines.map((l) => l.oldLine)).toEqual([1, 2]);
  });

  it('parses pure renames', () => {
    const [s] = parseUnifiedDiff(RENAME);
    expect(s!.status).toBe('renamed');
    expect(s!.previousPath).toBe('old.txt');
    expect(s!.newPath).toBe('new.txt');
    expect(s!.hunks).toHaveLength(0);
  });

  it('parses renames with changes', () => {
    const [s] = parseUnifiedDiff(RENAME_WITH_CHANGE);
    expect(s!.status).toBe('renamed');
    expect(s!.previousPath).toBe('lib/old.js');
    expect(s!.newPath).toBe('lib/new.js');
    expect(s!.hunks[0]!.lines.filter((l) => l.kind === 'add')).toHaveLength(2);
    expect(s!.hunks[0]!.lines.filter((l) => l.kind === 'add').map((l) => l.newLine)).toEqual([1, 2]);
  });

  it('parses binary files', () => {
    const [s] = parseUnifiedDiff(BINARY);
    expect(s!.isBinary).toBe(true);
    expect(s!.status).toBe('modified');
  });

  it('parses C-quoted (unicode) paths', () => {
    const [s] = parseUnifiedDiff(QUOTED);
    expect(s!.oldPath).toBe('src/fél.ts');
    expect(s!.newPath).toBe('src/fél.ts');
    expect(s!.status).toBe('modified');
  });

  it('numbers context lines around blank-line edits', () => {
    const [s] = parseUnifiedDiff(MULTILINE_CONTEXT_BLANK);
    const lines = s!.hunks[0]!.lines;
    expect(lines.map((l) => l.kind)).toEqual([
      'context',
      'delete',
      'delete',
      'add',
      'add',
      'context',
    ]);
    expect(lines[0]!.newLine).toBe(1);
    expect(lines[5]!.newLine).toBe(4);
    expect(lines[1]!.newLine).toBeNull();
    expect(lines[3]!.newLine).toBe(2);
    expect(lines[3]!.oldLine).toBeNull();
    expect(lines[1]!.oldLine).toBe(2);
  });
});

describe('parseNumstat', () => {
  it('parses counts, binaries, and rename forms', () => {
    const text = [
      '3\t2\tsrc/app.ts',
      '-\t-\timg/logo.png',
      '0\t0\told.txt => new.txt',
      '1\t0\tlib/prefix{a.js => b.js}.map',
      '',
    ].join('\n');
    const m = parseNumstat(text);
    expect(m.get('src/app.ts')).toEqual({ additions: 3, deletions: 2, isBinary: false });
    expect(m.get('img/logo.png')).toEqual({ additions: 0, deletions: 0, isBinary: true });
    expect(m.get('new.txt')!.from).toBe('old.txt');
    const braced = m.get('lib/prefixb.js.map');
    expect(braced).toBeDefined();
    expect(braced!.from).toBe('lib/prefixa.js.map');
  });
});

describe('buildDiffMap', () => {
  it('assembles files, hunks, and added lines', () => {
    const diffText = [SIMPLE, RENAME_WITH_CHANGE, BINARY].join('\n');
    const numstat = [
      '1\t0\tsrc/app.ts',
      '2\t1\tlib/new.js',
      '-\t-\timg/logo.png',
    ].join('\n');
    const m = buildDiffMap('base123', 'head456', diffText, numstat);
    expect(m.baseSha).toBe('base123');
    expect(m.headSha).toBe('head456');
    expect([...m.files.keys()].sort()).toEqual(['img/logo.png', 'lib/new.js', 'src/app.ts']);
    expect(m.files.get('src/app.ts')!.status).toBe('modified');
    expect(m.files.get('lib/new.js')!.previousPath).toBe('lib/old.js');
    expect(m.files.get('img/logo.png')!.isBinary).toBe(true);
    expect([...m.addedLines.get('src/app.ts')!]).toEqual([2]);
    expect([...m.addedLines.get('lib/new.js')!]).toEqual([1, 2]);
  });

  it('renderFileDiff round-trips for a modified file', () => {
    const m = buildDiffMap('b', 'h', SIMPLE, '1\t0\tsrc/app.ts');
    const text = renderFileDiff(m, 'src/app.ts');
    expect(text).toContain('+const b = 2;');
    expect(text).toContain('@@ -1,4 +1,5 @@');
    expect(renderFileDiff(m, 'nope.ts')).toBeNull();
  });
});
