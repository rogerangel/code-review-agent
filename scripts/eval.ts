/** Opt-in live evaluation; synthetic fixtures only, no GitHub posting. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenAICompatibleClient } from '../src/core/llm/client.js';
import { probeModel, decideToolMode } from '../src/core/llm/doctor.js';
import { runReview } from '../src/core/review/pipeline.js';
import { LocalSink } from '../src/core/review/sink.js';
import { BudgetTracker } from '../src/core/review/budget.js';
import { resolveTarget, buildDiff } from '../src/core/diff/git.js';
import { makeBranchRepo, commitAll } from '../test/helpers/repos.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { aggregate, scoreCase, type EvaluationCase, type Judgment, type PlantedIssue } from './eval-metrics.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function snapshot(directory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [name, content] of Object.entries(await snapshot(full))) files[entry.name + '/' + name] = content;
    } else files[entry.name] = await fs.readFile(full, 'utf8');
  }
  return files;
}
interface EvaluationReport {
  schema: 'code-review-agent.eval/v1'; model: string; mode?: string; startedAt: string;
  server: { modelRevision?: string; vllmVersion?: string; toolParser?: string };
  cases: EvaluationCase[]; metrics?: ReturnType<typeof aggregate>;
}
const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error('missing value for ' + name);
  return value;
}
async function main() {
  for (let index = 0; index < args.length; index += 2) {
    if (!['--score', '--adjudication', '--only', '--output'].includes(args[index]!)) throw new Error('unknown eval option: ' + args[index]);
    flag(args[index]!);
  }
  const scorePath = flag('--score'), adjudicationPath = flag('--adjudication'), only = flag('--only');
  if (scorePath && only) throw new Error('--only cannot be combined with --score');
  const judgments = adjudicationPath ? (JSON.parse(await fs.readFile(adjudicationPath, 'utf8')) as { judgments: Judgment[] }).judgments : [];
  if (!Array.isArray(judgments)) throw new Error('adjudication must contain a judgments array');
  let report: EvaluationReport;
  if (scorePath) {
    report = JSON.parse(await fs.readFile(scorePath, 'utf8'));
    if (report.schema !== 'code-review-agent.eval/v1' || !Array.isArray(report.cases)) throw new Error('invalid evaluation report');
  } else {
    const baseUrl = process.env.CRA_LLM_BASE_URL ?? process.env.OPENAI_BASE_URL;
    const model = process.env.CRA_LLM_MODEL ?? process.env.OPENAI_MODEL;
    if (!baseUrl || !model) throw new Error('set CRA_LLM_BASE_URL and CRA_LLM_MODEL first');
    const apiKey = process.env.CRA_LLM_API_KEY ?? process.env.OPENAI_API_KEY;
    report = { schema: 'code-review-agent.eval/v1', model, startedAt: new Date().toISOString(),
      server: { modelRevision: process.env.CRA_EVAL_MODEL_REVISION, vllmVersion: process.env.CRA_EVAL_VLLM_VERSION,
        toolParser: process.env.CRA_EVAL_TOOL_PARSER }, cases: [] };
    for (const [fixtureSet, kind] of [['repos', 'clean-control'], ['eval', 'planted-bug']] as const) {
      const directory = path.join(root, 'test/fixtures', fixtureSet);
      const languages = (await fs.readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
      for (const language of languages) {
        if (only && language !== only) continue;
        const fixture = path.join(directory, language);
        const truth = JSON.parse(await fs.readFile(path.join(fixture, 'issues.json'), 'utf8')) as { issues: PlantedIssue[] };
        if (!Array.isArray(truth.issues)) throw new Error('fixture issues.json is required');
        const item: EvaluationCase = { caseId: language + '/' + kind, language, kind, issues: truth.issues };
        const baseFiles = await snapshot(path.join(fixture, 'base')), headFiles = await snapshot(path.join(fixture, 'head'));
        const repo = await makeBranchRepo({ baseFiles, headFiles });
        try {
          // Fixture paths absent at head must be removed; repo helper intentionally preserves others.
          for (const file of Object.keys(baseFiles)) if (!(file in headFiles)) await fs.rm(path.join(repo.dir, file));
          await commitAll(repo.dir, 'fixture removals');
          const budget = new BudgetTracker(Date.now(), 20);
          const target = await resolveTarget(repo.dir, { target: 'main...feature' }, { budget });
          const diff = await buildDiff(repo.dir, target, { budget });
          const llm = new OpenAICompatibleClient({ baseUrl, model, apiKey, budget });
          item.result = await runReview({ repoDir: repo.dir, target, budget, llm, mode: 'structured', sink: new LocalSink(),
            options: { configPath: '.code-review-agent.yml', toolMode: 'auto', maxDurationMinutes: 20,
              maxInlineComments: 6, failOnSeverity: 'none', config: DEFAULT_CONFIG },
            prepare: async (counted) => {
              const probe = await probeModel({ model, chat: counted.chat, listModels: () => budget.run((signal) => llm.listModels(signal)) });
              const decision = decideToolMode(probe, 'auto');
              report.mode = decision.mode;
              return { mode: decision.mode };
            } });
          item.metrics = scoreCase(item.result, diff, truth.issues);
          console.log(item.caseId + ': status=' + item.result.status + ', coverage=' + item.result.coverage.reviewed + '/' +
            item.result.coverage.eligible + ', findings=' + item.result.findings.length + ', seconds=' + item.metrics.elapsedSec);
        } catch (error) {
          item.error = (error as Error).message;
          console.error(item.caseId + ': failed (' + item.error + ')');
        } finally { await repo.dispose(); }
        report.cases.push(item);
      }
    }
    if (!report.cases.length) throw new Error('no fixtures selected; --only must name an existing language');
  }
  report.metrics = aggregate(report.cases, judgments);
  const output = path.resolve(flag('--output') ?? path.join(root, 'eval-report-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json'));
  await fs.writeFile(output, JSON.stringify(report, null, 2), 'utf8');
  console.log('Reliability: ' + (report.metrics.reliabilityPass ? 'PASS' : 'FAIL') + '; precision: ' +
    (report.metrics.precision === null ? 'UNSCORED (human adjudication required)' : report.metrics.precision.toFixed(3)));
  console.log('Report: ' + output);
  if (!report.metrics.reliabilityPass || (scorePath && !report.metrics.releaseReadyForThisRun)) process.exitCode = 1;
}
main().catch((error) => { console.error('eval: ' + (error as Error).message); process.exitCode = 1; });
