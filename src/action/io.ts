/**
 * Minimal GitHub Actions I/O (no external dependency):
 *  - inputs via INPUT_<UPPER_SNAKE> env vars
 *  - outputs via the $GITHUB_OUTPUT file (multi-line safe)
 *  - step summary via $GITHUB_STEP_SUMMARY
 */
import { appendFileSync } from 'node:fs';

export function readInput(name: string): string {
  const key = `INPUT_${name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
  const v = process.env[key];
  return v === undefined ? '' : v.trim();
}

export function setOutput(name: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  if (!value || !value.includes('\n')) {
    appendFileSync(file, `${name}=${value}\n`);
    return;
  }
  const delimiter = `ghadelimiter_${Math.random().toString(36).slice(2)}`;
  appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

export function setSummary(markdown: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  appendFileSync(file, markdown + '\n');
}

export function fail(message: string): never {
  // GitHub Actions workflow command (deliberately raw console output).
  console.error(`::error::${message.replace(/[:\n]/g, ' ')}`);
  process.exit(1);
}
