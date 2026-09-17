/**
 * Result formatting for the CLI: terminal, markdown, json.
 */
import type { ReviewResult } from '../core/types.js';
import { formatDuration } from '../core/util.js';

export type OutputFormat = 'terminal' | 'markdown' | 'json';

export function formatResult(result: ReviewResult, format: OutputFormat): string {
  switch (format) {
    case 'json':
      return JSON.stringify(result, null, 2);
    case 'markdown':
      return toMarkdown(result);
    case 'terminal':
    default:
      return toTerminal(result);
  }
}

function toTerminal(r: ReviewResult): string {
  const lines: string[] = [];
  const mark =
    r.status === 'clean'
      ? 'CLEAN'
      : r.status === 'findings'
        ? 'FINDINGS'
        : r.status === 'partial'
          ? 'PARTIAL'
          : r.status === 'skipped'
            ? 'SKIPPED'
            : 'FAILED';
  lines.push(`code-review-agent — ${mark}`);
  lines.push(`  target:   ${r.target}`);
  lines.push(`  head:     ${r.headSha.slice(0, 12)}`);
  lines.push(`  base:     ${r.baseSha.slice(0, 12)}`);
  lines.push(`  model:    ${r.model}`);
  lines.push(`  duration: ${formatDuration(r.durationMs)}`);
  const c = r.coverage;
  lines.push(
    `  coverage: ${c.reviewed}/${c.eligible} eligible reviewed, ${c.excluded} excluded, ${c.totalChanged} changed`,
  );
  lines.push(
    `  calls:    ${r.callCounts.llmCalls} llm, ${r.callCounts.toolCalls} tool, ` +
      `${r.callCounts.inlineCommentsPosted} posted, ${r.callCounts.inlineCommentsRejected} rejected`,
  );
  if (r.statusReason) lines.push(`  reason:   ${r.statusReason}`);
  if (r.findings.length > 0) {
    lines.push('');
    lines.push('Findings:');
    for (const f of r.findings) {
      lines.push(`  [${f.severity}] ${f.file}:${f.startLine}-${f.endLine} ${f.message}`);
      if (f.url) lines.push(`      ${f.url}`);
    }
  }
  if (c.skipped > 0) {
    lines.push('');
    lines.push('Skipped (eligible):');
    for (const f of c.files.filter((x) => x.status === 'skipped' && !x.reason?.startsWith('excluded:'))) {
      lines.push(`  ${f.file} — ${f.reason}`);
    }
  }
  if (r.summary) {
    lines.push('');
    lines.push(r.summary);
  }
  return lines.join('\n');
}

function toMarkdown(r: ReviewResult): string {
  const lines: string[] = [];
  lines.push(`## code-review-agent: ${r.status}`);
  lines.push('');
  lines.push(`| | |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Target | \`${r.target}\` |`);
  lines.push(`| Head | \`${r.headSha}\` |`);
  lines.push(`| Base | \`${r.baseSha}\` |`);
  lines.push(`| Model | ${r.model} |`);
  lines.push(`| Duration | ${formatDuration(r.durationMs)} |`);
  lines.push(
    `| Coverage | ${r.coverage.reviewed}/${r.coverage.eligible} eligible, ${r.coverage.excluded} excluded |`,
  );
  lines.push(`| Findings | ${r.findings.length} |`);
  if (r.statusReason) lines.push(`| Reason | ${r.statusReason} |`);
  lines.push('');
  if (r.findings.length > 0) {
    lines.push('### Findings');
    for (const f of r.findings) {
      lines.push(`- **${f.severity}** \`${f.file}:${f.startLine}\` — ${f.message}`);
    }
    lines.push('');
  }
  lines.push(`### Summary`);
  lines.push(r.summary);
  return lines.join('\n');
}
