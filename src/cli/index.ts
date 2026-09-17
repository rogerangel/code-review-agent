/**
 * CLI entry: code-review-agent review [target] | doctor
 */
import { Command } from 'commander';
import { promises as fs, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { git, resolveTarget, TargetError } from '../core/diff/git.js';
import { OpenAICompatibleClient, LLMError } from '../core/llm/client.js';
import { probeModel, decideToolMode } from '../core/llm/doctor.js';
import { runReview } from '../core/review/pipeline.js';
import { LocalSink } from '../core/review/sink.js';
import { clampResource } from '../core/security/limits.js';
import { LIMITS } from '../core/security/limits.js';
import type { FailOnSeverity, ResolvedOptions, ReviewResult, Severity, ToolMode } from '../core/types.js';
import { formatResult, type OutputFormat } from './format.js';
import { BudgetTracker } from '../core/review/budget.js';
import manifest from '../../package.json' with { type: 'json' };
import { parseGenerationOptions } from '../core/llm/generation.js';
import { createProgressReporter } from './progress.js';

const VERSION = manifest.version;

function llmEnv(opts: {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}): { baseUrl: string; model: string; apiKey?: string } {
  const baseUrl = opts.baseUrl ?? process.env.CRA_LLM_BASE_URL ?? process.env.OPENAI_BASE_URL;
  const model = opts.model ?? process.env.CRA_LLM_MODEL ?? process.env.OPENAI_MODEL;
  const apiKey = opts.apiKey ?? process.env.CRA_LLM_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!baseUrl) {
    throw new Error(
      'no LLM endpoint configured: use --base-url or set CRA_LLM_BASE_URL (e.g. http://<tailscale-host>:8000)',
    );
  }
  if (!model) {
    throw new Error('no LLM model configured: use --model or set CRA_LLM_MODEL');
  }
  return { baseUrl, model, apiKey };
}

function buildOptions(opts: {
  config: string;
  toolMode: string;
  maxDurationMinutes: string;
  maxInlineComments: string;
  failOnSeverity: string;
}): Omit<ResolvedOptions, 'config' | 'configPath'> {
  const toolMode = opts.toolMode as ToolMode;
  if (!['auto', 'tools', 'structured'].includes(toolMode)) {
    throw new Error(`invalid --tool-mode "${opts.toolMode}"`);
  }
  const fail = opts.failOnSeverity as FailOnSeverity;
  if (!['none', 'medium', 'high', 'critical'].includes(fail)) {
    throw new Error(`invalid --fail-on-severity "${opts.failOnSeverity}"`);
  }
  return {
    toolMode,
    maxDurationMinutes: clampResource(
      Number(opts.maxDurationMinutes),
      LIMITS.maxDurationMinutesLocalDefault,
      LIMITS.maxDurationMinutesHard,
    ),
    maxInlineComments: clampResource(
      Number(opts.maxInlineComments),
      LIMITS.maxInlineCommentsDefault,
      LIMITS.maxInlineCommentsHard,
    ),
    failOnSeverity: fail,
  };
}

