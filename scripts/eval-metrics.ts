/** Semantic quality requires human labels. Line overlap alone is not precision. */
import type { DiffMap, ReviewResult } from '../src/core/types.js';
export interface PlantedIssue { id: string; file: string; lines: number[]; description: string }
export interface Judgment { caseId: string; findingId: string; verdict: 'true_positive' | 'false_positive'; issueId?: string }
export interface EvaluationCase {
  caseId: string; language: string; kind: 'clean-control' | 'planted-bug'; issues: PlantedIssue[];
  result?: ReviewResult; error?: string;
  metrics?: ReturnType<typeof scoreCase>;
}
export function scoreCase(result: ReviewResult, diff: DiffMap, issues: PlantedIssue[]) {
  const offDiff = result.findings.filter((finding) => {
    const added = diff.addedLines.get(finding.file);
    return !added || ![...added].some((line) => finding.startLine <= line && line <= finding.endLine);
  }).length;
  return {
    withinBudget: result.durationMs <= 20 * 60_000,
    complete: ['clean', 'findings'].includes(result.status) && result.coverage.skipped === 0 && result.durationMs <= 20 * 60_000,
    elapsedSec: +(result.durationMs / 1000).toFixed(3),
    coverage: result.coverage.eligible ? result.coverage.reviewed / result.coverage.eligible : 0,
    validToolRate: result.callCounts.agentResponses ? result.callCounts.validAgentResponses / result.callCounts.agentResponses : 0,
    offDiff, duplicates: result.findings.length - new Set(result.findings.map((finding) => finding.fingerprint)).size,
    candidateMatches: result.findings.map((finding) => ({ findingId: finding.id, possibleIssueIds: issues.filter((issue) =>
      issue.file === finding.file && issue.lines.some((line) => finding.startLine <= line && line <= finding.endLine)).map((issue) => issue.id) })),
  };
}
export function aggregate(cases: EvaluationCase[], judgments: Judgment[] = []) {
  const keyed = new Map<string, Judgment>();
  for (const judgment of judgments) {
    const item = cases.find((entry) => entry.caseId === judgment.caseId);
    if (!item?.result?.findings.some((finding) => finding.id === judgment.findingId)) throw new Error('judgment refers to an unknown case/finding');
    if (!['true_positive', 'false_positive'].includes(judgment.verdict)) throw new Error('invalid judgment verdict');
    if (judgment.verdict === 'true_positive' && !item.issues.some((issue) => issue.id === judgment.issueId)) throw new Error('true-positive labels must identify a planted issue');
    const key = judgment.caseId + ':' + judgment.findingId;
    if (keyed.has(key)) throw new Error('duplicate judgment');
    keyed.set(key, judgment);
  }
  const pending = cases.flatMap((item) => (item.result?.findings ?? []).filter((finding) => !keyed.has(item.caseId + ':' + finding.id))
    .map((finding) => ({ caseId: item.caseId, findingId: finding.id, verdict: null, issueId: null, message: finding.message, file: finding.file })));
  const count = cases.length;
  const completeRate = count ? cases.filter((item) => item.metrics?.complete).length / count : 0;
  const coverage = count ? cases.reduce((sum, item) => sum + (item.metrics?.coverage ?? 0), 0) / count : 0;
  const responses = cases.reduce((sum, item) => sum + (item.result?.callCounts.agentResponses ?? 0), 0);
  const validResponses = cases.reduce((sum, item) => sum + (item.result?.callCounts.validAgentResponses ?? 0), 0);
  const validToolRate = responses ? validResponses / responses : 0;
  const offDiff = cases.reduce((sum, item) => sum + (item.metrics?.offDiff ?? 0), 0);
  const duplicates = cases.reduce((sum, item) => sum + (item.metrics?.duplicates ?? 0), 0);
  const withinBudget = count > 0 && cases.every((item) => item.metrics?.withinBudget);
  const truePositives = judgments.filter((item) => item.verdict === 'true_positive').length;
  const precision = !pending.length && judgments.length ? truePositives / judgments.length : null;
  const detectedIssues = new Set(judgments.filter((item) => item.verdict === 'true_positive').map((item) => item.caseId + ':' + item.issueId)).size;
  const plantedTotal = cases.reduce((sum, item) => sum + item.issues.length, 0);
  const reliabilityPass = count > 0 && completeRate >= .95 && coverage >= .95 && validToolRate >= .95 &&
    offDiff === 0 && duplicates === 0 && withinBudget;
  const fullSuite = ['dotnet', 'go', 'java', 'python', 'typescript'].every((language) =>
    ['clean-control', 'planted-bug'].every((kind) => cases.some((item) => item.language === language && item.kind === kind)));
  return { completeRate, coverage, validToolRate, offDiff, duplicates, withinBudget, precision, detectedIssues, plantedTotal,
    pendingJudgments: pending, reliabilityPass, qualityPass: precision !== null && precision >= .8,
    fullSuite, releaseReadyForThisRun: fullSuite && reliabilityPass && precision !== null && precision >= .8 };
}
