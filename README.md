# code-review-agent

A Junie-shaped reviewer powered by your own local LLM: Node 24 GitHub Action, reusable workflow, and local CLI/API. It works across repositories and languages; no Qwen, GB10, .NET, or project-specific dependency.

The agent explores with read/list/search tools and calls post_inline_review_comment directly. Ordinary comments have no independent verification model. Only apply-ready code suggestions get a focused critic; uncertain/rejected patches are omitted while the explanatory finding stays.

Publishing is deferred. This repository is not an npm release. Start with [the first-run guide](docs/first-run.md), which covers your existing remote, initial commit/push, GB10/vLLM, Tailscale federation, and installation in other repos.

## Review flow

~~~text
event → trusted Node gate → pinned PR checkout → authorized Tailscale connection
      → endpoint round-trip probe → diff/eligibility → plan (≤6 batches)
      → agent repository tools + direct inline posting → final answer → sticky summary
~~~

Trusted reviewer executables live in reviewer/; PR code lives in review-target/ and is never executed. Repository configuration and root/applicable nested AGENTS.md, .code-review-agent/review.md and custom guidance come from the reviewed head. PR title/description and existing same-head bot comments are bounded review data.

## Results

| Status | Meaning |
| --- | --- |
| clean | Every eligible file explicitly reviewed; no accepted findings. Not a guarantee of correctness. |
| findings | Full coverage and at least one accepted finding. |
| partial | Unreviewed eligible files, bounded-step/context cutoff, time budget exhausted, or PR superseded. |
| skipped | Event not authorized/eligible, no changes, or all changed files excluded. |
| failed | Operational failure: authorization API, Git/config, endpoint/protocol, critic, or delivery failed. |

Accepted findings remain in the normalized result even when delivery fails or the inline quota is full. Their delivery is posted, reused, local, summary_only, or failed. A failed run fails the job; ordinary findings and partial results are advisory. Optional fail_on_severity can also fail on accepted findings.

Coverage credits require complete diff reads and explicit review completion. The agent checkpoints each file with complete_review_file, preserving coverage when a later file times out; complete_review_batch remains compatible. Planner-skipped files stay eligible. A budget-limited run cannot become clean.

## Local use before publishing

Node 24+, Git, and a reachable OpenAI-compatible endpoint are required.

~~~bash
npm ci
npm run build
export CRA_LLM_BASE_URL=http://gb10.YOUR-TAILNET.ts.net:8123/v1
export CRA_LLM_MODEL=YOUR-SERVED-MODEL-ID
node dist/cli.js doctor
~~~

From any other Git repository, invoke the CLI by absolute path:

~~~bash
node /absolute/path/code-review-agent/dist/cli.js review --staged --format json
~~~

Alternatively, create a local npm tarball and install that file, as described in [CLI setup](docs/cli.md). There is no public-registry installation step yet.

## Host-enforced boundaries

- Tools cannot execute shell commands, builds/tests, edit files, approve PRs, or request changes.
- Inline anchors must resolve uniquely to source, overlap an added line, and fit wholly in one visible RIGHT-side hunk. Multiline suggestions use that full range.
- Medium severity floor; default 6 new inline comments (hard 12), ≤6 batches. CLI defaults to 60 minutes; GitHub defaults to 20 (hard 120 for both). Reused comments consume no new-comment quota. Caps are never comment quotas.
- Every physical GitHub mutation/retry rechecks the PR head/state; comments pin commit_id. Checks are not an atomic GitHub transaction, so a push can still race a request.
- Hidden fingerprints reuse exact matching bot-owned comments on the same head. Paraphrased findings are not semantic deduplication; new heads start new sets.
- Tokens stay in host clients, not model prompts. GitHub mutation retries reconcile ambiguous responses before retrying.
- Repository paths exclude Git metadata and symlink traversal. Diff/textconv helpers and Git hooks are disabled for host Git operations.
- No raw prompt/reasoning/snapshot uploads by default. Findings and summary prose are deliberately published to the PR.

Head guidance is advisory, not a security guarantee against prompt injection. It can change review focus and exclusions, so review changes to those files carefully. Programmatic checks protect tool scope, not model judgment.

## Slow local inference

Every review phase has an output-token cap. Repository tools return paginated/bounded context, broad worktree discovery respects Git ignores, and old tool exchanges are compacted without an extra model call. Reasoning from either modern reasoning or legacy reasoning_content fields stays out of history and diagnostics.

Use --llm-options or CRA_LLM_OPTIONS for operator-owned thinking/sampling controls; no model name is hardcoded. See [vLLM generation settings](docs/setup-vllm.md). Progress and 30-second inference heartbeats go to stderr; --quiet suppresses them, and --format json keeps stdout machine-readable. Optional performance records in result v1 contain timing, reported token usage, caps and compactions, never prompts or reasoning text.

## Guides

- [Initial push and first real review](docs/first-run.md)
- [Caller workflow and outputs](docs/caller-workflow.md)
- [Tailscale federation and restricted access](docs/tailscale.md)
- [vLLM setup and doctor](docs/setup-vllm.md)
- [Fork authorization](docs/fork-behavior.md)
- [Repository configuration](docs/configuration.md)
- [CLI/API](docs/cli.md)
- [Live quality evaluation](docs/evaluation.md)
- [Troubleshooting](docs/troubleshooting.md)

## Development

~~~bash
npm run lint
npm run typecheck
npm test
npm run build
npm run check:dist
npm run smoke
~~~

Commit both dist/action.cjs and gate-action/dist/gate.cjs, along with CLI/API distributions. CI checks artifact freshness, isolated Node Actions, and a packed/installed CLI/API. Tests use synthetic repos and mocked GitHub/LLM transport; live evaluation is opt-in.

The interaction style draws on [Junie's GitHub Action](https://github.com/JetBrains/junie-github-action), especially direct inline-comment tooling. This is an independent implementation, not Junie feature parity.

Apache-2.0 — see [LICENSE](LICENSE).
