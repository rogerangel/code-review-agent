/**
 * Deterministic eligibility filtering.
 *
 * Binary, lock, generated, and vendored files are excluded by default.
 * Repository configuration can opt files back in with explicit `include`
 * globs, and can always exclude more with `exclude` globs.
 *
 * Precedence (highest wins):
 *   1. binary files            -> always excluded
 *   2. config `exclude` globs  -> always excluded
 *   3. config `include` globs  -> whitelist when non-empty; also opts a file
 *      back in past default exclusions
 *   4. default exclusions      -> lock / generated / vendored
 */
import { minimatch } from 'minimatch';
import type { RepoConfig } from '../types.js';

export type ExcludeKind = 'binary' | 'lock-file' | 'generated' | 'vendored' | 'config-exclude' | 'include-filter';

export interface Eligibility {
  eligible: boolean;
  kind?: ExcludeKind;
  reason: string;
}

interface DefaultRule {
  pattern: string;
  kind: ExcludeKind;
}

export const DEFAULT_EXCLUDE_RULES: readonly DefaultRule[] = [
  // lock files
  { pattern: '**/package-lock.json', kind: 'lock-file' },
  { pattern: '**/yarn.lock', kind: 'lock-file' },
  { pattern: '**/pnpm-lock.yaml', kind: 'lock-file' },
  { pattern: '**/bun.lock', kind: 'lock-file' },
  { pattern: '**/bun.lockb', kind: 'lock-file' },
  { pattern: '**/npm-shrinkwrap.json', kind: 'lock-file' },
  { pattern: '**/Pipfile.lock', kind: 'lock-file' },
  { pattern: '**/poetry.lock', kind: 'lock-file' },
  { pattern: '**/uv.lock', kind: 'lock-file' },
  { pattern: '**/Gemfile.lock', kind: 'lock-file' },
  { pattern: '**/composer.lock', kind: 'lock-file' },
  { pattern: '**/Cargo.lock', kind: 'lock-file' },
  { pattern: '**/go.sum', kind: 'lock-file' },
  { pattern: '**/mix.lock', kind: 'lock-file' },
  { pattern: '**/pubspec.lock', kind: 'lock-file' },
  // vendored dependencies
  { pattern: '**/node_modules/**', kind: 'vendored' },
  { pattern: '**/vendor/**', kind: 'vendored' },
  { pattern: '**/.vendor/**', kind: 'vendored' },
  // generated build output
  { pattern: '**/dist/**', kind: 'generated' },
  { pattern: '**/build/**', kind: 'generated' },
  { pattern: '**/out/**', kind: 'generated' },
  { pattern: '**/target/**', kind: 'generated' },
  { pattern: '**/obj/**', kind: 'generated' },
  { pattern: '**/*.min.js', kind: 'generated' },
  { pattern: '**/*.min.css', kind: 'generated' },
  { pattern: '**/*.map', kind: 'generated' },
  { pattern: '**/*.generated.*', kind: 'generated' },
  { pattern: '**/*.pb.go', kind: 'generated' },
  { pattern: '**/*_pb2.py', kind: 'generated' },
];

function matchesAny(p: string, globs: string[]): boolean {
  return globs.some((g) => minimatch(p, g, { dot: true }));
}

export function classifyFile(path: string, isBinary: boolean, config: RepoConfig): Eligibility {
  if (isBinary) {
    return { eligible: false, kind: 'binary', reason: 'excluded:binary-file' };
  }
  if (config.exclude.length > 0 && matchesAny(path, config.exclude)) {
    return { eligible: false, kind: 'config-exclude', reason: 'excluded:config-exclude' };
  }
  const includeMatches = config.include.length > 0 ? matchesAny(path, config.include) : null;
  if (includeMatches === false) {
    return {
      eligible: false,
      kind: 'include-filter',
      reason: 'excluded:does-not-match-include',
    };
  }
  // No include constraint (or include matched): apply default exclusions,
  // unless an explicit include matched (opt-back-in).
  if (includeMatches === null) {
    const rule = DEFAULT_EXCLUDE_RULES.find((r) => minimatch(path, r.pattern, { dot: true }));
    if (rule) {
      return {
        eligible: false,
        kind: rule.kind,
        reason: `excluded:${rule.kind.replace(/-/g, '-')}`,
      };
    }
  }
  return { eligible: true, reason: 'eligible' };
}

/**
 * Apply eligibility to every changed file, producing per-file dispositions.
 */
export function classifyAll(
  paths: { path: string; isBinary: boolean }[],
  config: RepoConfig,
): Map<string, Eligibility> {
  const out = new Map<string, Eligibility>();
  for (const f of paths) {
    out.set(f.path, classifyFile(f.path, f.isBinary, config));
  }
  return out;
}
