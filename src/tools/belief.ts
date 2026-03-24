/**
 * belief — view belief history for a concept.
 *
 * Returns a chronological list of how a concept's definition
 * has changed over time, with timestamps and reasons.
 */

import type { ToolDefinition } from '../mcp/tools.js';
import { str, optStr } from './_helpers.js';

export const beliefTool: ToolDefinition = {
  name: 'belief',
  description:
    "View the history of how a concept's definition has changed over time. Returns a chronological list of past definitions with timestamps and reasons. Use to understand how a belief evolved. Use believe() to record a new belief change.",
  inputSchema: {
    type: 'object',
    properties: {
      concept_id: { type: 'string', description: 'Memory/concept ID to trace' },
      namespace: { type: 'string', description: 'Namespace (defaults to default namespace)' },
    },
    required: ['concept_id'],
  },

  async handler(args, ctx) {
    const conceptId = str(args, 'concept_id');
    const namespace = optStr(args, 'namespace');
    const store = ctx.namespaces.getStore(namespace);

    // Get the current concept
    const memory = await store.getMemory(conceptId);

    // Get the belief history
    const history = await store.getBeliefHistory(conceptId);

    const formattedHistory = history.map((entry) => ({
      changed_at: entry.changed_at instanceof Date
        ? entry.changed_at.toISOString()
        : String(entry.changed_at),
      old_definition: entry.old_definition,
      new_definition: entry.new_definition,
      reason: entry.reason,
    }));

    return {
      concept_id: conceptId,
      name: memory?.name ?? 'Unknown',
      current_definition: memory?.definition ?? null,
      salience: memory?.salience ?? null,
      access_count: memory?.access_count ?? 0,
      history_count: formattedHistory.length,
      history: formattedHistory,
      namespace: namespace ?? ctx.namespaces.getDefaultNamespace(),
    };
  },
};
