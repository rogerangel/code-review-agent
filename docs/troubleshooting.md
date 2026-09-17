# Troubleshooting

## Setup / packaging

- No npm registry package yet: publishing is deferred. Use the built CLI or a local npm tarball.
- Remote exists but GitHub is empty: create the initial local commit, then git push -u origin main. Follow [first-run](first-run.md); no repeated git init/remote add is needed.
- Missing Action module: rebuild/commit dist/action.cjs AND gate-action/dist/gate.cjs. Both are self-contained; callers need no npm install of reviewer dependencies.
- CI reports stale distributions: run npm run build, review the generated changes and commit them. npm run check:dist compares bytes after rebuilding.
- Native tsx permission/IPC error in a restricted local environment: the runner needs permission for its local IPC socket; this is not an LLM failure.
- Versioned tag rejected: it must be v<package.json version>, not mutable v1. Tags still do not publish npm.

## Workflow / GitHub

- Event skipped: only configured PR actions or newly created exact /review commands are eligible.
- /review doesn't trigger: merge the caller workflow onto its DEFAULT branch and ensure issue_comment: types [created].
- Automatic fork skip: expected; use a new authorized /review comment.
- Unauthorized: commenter needs write/maintain/admin in the base repository.
- Gate API error: fails operationally and does not connect to Tailscale; check API availability and token read access.
- Publishing HTTP 403: caller needs pull-requests AND issues write; the default token may be restricted by org policies. Accepted findings remain in the result with failed delivery.
- Custom App ownership mismatch: set github_comment_author to its actual bot login. PAT identity is discovered; App tokens cannot use GET /user.
- Caller action.yml executed: do not use ./ from a PR checkout. Use the supplied workflow's separate reviewer/ and review-target/ directories and pinned trusted SHA.
- Empty downstream result_path: the path is ephemeral and belongs to the REVIEW job; it cannot be read in a later job without deliberately persisting an artifact.

## Tailscale / model

- OIDC exchange failed: verify generated Client ID/Audience, auth_keys scope/tag, caller repository/subject and pinned workflow claims, and caller id-token write. Inspect trust-credential errors in the Tailscale console, not JWT logs.
- Connection succeeds but /v1/models times out: check GB10 online state, listener binding/port, MagicDNS and effective grants/firewall. A Mac doctor pass alone does not prove runner access.
- Model not discovered: use the exact id from /v1/models.
- Tool probe fails: check the model's parser/chat template and the full tool-result follow-up. Auto only falls back to verified schema output.
- 401/403/server/transport errors: operational failure, not a reason to silently switch modes.
- Explicit structured mode still probes: intentional; mode selection does not waive preflight.
- Context-limit error: reduce diff/context workload or configure a suitable server context length. No universal GB10 context size is assumed.
- reasoning separation n/a: ensure the updated client recognizes reasoning as well as legacy reasoning_content. No observed field is not evidence that thinking is off.
- llm_options rejected: check provider support and JSON validation. Overrides are explicit and never silently removed to make probes pass.
- Long inference: inspect result.performance.llmCalls for phase, duration, reported completion/reasoning usage, reasoningChars, and configured caps. At 12 tokens/s, 3000 generated tokens take about four minutes; prefix caching cannot remove that decoding work.
- Unsupported upgrade warning followed by successful HTTP requests: inspect client/proxy upgrade headers separately; this alone does not establish an inference failure.

## Result interpretation

- Head moved: status partial with head-changed-during-review; old comments remain and the old run does not intentionally overwrite a newer summary. SHA checks and writes are not transactional.
- Time budget expired: partial, never clean; a reserved host-finalization window tries to publish deterministic facts.
- Local CLI now defaults to 60 minutes (inference can stop near 59); GitHub/API examples retain 20 (near 19). Use an explicit --max-duration-minutes to compare fairly. Longer runs are fresh reviews, not resumptions.
- output-budget-exhausted: no tools from truncated responses were executed. After one concise retry, the remaining batch stays partial; earlier file checkpoints and accepted findings remain.
- bounded transcript limit reached: history compaction could not fit the immutable task and recent evidence under the hard cap. Reduce guidance/workload; the reviewer never drops system rules to continue.
- File inspected but not counted: all diff pages plus explicit completion are required. A truncated line or skipped page cannot earn coverage. Reading alone is not review completion.
- Planner skips / unread or truncated diffs: partial coverage. They cannot disappear from the eligible denominator.
- Repeated prose, malformed tools, or invalid final answer: failed, not clean.
- Suggestion uncertain/rejected: ordinary explanatory finding remains; no apply-ready patch is posted.
- Suggestion critic unavailable/malformed: operational failure.
- Same head duplicated: only exact fingerprint matches are reused; changed wording/severity is not semantic dedup. Check author/marker ownership and concurrent external runs.
- New head duplicated: fresh head-specific comments are intentional; old anchors are never automatically moved.
- Comment ends on context: valid if its full visible range overlaps an added line. The anchor range, not just the end line, determines relevance.
- Delivery failure: inspect operational_errors_json and finding.delivery. Findings, coverage and earlier comments are preserved.

No clean review guarantees absence of bugs. Evaluate the real model using [live evaluation](evaluation.md).
