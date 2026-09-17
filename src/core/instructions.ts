/**
 * Instruction loading: root + applicable nested AGENTS.md files and
 * .code-review-agent/review.md, all read from the reviewed head via the
 * RepoView. Sizes are capped; content is treated as data for the prompt.
 */
import { LIMITS } from './security/limits.js';
import { parentDir } from './security/paths.js';
import type { RepoView } from './repo/view.js';
import { ViewError } from './repo/view.js';
import type { InstructionBlock, RepoConfig } from './types.js';
import { truncateUtf8 } from './util.js';

const AGENTS_MD = 'AGENTS.md';
const REVIEW_MD = '.code-review-agent/review.md';

async function readBlock(view: RepoView, p: string, source: string): Promise<InstructionBlock | null> {
  try {
    if (!(await view.exists(p))) return null;
    const { content } = await view.read(p);
    if (content.length === 0) return null;
    return { source, content: truncateUtf8(content, LIMITS.maxInstructionBytesPerFile) };
  } catch (err) {
    if (err instanceof ViewError) return null;
    throw err;
  }
}

/**
 * Collect instruction blocks for a review:
 *  - root AGENTS.md
 *  - nested AGENTS.md files in directories containing changed files
 *    (all levels from the file up to the root)
 *  - .code-review-agent/review.md
 *  - config-listed instruction files
 */
export async function loadInstructions(
  view: RepoView,
  changedPaths: string[],
  config: RepoConfig,
): Promise<InstructionBlock[]> {
  const candidates: { path: string; source: string }[] = [];
  const seen = new Set<string>();
  const push = (p: string, source: string) => {
    if (p && !seen.has(p)) {
      seen.add(p);
      candidates.push({ path: p, source });
    }
  };

  // Nested AGENTS.md: for each changed file, walk up to the root.
  const nested = new Set<string>();
  for (const p of changedPaths) {
    let dir = parentDir(p);
    while (true) {
      nested.add(dir === '' ? AGENTS_MD : `${dir}/${AGENTS_MD}`);
      if (dir === '') break;
      dir = parentDir(dir);
    }
  }
  // Outermost first.
  const sortedNested = [...nested].sort((a, b) => a.length - b.length);
  for (const p of sortedNested) {
    push(p, p === AGENTS_MD ? 'AGENTS.md (repo root)' : `AGENTS.md (${p})`);
  }
  push(REVIEW_MD, '.code-review-agent/review.md');
  for (const p of config.instructions) {
    push(p, `instruction file (${p})`);
  }

  const blocks: InstructionBlock[] = [];
  let total = 0;
  for (const c of candidates) {
    const block = await readBlock(view, c.path, c.source);
    if (!block) continue;
    if (total + Buffer.byteLength(block.content) > LIMITS.maxInstructionBytesTotal) {
      const room = LIMITS.maxInstructionBytesTotal - total;
      if (room <= 0) break;
      block.content = truncateUtf8(block.content, room);
    }
    total += Buffer.byteLength(block.content);
    blocks.push(block);
  }
  return blocks;
}
