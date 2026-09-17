# Calling the reusable workflow

In every repository you want reviewed, add the workflow below. Replace both REVIEWER_COMMIT_SHA occurrences with the same full 40-character SHA from a pushed, CI-verified commit in rogerangel/code-review-agent. No release tag or npm publication is needed.

~~~yaml
# .github/workflows/code-review.yml
name: Code review (local LLM)
on:
  pull_request:
    types: [opened, reopened, ready_for_review, synchronize]
  issue_comment:
    types: [created]
permissions:
  contents: read
  pull-requests: write
  issues: write
  id-token: write
jobs:
  review:
    uses: rogerangel/code-review-agent/.github/workflows/code-review-agent.yml@REVIEWER_COMMIT_SHA
    with:
      reviewer_repository: rogerangel/code-review-agent
      reviewer_ref: REVIEWER_COMMIT_SHA
      llm_base_url: 'http://gb10.YOUR-TAILNET.ts.net:8123/v1'
      llm_model: 'YOUR-SERVED-MODEL-ID'
      tailscale_tags: 'tag:code-review-agent'
      tool_mode: auto
      max_duration_minutes: 20
      max_inline_comments: 6
      fail_on_severity: none
    secrets:
      tailscale_client_id: ${{ secrets.TS_CLIENT_ID }}
      tailscale_audience: ${{ secrets.TS_AUDIENCE }}
      # Only when the inference endpoint requires a key:
      # llm_api_key: ${{ secrets.CRA_LLM_API_KEY }}
      # Optional token override:
      # repository_token: ${{ secrets.CR_AGENT_TOKEN }}
~~~

Merge this caller workflow onto the target repository's default branch for issue_comment /review support. Use normal pull_request, not pull_request_target. Do not execute PR scripts before connecting to the tailnet.

Called workflows cannot elevate caller token permissions; that is why the caller grants issues/pull-requests write and id-token write. The gate job narrows these to contents/pull-requests read. See [GitHub reusable-workflow permissions](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows).

## Tokens and Tailscale credentials

The default github.token is enough for ordinary repos with writable Actions tokens. No personal token is required for the public reviewer source.

- tailscale_client_id / tailscale_audience map to a federated identity configured for the CALLER repository and the pinned reusable workflow. They are identifiers, not an OAuth secret; stored as repository secrets here for convenient passing.
- llm_api_key is a workflow secret, never a with input on the caller job.
- repository_token is optional. A fine-grained PAT/App installation token needs target Contents read, Pull requests read/write, and Issues read/write. If reviewer source is made private, it also needs reviewer Contents read and suitable GitHub reusable-workflow access settings. The reusable-workflow secret cannot be named github_token because GitHub reserves that name; the standalone Action's github_token input is unchanged.
- Custom App tokens need github_comment_author set to that App's bot login, e.g. my-reviewer[bot]. Installation tokens cannot use GET /user; ownership uses the trusted hint. PAT logins are discovered automatically.

Set these separately in each caller repo, or use organization secrets restricted to your chosen repos. [Tailscale setup](tailscale.md) explains tag/issuer/claim restrictions.

## Execution order

The gate checks out only the pinned reviewer code and runs its bundled Node gate. The authorized job separately checks out that reviewer source and the caller's PR head under review-target/. It compares the snapshot to the gate's SHA before Tailscale, then runs ./reviewer with repository_path: review-target. The worker repeats authorization and snapshot checks before model requests.

A local action reference is workspace-relative; simply using ./ after a PR checkout would run the caller's action, not this reviewer. Separate directories prevent that.

The worker pins both base/head from the PR API, recovers shallow merge-base history, reads head-side policy, probes the endpoint, and runs the agent.

## Outputs

| Output | Meaning |
| --- | --- |
| status | clean / findings / partial / skipped / failed; denied gate runs return skipped. |
| findings_count | Accepted findings, including reused, summary-only and failed delivery. |
| reviewed_head_sha | Pinned reviewed head; empty before a snapshot exists. |
| summary_comment_url | Bot-owned sticky summary URL, when delivered. |
| coverage_json | Changed/eligible/reviewed/skipped/excluded counts plus each file's disposition. |
| operational_errors_json | Stage/code/message/finding ID diagnostics; operational failure fails the job. |
| inline_comments_reused | Exact same-head comments reused without new posting. |
| result_path | Review-job-local temporary JSON file; NOT available in a downstream job. |

These are mapped step → job → reusable workflow. To persist JSON, add an explicit artifact step INSIDE the review job; no result/prompt artifacts are uploaded by default. Normalized results include source blocks and suggestions: handle them as sensitive.

## Retriggers and concurrency

Only authorized review jobs share a repository/PR concurrency group and cancel the previous review. Unrelated issue comments do not cancel one. Pushes start a new head-specific finding set and update the sticky summary. Exact /review reruns reuse matching comments on an unchanged head.

Posting is immediate and cannot be rolled back on cancellation; already-posted comments remain. Every physical write/retry checks current head/state, but the API offers no atomic check-and-post operation.
