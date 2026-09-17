/**
 * Pure parser for git unified diff output (no git required).
 * Handles renames, additions, deletions, binaries, quoted paths,
 * and multi-hunk files. This is the deterministic core of the diff map.
 */
import type { ChangedFile, DiffHunk, DiffMap, FileStatus } from '../types.js';

export interface ParsedSection {
  oldPath: string;
  newPath: string;
  status: FileStatus;
  previousPath?: string;
  isBinary: boolean;
  hunks: DiffHunk[];
}

/**
 * Parse a path token starting at index i. Raw (up to space) or C-quoted.
 *
 * Git C-quoting escapes non-ASCII bytes as octal (\303\251 for UTF-8 é), so
 * octal bytes must be assembled into a Buffer and decoded as UTF-8, not
 * converted per byte with String.fromCharCode.
 */
function parsePathToken(s: string, start: number): { value: string; end: number } | null {
  let i = start;
  if (s[i] === '"') {
    i++;
    const bytes: number[] = [];
    let usedOctal = false;
    let closed = false;
    while (i < s.length) {
      const c = s.charAt(i);
      if (c === '\\') {
        const n = s[i + 1];
        if (n === 't') bytes.push(0x09);
        else if (n === 'n') bytes.push(0x0a);
        else if (n === 'r') bytes.push(0x0d);
        else if (n === '"' || n === '\\') bytes.push(n === '"' ? 0x22 : 0x5c);
        else if (n !== undefined && n >= '0' && n <= '7') {
          let j = i + 1;
          let oct = '';
          while (j < s.length && j < i + 4) {
            const ch = s.charAt(j);
            if (ch < '0' || ch > '7') break;
            oct += ch;
            j++;
          }
          bytes.push(parseInt(oct, 8));
          usedOctal = true;
          i = j;
          continue;
        } else bytes.push(c.charCodeAt(0));
        i += 2;
      } else if (c === '"') {
        i++;
        closed = true;
        break;
      } else {
        bytes.push(c.charCodeAt(0));
        i++;
      }
    }
    if (!closed) return null;
    const value = usedOctal ? Buffer.from(bytes).toString('utf8') : String.fromCharCode(...bytes);
    return { value, end: i };
  }
  let j = i;
  while (j < s.length && s[j] !== ' ') j++;
  return { value: s.slice(i, j), end: j };
}

function stripSidePrefix(value: string): string {
  if (value === '/dev/null' || value === 'a/dev/null' || value === 'b/dev/null') return '';
  if (value.startsWith('a/')) return value.slice(2);
  if (value.startsWith('b/')) return value.slice(2);
  return value;
}

function parseDiffGitLine(line: string): { oldPath: string; newPath: string } | null {
  const prefix = 'diff --git ';
  if (!line.startsWith(prefix)) return null;
  const rest = line.slice(prefix.length);
  if (!rest.startsWith('"')) {
    const split = rest.lastIndexOf(' b/');
    if (split !== -1) return { oldPath: stripSidePrefix(rest.slice(0, split)), newPath: stripSidePrefix(rest.slice(split + 1)) };
  }
  const a = parsePathToken(rest, 0);
  if (!a) return null;
  if (rest[a.end] !== ' ') return null;
  const b = parsePathToken(rest, a.end + 1);
  if (!b) return null;
  return { oldPath: stripSidePrefix(a.value), newPath: stripSidePrefix(b.value) };
}

