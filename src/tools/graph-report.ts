/**
 * graph_report — graph connectivity report.
 *
 * Counts edges per concept, finds orphans, reports category breakdown
 * and most/least connected nodes.
 */

import type { ToolDefinition, ToolContext } from '../mcp/tools.js';

const EDGES_COLLECTION = 'edges';

export const graphReportTool: ToolDefinition = {
  name: 'graph_report',
  description:
    'Graph connectivity report — orphaned concepts, most/least connected nodes, memory density by category.',
  inputSchema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        description: 'Filter report to a specific memory category (e.g. "belief", "pattern")',
      },
      namespace: { type: 'string', description: 'Namespace (defaults to default)' },
    },
  },

  async handler(args: Record<string, unknown>, ctx: ToolContext): Promise<Record<string, unknown>> {
    const category = typeof args['category'] === 'string' ? args['category'] : '';
    const namespace = typeof args['namespace'] === 'string' ? args['namespace'] : undefined;

    const store = ctx.namespaces.getStore(namespace);

    // Fetch all edges
    const edges = await store.query(EDGES_COLLECTION, []);
    const edgeCounts = new Map<string, number>();
    for (const edge of edges) {
      const sourceId = typeof edge['source_id'] === 'string' ? edge['source_id'] : '';
      const targetId = typeof edge['target_id'] === 'string' ? edge['target_id'] : '';
      if (sourceId) edgeCounts.set(sourceId, (edgeCounts.get(sourceId) ?? 0) + 1);
      if (targetId) edgeCounts.set(targetId, (edgeCounts.get(targetId) ?? 0) + 1);
    }

    // Fetch all memories
    const memories = await store.getAllMemories();

    const memStats = memories
      .filter((m) => !category || m.category === category)
      .map((m) => ({
        id: m.id,
        name: m.name,
        category: m.category,
        edges: edgeCounts.get(m.id) ?? 0,
        salience: m.salience,
      }));

    const orphans = memStats.filter((m) => m.edges === 0);
    const sorted = [...memStats].sort((a, b) => b.edges - a.edges);

    // Category breakdown
    const byCategory: Record<string, number> = {};
    for (const m of memStats) {
      byCategory[m.category] = (byCategory[m.category] ?? 0) + 1;
    }

    return {
      filter_category: category || 'all',
      total_memories: memStats.length,
      total_edges: edges.length,
      orphaned_concepts: orphans.length,
      orphans: orphans.slice(0, 10).map((o) => ({ id: o.id, name: o.name })),
      most_connected: sorted.slice(0, 5),
      least_connected: sorted.slice(-5).reverse(),
      by_category: byCategory,
    };
  },
};
