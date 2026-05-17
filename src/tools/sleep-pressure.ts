/**
 * sleep_pressure — calculate consolidation pressure.
 *
 * Reports unconsolidated observation count, last dream time,
 * and hours since last dream. Useful for deciding whether to
 * trigger a dream consolidation run.
 */

import type { ToolDefinition, ToolContext } from '../mcp/tools.js';

const CONSOLIDATION_HISTORY = 'consolidation_history';
const SYSTEM_COLLECTION = 'system';

export const sleepPressureTool: ToolDefinition = {
  name: 'sleep_pressure',
  category: 'maintenance',
  description: 'Returns unconsolidated observation count, last dream timestamp, and hours since the last dream — read-only signal of whether consolidation is overdue.',
  whenToUse: 'You are deciding whether to run dream() based on accumulated unprocessed observations.',
  doNotUse: 'You want a full consolidation health summary — use consolidation_status.',
  inputSchema: {
    type: 'object',
    properties: {
      namespace: { type: 'string', description: 'Namespace (defaults to default)' },
    },
  },

  async handler(args: Record<string, unknown>, ctx: ToolContext): Promise<Record<string, unknown>> {
    const namespace = typeof args['namespace'] === 'string' ? args['namespace'] : undefined;
    const store = ctx.namespaces.getStore(namespace);

    // Count unprocessed observations
    const unprocessed = await store.getUnprocessedObservations(10000);
    const unconsolidatedCount = unprocessed.length;

    // Try to get last dream time from system state
    let lastDreamAt: Date | null = null;

    const dreamState = await store.get(SYSTEM_COLLECTION, 'dream_state');
    if (dreamState) {
      const at = dreamState['last_dream_at'];
      if (typeof at === 'string') lastDreamAt = new Date(at);
      else if (at instanceof Date) lastDreamAt = at;
    }

    // Fallback: check consolidation_history
    if (!lastDreamAt) {
      const history = await store.query(CONSOLIDATION_HISTORY, [], {
        orderBy: 'at',
        orderDir: 'desc',
        limit: 1,
      });
      if (history.length > 0) {
        const at = history[0]['at'];
        if (typeof at === 'string') lastDreamAt = new Date(at);
        else if (at instanceof Date) lastDreamAt = at;
      }
    }

    const lastDreamAtIso = lastDreamAt ? lastDreamAt.toISOString() : null;
    const now = Date.now();
    const hoursSinceDream = lastDreamAt
      ? Math.round(((now - lastDreamAt.getTime()) / (1000 * 60 * 60)) * 100) / 100
      : null;

    return {
      unconsolidated_count: unconsolidatedCount,
      last_dream_at_iso: lastDreamAtIso,
      hours_since_dream: hoursSinceDream,
    };
  },
};
