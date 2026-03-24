/**
 * query_explain — semantic search over memory with LLM-generated relevance explanations.
 * Performs embedding-based retrieval then explains each result.
 */

import type { ToolDefinition } from '../mcp/tools.js';
import { str, optNum, optStr } from './_helpers.js';

export const queryExplainTool: ToolDefinition = {
  name: 'query_explain',
  description:
    'Semantic search over memory with one-sentence relevance explanations. Returns each result plus a "why" string explaining why that memory is relevant to the query.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The query text' },
      top_k: { type: 'number', description: 'Number of results (default: 5)' },
      namespace: { type: 'string', description: 'Namespace (defaults to default)' },
    },
    required: ['text'],
  },

  async handler(args, ctx) {
    const text = str(args, 'text');
    const topK = optNum(args, 'top_k', 5);
    const namespace = optStr(args, 'namespace');

    const store = ctx.namespaces.getStore(namespace);

    // Embed the query and find nearest memories
    const embedding = await ctx.embed.embed(text);
    const searchResults = await store.findNearest(embedding, topK);

    // Add LLM-generated relevance explanations
    const resultsWithWhy = await Promise.all(
      searchResults.map(async (r) => {
        const prompt = `In one sentence, why is this memory relevant to the query: ${text}? Memory: ${r.memory.name}: ${r.memory.definition ?? ''}.`;
        const why = await ctx.llm.generate(prompt, { temperature: 0.2 });
        return {
          id: r.memory.id,
          name: r.memory.name,
          definition: r.memory.definition,
          category: r.memory.category,
          score: r.score,
          why: why.trim(),
        };
      }),
    );

    return {
      query: text,
      results: resultsWithWhy,
    };
  },
};
