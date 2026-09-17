import { describe, expect, it } from 'vitest';
import { aggregate, scoreCase, type EvaluationCase } from '../../scripts/eval-metrics.js';
import { emptyCallCounts } from '../../src/core/review/pipeline.js';
import type { DiffMap, ReviewResult } from '../../src/core/types.js';

function result(): ReviewResult {
  return { schema: 'code-review-agent.result/v1', status: 'findings', target: 'fixture',
    baseSha: 'base', headSha: 'head', model: 'fake', summary: 'summary', operationalErrors: [],
    startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:01Z', durationMs: 1500,
    findings: [{ id: 'finding', fingerprint: 'x', file: 'a.ts', startLine: 2, endLine: 2, severity: 'high',
      block: 'return a-b;', message: 'Wrong arithmetic.', batchIndex: 0, delivery: 'local' }],
    coverage: { totalChanged: 1, eligible: 1, reviewed: 1, skipped: 0, excluded: 0, files: [{ file: 'a.ts', status: 'reviewed' }] },
    callCounts: { ...emptyCallCounts(), agentResponses: 3, validAgentResponses: 3 } };
}
const diff: DiffMap = { baseSha: 'base', headSha: 'head', files: new Map(), hunks: new Map(), addedLines: new Map([['a.ts', new Set([2])]]) };
const issues = [{ id: 'arithmetic', file: 'a.ts', lines: [2], description: 'Add was changed to subtract.' }];
function evaluated(r = result()): EvaluationCase {
  return { caseId: 'typescript/planted-bug', language: 'typescript', kind: 'planted-bug', issues, result: r, metrics: scoreCase(r, diff, issues) };
}
describe('honest live evaluation metrics', () => {
  it('uses real seconds, computes tool rate and never treats failed/partial as completed', () => {
    expect(evaluated().metrics!.elapsedSec).toBe(1.5);
    for (const status of ['failed', 'partial'] as const) {
      const r = result(); r.status = status;
      expect(evaluated(r).metrics!.complete).toBe(false);
      expect(aggregate([evaluated(r)]).reliabilityPass).toBe(false);
    }
    const r = result(); r.durationMs = 20 * 60_000 + 1;
    expect(evaluated(r).metrics!.withinBudget).toBe(false);
  });
  it('does not claim precision from line-overlap matches', () => {
    const report = aggregate([evaluated()]);
    expect(report.precision).toBeNull();
    expect(report.detectedIssues).toBe(0);
    expect(report.pendingJudgments).toHaveLength(1);
    expect(evaluated().metrics!.candidateMatches[0]!.possibleIssueIds).toEqual(['arithmetic']);
    expect(report.releaseReadyForThisRun).toBe(false);
  });
  it('scores precision from complete human labels and rejects unknown/duplicate labels', () => {
    const judgments = [{ caseId: 'typescript/planted-bug', findingId: 'finding', verdict: 'true_positive' as const, issueId: 'arithmetic' }];
    const scored = aggregate([evaluated()], judgments);
    expect(scored.precision).toBe(1);
    expect(scored.detectedIssues).toBe(1);
    expect(scored.fullSuite).toBe(false);
    expect(() => aggregate([evaluated()], [...judgments, ...judgments])).toThrow(/duplicate/);
    expect(() => aggregate([evaluated()], [{ ...judgments[0]!, issueId: 'unknown' }])).toThrow(/planted/);
  });
  it('detects off-diff and duplicate findings as harness violations', () => {
    const r = result();
    r.findings.push({ ...r.findings[0]!, startLine: 10, endLine: 10 });
    const scored = evaluated(r);
    expect(scored.metrics!.offDiff).toBe(1);
    expect(scored.metrics!.duplicates).toBe(1);
    expect(aggregate([scored]).reliabilityPass).toBe(false);
  });
});

