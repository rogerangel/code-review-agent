# Forks and /review

Automatic opened/reopened/ready_for_review/synchronize review is restricted to open non-draft PRs whose head repository identity equals the base repository identity. A repository being itself a fork does not disqualify its own branches.

Cross-repository/fork PRs intentionally emit fork-pull-request-automatic-skip before tailnet or inference access.

A newly CREATED comment whose trimmed body is exactly /review can trigger any open non-draft PR, including a fork, if the commenter has write, maintain, or admin permission in the BASE repository.

~~~text
/review
~~~

Edited comments, /Review, /review please, plain-issue comments, read-only users and non-collaborators are denied. The permission API is authoritative; API failures deny access AND fail operationally rather than looking like a normal skip.

The caller's issue_comment workflow must be present on its default branch. Default-branch trusted workflow settings and pinned reviewer executables run; fork code/config/guidance is only read as review data.

Authorization precedes Tailscale in the reusable workflow. The standalone worker also repeats this check before LLM discovery/inference, so calling the Action directly cannot bypass command authorization. It does not disconnect an already-connected custom runner; keep connection ordering in the trusted caller.

No PR scripts, builds, tests, action.yml, or package install hooks from the target are executed. Already-posted comments survive cancellation/head changes and stay pinned to their original commit.

Use [the supplied caller workflow](caller-workflow.md), not pull_request_target plus PR execution. Begin with one tailnet identity limited to one target repo.
