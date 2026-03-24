/**
 * consolidation_status — reports consolidation metrics.
 *
 * Returns the last dream summary, quality trend over recent dreams,
 * and current sleep pressure.
 */

import type { ToolDefinition, ToolContext } from '../mcp/tools.js';

const CONSOLIDATION_HISTORY = 'consolidation_history';
const SYSTEM_COLLECTION = 'system';

export const consolidationStatusTool: ToolDefinition = {
  name: 'consolidation_status',
  description:
    'Read-only: last dream summary, consolidation quality trend (last 7 dreams), and sleep pressure.',
  inputSchema: {
    type: 'object',
    properties: {
      namespace: { type: 'string', description: 'Namespace (defaults to default)' },
    },
  },

  async handler(args: Record<string, unknown>, ctx: ToolContext): Promise<Record<string, unknown>> {
    const namespace = typeof args['namespace'] === 'string' ? args['namespace'] : undefined;
    const store = ctx.namespaces.getStore(namespace);

    // Fetch recent consolidation history
    const history = await store.query(CONSOLIDATION_HISTORY, [], {
      orderBy: 'at',
      orderDir: 'desc',
      limit: 7,
    });

    // Calculate sleep pressure inline
    const unprocessed = await store.getUnprocessedObservations(10000);
    const unconsolidatedCount = unprocessed.length;

    let lastDreamAt: Date | null = null;
    const dreamState = await store.get(SYSTEM_COLLECTION, 'dream_state');
    if (dreamState) {
      const at = dreamState['last_dream_at'];
      if (typeof at === 'string') lastDreamAt = new Date(at);
      else if (at instanceof Date) lastDreamAt = at;
    }
    if (!lastDreamAt && history.length > 0) {
      const at = history[0]['at'];
      if (typeof at === 'string') lastDreamAt = new Date(at);
      else if (at instanceof Date) lastDreamAt = at;
    }

    const hoursSinceDream = lastDreamAt
      ? Math.round(((Date.now() - lastDreamAt.getTime()) / (1000 * 60 * 60)) * 100) / 100
      : null;

    // Parse last dream
    const lastDream =
      history.length > 0
        ? parseDreamEntry(history[0])
        : null;

    // Quality trend
    const qualityTrend = history.map((doc) => {
      const at = doc['at'];
      const atIso = typeof at === 'string' ? at : at instanceof Date ? at.toISOString() : null;
      return {
        at_iso: atIso,
        consolidation_quality: toNumberOrNull(doc['consolidation_quality']),
        integration_rate: toNumberOrNull(doc['integration_rate']),
        total_observations: toNumberOrZero(doc['total_observations']),
        unclustered_count: toNumberOrZero(doc['unclustered_count']),
        duration_ms: toNumberOrZero(doc['duration_ms']),
      };
    });

    return {
      last_dream: lastDream,
      quality_trend: qualityTrend,
      sleep_pressure: {
        unconsolidated_count: unconsolidatedCount,
        last_dream_at_iso: lastDreamAt ? lastDreamAt.toISOString() : null,
        hours_since_dream: hoursSinceDream,
      },
    };
  },
};

function parseDreamEntry(doc: Record<string, unknown>): Record<string, unknown> {
  const at = doc['at'];
  const atIso = typeof at === 'string' ? at : at instanceof Date ? at.toISOString() : null;
  return {
    at_iso: atIso,
    phase1_clustered: toNumberOrZero(doc['phase1_clustered']),
    phase2_refined: toNumberOrZero(doc['phase2_refined']),
    phase3_created: toNumberOrZero(doc['phase3_created']),
    phase4_edges: toNumberOrZero(doc['phase4_edges']),
    phase5_scored: toNumberOrZero(doc['phase5_scored']),
    phase7_abstractions: toNumberOrZero(doc['phase7_abstractions']),
    total_observations: toNumberOrZero(doc['total_observations']),
    unclustered_count: toNumberOrZero(doc['unclustered_count']),
    duration_ms: toNumberOrZero(doc['duration_ms']),
    consolidation_quality: toNumberOrNull(doc['consolidation_quality']),
    integration_rate: toNumberOrNull(doc['integration_rate']),
  };
}

function toNumberOrZero(val: unknown): number {
  return typeof val === 'number' ? val : 0;
}

function toNumberOrNull(val: unknown): number | null {
  return typeof val === 'number' ? val : null;
}
