/**
 * Structured planning call: groups all eligible changed files into at most
 * six review batches. Every file must be assigned or carry an explicit skip
 * reason. Validation is strict; any malformed plan falls back to a
 * deterministic bin-packing planner so a review is never blocked by planning.
 */
import { extractJsonObject, type LlmClient, type ToolSpec } from '../llm/client.js';
import { LIMITS } from '../security/limits.js';
import { parentDir } from '../security/paths.js';

export interface ReviewBatch {
  index: number;
  files: string[];
  notes?: string;
}

export interface PlanResult {
  batches: ReviewBatch[];
  /** Eligible files the planner explicitly skipped, with reasons. */
  skipped: { file: string; reason: string }[];
  /** True when the deterministic fallback planner was used. */
  fallback: boolean;
}

export interface PlanFile {
  path: string;
  additions: number;
  deletions: number;
  status: string;
}

const PLAN_TOOL_SPEC: ToolSpec = {
  name: 'plan_review_batches',
  description: 'Submit the review batch plan as JSON.',
  parameters: {
    type: 'object',
    properties: {
      batches: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            files: { type: 'array', items: { type: 'string' } },
            notes: { type: 'string' },
          },
          required: ['files'],
          additionalProperties: false,
        },
      },
      skipped: {
        type: 'array',
        items: {
          type: 'object',
          properties: { file: { type: 'string' }, reason: { type: 'string' } },
          required: ['file', 'reason'],
          additionalProperties: false,
        },
      },
    },
    required: ['batches', 'skipped'],
    additionalProperties: false,
  },
};

const PLAN_SCHEMA: Record<string, unknown> = PLAN_TOOL_SPEC.parameters;

function fileListText(files: PlanFile[]): string {
  return files
    .map((f) => `- ${f.path} (${f.status}, +${f.additions}/-${f.deletions})`)
    .join('\n');
}

function systemPrompt(files: PlanFile[]): string {
  return [
    'You are a code-review batch planner. Group the eligible changed files into at most',
    `six review batches for focused LLM review agents.`,
    '',
    'Rules:',
    '- Every eligible file must appear in exactly one batch, or in "skipped" with an explicit reason.',
    '- Do not invent files that are not listed.',
    '- Keep related files (same directory or module) together when practical.',
    '- Avoid overloading a single batch: spread large files (high +/− counts) across batches.',
    '- "skipped" is only for files that genuinely cannot be reviewed in this run (e.g. far too large); prefer assigning every file.',
    '',
    'Eligible files:',
    fileListText(files),
    '',
    `Respond with JSON matching the schema: {"batches":[{"files":[...],"notes":"..."}],"skipped":[{"file":"...","reason":"..."}]}. Use at most ${LIMITS.maxBatches} batches.`,
  ].join('\n');
}

/**
 * Validate a raw plan document against the eligible file set.
 * Returns a normalized PlanResult or null.
 */
export function validatePlan(
  doc: unknown,
  eligible: string[],
  maxBatches: number = LIMITS.maxBatches,
): PlanResult | null {
  if (typeof doc !== 'object' || doc === null) return null;
  const d = doc as Record<string, unknown>;
  if (!Array.isArray(d.batches) || !Array.isArray(d.skipped)) return null;
  const eligibleSet = new Set(eligible);
  const assigned = new Set<string>();
  const batches: ReviewBatch[] = [];
  for (const raw of d.batches) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    if (!Array.isArray(r.files)) return null;
    const files: string[] = [];
    for (const f of r.files) {
      if (typeof f !== 'string') return null;
      if (!eligibleSet.has(f)) return null; // unknown file
      if (assigned.has(f)) return null; // double assignment
      assigned.add(f);
      files.push(f);
    }
    if (files.length === 0) return null; // empty batch
    batches.push({
      index: batches.length,
      files,
      ...(typeof r.notes === 'string' ? { notes: r.notes.slice(0, 500) } : {}),
    });
  }
  if (batches.length > maxBatches) return null;
  const skipped: { file: string; reason: string }[] = [];
  for (const raw of d.skipped) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.file !== 'string' || typeof r.reason !== 'string') return null;
    if (!eligibleSet.has(r.file)) return null;
    if (assigned.has(r.file)) return null;
    if (r.reason.trim().length === 0) return null;
    assigned.add(r.file);
    skipped.push({ file: r.file, reason: r.reason.slice(0, 300) });
  }
  // Every eligible file must be accounted for.
  for (const f of eligible) {
    if (!assigned.has(f)) return null;
  }
  return { batches, skipped, fallback: false };
}

