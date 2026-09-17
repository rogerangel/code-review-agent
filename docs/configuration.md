# Repository configuration

.code-review-agent.yml controls review focus and filtering. It is read from the reviewed head in PR/range mode, the index for --staged, and the working tree for --unstaged.

~~~yaml
focus:
  - correctness
  - security
  - authorization
include: []                  # no whitelist; use e.g. ['src/**'] to restrict review
exclude:
  - '**/*.generated.*'
instructions:
  - docs/review-guidelines.md
min_severity: medium         # medium hard floor; high/critical can raise it
suggestions: true
~~~

Only focus, include, exclude, instructions, min_severity, and suggestions are accepted. Unknown keys or invalid types fail the run. Repository config cannot supply credentials/endpoints, add tools, alter permissions, or raise resource ceilings.

Generation settings are operator-owned, not repository policy: use CLI --llm-options / CRA_LLM_OPTIONS, Action/workflow llm_options, or SDK GenerationOptions. See [vLLM setup](setup-vllm.md) for the allowlist and bounded-thinking profile. Local CLI reviews default to 60 minutes; GitHub reviews keep their 20-minute default.

## File eligibility

Binary files are always excluded. Explicit exclude globs always win. A NONEMPTY include list is a whitelist: it excludes every nonmatching file and opts matching files back in past default lock/generated/vendor exclusions. This is not an additive include list.

Defaults exclude common lockfiles, dependency/vendor directories, and generated build output. See src/core/filtering/eligibility.ts for the exact rules.

Coverage lists every changed file. Deterministically excluded files are outside the eligible count. Planner skips, unread/truncated diffs, or agent skips remain eligible and yield partial coverage. If all files are excluded, the run is skipped.

The agent can checkpoint a file with complete_review_file after reading every untruncated diff page. That credit survives later timeouts or failures; reading a diff alone never counts as reviewing it. The existing complete_review_batch tool remains supported.

## Guidance

The host loads root AGENTS.md, applicable nested AGENTS.md, .code-review-agent/review.md, and instruction paths. Nested guidance is labeled by directory and the model is told to apply it only there. Guidance is bounded to 20,000 UTF-8 bytes per file and 100,000 total.

For example, .code-review-agent/review.md:

~~~markdown
Review correctness, authorization, tenant isolation, concurrency and breaking APIs.
Inspect callers/types when they materially affect the change.
Avoid formatting, naming preferences and generated output.
Post only evidence-backed, actionable defects.
~~~

Head-side policy is a deliberate Junie-like choice. A PR CAN change its own focus/exclusions and influence model judgment; review those changes as policy changes. Treat guidance as advisory/untrusted, subordinate to immutable tool rules. These boundaries do not prove semantic resistance to prompt injection.

Config can suppress apply-ready suggestions. Otherwise each replacement gets a separate focused critic, and only confirmed patches become suggestion fences. Ordinary comments do not get a separate critic. Rejected/uncertain suggestions keep their explanatory finding; a critic operational/protocol failure fails the run.
