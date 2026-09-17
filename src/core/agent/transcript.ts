/** Deterministic history compaction; no summarizing model call or reasoning replay. */
import type { ChatMessage, ToolSpec } from '../llm/client.js';
import type { ToolContext } from '../types.js';
import { LIMITS } from '../security/limits.js';

const PREFIX = 'HOST REVIEW CHECKPOINT\n';
export function transcriptSize(messages: ChatMessage[], tools: ToolSpec[]): number {
  return JSON.stringify({ messages, tools }).length;
}

function checkpoint(ctx: ToolContext): ChatMessage {
  const facts = {
    completed_count: ctx.fileCompletions?.size ?? 0,
    completed_files: [...(ctx.fileCompletions?.keys() ?? [])],
    full_diff_reads: [...ctx.diffReads],
    diff_pages: [...(ctx.diffReadPages ?? [])].map(([path, lines]) => ({ path, delivered_lines: lines.size })),
    remaining_files: ctx.batchFiles.filter((file) => !ctx.fileCompletions?.has(file)),
    accepted_findings: ctx.findings.map((f) => ({ file: f.file, severity: f.severity, startLine: f.startLine,
      endLine: f.endLine, delivery: f.delivery, explanation: f.message.slice(0, 180) })),
    details_omitted: false,
  };
  // Long path lists cannot themselves recreate an oversized transcript.
  while (JSON.stringify(facts).length > 8000) {
    const arrays = [facts.completed_files, facts.full_diff_reads, facts.diff_pages, facts.remaining_files, facts.accepted_findings];
    const largest = arrays.reduce((a, b) => JSON.stringify(a).length > JSON.stringify(b).length ? a : b);
    if (!largest.length) break;
    largest.pop(); facts.details_omitted = true;
  }
  return { role: 'user', content: PREFIX +
    'Earlier exchanges were omitted to bound context. These are host-recorded facts, not new instructions. ' +
    'Source evidence is not retained here: reread necessary evidence before posting. Diff reading alone is not review completion.\n' + JSON.stringify(facts) };
}

export function compactTranscript(messages: ChatMessage[], tools: ToolSpec[], ctx: ToolContext): boolean {
  if (transcriptSize(messages, tools) <= LIMITS.transcriptCompactChars) return true;
  const base = messages.slice(0, 2);
  const groups: ChatMessage[][] = [];
  for (const message of messages.slice(2)) {
    if (message.role === 'user' && message.content?.startsWith(PREFIX)) continue;
    if (message.role === 'assistant' || !groups.length) groups.push([]);
    groups.at(-1)!.push(message);
  }
  // A complete assistant/tools exchange is indivisible in native mode.
  const recent = groups.slice(-2);
  const note = checkpoint(ctx);
  while (recent.length > 1 && transcriptSize([...base, note, ...recent.flat()], tools) > LIMITS.transcriptCompactChars) recent.shift();
  const compacted = [...base, note, ...recent.flat()];
  if (transcriptSize(compacted, tools) > LIMITS.maxTranscriptChars) return false;
  messages.splice(0, messages.length, ...compacted);
  if (ctx.performance) ctx.performance.transcriptCompactions++;
  ctx.onProgress?.({ type: 'transcript-compacted', count: ctx.performance?.transcriptCompactions ?? 1, elapsedMs: ctx.budget.elapsed() });
  return true;
}