function failOnExitCode(failOnSeverity: FailOnSeverity, findings: { severity: Severity }[]): number | null {
  if (failOnSeverity === 'none') return null;
  const rank = { low: 0, medium: 1, high: 2, critical: 3 } as const;
  const threshold = rank[failOnSeverity];
  return findings.some((f) => rank[f.severity] >= threshold) ? 3 : null;
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('code-review-agent')
    .description('Junie-shaped local-LLM code reviewer (read-only tools, inline comments, final answer).')
    .version(VERSION);

  program
    .command('review')
    .description('Review a git target: branch vs main, staged, unstaged, last-commit, or A..B.')
    .argument('[target]', 'revision range (A..B, A...B) or branch name')
    .option('--staged', 'review staged (index vs HEAD) changes')
    .option('--unstaged', 'review unstaged (worktree vs index) changes')
    .option('--last-commit', 'review the last commit (HEAD~1..HEAD)')
    .option('--config <path>', 'repository config path', '.code-review-agent.yml')
    .option('--tool-mode <mode>', 'auto | tools | structured', 'auto')
    .option('--max-duration-minutes <n>', 'run budget in minutes (default 60, max 120)', '60')
    .option('--max-inline-comments <n>', 'inline comment cap (default 6, max 12)', '6')
    .option('--fail-on-severity <sev>', 'exit 3 when findings meet threshold: none|medium|high|critical', 'none')
    .option('--format <fmt>', 'terminal | markdown | json', 'terminal')
    .option('--output <file>', 'write the normalized result JSON to a file')
    .option('--base-url <url>', 'OpenAI-compatible base URL (env CRA_LLM_BASE_URL)')
    .option('--model <model>', 'model id (env CRA_LLM_MODEL)')
    .option('--api-key <key>', 'API key (env CRA_LLM_API_KEY)')
    .option('--llm-options <json>', 'operator generation settings (env CRA_LLM_OPTIONS)')
    .option('--quiet', 'suppress progress on stderr')
    .action(async (target: string | undefined, opts) => {
      if (!['terminal', 'markdown', 'json'].includes(opts.format)) throw new Error('invalid --format');
      const clamped = buildOptions(opts);
      const generation = parseGenerationOptions(opts.llmOptions ?? process.env.CRA_LLM_OPTIONS);
      const budget = new BudgetTracker(Date.now(), clamped.maxDurationMinutes);
      const cwd = process.cwd();
      const inGit = await git(cwd, ['rev-parse', '--is-inside-work-tree'], { budget });
      if (inGit.code !== 0 || inGit.stdout.trim() !== 'true') {
        console.error('not inside a git repository');
        process.exit(1);
      }
      let llm;
      try {
        const env = llmEnv(opts);
        llm = new OpenAICompatibleClient({ ...env, budget });
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
      const processExit = async (code: number) => process.exit(code);

      let targetResolved;
      try {
        targetResolved = await resolveTarget(cwd, {
          target,
          staged: opts.staged,
          unstaged: opts.unstaged,
          lastCommit: opts.lastCommit,
        }, { budget });
      } catch (err) {
        if (err instanceof TargetError) {
          console.error(err.message);
          await processExit(1);
          return;
        }
        throw err;
      }

      const sink = new LocalSink();
      const reporter = createProgressReporter(!opts.quiet && opts.format !== 'json');
      let result: ReviewResult;
      try { result = await runReview({
        repoDir: cwd,
        generation, onProgress: reporter.onProgress,
        target: targetResolved,
        options: { configPath: opts.config, config: { focus: [], include: [], exclude: [], instructions: [], minSeverity: 'medium', suggestions: true }, ...clamped },
        llm,
        sink,
        mode: 'structured',
        budget,
        prepare: async (boundedLlm) => {
          const probe = await probeModel({ model: llm.model, chat: boundedLlm.chat,
            listModels: () => budget.run((signal) => llm.listModels(signal)) }, generation);
          const decision = decideToolMode(probe, clamped.toolMode);
          if (!opts.quiet && opts.format !== 'json') console.error(`[review] mode=${decision.mode} (${decision.reason})`);
          return { mode: decision.mode };
        },
      }); } finally { reporter.close(); }

      const format = opts.format as OutputFormat;
      console.log(formatResult(result, format));
      if (opts.output) {
        await fs.mkdir(path.dirname(path.resolve(opts.output)), { recursive: true });
        await fs.writeFile(opts.output, formatResult(result, 'json'), 'utf8');
        if (!opts.quiet && format !== 'json') console.error(`[review] result written to ${opts.output}`);
      }

      const sevExit = failOnExitCode(clamped.failOnSeverity, result.findings);
      if (result.status === 'failed') { await processExit(1); return; }
      if (sevExit !== null) {
        await processExit(sevExit);
        return;
      }
      await processExit(0);
    });

  program
    .command('doctor')
    .description('Check LLM endpoint: model discovery, structured output, reasoning separation, tool calls.')
    .option('--base-url <url>', 'OpenAI-compatible base URL (env CRA_LLM_BASE_URL)')
    .option('--model <model>', 'model id (env CRA_LLM_MODEL)')
    .option('--api-key <key>', 'API key (env CRA_LLM_API_KEY)')
    .option('--llm-options <json>', 'operator generation settings (env CRA_LLM_OPTIONS)')
    .action(async (opts) => {
      const budget = new BudgetTracker(Date.now(), 2);
      const generation = parseGenerationOptions(opts.llmOptions ?? process.env.CRA_LLM_OPTIONS);
      let llm;
      try {
        const env = llmEnv(opts);
        llm = new OpenAICompatibleClient({ ...env, budget, timeoutMs: 30_000 });
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
      console.log(`doctor: probing ${llm.model} at ${llm.endpoint}`);
      const probe = await probeModel({ model: llm.model,
        chat: (request) => budget.run((signal) => llm.chat({ ...request, signal })),
        listModels: () => budget.run((signal) => llm.listModels(signal)) }, generation);
      const rows: [string, boolean | null][] = [
        ['endpoint reachable', probe.reachable],
        ['model discovered', probe.discovered],
        ['structured output', probe.structuredOk],
        ['tool calling', probe.supportsTools],
        ['reasoning separated', probe.reasoningSeparated],
      ];
      for (const [name, ok] of rows) {
        const status = ok === null ? 'n/a' : ok ? 'PASS' : 'FAIL';
        console.log(`  ${status.padEnd(5)} ${name}`);
      }
      for (const detail of probe.details) console.log('  ' + detail);
      try {
        const decision = decideToolMode(probe, 'auto');
        console.log('doctor: usable in ' + decision.mode + ' mode (' + decision.reason + ')');
        process.exit(0);
      } catch (err) {
        console.error('doctor: ' + (err as Error).message);
        process.exit(1);
      }
    });

  return program;
}

export function main(argv: string[]): void {
  const program = buildProgram();
  program.parseAsync(argv).catch((err) => {
    if (err instanceof LLMError) {
      console.error(`LLM error: ${err.message}`);
      process.exit(1);
    }
    console.error(`error: ${(err as Error).message}`);
    process.exit(1);
  });
}

// Run only when executed as the CLI entry (dist/cli.js), not when imported.
function isDirectEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isDirectEntry()) {
  main(process.argv);
}