/** Parse the path after "rename from "/"rename to " (raw or quoted). */
function parseRenamePath(line: string): string {
  const body = line.replace(/^rename (from|to) /, '');
  if (body.startsWith('"')) {
    const t = parsePathToken(body, 0);
    return t ? t.value : body;
  }
  return body;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function nextNew(h: DiffHunk): number {
  let n = h.newStart;
  for (const l of h.lines) {
    if (l.newLine !== null) n = l.newLine + 1;
    else if (l.kind === 'context') n++;
  }
  return n;
}

function nextOld(h: DiffHunk): number {
  let n = h.oldStart;
  for (const l of h.lines) {
    if (l.oldLine !== null) n = l.oldLine + 1;
    else if (l.kind === 'context') n++;
  }
  return n;
}

/**
 * Whether the hunk has consumed all its declared lines. Once true, further
 * lines (including blank lines at end of file) are not part of the hunk.
 */
function hunkComplete(h: DiffHunk): boolean {
  let old = 0;
  let nn = 0;
  for (const l of h.lines) {
    if (l.kind !== 'add') old++;
    if (l.kind !== 'delete') nn++;
  }
  return old >= h.oldCount && nn >= h.newCount;
}

/**
 * Parse full `git diff -M --no-color` output into per-file sections.
 */
export function parseUnifiedDiff(text: string): ParsedSection[] {
  // CRLF files make git emit each diff line as "...content\r"; strip the
  // trailing CR so line content matches the (CRLF-normalized) file content.
  const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  const sections: ParsedSection[] = [];
  let cur: ParsedSection | null = null;

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      const parsed = parseDiffGitLine(line);
      if (parsed) {
        cur = {
          oldPath: parsed.oldPath,
          newPath: parsed.newPath,
          status: 'modified',
          isBinary: false,
          hunks: [],
        };
        sections.push(cur);
      }
      continue;
    }
    if (!cur) continue;

    if (line.startsWith('rename from ')) {
      cur.status = 'renamed';
      cur.previousPath = parseRenamePath(line);
      continue;
    }
    if (line.startsWith('rename to ')) {
      if (cur.status !== 'renamed') cur.status = 'renamed';
      const to = parseRenamePath(line);
      if (to) cur.newPath = to;
      continue;
    }
    if (line.startsWith('new file mode ')) {
      cur.status = 'added';
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      const body = line.slice(4);
      const value = body.startsWith('"') ? parsePathToken(body, 0)?.value ?? '' : body.split('\t')[0]!;
      if (line.startsWith('--- ')) cur.oldPath = stripSidePrefix(value);
      else cur.newPath = stripSidePrefix(value);
      continue;
    }
    if (line.startsWith('deleted file mode ')) {
      cur.status = 'deleted';
      continue;
    }
    if (
      line.startsWith('old mode ') ||
      line.startsWith('new mode ') ||
      line.startsWith('similarity index ') ||
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ')
    ) {
      continue;
    }
    if (line.startsWith('Binary files ')) {
      cur.isBinary = true;
      continue;
    }
    const hunkMatch = HUNK_RE.exec(line);
    if (hunkMatch) {
      const oldCountRaw = hunkMatch[2];
      const newCountRaw = hunkMatch[4];
      cur.hunks.push({
        header: line,
        oldStart: parseInt(hunkMatch[1]!, 10),
        oldCount: oldCountRaw !== undefined ? parseInt(oldCountRaw, 10) : 1,
        newStart: parseInt(hunkMatch[3]!, 10),
        newCount: newCountRaw !== undefined ? parseInt(newCountRaw, 10) : 1,
        lines: [],
      });
      continue;
    }
    const hunk = cur.hunks[cur.hunks.length - 1];
    if (!hunk) continue;
    if (hunkComplete(hunk)) continue; // hunk already finished; ignore stray lines
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    if (line.length === 0) {
      // Blank context line (git may emit it without the leading space).
      hunk.lines.push({
        kind: 'context',
        content: '',
        newLine: hunk.newCount === 0 ? null : nextNew(hunk),
        oldLine: hunk.oldCount === 0 ? null : nextOld(hunk),
      });
      continue;
    }
    const marker = line[0];
    if (marker === '+') {
      hunk.lines.push({ kind: 'add', content: line.slice(1), newLine: nextNew(hunk), oldLine: null });
    } else if (marker === '-') {
      hunk.lines.push({ kind: 'delete', content: line.slice(1), newLine: null, oldLine: nextOld(hunk) });
    } else if (marker === ' ') {
      hunk.lines.push({
        kind: 'context',
        content: line.slice(1),
        newLine: hunk.newCount === 0 ? null : nextNew(hunk),
        oldLine: hunk.oldCount === 0 ? null : nextOld(hunk),
      });
    }
    // Unrecognized lines are ignored defensively.
  }

  // Fill status/previousPath from the diff --git line where rename metadata
  // was absent (e.g. mode-only changes keep status 'modified').
  for (const s of sections) {
    if (s.status === 'modified' && s.oldPath === '' && s.newPath !== '') s.status = 'added';
    if (s.status === 'modified' && s.oldPath !== '' && s.newPath === '') s.status = 'deleted';
    if (s.status === 'renamed' && !s.previousPath) s.previousPath = s.oldPath;
  }
  return sections;
}

/**
 * Parse `git diff -M --numstat` output. Binary rows use `-` counts.
 * Renames appear as `old => new` or `prefix{old => new}suffix`.
 */
