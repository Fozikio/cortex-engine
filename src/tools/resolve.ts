/**
 * resolve — mark a signal as resolved with an optional note.
 */

import type { ToolDefinition } from '../mcp/tools.js';
import { str, optStr } from './_helpers.js';

const SIGNALS_COLLECTION = 'signals';

export const resolveTool: ToolDefinition = {
  name: 'resolve',
  category: 'meta',
  description: 'Marks an open signal (contradiction, tension, gap) as resolved with an optional note describing how. Returns the updated signal.',
  whenToUse: 'You addressed something surfaced earlier and want to clear it from the open queue.',
  doNotUse: 'You want to record a new contradiction — use contradict. You want to see open signals — use surface.',
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
