/**
 * journal_write — create or update a reflective journal entry by date.
 */

import type { ToolDefinition, ToolContext } from '../mcp/tools.js';

const COLLECTION = 'journals';

export const journalWriteTool: ToolDefinition = {
  name: 'journal_write',
  description: 'Write or update a reflective journal entry. Uses date as document ID. Creates if new, updates if existing.',
  inputSchema: {
    type: 'object',
    properties: {
      entry: { type: 'string', description: 'The reflection text' },
      theme: { type: 'string', description: 'What the day was about' },
      mood: { type: 'string', description: 'How the day felt' },
      date: { type: 'string', description: 'YYYY-MM-DD, defaults to today' },
      evolution_id: { type: 'string', description: 'ID of an evolution proposed today to link' },
      namespace: { type: 'string', description: 'Namespace (defaults to default)' },
    },
    required: ['entry'],
  },

  async handler(args: Record<string, unknown>, ctx: ToolContext): Promise<Record<string, unknown>> {
    const entry = typeof args['entry'] === 'string' ? args['entry'] : '';
    if (!entry) return { error: 'entry is required' };

    const date = typeof args['date'] === 'string' ? args['date'] : new Date().toISOString().slice(0, 10);
    const theme = typeof args['theme'] === 'string' ? args['theme'] : undefined;
    const mood = typeof args['mood'] === 'string' ? args['mood'] : undefined;
    const evolutionId = typeof args['evolution_id'] === 'string' ? args['evolution_id'] : undefined;
    const namespace = typeof args['namespace'] === 'string' ? args['namespace'] : undefined;

    const store = ctx.namespaces.getStore(namespace);
    const now = new Date().toISOString();

    // Try to read existing entry by date (date is used as doc ID)
    const existing = await store.get(COLLECTION, date);

    if (!existing) {
      // Create new journal entry
      const doc: Record<string, unknown> = {
        id: date,
        date,
        entry,
        evolutions_proposed: evolutionId ? [evolutionId] : [],
        created_at: now,
        updated_at: now,
      };
      if (theme !== undefined) doc['theme'] = theme;
      if (mood !== undefined) doc['mood'] = mood;

      await store.put(COLLECTION, doc);
      return { date, action: 'created' };
    }

    // Update existing entry
    const updates: Record<string, unknown> = {
      entry,
      updated_at: now,
    };

    if (theme !== undefined) updates['theme'] = theme;
    if (mood !== undefined) updates['mood'] = mood;
    if (evolutionId) {
      const existingEvolutions = Array.isArray(existing['evolutions_proposed'])
        ? existing['evolutions_proposed'] as string[]
        : [];
      if (!existingEvolutions.includes(evolutionId)) {
        updates['evolutions_proposed'] = [...existingEvolutions, evolutionId];
      }
    }

    await store.update(COLLECTION, date, updates);
    return { date, action: 'updated' };
  },
};
