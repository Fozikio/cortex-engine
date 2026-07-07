/**
 * resolve — mark a signal as resolved with an optional note.
 */

import type { ToolDefinition } from '../mcp/tools.js';
import { str, optStr } from './_helpers.js';

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

    const signal = await store.getSignal(signalId);
    if (!signal) {
      return { error: `Signal ${signalId} not found` };
    }

    await store.updateSignal(signalId, {
      resolved: true,
      resolution_note: note,
      resolved_at: new Date(),
    });

    // The tool contract is "returns the updated signal" — read it back so
    // callers see the post-resolution state.
    const updated = await store.getSignal(signalId);

    return {
      action: 'resolved',
      signal_id: signalId,
      note,
      signal: updated
        ? {
            id: updated.id,
            type: updated.type,
            description: updated.description,
            concept_ids: updated.concept_ids,
            priority: updated.priority,
            resolved: updated.resolved,
            resolution_note: updated.resolution_note,
            created_at: updated.created_at.toISOString(),
            resolved_at: updated.resolved_at?.toISOString() ?? null,
            observation_id: updated.observation_id,
          }
        : null,
    };
  },
};
