# Live evaluation (opt-in)

Local tests validate behavior with synthetic repos and mocked HTTP/LLMs. They do not demonstrate the GB10 model's defect precision or live Tailscale/GitHub access.

~~~bash
export CRA_LLM_BASE_URL=http://gb10.YOUR-TAILNET.ts.net:8123/v1
export CRA_LLM_MODEL=YOUR-SERVED-MODEL-ID
export CRA_EVAL_MODEL_REVISION=EXACT_MODEL_REVISION
export CRA_EVAL_VLLM_VERSION=INSTALLED_VLLM_VERSION
export CRA_EVAL_TOOL_PARSER=ACTUAL_PARSER
npm run eval
npm run eval -- --only typescript
~~~

Each run builds disposable Git repos, performs bounded model preflight, and runs the real reviewer with a LOCAL sink. No GitHub comments or repository code execution occur.

The full suite has five languages × two cases:

- Existing test/fixtures/repos/ snapshots are explicitly labeled clean controls (including CRLF, rename and deletion).
- test/fixtures/eval/ contains known arithmetic, zero-division, and null-handling regressions.
- Every case has a required issues.json truth sidecar, kept outside the repository/model context.

## Honest metrics

| Metric | Computed definition | Target |
| --- | --- | --- |
| Valid tool response rate | Schema-valid batch responses / attempted batch responses; excludes planning/probes/critic/answer | ≥0.95 |
| Off-diff findings | Findings with no added-line overlap | 0 |
| Duplicate findings | Repeated exact fingerprints within one run | 0 |
| Coverage | Reviewed / eligible; skipped eligible files stay in denominator | ≥0.95 |
| Completion | clean/findings, no skipped eligible files, and within 20-minute budget | ≥0.95 |
| Within budget | Actual durationMs ≤20 minutes | All cases |
| Precision | Human true-positive judgments / all labeled findings | ≥0.8 |

A failed or partial run is NOT completed. elapsedSec divides milliseconds by 1000. Line-overlap candidateMatches merely help labeling; they do not prove that the explanation detects a planted issue. precision stays null/UNSCORED until all findings are judged, and zero findings cannot manufacture perfect precision.

Reports contain full normalized results and pendingJudgments. They contain synthetic fixture code, not prompts/reasoning/API keys; keep local reports out of Git by default.

## Human adjudication

Read every finding against its complete source/diff and truth description. False assumptions, style-only concerns, wrong defect explanations and redundant paraphrases count as false positives. A true positive must identify a planted issue; amend truth deliberately if you discover a real unlisted fixture bug.

Create a separate JSON file using case/finding IDs from the report:

~~~json
{
  "judgments": [
    {
      "caseId": "typescript/planted-bug",
      "findingId": "COPY_FINDING_ID",
      "verdict": "true_positive",
      "issueId": "typescript-regression"
    },
    {
      "caseId": "python/clean-control",
      "findingId": "COPY_OTHER_FINDING_ID",
      "verdict": "false_positive"
    }
  ]
}
~~~

Re-score the saved report without making inference requests:

~~~bash
npm run eval -- --score eval-report-TIMESTAMP.json --adjudication judgments.json --output eval-report-scored.json
~~~

Unknown/duplicate judgments are rejected. Detected planted issues count distinct human-confirmed issue IDs, not line matches; inspect missed issues too.

A normal live run exits nonzero when reliability/budget/guard gates fail. Its successful exit with unscored precision is NOT a quality pass. Re-scoring exits nonzero unless the full five-language/control+bug suite meets reliability and labeled precision gates. A --only run cannot pass full-suite release readiness.

## Before relying on a model

Repeat the full suite at least FIVE times with recorded model/vLLM revisions, parser, chat template, context/GPU settings and deployment changes. Meet the metrics above and inspect missed planted defects plus representative real PR false positives.

No result automatically enables publishing, approval, or merge gating. Keep fail_on_severity: none until you've evaluated real-world trust. Also validate one live same-repo PR, an authorized fork /review, same-head reruns, stale-head supersession and actual runner connectivity.

Default production logs are metrics/diagnostics only. Raw prompt or reasoning trace collection is not implemented; any future capture must be explicit, opt-in and handled as sensitive data.
