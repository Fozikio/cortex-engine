/**
 * wander — information-gain-weighted walk through memories.
 *
 * Prefers under-explored, uncertain, goal-adjacent, and stale nodes
 * while preserving serendipity.
 */

import type { ToolDefinition, ToolContext } from '../mcp/tools.js';
import type { Memory } from '../core/types.js';
import { optStr, optNum, epistemicScore } from './_helpers.js';
import { memoryToSummary } from '../engines/memory.js';

export const wanderTool: ToolDefinition = {
  name: 'wander',
  description:
    'Take an information-gain-weighted walk through your memories. ' +
    'Prefers under-explored, uncertain, goal-adjacent, and stale nodes while ' +
    'preserving serendipity. Use when you want inspiration or to surface what ' +
    'deserves more attention.',
  inputSchema: {
    type: 'object',
    properties: {
      namespace: { type: 'string', description: 'Namespace to wander in (defaults to default namespace)' },
      steps: { type: 'number', description: 'Number of hops to take (default: 3)' },
    },
  },
  async handler(args: Record<string, unknown>, ctx: ToolContext) {
    const namespace = optStr(args, 'namespace');
    const steps = optNum(args, 'steps', 3);

    const store = ctx.namespaces.getStore(namespace);

    // Get all memories
    const allMemories = await store.getAllMemories();
    if (allMemories.length === 0) {
      return { namespace: namespace ?? ctx.namespaces.getDefaultNamespace(), path: [], message: 'No memories to wander through' };
    }

    // Epistemic seed selection: pick from top candidates by info-gain score
    const scoredAll = allMemories.map(m => ({ memory: m, score: epistemicScore(m) }));
    scoredAll.sort((a, b) => b.score - a.score);
    // Weighted-random pick from top 10 to preserve serendipity
    const seedPool = scoredAll.slice(0, Math.min(10, scoredAll.length));
    const totalSeedWeight = seedPool.reduce((s, c) => s + c.score, 0);
    let seedRand = Math.random() * totalSeedWeight;
    let seedMemory = seedPool[0].memory;
    for (const candidate of seedPool) {
      seedRand -= candidate.score;
      if (seedRand <= 0) { seedMemory = candidate.memory; break; }
    }

    const path: Array<{ step: number; memory: ReturnType<typeof memoryToSummary>; relation?: string; epistemic_score?: number }> = [
      { step: 0, memory: memoryToSummary(seedMemory), epistemic_score: epistemicScore(seedMemory) },
    ];

    let currentId = seedMemory.id;
    const visited = new Set<string>([seedMemory.id]);

    for (let step = 1; step <= steps; step++) {
      const edges = await store.getEdgesFrom(currentId);
      if (edges.length === 0) break;

      // Resolve neighbor memories and score by epistemic value
      const candidates: Array<{ memory: Memory; edge: typeof edges[0]; score: number }> = [];
      for (const edge of edges) {
        if (visited.has(edge.target_id)) continue;
        const neighbor = await store.getMemory(edge.target_id);
        if (!neighbor) continue;
        // Combine edge weight with epistemic score so well-connected AND
        // high-information-gain nodes are preferred
        const score = edge.weight * 0.4 + epistemicScore(neighbor) * 0.6;
        candidates.push({ memory: neighbor, edge, score });
      }

      if (candidates.length === 0) break;

      // Weighted-random selection to preserve serendipity
      const totalWeight = candidates.reduce((s, c) => s + c.score, 0);
      let rand = Math.random() * totalWeight;
      let chosen = candidates[0];
      for (const candidate of candidates) {
        rand -= candidate.score;
        if (rand <= 0) { chosen = candidate; break; }
      }

      path.push({
        step,
        memory: memoryToSummary(chosen.memory),
        relation: chosen.edge.relation,
        epistemic_score: parseFloat(chosen.score.toFixed(3)),
      });

      visited.add(chosen.memory.id);
      currentId = chosen.memory.id;
    }

    return {
      namespace: namespace ?? ctx.namespaces.getDefaultNamespace(),
      seed_id: seedMemory.id,
      steps_taken: path.length - 1,
      path,
    };
  },
};
