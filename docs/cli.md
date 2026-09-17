# Local CLI and API

Node 24+ and Git are required. npm registry publishing is deferred, so use the built CLI or install a local tarball.

~~~bash
# From the reviewer repository:
npm ci
npm run build
node dist/cli.js --help
npm pack
# Optional, using the actual tarball filename printed by npm pack:
npm install -g /absolute/path/code-review-agent-0.1.0.tgz
~~~

Until installed, run the built CLI by absolute path from any directory inside a target Git repository:

~~~bash
export CRA_LLM_BASE_URL=http://gb10.YOUR-TAILNET.ts.net:8123/v1
export CRA_LLM_MODEL=YOUR-SERVED-MODEL-ID
node /absolute/path/code-review-agent/dist/cli.js doctor
node /absolute/path/code-review-agent/dist/cli.js review --staged
~~~

No GitHub credentials or repository code execution are needed. The local sink stores findings instead of posting comments; its inline quota still bounds immediate finding delivery. Overflow findings are retained as summary_only.

## Endpoint settings

| Flag | Environment fallback |
| --- | --- |
| --base-url | CRA_LLM_BASE_URL or OPENAI_BASE_URL |
| --model | CRA_LLM_MODEL or OPENAI_MODEL |
| --api-key | CRA_LLM_API_KEY or OPENAI_API_KEY |
| --llm-options | CRA_LLM_OPTIONS (JSON; default {}) |

The URL accepts an origin or a /v1 base path, without embedded credentials/query/fragment. Use environment/secret-manager keys rather than command-line keys visible in process listings.

## Targets

| Invocation | Compared content |
| --- | --- |
| review | Current branch vs merge-base(default branch, current branch) |
| review feature | Named branch vs merge-base(default branch, feature) |
| review A..B | Commit A vs B |
| review A...B | Merge-base(A,B) vs B |
| review --staged | Index vs HEAD; context reads the index |
| review --unstaged | Working tree vs index; context reads the working tree |
| review --last-commit | HEAD~1 vs HEAD |

Only one target can be selected. Default branch detection uses origin/HEAD then main/master. Untracked files are not included in --unstaged; stage them first. Shallow history is deepened for unresolved commits AND missing merge bases.

## Review options

~~~text
--config <path>              default .code-review-agent.yml
--tool-mode <mode>           auto | tools | structured
--max-duration-minutes <n>   default 60; ceiling 120 (GitHub remains 20)
--max-inline-comments <n>    default 6; ceiling 12
--fail-on-severity <sev>     none | medium | high | critical
--format <fmt>               terminal | markdown | json
--output <file>              also save normalized result JSON
--llm-options <json>         operator generation/thinking/sampling settings
--quiet                      suppress progress/heartbeats on stderr
~~~

With --format json, stdout contains only the normalized result, including when --output is used. Diagnostics go to stderr. Git/config/endpoint/protocol failures inside the pipeline return status failed rather than disappearing behind a clean result.

Terminal/Markdown runs report model call start/end, file checkpoints, compactions, and a 30-second heartbeat while inference is active. --quiet suppresses these; JSON mode has no progress output. Completion caps are 2048 review, 1024 planning/critic, 1536 summary, and 512 per probe. To change the review cap or configure provider thinking controls, see [generation settings](setup-vllm.md#operator-generation-settings).

The 60-minute CLI budget includes up to one minute reserved for deterministic finalization, so inference can stop near minute 59. Raising the budget starts a fresh run; cross-run resume is not implemented.

Exit 0: advisory clean/findings/partial/skipped. Exit 1: operational/usage/target/output error. Exit 3: accepted findings meet --fail-on-severity (unless an operational failure already takes precedence).

## Doctor

Doctor has its own two-minute deadline. It verifies /v1/models discovery, schema output, native function serialization AND tool-result follow-up, and separation when either reasoning or reasoning_content is present. It independently verifies explicitly configured overrides before capability probes. n/a means reasoning was not observed, not that thinking is disabled.

A verified native mode OR verified structured mode is sufficient. Authentication, transport, server, or reasoning-separation failures cannot silently select a fallback. Both explicit review modes still run preflight; forcing structured does not bypass endpoint checks.

## API

After installing the local tarball into another Node project:

~~~js
import { runReview, resolveTarget, LocalSink, BudgetTracker,
  OpenAICompatibleClient, probeModel, decideToolMode, DEFAULT_CONFIG,
  parseGenerationOptions } from 'code-review-agent';

const budget = new BudgetTracker(Date.now(), 20);
const generation = parseGenerationOptions(process.env.CRA_LLM_OPTIONS);
const llm = new OpenAICompatibleClient({
  baseUrl: process.env.CRA_LLM_BASE_URL,
  model: process.env.CRA_LLM_MODEL,
  apiKey: process.env.CRA_LLM_API_KEY,
  budget,
});
const repoDir = process.cwd();
const target = await resolveTarget(repoDir, { staged: true }, { budget });
const result = await runReview({
  repoDir, target, llm, budget, generation, sink: new LocalSink(), mode: 'structured',
  onProgress: (event) => { /* optional typed, count/timing-only observer */ },
  options: { configPath: '.code-review-agent.yml', toolMode: 'auto',
    maxDurationMinutes: 20, maxInlineComments: 6, failOnSeverity: 'none', config: DEFAULT_CONFIG },
  prepare: async (counted) => {
    const probe = await probeModel({ model: llm.model, chat: counted.chat,
      listModels: () => budget.run((signal) => llm.listModels(signal)) }, generation);
    return { mode: decideToolMode(probe, 'auto').mode };
  },
});
~~~

API consumers must provide their own authorization when constructing a GitHubSink; runReview is transport-neutral, not an authorization service. The standalone Action handles authorization itself.

The common result schema is code-review-agent.result/v1. It separates finding acceptance/delivery, deterministic coverage, operationalErrors, and counted calls. Results contain source blocks/suggestions; store them appropriately.

GenerationOptions uses camelCase fields (maxOutputTokens, thinkingTokenBudget, chatTemplateKwargs, temperature, topP, topK, presencePenalty). The optional performance field adds per-call phase/duration/caps, finish outcome, reported prompt/completion/reasoning/cache tokens, reasoning character count, transcriptCompactions, and toolResultChars. Missing usage remains undefined, never fabricated zero. Completion counts already include reasoning; do not add reasoning tokens again. Observer failures cannot change review acceptance.
