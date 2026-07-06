/**
 * surface — list unresolved signals (contradictions, tensions, gaps).
 */

import type { ToolDefinition } from '../mcp/tools.js';
import { optNum, optStr } from './_helpers.js';

export const surfaceTool: ToolDefinition = {
  name: 'surface',
  category: 'meta',
  description: 'Returns unresolved cognitive signals — contradictions, tensions, gaps — that the graph has flagged for attention.',
  whenToUse: 'You want to see what the agent has open and unaddressed in its understanding.',
  doNotUse: 'You want to close one out — use resolve. You want to record a new tension — use contradict.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Max signals to return (default: 20)' },
      namespace: { type: 'string', description: 'Namespace (defaults to default)' },
    },
  },

  async handler(args, ctx) {
    const limit = optNum(args, 'limit', 20);
    const namespace = optStr(args, 'namespace');
    const store = ctx.namespaces.getStore(namespace);

    const results = await store.getSignals({ resolved: false, limit });

    const signals = results.map((signal) => ({
      id: signal.id,
      type: signal.type,
      description: signal.description,
      concept_ids: signal.concept_ids,
      priority: signal.priority,
      created_at: signal.created_at.toISOString(),
    }));

    return { unresolved_count: signals.length, signals };
  },
};
