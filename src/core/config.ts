/**
 * Repository configuration (.code-review-agent.yml).
 *
 * Configuration may control review focus, include/exclude globs, instruction
 * files, the inline severity threshold, and suggestion behavior. It CANNOT
 * configure credentials, network endpoints, permissions, or exceed workflow
 * resource ceilings. Unknown keys are rejected to keep the surface immutable.
 */
import { parse as parseYaml } from 'yaml';
import { SEVERITIES, SEVERITY_RANK, type RepoConfig, type Severity } from './types.js';
import type { RepoView } from './repo/view.js';
import { ViewError } from './repo/view.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const ALLOWED_KEYS = new Set([
  'focus',
  'include',
  'exclude',
  'instructions',
  'min_severity',
  'suggestions',
]);

export const DEFAULT_CONFIG: RepoConfig = {
  focus: [],
  include: [],
  exclude: [],
  instructions: [],
  minSeverity: 'medium',
  suggestions: true,
};

function asStringArray(value: unknown, key: string): string[] {
  if (value === undefined) return [];
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new ConfigError(`"${key}" must be a string or array of strings`);
  }
  return value as string[];
}

/** Parse and validate a raw config document. Throws ConfigError on violations. */
export function parseConfigDoc(doc: unknown): RepoConfig {
  if (doc === null || doc === undefined) return { ...DEFAULT_CONFIG };
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    throw new ConfigError('config root must be a mapping');
  }
  const obj = doc as Record<string, unknown>;
  const unknown = Object.keys(obj).filter((k) => !ALLOWED_KEYS.has(k));
  if (unknown.length > 0) {
    throw new ConfigError(
      `unknown config key(s): ${unknown.join(', ')}. Allowed keys: ${[...ALLOWED_KEYS].join(', ')}. ` +
        'Credentials, endpoints, permissions, and resource ceilings cannot be set here.',
    );
  }
  let minSeverity: Severity = DEFAULT_CONFIG.minSeverity;
  if (obj.min_severity !== undefined) {
    if (!SEVERITIES.includes(obj.min_severity as Severity)) {
      throw new ConfigError(`"min_severity" must be one of ${SEVERITIES.join(', ')}`);
    }
    minSeverity = obj.min_severity as Severity;
  }
  // The posting tool hard-enforces medium-or-higher; config can only raise.
  if (obj.suggestions !== undefined && typeof obj.suggestions !== 'boolean') throw new ConfigError('"suggestions" must be a boolean');
  const suggestions = obj.suggestions === undefined ? true : obj.suggestions === true;
  return {
    focus: asStringArray(obj.focus, 'focus'),
    include: asStringArray(obj.include, 'include'),
    exclude: asStringArray(obj.exclude, 'exclude'),
    instructions: asStringArray(obj.instructions, 'instructions'),
    minSeverity,
    suggestions,
  };
}

/** Effective minimum severity: max(config value, medium hard floor). */
export function effectiveMinSeverity(config: RepoConfig): Severity {
  const floor: Severity = 'medium';
  return SEVERITY_RANK[config.minSeverity] >= SEVERITY_RANK[floor]
    ? config.minSeverity
    : floor;
}

/**
 * Load configuration from the repository view (pinned to the reviewed head).
 * Returns the default config when the file does not exist.
 */
export async function loadConfig(view: RepoView, configPath: string): Promise<RepoConfig> {
  try {
    if (!(await view.exists(configPath))) return { ...DEFAULT_CONFIG };
    const { content } = await view.read(configPath);
    const doc = parseYaml(content);
    return parseConfigDoc(doc);
  } catch (err) {
    if (err instanceof ViewError && (err.reason === 'not-found' || err.reason === 'invalid-path')) {
      return { ...DEFAULT_CONFIG };
    }
    if (err instanceof ConfigError) throw err;
    throw new ConfigError(`cannot read config "${configPath}": ${(err as Error).message}`);
  }
}
