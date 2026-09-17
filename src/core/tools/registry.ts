/**
 * Transport-neutral tool registry. Tools are plain objects with a JSON-schema
 * spec and an executor; the runner drives them in tool-calling or
 * structured-output mode. An MCP adapter can be added later without touching
 * the tools themselves.
 */
import type { ToolSpec } from '../llm/client.js';
import type { ToolContext, ToolResult } from '../types.js';

export interface Tool {
  spec: ToolSpec;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): this {
    if (this.tools.has(tool.spec.name)) {
      throw new Error(`duplicate tool registration: ${tool.spec.name}`);
    }
    this.tools.set(tool.spec.name, tool);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  specs(names?: string[]): ToolSpec[] {
    const selected = names ?? this.names();
    return selected
      .map((n) => this.tools.get(n)?.spec)
      .filter((s): s is ToolSpec => s !== undefined);
  }

  validArguments(name: string, args: unknown): boolean {
    const tool = this.tools.get(name);
    return !!tool && matchesSchema(args, tool.spec.parameters);
  }

  /**
   * Execute a tool by name. Unknown tools and executor crashes are reported
   * as ok=false results (never thrown out of the runner loop).
   */
  async execute(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, result: null, error: `unknown tool "${name}"`, protocolError: true };
    }
    if (!this.validArguments(name, args)) return { ok: false, result: null, error: `arguments do not match the schema for "${name}"`, protocolError: true };
    const obj =
      typeof args === 'object' && args !== null && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {};
    try {
      return await ctx.budget.run(async (signal) => {
        const previous = ctx.signal;
        ctx.signal = signal;
        try { return await tool.execute(obj, ctx); }
        finally { ctx.signal = previous; }
      }, false, ctx.signal);
    } catch (err) {
      if ((err as Error).name === 'BudgetExceededError') throw err;
      if (ctx.signal.aborted) throw err;
      ctx.operationalErrors.push({ stage: 'tool', code: 'executor-failed', message: (err as Error).message });
      return {
        ok: false,
        result: null,
        error: `tool executor error: ${(err as Error).message}`,
      };
    }
  }
}

function matchesSchema(value: unknown, schema: Record<string, unknown>): boolean {
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  if (schema.type === 'string') return typeof value === 'string';
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'integer') return typeof value === 'number' && Number.isInteger(value) && (typeof schema.minimum !== 'number' || value >= schema.minimum);
  if (schema.type === 'array') return Array.isArray(value) && value.every((v) => matchesSchema(v, schema.items as Record<string, unknown>));
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const object = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    if (Array.isArray(schema.required) && schema.required.some((key) => typeof key === 'string' && !Object.hasOwn(object, key))) return false;
    return Object.entries(object).every(([key, val]) => Object.hasOwn(properties, key) ? matchesSchema(val, properties[key]!) : schema.additionalProperties !== false);
  }
  return true;
}

/** Validate that args are a plain object. */
export function asArgs(args: unknown): Record<string, unknown> {
  if (typeof args === 'object' && args !== null && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  return {};
}

export function requireString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' ? v : undefined;
}
