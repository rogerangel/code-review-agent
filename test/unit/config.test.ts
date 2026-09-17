import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  DEFAULT_CONFIG,
  effectiveMinSeverity,
  parseConfigDoc,
} from '../../src/core/config.js';
import { clampResource, LIMITS } from '../../src/core/security/limits.js';

describe('parseConfigDoc', () => {
  it('returns defaults for empty docs', () => {
    expect(parseConfigDoc(null)).toEqual(DEFAULT_CONFIG);
    expect(parseConfigDoc({})).toEqual(DEFAULT_CONFIG);
  });

  it('parses a valid document', () => {
    const c = parseConfigDoc({
      focus: ['security'],
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.ts'],
      instructions: ['docs/rules.md'],
      min_severity: 'high',
      suggestions: false,
    });
    expect(c).toEqual({
      focus: ['security'],
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.ts'],
      instructions: ['docs/rules.md'],
      minSeverity: 'high',
      suggestions: false,
    });
  });

  it('accepts a scalar focus as a single element', () => {
    expect(parseConfigDoc({ focus: 'performance' }).focus).toEqual(['performance']);
  });

  it('rejects unknown keys (credential/endpoint/permission smuggling)', () => {
    for (const bad of ['llm_base_url', 'api_key', 'github_token', 'permissions', 'max_duration_minutes']) {
      expect(() => parseConfigDoc({ [bad]: 'x' })).toThrowError(ConfigError);
    }
  });

  it('rejects invalid min_severity', () => {
    expect(() => parseConfigDoc({ min_severity: 'apocalyptic' })).toThrowError(ConfigError);
  });

  it('rejects non-mapping roots and malformed arrays', () => {
    expect(() => parseConfigDoc(['a'])).toThrowError(ConfigError);
    expect(() => parseConfigDoc('a string')).toThrowError(ConfigError);
    expect(() => parseConfigDoc({ include: 42 })).toThrowError(ConfigError);
    expect(() => parseConfigDoc({ include: ['a', 1] })).toThrowError(ConfigError);
    expect(() => parseConfigDoc({ suggestions: 'true' })).toThrowError(ConfigError);
  });
});

describe('severity threshold and clamping', () => {
  it('posting floor is medium even when config asks for low', () => {
    expect(effectiveMinSeverity({ ...DEFAULT_CONFIG, minSeverity: 'low' })).toBe('medium');
    expect(effectiveMinSeverity({ ...DEFAULT_CONFIG, minSeverity: 'medium' })).toBe('medium');
    expect(effectiveMinSeverity({ ...DEFAULT_CONFIG, minSeverity: 'high' })).toBe('high');
    expect(effectiveMinSeverity({ ...DEFAULT_CONFIG, minSeverity: 'critical' })).toBe('critical');
  });

  it('resource clamping: config can never exceed workflow ceilings', () => {
    expect(clampResource(500, 20, LIMITS.maxDurationMinutesHard)).toBe(120);
    expect(clampResource(20, 20, LIMITS.maxDurationMinutesHard)).toBe(20);
    expect(clampResource(0, 20, LIMITS.maxDurationMinutesHard)).toBe(1);
    expect(clampResource(NaN, 20, LIMITS.maxDurationMinutesHard)).toBe(20);
    expect(clampResource(99, 6, LIMITS.maxInlineCommentsHard)).toBe(12);
    expect(clampResource(6, 6, LIMITS.maxInlineCommentsHard)).toBe(6);
  });
});
