/**
 * Model probing: verifies endpoint reachability, model discovery,
 * structured output, reasoning separation, and tool-call behavior.
 * Used by the `doctor` CLI command and by `auto` tool-mode selection.
 */
import {
  OpenAICompatibleClient,
  LLMError,
  parseToolArgs,
  extractJsonObject,
  type ChatRequest,
} from './client.js';
import { applyGenerationPolicy, validateGenerationOptions, type GenerationOptions } from './generation.js';

export interface ProbeResult {
  /** Endpoint reachable and models list served. */
  reachable: boolean;
  /** The requested model id appears in the model list (or chat worked). */
  discovered: boolean;
  /** Native tool calling produced a valid tool call. */
  supportsTools: boolean;
  /** JSON-schema structured output produced a valid object. */
  structuredOk: boolean;
  /**
   * Reasoning separation: when the model emits a normalized reasoning field, the
   * visible content is not contaminated with tool-call JSON.
   */
  reasoningSeparated: boolean | null;
  details: string[];
  fatalError?: string;
}

const PROBE_TOOL = {
  name: 'get_weather',
  description: 'Get the weather for a city.',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string', description: 'City name' } },
    required: ['city'],
    additionalProperties: false,
  },
} as const;

export async function probeModel(client: Pick<OpenAICompatibleClient, 'model' | 'chat' | 'listModels'>, generation: GenerationOptions = {}): Promise<ProbeResult> {
  validateGenerationOptions(generation);
  const details: string[] = [];
  const result: ProbeResult = {
    reachable: false,
    discovered: false,
    supportsTools: false,
    structuredOk: false,
    reasoningSeparated: null,
    details,
  };
  const classifyFailure = (err: unknown) => {
    if ((err as Error).name === 'BudgetExceededError') throw err;
    if (!(err instanceof LLMError) || ![400, 404, 422].includes(err.status ?? 0)) {
      result.fatalError = (err as Error).message;
    }
  };
  const chat = async (request: ChatRequest) => {
    const response = await client.chat(applyGenerationPolicy({ ...request, phase: 'probe' }, generation));
    const leakedTags = /<think>|<\/think>/.test(response.content ?? '');
    if (response.reasoning !== undefined || leakedTags) {
      const leaked = leakedTags || /"tool_calls"/.test(response.content ?? '');
      result.reasoningSeparated = result.reasoningSeparated !== false && !leaked;
    }
    return response;
  };

  // 1. Reachability + model discovery.
  try {
    const models = await client.listModels();
    result.reachable = true;
    result.discovered = models.includes(client.model);
    details.push(
      result.discovered
        ? `listed ${models.length} model(s); "${client.model}" found`
        : `listed ${models.length} model(s); "${client.model}" NOT in list`,
    );
  } catch (err) {
    classifyFailure(err);
    details.push(`model listing failed: ${(err as Error).message}`);
    return result;
  }

  // Check operator overrides independently of tool/schema capability support.
  if (Object.keys(generation).length) {
    try {
      const response = await chat({ messages: [{ role: 'user', content: 'Reply with OK only.' }], temperature: 0 });
      if (response.finishReason === 'length') throw new Error('configured generation probe exhausted its output budget');
      details.push('configured generation settings accepted by the endpoint');
    } catch (err) {
      if ((err as Error).name === 'BudgetExceededError') throw err;
      result.fatalError = 'configured generation request rejected: ' + (err as Error).message;
      details.push(result.fatalError);
      return result;
    }
  }

  // 2. Structured output.
  try {
    const resp = await chat({
      messages: [
        { role: 'user', content: 'Return the JSON object for a person named "Ada" with age 36.' },
      ],
      jsonSchema: {
        name: 'person',
        schema: {
          type: 'object',
          properties: { name: { type: 'string' }, age: { type: 'integer' } },
          required: ['name', 'age'],
          additionalProperties: false,
        },
      },
      temperature: 0,
      maxTokens: 2048,
    });
    const obj = extractJsonObject(resp.content ?? '');
    if (resp.finishReason !== 'length' && obj?.name === 'Ada' && obj.age === 36 && Object.keys(obj).length === 2) {
      result.structuredOk = true;
      details.push('structured output produced a valid JSON object');
    } else {
      details.push('structured output did not match the requested schema/value');
    }
  } catch (err) {
    classifyFailure(err);
    details.push(`structured output failed: ${(err as Error).message}`);
  }
  if (result.fatalError) return result;

  // 3. Tool calling.
  try {
    const resp = await chat({
      messages: [
        {
          role: 'user',
          content: 'What is the weather in Paris? Use the get_weather tool. Do not answer without calling the tool.',
        },
      ],
      tools: [
        {
          name: PROBE_TOOL.name,
          description: PROBE_TOOL.description,
          parameters: { ...PROBE_TOOL.parameters, properties: { city: { type: 'string' } } },
        },
      ],
      temperature: 0,
      toolChoice: { function: { name: PROBE_TOOL.name } },
      maxTokens: 2048,
    });
    const call = resp.toolCalls[0];
    if (resp.finishReason !== 'length' && call && call.name === PROBE_TOOL.name) {
      const args = parseToolArgs(call.arguments);
      if (args?.city === 'Paris' && resp.toolCalls.length === 1) {
        const followup = await chat({
          messages: [
            { role: 'user', content: 'Get the weather in Paris using get_weather; then report the temperature.' },
            { role: 'assistant', content: resp.content, tool_calls: resp.toolCalls },
            { role: 'tool', tool_call_id: call.id, content: '{"city":"Paris","temperature_c":17}' },
          ],
          tools: [{ ...PROBE_TOOL, parameters: { ...PROBE_TOOL.parameters } }],
          toolChoice: 'none',
          temperature: 0,
          maxTokens: 2048,
        });
        result.supportsTools = followup.finishReason !== 'length' && followup.toolCalls.length === 0 && /\b17\b/.test(followup.content ?? '');
        details.push(result.supportsTools ? 'native tool/result/follow-up round trip verified' : 'tool-result follow-up failed');
      } else {
        details.push('tool call arguments did not match the requested city');
      }
    } else {
      details.push(
        'no valid tool call produced',
      );
    }
    // 4. Reasoning separation: judged from whichever response carried reasoning.
    if (result.reasoningSeparated !== null) {
      details.push(
        result.reasoningSeparated
          ? 'normalized reasoning kept separate from content'
          : 'reasoning leaked into content/tool arguments',
      );
    }
  } catch (err) {
    classifyFailure(err);
    details.push(`tool-call probe failed: ${(err as Error).message}`);
  }

  return result;
}

/** Decide the tool mode to use for a review given a probe. */
export function decideToolMode(probe: ProbeResult, requested: 'auto' | 'tools' | 'structured'): {
  mode: 'tools' | 'structured';
  reason: string;
} {
  if (probe.fatalError) throw new Error(`LLM preflight failed: ${probe.fatalError}`);
  if (!probe.reachable || !probe.discovered) throw new Error('LLM endpoint/model discovery failed');
  if (probe.reasoningSeparated === false) throw new Error('LLM reasoning/tool output separation failed');
  if (requested === 'tools') {
    if (!probe.supportsTools) {
      throw new Error('tool_mode=tools requires a verified native tool round trip');
    }
    return { mode: 'tools', reason: 'native tool calling verified' };
  }
  if (requested === 'structured') {
    if (!probe.structuredOk) throw new Error('tool_mode=structured requires verified structured output');
    return {
      mode: 'structured',
      reason: 'structured output verified',
    };
  }
  // auto
  if (probe.supportsTools) return { mode: 'tools', reason: 'native tool calling available' };
  if (probe.structuredOk) return { mode: 'structured', reason: 'verified JSON-schema fallback' };
  throw new Error('model supports neither verified native tools nor structured output');
}
