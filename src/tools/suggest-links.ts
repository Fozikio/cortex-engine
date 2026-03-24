/**
 * suggest_links — find potential links between a text and known concepts.
 *
 * Takes a text input, extracts candidate phrases, embeds them, and finds
 * matching concepts in the memory graph. Returns suggestions for links
 * that could strengthen the graph.
 */

import type { ToolDefinition, ToolContext } from '../mcp/tools.js';

const MATCH_THRESHOLD = 0.75;
const MAX_CANDIDATES = 30;

export const suggestLinksTool: ToolDefinition = {
  name: 'suggest_links',
  description:
    'Scan a text for phrases that match known concepts in the memory graph. Returns link suggestions with similarity scores.',
  inputSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'Text content to scan for linkable concepts',
      },
      threshold: {
        type: 'number',
        description: 'Minimum similarity threshold 0-1 (default: 0.75)',
      },
      namespace: { type: 'string', description: 'Namespace (defaults to default)' },
    },
    required: ['text'],
  },

  async handler(args: Record<string, unknown>, ctx: ToolContext): Promise<Record<string, unknown>> {
    const text = typeof args['text'] === 'string' ? args['text'] : '';
    const threshold = typeof args['threshold'] === 'number' ? args['threshold'] : MATCH_THRESHOLD;
    const namespace = typeof args['namespace'] === 'string' ? args['namespace'] : undefined;

    if (!text) return { error: 'text is required' };

    const store = ctx.namespaces.getStore(namespace);

    // Extract candidate phrases: capitalized words and short 2-word phrases
    const words = text.replace(/[#>\[\]|`]/g, ' ').split(/\s+/).filter(Boolean);
    const candidates = new Set<string>();

    for (let i = 0; i < words.length; i++) {
      // Single capitalized words (likely proper nouns/concepts)
      if (/^[A-Z][a-z]{2,}/.test(words[i])) {
        candidates.add(words[i].replace(/[^a-zA-Z]/g, ''));
      }
      // 2-word phrases
      if (i + 1 < words.length) {
        const phrase = `${words[i]} ${words[i + 1]}`.replace(/[^a-zA-Z ]/g, '').trim();
        if (phrase.length > 5) candidates.add(phrase);
      }
    }

    const suggestions: Array<{
      phrase: string;
      concept: string;
      concept_id: string;
      score: number;
    }> = [];

    const candidateList = Array.from(candidates).slice(0, MAX_CANDIDATES);

    for (const phrase of candidateList) {
      try {
        const embedding = await ctx.embed.embed(phrase);
        const nearest = await store.findNearest(embedding, 1);
        if (nearest.length > 0 && nearest[0].score >= threshold) {
          suggestions.push({
            phrase,
            concept: nearest[0].memory.name,
            concept_id: nearest[0].memory.id,
            score: Math.round(nearest[0].score * 100) / 100,
          });
        }
      } catch {
        // Skip failed embeddings
      }
    }

    // Deduplicate by concept
    const seen = new Set<string>();
    const deduped = suggestions.filter((s) => {
      if (seen.has(s.concept_id)) return false;
      seen.add(s.concept_id);
      return true;
    });

    return {
      candidates_checked: candidateList.length,
      suggestions: deduped.sort((a, b) => b.score - a.score),
    };
  },
};