export function parseNumstat(
  text: string,
): Map<string, { additions: number; deletions: number; isBinary: boolean; from?: string }> {
  const out = new Map<
    string,
    { additions: number; deletions: number; isBinary: boolean; from?: string }
  >();
  if (text.includes('\0')) {
    const rows = text.split('\0');
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      if (!row) continue;
      const first = row.indexOf('\t');
      const second = row.indexOf('\t', first + 1);
      if (first < 0 || second < 0) throw new Error('malformed NUL numstat');
      const a = row.slice(0, first), d = row.slice(first + 1, second);
      let name = row.slice(second + 1);
      let from: string | undefined;
      if (!name) { from = rows[++i]; name = rows[++i] ?? ''; }
      if (!name) throw new Error('missing NUL numstat path');
      out.set(name, { additions: a === '-' ? 0 : Number(a), deletions: d === '-' ? 0 : Number(d), isBinary: a === '-', ...(from ? { from } : {}) });
    }
    return out;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const addRaw = parts[0] ?? '';
    const delRaw = parts[1] ?? '';
    const rawPath = parts.slice(2).join('\t');
    const path = rawPath.startsWith('"') ? parsePathToken(rawPath, 0)?.value ?? rawPath : rawPath;
    const isBinary = addRaw === '-' && delRaw === '-';
    const additions = isBinary ? 0 : parseInt(addRaw, 10);
    const deletions = isBinary ? 0 : parseInt(delRaw, 10);
    // Rename forms: "old => new" or "prefix{old => new}suffix" (braces wrap
    // the changed part, so " => " sits inside the brace range).
    const openBrace = path.indexOf('{');
    const closeBrace = path.lastIndexOf('}');
    if (openBrace !== -1 && closeBrace > openBrace) {
      const inner = path.slice(openBrace + 1, closeBrace);
      const arrow = inner.indexOf(' => ');
      if (arrow !== -1) {
        const oldInner = inner.slice(0, arrow);
        const newInner = inner.slice(arrow + 4);
        const prefix = path.slice(0, openBrace);
        const suffix = path.slice(closeBrace + 1);
        out.set(`${prefix}${newInner}${suffix}`, {
          additions,
          deletions,
          isBinary,
          from: `${prefix}${oldInner}${suffix}`,
        });
        continue;
      }
    }
    const arrow = path.indexOf(' => ');
    if (arrow !== -1) {
      out.set(path.slice(arrow + 4), {
        additions,
        deletions,
        isBinary,
        from: path.slice(0, arrow),
      });
    } else {
      out.set(path, { additions, deletions, isBinary });
    }
  }
  return out;
}

/** Assemble a full DiffMap from raw diff text + numstat. */
export function buildDiffMap(
  baseSha: string,
  headSha: string,
  diffText: string,
  numstatText: string,
  nameStatusText?: string,
): DiffMap {
  const sections = parseUnifiedDiff(diffText);
  const numstat = parseNumstat(numstatText);
  if (nameStatusText !== undefined) {
    const names = nameStatusText.split('\0').filter(Boolean);
    let section = 0;
    for (let i = 0; i < names.length; i++) {
      const code = names[i]!;
      const old = names[++i];
      const next = code.startsWith('R') ? names[++i] : old;
      const s = sections[section++];
      if (!s || !old || !next) throw new Error('diff/name-status mismatch');
      s.status = code.startsWith('R') ? 'renamed' : code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified';
      s.oldPath = code === 'A' ? '' : old;
      s.newPath = code === 'D' ? '' : next;
      s.previousPath = code.startsWith('R') ? old : undefined;
    }
    if (section !== sections.length) throw new Error('diff/name-status mismatch');
  }

  const files = new Map<string, ChangedFile>();
  const hunks = new Map<string, DiffHunk[]>();
  const addedLines = new Map<string, Set<number>>();

  for (const s of sections) {
    const path = s.status === 'deleted' ? s.oldPath : s.newPath;
    if (path === '') continue;
    const ns = numstat.get(path) ?? { additions: 0, deletions: 0, isBinary: false };
    const added = new Set<number>();
    let maxNew = 0;
    for (const h of s.hunks) {
      for (const l of h.lines) {
        if (l.kind === 'add' && l.newLine !== null) added.add(l.newLine);
        if (l.newLine !== null && l.newLine > maxNew) maxNew = l.newLine;
      }
    }
    files.set(path, {
      path,
      status: s.status,
      previousPath: s.previousPath && s.previousPath !== path ? s.previousPath : undefined,
      additions: ns.additions,
      deletions: ns.deletions,
      isBinary: s.isBinary || ns.isBinary,
      lines: s.status === 'deleted' ? 0 : maxNew,
    });
    hunks.set(path, s.hunks);
    addedLines.set(path, added);
  }
  return { baseSha, headSha, files, hunks, addedLines };
}

/**
 * Render the diff text for a single file (used by the read_diff tool).
 */
export function renderFileDiff(diff: DiffMap, path: string): string | null {
  const file = diff.files.get(path);
  if (!file) return null;
  const hunks = diff.hunks.get(path) ?? [];
  const parts: string[] = [];
  parts.push(`diff --git a/${file.previousPath ?? path} b/${path}`);
  if (file.status === 'added') parts.push('new file');
  if (file.status === 'deleted') parts.push('deleted file');
  if (file.status === 'renamed') parts.push(`renamed from ${file.previousPath}`);
  if (file.isBinary) parts.push('Binary files differ');
  for (const h of hunks) {
    parts.push(h.header);
    for (const l of h.lines) {
      const marker = l.kind === 'add' ? '+' : l.kind === 'delete' ? '-' : ' ';
      parts.push(`${marker}${l.content}`);
    }
  }
  return parts.join('\n');
}
