/**
 * neighbors — explore memories connected to a specific memory via knowledge graph edges.
 */

import type { ToolDefinition } from '../mcp/tools.js';
import { memoryToSummary } from '../engines/memory.js';
import { str, optStr, optNum } from './_helpers.js';

export const neighborsTool: ToolDefinition = {
  name: 'neighbors',
  description: 'Explore memories connected to a specific memory. Shows related concepts linked by edges in the knowledge graph. Use after query() to explore around a result.',
  inputSchema: {
    type: 'object',
    properties: {
      memory_id: { type: 'string', description: 'ID of the memory to start from' },
      namespace: { type: 'string', description: 'Namespace to search in (defaults to default namespace)' },
      depth: { type: 'number', description: 'Graph traversal depth (default: 1)' },
    },
    required: ['memory_id'],
  },
  async handler(args, ctx) {
    const memoryId = str(args, 'memory_id');
    const namespace = optStr(args, 'namespace');
    const depth = optNum(args, 'depth', 1);

    const store = ctx.namespaces.getStore(namespace);

    // Get the seed memory
    const seed = await store.getMemory(memoryId);
    if (!seed) {
      return { error: `Memory not found: ${memoryId}`, memory_id: memoryId };
    }

    // Traverse edges layer by layer up to depth
    const visited = new Set<string>([memoryId]);
    const layers: Array<{ depth: number; memory: ReturnType<typeof memoryToSummary>; edges: unknown[] }> = [
      { depth: 0, memory: memoryToSummary(seed), edges: [] },
    ];

    let frontier = [memoryId];
    for (let d = 0; d < depth; d++) {
      const edges = await store.getEdgesForMemories(frontier);
      const nextFrontier: string[] = [];

      for (const edge of edges) {
        const targetId = edge.source_id === frontier.find(id => id === edge.source_id)
          ? edge.target_id
          : edge.source_id;

        if (visited.has(targetId)) continue;
        visited.add(targetId);

        const neighbor = await store.getMemory(targetId);
        if (!neighbor) continue;

        layers.push({
          depth: d + 1,
          memory: memoryToSummary(neighbor),
          edges: edges
            .filter(e => e.source_id === memoryId || e.target_id === memoryId)
            .map(e => ({ relation: e.relation, weight: e.weight, evidence: e.evidence })),
        });
        nextFrontier.push(targetId);
      }

      frontier = nextFrontier;
      if (frontier.length === 0) break;
    }

    return {
      seed_id: memoryId,
      namespace: namespace ?? ctx.namespaces.getDefaultNamespace(),
      depth,
      node_count: layers.length,
      nodes: layers,
    };
  },
};
