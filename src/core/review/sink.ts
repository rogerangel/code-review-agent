/**
 * Review sinks: where inline comments and the sticky summary go.
 *
 * GitHubSink posts immediately through the GitHub review-comment API.
 * LocalSink records findings in the local result (same normalized schema),
 * so local CLI mode and GitHub mode produce identical ReviewResult shapes.
 */
import type { Finding, HeadCheck, ReviewResult } from '../types.js';

export interface ReviewSink {
  kind: 'github' | 'local';
  /** Findings accepted and posted by this sink, in post order. */
  readonly posted: Finding[];
  setSignal?(signal: AbortSignal): void;
  existingComments?(): Promise<{ fingerprint: string; file: string; body: string; url?: string }[]>;
  findExistingInline?(fingerprint: string): Promise<{ url?: string } | undefined>;
  /**
   * Recheck the current head before any side effect. Sinks track the
   * expected head they were built with; `expectedHead` may override it.
   */
  recheckHead(expectedHead?: string): Promise<HeadCheck>;
  /**
   * Post one inline comment. Must be called immediately when a finding is
   * accepted. Returns the posted URL (GitHub mode) or empty (local mode).
   */
  postInlineComment(f: Finding, body: string): Promise<{ url?: string; reused?: boolean }>;
  /**
   * Create or update the single marker-owned sticky summary comment.
   * The marker identifies ownership; any existing marker comment is updated.
   */
  upsertSummaryComment(params: { marker: string; body: string }): Promise<{ url?: string }>;
  /** Called once when the run finishes. */
  finalize(result: ReviewResult): Promise<void>;
}

export class LocalSink implements ReviewSink {
  kind = 'local' as const;
  readonly posted: Finding[] = [];

  async recheckHead(expectedHead?: string): Promise<HeadCheck> {
    return { ok: true, currentHead: expectedHead ?? 'local', stale: false };
  }

  async postInlineComment(f: Finding): Promise<{ url?: string }> {
    this.posted.push(f);
    return {};
  }

  async upsertSummaryComment(): Promise<{ url?: string }> {
    return {};
  }

  async finalize(): Promise<void> {
    // Findings are already recorded in this.posted.
  }
}
