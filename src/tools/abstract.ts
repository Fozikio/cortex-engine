/**
 * abstract — propose a higher-level concept that subsumes 2-10 memories.
 * Does not create the memory; returns the proposal only.
 */

import type { ToolDefinition } from '../mcp/tools.js';
import { optStr } from './_helpers.js';

const MEMORIES_COLLECTION = 'memories';

export const abstractTool: ToolDefinition = {
  name: 'abstract',
  description:
    'Propose a single higher-level concept (name and definition) that subsumes the given 2-10 memories. Does not write to the graph; returns the proposal only.',
  inputSchema: {
    type: 'object',
    properties: {
      memory_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of 2-10 memory document IDs',
      },
      namespace: { type: 'string', description: 'Namespace (defaults to default)' },
    },
    required: ['memory_ids'],
  },

  async handler(args, ctx) {
    const raw = args['memory_ids'];
    const memoryIds = Array.isArray(raw)
      ? (raw as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];

    if (memoryIds.length < 2 || memoryIds.length > 10) {
      return { error: 'memory_ids must be an array of 2-10 memory document IDs.' };
    }

    const namespace = optStr(args, 'namespace');
    const store = ctx.namespaces.getStore(namespace);

    const memories: Array<{ name: string; definition: string }> = [];

    for (const id of memoryIds) {
      const doc = await store.get(MEMORIES_COLLECTION, id);
      if (!doc) {
        return { error: `Memory ${id} not found` };
      }
      memories.push({
        name: typeof doc['name'] === 'string' ? doc['name'] : '',
        definition: typeof doc['definition'] === 'string' ? doc['definition'] : '',
      });
    }

    const formatted = memories
      .map((m, i) => `[${i + 1}] "${m.name}": ${m.definition}`)
      .join('\n\n');

    const prompt = `You are finding a higher-level concept that subsumes these ${memories.length} specific concepts.\n\nConcepts:\n${formatted}\n\nPropose ONE abstract concept (name and definition) that meaningfully generalizes or unifies them. Respond with JSON: {"name": "<short name>", "definition": "<2-3 sentence definition>"}`;

    const parsed = await ctx.llm.generateJSON<{ name: string; definition: string }>(prompt, {
      temperature: 0.3,
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          definition: { type: 'string' },
        },
        required: ['name', 'definition'],
      },
    });

    if (!parsed.name || !parsed.definition) {
      return { error: 'LLM did not return valid name and definition' };
    }

    return { proposed_name: parsed.name, proposed_definition: parsed.definition };
  },
};
