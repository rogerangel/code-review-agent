/**
 * JSON schemas for the Junie-shaped read-only tool surface.
 * These are transport-neutral: the same specs drive native tool calling,
 * structured-output fallback, and (later) an MCP adapter.
 */
import type { ToolSpec } from '../llm/client.js';

export const TOOL_NAMES = {
  listChangedFiles: 'list_changed_files',
  readDiff: 'read_diff',
  readFile: 'read_file',
  listDirectory: 'list_directory',
  search: 'search',
  postInlineReviewComment: 'post_inline_review_comment',
  completeReviewFile: 'complete_review_file',
  completeReviewBatch: 'complete_review_batch',
  answer: 'answer',
} as const;

export const SEVERITY_ENUM = ['low', 'medium', 'high', 'critical'] as const;

export const BATCH_TOOL_SPECS: ToolSpec[] = [
  {
    name: TOOL_NAMES.listChangedFiles,
    description:
      'List every changed file in the review target with status, added/deleted line counts, and eligibility. Call this first to understand the change surface.',
    parameters: { type: 'object', properties: { offset: { type: 'integer', minimum: 0, description: 'Continue from next_offset (default 0).' } }, additionalProperties: false },
  },
  {
    name: TOOL_NAMES.readDiff,
    description:
      'Read the normalized unified diff for one changed file (the exact change under review).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repository-relative file path from list_changed_files.' },
        offset: { type: 'integer', minimum: 0, description: 'Normalized rendered-line offset. Follow next_offset until has_more=false.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_NAMES.readFile,
    description:
      'Read file content as of the reviewed head commit (read-only), up to 200 lines per call. Follow next_start_line for more context.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repository-relative file path.' },
        start_line: { type: 'integer', minimum: 1, description: 'First line to read (1-based).' },
        end_line: { type: 'integer', minimum: 1, description: 'Last line to read (1-based, inclusive).' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_NAMES.listDirectory,
    description:
      'List files and subdirectories of a directory as of the reviewed head commit.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Repository-relative directory path. Use the empty string for the repository root.',
        },
        offset: { type: 'integer', minimum: 0, description: 'Continue from next_offset (default 0).' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_NAMES.search,
    description:
      'Search file contents as of the reviewed head commit. Literal substring by default; set regex=true for a regular expression.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Literal text or regular expression to find.' },
        dir: { type: 'string', description: 'Restrict search to this directory (default: repository root).' },
        regex: { type: 'boolean', description: 'Treat pattern as a regular expression (default false).' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_NAMES.postInlineReviewComment,
    description:
      'Post one inline review comment anchored to an exact source block on a changed line. ' +
      'Use only for real issues at medium or higher severity that are directly relevant to the changed lines. ' +
      'The block must be copied verbatim from the current head file, must occur exactly once in that file, and must overlap a changed line. ' +
      'A strict per-run cap applies and duplicate findings are rejected. Verify framework behavior, alternate code paths, and evidence before calling.',
    parameters: {
      type: 'object',
      properties: {
        severity: { type: 'string', enum: [...SEVERITY_ENUM] },
        path: { type: 'string', description: 'Repository-relative file path.' },
        block: {
          type: 'string',
          description:
            'Exact source code block (one or more complete lines) from the current head file, copied verbatim including indentation. Must occur exactly once in the file.',
        },
        explanation: {
          type: 'string',
          description: 'Concise explanation of the issue and its impact (1-3 sentences).',
        },
        suggestion: {
          type: 'string',
          description:
            'Optional exact replacement code for the block. It is verified by a focused critic before posting; unconfirmed suggestions are omitted.',
        },
      },
      required: ['severity', 'path', 'block', 'explanation'],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_NAMES.completeReviewFile,
    description: 'Checkpoint one assigned file after reading its entire diff, verifying issues, and posting its findings. This survives later batch interruption. Never call just because you read the diff.',
    parameters: { type: 'object', properties: {
      path: { type: 'string', description: 'Assigned repository-relative file path.' },
      summary: { type: 'string', description: 'Brief outcome of the completed review; no praise or low-impact nits.' },
    }, required: ['path', 'summary'], additionalProperties: false },
  },
  {
    name: TOOL_NAMES.completeReviewBatch,
    description:
      'Finish the current review batch. Call exactly once when the batch is complete, with a short summary of what was checked and any observations that were not posted inline.',
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'Short batch summary: what was checked, notable observations, anything that could not be posted.',
        },
        reviewed_files: { type: 'array', items: { type: 'string' }, description: 'Assigned files whose complete diff you read and reviewed.' },
        skipped_files: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, reason: { type: 'string' } }, required: ['file', 'reason'], additionalProperties: false } },
      },
      required: ['summary', 'reviewed_files', 'skipped_files'],
      additionalProperties: false,
    },
  },
];

export const ANSWER_TOOL_SPEC: ToolSpec = {
  name: TOOL_NAMES.answer,
  description:
    'Submit the final review answer. You MUST call this exactly once, at the very end of the review, after all batches are complete. ' +
    'It creates or updates the single marker-owned sticky review summary on the pull request.',
  parameters: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['clean', 'findings', 'partial'],
        description:
          'clean = every eligible file reviewed with no findings. findings = full coverage with at least one finding. partial = coverage or time budget was not fully achieved.',
      },
      summary: {
        type: 'string',
        description:
          'Prose summary of the review: what was reviewed, key findings and their impact, residual risk. Written for human reviewers.',
      },
      reviewed_files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Repository-relative paths of all eligible files that were reviewed.',
      },
      skipped_files: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            file: { type: 'string' },
            reason: { type: 'string' },
          },
          required: ['file', 'reason'],
          additionalProperties: false,
        },
        description: 'Eligible files that could not be reviewed, each with an explicit reason.',
      },
    },
    required: ['status', 'summary', 'reviewed_files', 'skipped_files'],
    additionalProperties: false,
  },
};

/** Tool names available to a batch agent. */
export const BATCH_TOOL_NAMES: string[] = BATCH_TOOL_SPECS.map((t) => t.name);
