/**
 * journal_read — read journal entries by date or last N days.
 */

import type { ToolDefinition, ToolContext } from '../mcp/tools.js';

const COLLECTION = 'journals';

export const journalReadTool: ToolDefinition = {
  name: 'journal_read',
  description: 'Read journal entries. Fetch a specific date or the last N days.',
  inputSchema: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD, defaults to today' },
      days: { type: 'number', description: 'Read last N days instead of a specific date' },
      namespace: { type: 'string', description: 'Namespace (defaults to default)' },
    },
    required: [],
  },

  async handler(args: Record<string, unknown>, ctx: ToolContext): Promise<Record<string, unknown>> {
    const namespace = typeof args['namespace'] === 'string' ? args['namespace'] : undefined;
    const store = ctx.namespaces.getStore(namespace);

    // Multi-day query
    if (typeof args['days'] === 'number' && args['days'] > 0) {
      const days = args['days'];
      const results = await store.query(COLLECTION, [], {
        orderBy: 'date',
        orderDir: 'desc',
        limit: days,
      });

      const entries = results.map((doc: Record<string, unknown>) => ({
        id: doc['id'] ?? null,
        date: doc['date'] ?? null,
        entry: doc['entry'] ?? null,
        theme: doc['theme'] ?? null,
        mood: doc['mood'] ?? null,
        evolutions_proposed: doc['evolutions_proposed'] ?? [],
        created_at: doc['created_at'] ?? null,
        updated_at: doc['updated_at'] ?? null,
      }));

      return { count: entries.length, entries };
    }

    // Single date lookup
    const date = typeof args['date'] === 'string' ? args['date'] : new Date().toISOString().slice(0, 10);
    const doc = await store.get(COLLECTION, date);

    if (!doc) {
      return { found: false, date, entry: null };
    }

    return {
      found: true,
      id: doc['id'] ?? date,
      date: doc['date'] ?? date,
      entry: doc['entry'] ?? null,
      theme: doc['theme'] ?? null,
      mood: doc['mood'] ?? null,
      evolutions_proposed: doc['evolutions_proposed'] ?? [],
      created_at: doc['created_at'] ?? null,
      updated_at: doc['updated_at'] ?? null,
    };
  },
};