/**
 * Deterministic fallback planner: directory-cohesive greedy bin packing
 * into at most maxBatches bins, largest groups first.
 */
export function fallbackPlan(eligible: PlanFile[], maxBatches: number = LIMITS.maxBatches): PlanResult {
  if (eligible.length === 0) return { batches: [], skipped: [], fallback: true };
  // Group by top-level directory for cohesion.
  const groups = new Map<string, PlanFile[]>();
  for (const f of [...eligible].sort((a, b) => a.path.localeCompare(b.path))) {
    const dir = parentDir(f.path);
    const key = dir === '' ? '(root)' : dir;
    const list = groups.get(key) ?? [];
    list.push(f);
    groups.set(key, list);
  }
  const groupSizes = new Map<string, number>();
  for (const [dir, list] of groups) {
    groupSizes.set(dir, list.reduce((s, f) => s + f.additions + f.deletions, 0));
  }
  const order = [...groups.keys()].sort(
    (a, b) => (groupSizes.get(b) ?? 0) - (groupSizes.get(a) ?? 0),
  );

  const bins: { files: string[]; notes?: string; size: number }[] = [];
  for (let i = 0; i < maxBatches; i++) bins.push({ files: [], size: 0 });
  for (const dir of order) {
    const list = groups.get(dir)!;
    const size = groupSizes.get(dir) ?? 0;
    // Small groups go to the least-loaded bin; a group larger than any bin
    // gets its own bin (bins can hold more than one group).
    if (bins.length > 1 && size < (Math.max(...bins.map((b) => b.size)) || size)) {
      const bin = bins.reduce((m, b) => (b.size < m.size ? b : m), bins[0]!);
      bin.files.push(...list.map((f) => f.path));
      bin.size += size;
      bin.notes = bin.notes ? `${bin.notes}; ${dir}` : dir;
    } else {
      const bin = bins[0]!;
      bin.files.push(...list.map((f) => f.path));
      bin.size += size;
      bin.notes = bin.notes ? `${bin.notes}; ${dir}` : dir;
    }
  }
  const used = bins.filter((b) => b.files.length > 0);
  return {
    batches: used.map((b, i) => ({ index: i, files: b.files, ...(b.notes ? { notes: b.notes } : {}) })),
    skipped: [],
    fallback: true,
  };
}

/**
 * Run the structured planning call with validation and fallback.
 */
export async function planBatches(params: {
  llm: LlmClient;
  mode: 'tools' | 'structured';
  files: PlanFile[];
  onLlmCall?: () => void;
}): Promise<PlanResult> {
  const { llm, mode, files } = params;
  const eligible = files.map((f) => f.path);
  if (eligible.length === 0) return { batches: [], skipped: [], fallback: true };

  const system = systemPrompt(files);
  const user = 'Produce the batch plan now.';
    let doc: unknown = null;
    if (mode === 'tools') {
      params.onLlmCall?.();
      const resp = await llm.chat({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        tools: [PLAN_TOOL_SPEC],
        toolChoice: { function: { name: 'plan_review_batches' } },
        temperature: 0,
      });
      const call = resp.toolCalls[0];
      if (call && call.name === 'plan_review_batches') {
        try {
          doc = JSON.parse(call.arguments);
        } catch {
          doc = null;
        }
      }
    } else {
      params.onLlmCall?.();
      const resp = await llm.chat({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        jsonSchema: { name: 'plan', schema: PLAN_SCHEMA },
        temperature: 0,
      });
      doc = extractJsonObject(resp.content ?? '');
    }
    const validated = doc !== null ? validatePlan(doc, eligible) : null;
    if (validated) return validated;
  return fallbackPlan(files);
}
