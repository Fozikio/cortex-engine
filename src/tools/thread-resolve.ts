/**
 * thread_resolve — resolve a thread with a resolution note.
 */

import type { ToolDefinition, ToolContext } from '../mcp/tools.js';

const COLLECTION = 'threads';

export const threadResolveTool: ToolDefinition = {
  name: 'thread_resolve',
  category: 'threads',
  description: 'Marks a thread resolved with a final note describing how/why it closed. Returns the resolved thread.',
  whenToUse: 'The question or exploration this thread tracked has reached a conclusion.',
  doNotUse: 'The thread is still active and you just need to log progress — use thread_update.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Thread ID' },
      resolution: { type: 'string', description: 'How/why it was resolved' },
      namespace: { type: 'string', description: 'Namespace (defaults to default)' },
    },
    required: ['id', 'resolution'],
  },

  async handler(args: Record<string, unknown>, ctx: ToolContext): Promise<Record<string, unknown>> {
    const id = typeof args['id'] === 'string' ? args['id'] : '';
    const resolution = typeof args['resolution'] === 'string' ? args['resolution'] : '';
    if (!id) return { error: 'id is required' };
    if (!resolution) return { error: 'resolution is required' };

    const namespace = typeof args['namespace'] === 'string' ? args['namespace'] : undefined;
    const store = ctx.namespaces.getStore(namespace);

    const existing = await store.get(COLLECTION, id);
    if (!existing) return { error: `Thread not found: ${id}` };

    const now = new Date().toISOString();
    const existingUpdates = Array.isArray(existing['updates']) ? existing['updates'] as Record<string, unknown>[] : [];
    const resolveEntry = { timestamp: now, content: `Resolved: ${resolution}` };

    await store.update(COLLECTION, id, {
      status: 'resolved',
      resolved_at: now,
      resolution,
      updated_at: now,
      updates: [...existingUpdates, resolveEntry],
    });

    return { id, status: 'resolved', resolution };
  },
};
