/**
 * resolve — mark a signal as resolved with an optional note.
 */

import type { ToolDefinition } from '../mcp/tools.js';
import { str, optStr } from './_helpers.js';

const SIGNALS_COLLECTION = 'signals';

export const resolveTool: ToolDefinition = {
  name: 'resolve',
  description: 'Mark a signal as resolved with an optional note explaining how it was addressed.',
  inputSchema: {
    type: 'object',
    properties: {
      signal_id: { type: 'string', description: 'Signal document ID' },
      note: { type: 'string', description: 'How the signal was resolved' },
      namespace: { type: 'string', description: 'Namespace (defaults to default)' },
    },
    required: ['signal_id'],
  },

  async handler(args, ctx) {
    const signalId = str(args, 'signal_id');
    const note = optStr(args, 'note') ?? '';
    const namespace = optStr(args, 'namespace');

    const store = ctx.namespaces.getStore(namespace);

    const doc = await store.get(SIGNALS_COLLECTION, signalId);
    if (!doc) {
      return { error: `Signal ${signalId} not found` };
    }

    const now = new Date().toISOString();
    await store.update(SIGNALS_COLLECTION, signalId, {
      resolved: true,
      resolution_note: note,
      resolved_at: now,
    });

    return { action: 'resolved', signal_id: signalId, note };
  },
};
