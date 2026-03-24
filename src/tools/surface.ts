/**
 * surface — list unresolved signals (contradictions, tensions, gaps).
 */

import type { ToolDefinition } from '../mcp/tools.js';
import { optNum, optStr } from './_helpers.js';

const SIGNALS_COLLECTION = 'signals';

export const surfaceTool: ToolDefinition = {
  name: 'surface',
  description: 'List unresolved signals — contradictions, tensions, and gaps in the knowledge graph.',
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

    const results = await store.query(
      SIGNALS_COLLECTION,
      [{ field: 'resolved', op: '==', value: false }],
      { limit, orderBy: 'priority', orderDir: 'desc' },
    );

    const signals = results.map((doc) => ({
      id: typeof doc['id'] === 'string' ? doc['id'] : '',
      type: typeof doc['type'] === 'string' ? doc['type'] : '',
      description: typeof doc['description'] === 'string' ? doc['description'] : '',
      concept_ids: Array.isArray(doc['concept_ids']) ? doc['concept_ids'] : [],
      priority: typeof doc['priority'] === 'number' ? doc['priority'] : 0,
      created_at: typeof doc['created_at'] === 'string' ? doc['created_at'] : '',
    }));

    return { unresolved_count: signals.length, signals };
  },
};
