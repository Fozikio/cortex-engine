/**
 * notice — fast-path observation without embedding.
 * Stored immediately; embedded when dream consolidation promotes it.
 */

import type { ToolDefinition } from '../mcp/tools.js';
import type { MemoryCategory } from '../core/types.js';
import { ALL_MEMORY_CATEGORIES } from '../core/types.js';
import { str, optStr, optNum, optStrArray } from './_helpers.js';

export const noticeTool: ToolDefinition = {
  name: 'notice',
  category: 'meta',
  description: 'Stores an observation without embedding for low-latency logging — embedding happens when dream consolidation promotes it. Returns the new observation id.',
  whenToUse: 'You want to log a quick observation without paying embedding cost in the hot path.',
  doNotUse: 'You want the observation searchable immediately — use observe.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The observation text' },
      file: { type: 'string', description: 'Source file path' },
      salience: { type: 'number', description: 'Importance 0.0-1.0 (default: 0.3)' },
      namespace: { type: 'string', description: 'Namespace (defaults to default)' },
      name: { type: 'string', description: 'Memory name/label, used verbatim instead of deriving one when this observation is later promoted' },
      category: { type: 'string', enum: [...ALL_MEMORY_CATEGORIES], description: 'Memory category, used verbatim instead of inferring one when this observation is later promoted' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Memory tags, used verbatim instead of keyword-derived tags when this observation is later promoted' },
    },
    required: ['text'],
  },

  async handler(args, ctx) {
    const text = str(args, 'text');
    const file = optStr(args, 'file') ?? 'unknown';
    const salience = optNum(args, 'salience', 0.3);
    const namespace = optStr(args, 'namespace');
    const name = optStr(args, 'name');
    const tags = optStrArray(args, 'tags');
    const rawCategory = optStr(args, 'category');
    if (rawCategory !== undefined && !ALL_MEMORY_CATEGORIES.includes(rawCategory as MemoryCategory)) {
      return { error: `Unknown category "${rawCategory}" — must be one of: ${ALL_MEMORY_CATEGORIES.join(', ')}` };
    }
    const category = rawCategory as MemoryCategory | undefined;

    const store = ctx.namespaces.getStore(namespace);
    const now = new Date();

    // Typed write (#123): one observations table, so recall/contradict and
    // dream consolidation see noticed rows the same as observe'd ones.
    const id = await store.putObservation({
      content: text,
      source_file: file,
      source_section: '',
      salience,
      processed: false,
      prediction_error: null,
      created_at: now,
      updated_at: now,
      embedding: null,
      keywords: [],
      name,
      category,
      tags,
    });

    return { action: 'noticed', observation_id: id };
  },
};
