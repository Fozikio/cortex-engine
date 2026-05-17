/**
 * suggest_tags — suggest tags for content based on semantic similarity.
 *
 * Embeds the input text and finds the nearest concepts in the memory graph,
 * converting their names into tag suggestions.
 */

import type { ToolDefinition, ToolContext } from '../mcp/tools.js';

const MIN_SCORE = 0.6;
const MAX_RESULTS = 10;

export const suggestTagsTool: ToolDefinition = {
  name: 'suggest_tags',
  category: 'graph',
  description: 'Returns suggested tags for a text — the names of memory-graph concepts most semantically similar to the input.',
  whenToUse: 'You want tag suggestions for a piece of content based on existing concepts in the graph.',
  doNotUse: 'You want raw concept matches with phrase positions — use suggest_links.',
  inputSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'Text content to generate tag suggestions for',
      },
      max_tags: {
        type: 'number',
        description: 'Maximum number of tag suggestions (default: 10)',
      },
      namespace: { type: 'string', description: 'Namespace (defaults to default)' },
    },
    required: ['text'],
  },

  async handler(args: Record<string, unknown>, ctx: ToolContext): Promise<Record<string, unknown>> {
    const text = typeof args['text'] === 'string' ? args['text'] : '';
    const maxTags = typeof args['max_tags'] === 'number' ? args['max_tags'] : MAX_RESULTS;
    const namespace = typeof args['namespace'] === 'string' ? args['namespace'] : undefined;

    if (!text) return { error: 'text is required' };

    const store = ctx.namespaces.getStore(namespace);

    // Strip markdown frontmatter if present, limit input size
    const body = text.replace(/^---[\s\S]*?---\n/, '').slice(0, 1500);
    const embedding = await ctx.embed.embed(body);
    const nearest = await store.findNearest(embedding, maxTags);

    const tags = nearest
      .filter((r) => r.score >= MIN_SCORE)
      .map((r) => ({
        tag: r.memory.name.toLowerCase().replace(/\s+/g, '-'),
        concept: r.memory.name,
        score: Math.round(r.score * 100) / 100,
      }));

    return { suggested_tags: tags };
  },
};
