/**
 * Path security: normalization, confinement, and classification of
 * repository-relative paths. All tool paths must pass through here.
 */

/**
 * Normalize a repo-relative path to forward slashes.
 *
 * Returns null when the path cannot be made safe:
 *  - absolute paths
 *  - NUL bytes
 *  - any segment equal to ".." (path escape)
 *  - empty or root-only paths
 */
export function normalizeRepoPath(input: string): string | null {
  if (typeof input !== 'string') return null;
  if (input.length === 0) return null;
  if (input.includes('\0')) return null;
  if (input.includes('\r') || input.includes('\n')) return null;

  let p = input;
  // Reject anything rooted outside the repository.
  if (p.startsWith('/')) return null;
  if (/^[a-zA-Z]:[\\/]/.test(p)) return null; // windows drive

  // Normalize backslashes (git itself never produces them, but models may).
  p = p.replace(/\\/g, '/');

  const segments = p.split('/');
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return null; // confinement: no escape
    out.push(seg);
  }
  if (out.length === 0) return null;
  // Reject "." as a whole (root listing is allowed via list_directory ""? no -
  // list_directory accepts empty meaning root; this helper is for file paths).
  return out.join('/');
}

/**
 * Classify a normalized repo path.
 */
export function classifyPath(path: string): 'ok' | 'root' | 'escape' | 'invalid' {
  if (path === '.') return 'root';
  if (path === '') return 'root';
  const n = normalizeRepoPath(path);
  if (n === null) {
    if (path.startsWith('/') || /(^|\/)\.\.([/]|$)/.test(path)) return 'escape';
    return 'invalid';
  }
  return 'ok';
}

/**
 * Whether a path looks like a git option-injection attempt when passed to a
 * process without a "--" separator. We always spawn with "--", but this is a
 * second layer of defense in depth for logging and diagnostics.
 */
export function looksLikeShellOption(path: string): boolean {
  return path.startsWith('-');
}

/** Join a directory (normalized, may be "" for root) with a file name. */
export function joinRepoPath(dir: string, file: string): string | null {
  const base = dir === '' || dir === '.' ? '' : normalizeRepoPath(dir);
  if (base === null) return null;
  const child = normalizeRepoPath(file);
  if (child === null) return null;
  return base === '' ? child : `${base}/${child}`;
}

export function parentDir(path: string): string {
  const idx = path.lastIndexOf('/');
  if (idx === -1) return '';
  return path.slice(0, idx);
}

export function basename(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}
