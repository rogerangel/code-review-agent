# First push and first real review

The reviewer repository is rogerangel/code-review-agent. The remote is already set:

~~~text
origin git@github.com:rogerangel/code-review-agent.git
~~~

The first push has already been completed. The commands below remain a checklist for source updates and future scratch repositories; do not repeat initialization. There is nothing to publish to npm. These steps are for you to run; the implementation does not commit or push automatically.

## 1. Check and push the reviewer source

From the reviewer directory, with Node 24+ installed:

~~~bash
git remote -v
git branch --show-current
git status --short
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm run check:dist
npm run smoke
~~~

Stage the source, documentation, workflows and built distributions:

~~~bash
git add .gitignore .github LICENSE README.md action.yml gate-action dist docs src scripts test package.json package-lock.json tsconfig.json tsup.config.ts vitest.config.ts eslint.config.js
git diff --cached --stat
git diff --cached --check
git status --short
~~~

Check that there are no keys, .env files, node_modules, IDE state, or model traces in the staged files. Both Action bundles must be included: dist/action.cjs and gate-action/dist/gate.cjs. The .gitignore keeps .idea/ and secrets out without hiding repository review guidance.

When satisfied:

~~~bash
git commit -m "Implement reusable local-LLM code reviewer"
git push -u origin main
git rev-parse HEAD
~~~

Keep that last 40-character SHA; it will pin the workflow and reviewer_ref in every caller. Open the GitHub repository's Actions tab and wait for CI to pass.

For subsequent updates, use a descriptive commit message and push your existing branch normally; no new repository or upstream setup is needed.

You do not need git init or git remote add again. If GitHub unexpectedly has another initial commit, stop and reconcile the histories; do not force-push. An SSH authentication failure is separate from the implementation; authenticate the GitHub SSH key used by this remote.

For a future scratch repository, create it empty on GitHub, without an auto-generated README/license/gitignore, before connecting the local history. That step is already done here.

## 2. Verify GB10/vLLM from your Mac

Keep the inference server private. Use its Tailscale IP or MagicDNS hostname and actual configured port, such as 8123; the model name must match /v1/models.

~~~bash
tailscale status
curl --fail --max-time 10 http://gb10.YOUR-TAILNET.ts.net:8123/v1/models
export CRA_LLM_BASE_URL=http://gb10.YOUR-TAILNET.ts.net:8123/v1
export CRA_LLM_MODEL=YOUR-SERVED-MODEL-ID
node dist/cli.js doctor
~~~

If vLLM uses a key, set CRA_LLM_API_KEY through your secret manager/environment rather than committing it; include a Bearer header in the curl check. Do not paste key values into PR comments.

On the same private LAN, its LAN address or an existing localhost forward also works; Tailscale is for private connectivity across networks. For slower thinking models, set the operator-owned CRA_LLM_OPTIONS profile in [vLLM setup](setup-vllm.md) before running doctor and review. Doctor checks those explicit settings without silently dropping rejected options.

Doctor tests model discovery, schema output, and an actual native tool → result → follow-up round trip. It exits successfully if at least one supported mode is verified and no operational/separation failure occurred. No parser or model is assumed. See [vLLM setup](setup-vllm.md).

A local dry review needs no GitHub token:

~~~bash
cd /path/to/a/feature-branch/repository
node /absolute/path/code-review-agent/dist/cli.js review --staged
~~~

Use --last-commit or an explicit A...B range if there are no staged changes. The local reviewer does not execute the project's tests and does not post GitHub comments.

Local reviews now default to 60 minutes, with call/file progress and 30-second inference heartbeats on stderr. Use --quiet to suppress progress; --format json keeps stdout machine-readable. GitHub reviews retain the 20-minute default.

## 3. Configure restricted runner access

Follow [Tailscale federation](tailscale.md). Start with ONE target repository, not an owner-wide wildcard.

Create tag:code-review-agent, allow it to reach only the GB10 inference TCP port, and create an OpenID Connect trust credential for GitHub. Grant auth_keys write for that tag, bind repository/subject claims to the caller repo, and bind job_workflow_ref/job_workflow_sha to this pinned reviewer workflow.

Store the generated Client ID and Audience in the TARGET repository's GitHub Actions secrets as TS_CLIENT_ID and TS_AUDIENCE. No Tailscale OAuth secret or API admin key is needed by the workflow. If inference requires a key, also add CRA_LLM_API_KEY.

Your Mac's successful doctor test proves the Mac-to-GB10 route, not the ephemeral runner's route. Verify runner connectivity independently on the first real PR.

Do not replace an existing tailnet policy wholesale with an example. Tailscale rules are additive; an existing allow-all grant can still permit broader access. Validate the effective policy and host firewall.

## 4. Install in a target repository

Copy [the caller workflow](caller-workflow.md) into that repo at .github/workflows/code-review.yml. Replace both SHA placeholders with the SAME SHA from step 1. Replace the endpoint hostname/port and model ID.

The reviewer source is public, so the target's ordinary github.token can check it out. Keep fail_on_severity: none while you evaluate quality. For custom tokens/App bot identities, see the caller guide.

Optionally add .code-review-agent.yml and .code-review-agent/review.md to describe that repo's stack and review priorities. The same reviewer can serve TypeScript, Python, Go, Java, C#, Rust, or mixed repos; only each repo's guidance changes.

Merge the caller workflow into its default branch so issue_comment triggers work.

## 5. First PR acceptance checks

Open a small non-draft PR in the target repo. Check the Actions log:

- The trusted gate approves BEFORE the runner joins Tailscale.
- The reviewer checkout and PR checkout are separate.
- The reviewed_head_sha equals the PR head.
- Coverage accounts for every changed file and does not silently remove planner skips.
- Findings create inline comments; one bot-owned sticky summary contains agent prose plus deterministic status/coverage.
- Repeating /review as a write/maintain/admin collaborator reuses exact same-head findings without new matching inline comments.
- A new commit triggers a new head-specific set and updates the summary.

Automatic fork PRs intentionally skip. To test a fork, create a NEW comment containing exactly /review as an authorized collaborator. Edited comments and read-only/non-collaborator commands must not connect to Tailscale.

If delivery/protocol/config/endpoint fails, the job should FAIL with operational_errors_json. If the budget runs out or the head moves, the review is advisory partial, not clean. Already-posted comments remain.

## 6. Evaluate before treating it as dependable

Run [the live evaluation](evaluation.md) on the GB10 endpoint. It includes planted defects and clean controls across five languages. Human labels are required for precision; an unscored report is not a quality pass. Repeat the full suite at least five times and inspect real PR false positives.

Local synthetic/transport tests do NOT prove your GB10 model's review quality, Tailscale trust configuration, or live GitHub permissions. Those remain deployment checks.

## Later: publishing

package.json intentionally has private: true, and CI has no publishing job. The repository/provenance metadata now points to your actual GitHub repo.

After live gates pass and you decide on npm ownership/package naming, explicitly enable a separate guarded release workflow: immutable version tag matching package.json, fresh distributions, tests/smokes, correct public repository metadata and provenance. A moving v1 tag must never republish npm. See [npm provenance requirements](https://docs.npmjs.com/generating-provenance-statements/).

You can already reuse the Action by pushed commit SHA and share a local npm tarball without publishing.
