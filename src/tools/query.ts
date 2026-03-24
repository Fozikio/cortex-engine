/**
 * query — search memories by meaning with HyDE expansion and spread activation.
 */

import type { ToolDefinition } from '../mcp/tools.js';
import type { CortexStore } from '../core/store.js';
import {
  hydeExpand,
  spreadActivation,
} from '../engines/memory.js';
import { retrievability, elapsedDaysSince } from '../engines/fsrs.js';
import { str, optStr, optNum, optBool, fireTriggers, fireBridges } from './_helpers.js';

export const queryTool: ToolDefinition = {
  name: 'query',
  description: 'Search your memories by meaning. Returns the most relevant stored knowledge for a given topic or question. Use before writing new observations to avoid duplicates.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'What to search for — a topic, question, or concept' },
      namespace: { type: 'string', description: 'Memory namespace to search (defaults to default)' },
      limit: { type: 'number', description: 'Max results (default: 5)' },
      hyde: { type: 'boolean', description: 'Expand query for better conceptual matches (default: true)' },
      min_score: { type: 'number', description: 'Minimum similarity score threshold (default: 0.3). Results below this are dropped.' },
      category: { type: 'string', description: 'Filter results to a specific category (belief, pattern, entity, topic, value, project, insight, observation)' },
    },
    required: ['text'],
  },
  async handler(args, ctx) {
    const text = str(args, 'text');
    const namespace = optStr(args, 'namespace');
    const limit = optNum(args, 'limit', 5);
    const useHyde = optBool(args, 'hyde', true);
    const minScore = optNum(args, 'min_score', 0.3);
    const categoryFilter = optStr(args, 'category');

    const store: CortexStore = ctx.namespaces.getStore(namespace);

    // Embed query — with HyDE expansion if enabled
    let queryEmbedding: number[];
    if (useHyde) {
      queryEmbedding = await hydeExpand(text, ctx.llm, ctx.embed);
    } else {
      queryEmbedding = await ctx.embed.embed(text);
    }

    // Find nearest memories (fetch extra to allow for filtering)
    const fetchLimit = Math.max(limit * 3, 15);
    const nearest = await store.findNearest(queryEmbedding, fetchLimit);

    // Spread activation for richer results — pass query embedding for query-conditioned BFS
    const activated = await spreadActivation(store, nearest, queryEmbedding);

    // Score retrievability, apply composite ranking, filter, and touch accessed memories
    const now = new Date();
    const scored = await Promise.all(
      activated.map(async (r) => {
        const memory = await store.getMemory(r.memory.id);
        const daysSince = memory?.fsrs.last_review
          ? elapsedDaysSince(memory.fsrs.last_review)
          : 0;
        const ret = memory
          ? retrievability(memory.fsrs.stability, daysSince)
          : r.score;

        // Composite score: similarity * retrievability * salience factor
        // Salience is 0-1, boost it so mid-salience memories aren't penalized too hard
        const salienceFactor = 0.5 + (r.memory.salience * 0.5); // maps 0-1 → 0.5-1.0
        const compositeScore = r.score * ret * salienceFactor;

        return {
          id: r.memory.id,
          name: r.memory.name,
          definition: r.memory.definition,
          category: r.memory.category,
          salience: r.memory.salience,
          confidence: r.memory.confidence,
          score: r.score,
          composite_score: compositeScore,
          hop_count: r.hop_count,
          retrievability: ret,
          last_accessed: now.toISOString(),
          provenance: r.memory.provenance,
        };
      })
    );

    // Filter by min_score, category, then sort by composite score
    const filtered = scored
      .filter(r => r.score >= minScore)
      .filter(r => !categoryFilter || r.category === categoryFilter)
      .sort((a, b) => b.composite_score - a.composite_score)
      .slice(0, limit);

    // Touch accessed memories and store retrieval metadata
    await Promise.all(filtered.map(async (r) => {
      await store.touchMemory(r.id, {});
      await store.updateMemory(r.id, {
        last_retrieval_score: r.score,
        last_hop_count: r.hop_count,
      });
    }));

    // Fire triggers and bridges after query
    const resolvedNs = namespace ?? ctx.namespaces.getDefaultNamespace();
    await fireTriggers(ctx, resolvedNs, 'query', text, { query: text, result_count: filtered.length }, ctx.allTools);
    await fireBridges(ctx, resolvedNs, 'query', { query: text, result_count: filtered.length }, ctx.allTools);

    return {
      query: text,
      hyde_used: useHyde,
      namespace: resolvedNs,
      count: filtered.length,
      results: filtered,
    };
  },
};
