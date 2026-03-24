/**
 * retrieve — direct retrieval by ID or semantic search.
 *
 * Simplified retrieval tool that fetches a memory by ID or performs
 * a semantic search when given text. Unlike the original router-based
 * retrieve, this is a straightforward store operation.
 */

import type { ToolDefinition, ToolContext } from '../mcp/tools.js';

export const retrieveTool: ToolDefinition = {
  name: 'retrieve',
  description:
    'Direct retrieval — fetch a memory by ID, or perform semantic search with text. Returns matching memories with scores.',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Direct memory ID to retrieve',
      },
      text: {
        type: 'string',
        description: 'Text to search for semantically',
      },
      top_k: {
        type: 'number',
        description: 'Max results for semantic search (default: 5)',
      },
      namespace: { type: 'string', description: 'Namespace (defaults to default)' },
    },
  },

  async handler(args: Record<string, unknown>, ctx: ToolContext): Promise<Record<string, unknown>> {
    const id = typeof args['id'] === 'string' ? args['id'] : '';
    const text = typeof args['text'] === 'string' ? args['text'] : '';
    const topK = typeof args['top_k'] === 'number' ? args['top_k'] : 5;
    const namespace = typeof args['namespace'] === 'string' ? args['namespace'] : undefined;

    if (!id && !text) return { error: 'Provide either id or text' };

    const store = ctx.namespaces.getStore(namespace);

    // Direct ID lookup
    if (id) {
      const memory = await store.getMemory(id);
      if (!memory) return { error: `Memory not found: ${id}` };
      return {
        id: memory.id,
        name: memory.name,
        definition: memory.definition,
        category: memory.category,
        salience: memory.salience,
        confidence: memory.confidence,
        tags: memory.tags,
        access_count: memory.access_count,
        updated_at: memory.updated_at.toISOString(),
      };
    }

    // Semantic search
    const embedding = await ctx.embed.embed(text);
    const results = await store.findNearest(embedding, topK);

    return {
      query: text,
      results: results.map((r) => ({
        id: r.memory.id,
        name: r.memory.name,
        definition: r.memory.definition,
        category: r.memory.category,
        salience: r.memory.salience,
        score: Math.round(r.score * 1000) / 1000,
      })),
    };
  },
};
