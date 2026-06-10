/**
 * context — tiered memory context loader, inspired by Hermes Agent's
 * OpenViking memory provider (L0 → L1 → L2 progressive loading).
 *
 * Three tiers trade latency for richness:
 *
 *   L0  ~100 tokens  Top-3 memories by salience × FSRS retrievability.
 *                    Names + first 80 chars of definition only.
 *                    Designed to be injected into every system prompt with
 *                    near-zero latency (no LLM call, one vector search).
 *
 *   L1  ~2k tokens   Semantic top-15 with full definitions, tags, and
 *                    immediate graph edges (one hop). Suitable for the
 *                    working memory section of a system prompt or a
 *                    context-window refresh mid-conversation.
 *
 *   L2  full         Multi-anchor retrieval across 4 query reformulations
 *                    with Borda-count consensus, spreading activation (2
 *                    hops), and full memory metadata including provenance
 *                    and FSRS state. Use when you need the richest possible
 *                    recall and can tolerate extra latency.
 *
 * All tiers use HyDE query expansion by default (disable with hyde: false).
 * Results are always filtered to faded=false and sorted by composite score.
 */

import type { ToolDefinition } from '../mcp/tools.js';
import { hydeExpand, spreadActivation, multiAnchorRetrieval } from '../engines/memory.js';
import { retrievability, elapsedDaysSince } from '../engines/fsrs.js';
import { str, optStr, optBool } from './_helpers.js';

type Tier = 'L0' | 'L1' | 'L2';

function parseTier(raw: unknown): Tier {
  if (raw === 'L0' || raw === 'L1' || raw === 'L2') return raw;
  return 'L1';
}

export const contextTool: ToolDefinition = {
  name: 'context',
  category: 'memory',
  description: 'Tiered memory loader: L0 (top-3 names, ~100 tokens, instant), L1 (semantic top-15 + graph edges, ~2k tokens), L2 (multi-anchor full recall, max richness). Use L0 for system-prompt injection, L1 for mid-conversation refresh, L2 for deep research.',
  whenToUse: 'You need to prefetch relevant memory before a response and want to control the token budget explicitly.',
  doNotUse: 'You want ranked search with HyDE + spread activation for a specific question — use query instead.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Topic or question to retrieve context for' },
      tier: { type: 'string', enum: ['L0', 'L1', 'L2'], description: 'L0 = fast summary (~100 tokens), L1 = working memory (~2k tokens), L2 = full deep recall (default: L1)' },
      namespace: { type: 'string', description: 'Memory namespace (defaults to default)' },
      hyde: { type: 'boolean', description: 'Use HyDE query expansion (default: true; ignored for L0)' },
    },
    required: ['text'],
  },

  async handler(args, ctx) {
    const text = str(args, 'text');
    const tier = parseTier(args['tier']);
    const namespace = optStr(args, 'namespace');
    const useHyde = optBool(args, 'hyde', true);

    const store = ctx.namespaces.getStore(namespace);
    const resolvedNs = namespace ?? ctx.namespaces.getDefaultNamespace();

    // ── L0: salience × retrievability top-3 — no LLM call ──────────────────
    if (tier === 'L0') {
      const rawEmbedding = await ctx.embed.embed(text);
      const candidates = await store.findNearest(rawEmbedding, 20);
      const now = new Date();

      const scored = candidates.map((r) => {
        const daysSince = r.memory.fsrs.last_review
          ? elapsedDaysSince(r.memory.fsrs.last_review)
          : 0;
        const ret = retrievability(r.memory.fsrs.stability, daysSince);
        return { r, score: r.memory.salience * ret };
      });

      const top = scored
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);

      void now;
      return {
        tier: 'L0',
        namespace: resolvedNs,
        count: top.length,
        memories: top.map(({ r }) => ({
          id: r.memory.id,
          name: r.memory.name,
          summary: r.memory.definition.slice(0, 80) + (r.memory.definition.length > 80 ? '…' : ''),
          category: r.memory.category,
          salience: r.memory.salience,
        })),
      };
    }

    // ── L1: semantic top-15 + immediate graph edges ─────────────────────────
    if (tier === 'L1') {
      const embedding = useHyde
        ? await hydeExpand(text, ctx.llm, ctx.embed)
        : await ctx.embed.embed(text);

      const nearest = await store.findNearest(embedding, 15);

      const now = new Date();
      const results = await Promise.all(
        nearest.map(async (r) => {
          const daysSince = r.memory.fsrs.last_review
            ? elapsedDaysSince(r.memory.fsrs.last_review)
            : 0;
          const ret = retrievability(r.memory.fsrs.stability, daysSince);
          const salienceFactor = 0.5 + r.memory.salience * 0.5;
          const compositeScore = r.score * ret * salienceFactor;

          const edges = await store.getEdgesFrom(r.memory.id);
          const links = edges.slice(0, 5).map((e) => ({
            target_id: e.target_id,
            relation: e.relation,
            weight: e.weight,
          }));

          return { r, compositeScore, ret, links };
        }),
      );

      void now;
      const sorted = results
        .sort((a, b) => b.compositeScore - a.compositeScore);

      return {
        tier: 'L1',
        namespace: resolvedNs,
        hyde_used: useHyde,
        count: sorted.length,
        memories: sorted.map(({ r, compositeScore, ret, links }) => ({
          id: r.memory.id,
          name: r.memory.name,
          definition: r.memory.definition,
          category: r.memory.category,
          tags: r.memory.tags,
          salience: r.memory.salience,
          confidence: r.memory.confidence,
          score: r.score,
          composite_score: compositeScore,
          retrievability: ret,
          links,
        })),
      };
    }

    // ── L2: multi-anchor retrieval + spread activation ──────────────────────
    const candidates = await multiAnchorRetrieval(store, ctx.embed, ctx.llm, text, 10);
    const embedding = useHyde
      ? await hydeExpand(text, ctx.llm, ctx.embed)
      : await ctx.embed.embed(text);
    const activated = await spreadActivation(store, candidates, embedding, 2);

    const now = new Date();
    const results = await Promise.all(
      activated.map(async (r) => {
        const memory = await store.getMemory(r.memory.id);
        if (!memory) return null;

        const daysSince = memory.fsrs.last_review
          ? elapsedDaysSince(memory.fsrs.last_review)
          : 0;
        const ret = retrievability(memory.fsrs.stability, daysSince);
        const salienceFactor = 0.5 + memory.salience * 0.5;
        const compositeScore = r.score * ret * salienceFactor;

        const edges = await store.getEdgesFrom(memory.id);
        return {
          compositeScore,
          data: {
            id: memory.id,
            name: memory.name,
            definition: memory.definition,
            category: memory.category,
            tags: memory.tags,
            salience: memory.salience,
            confidence: memory.confidence,
            access_count: memory.access_count,
            score: r.score,
            composite_score: compositeScore,
            retrievability: ret,
            hop_count: r.hop_count,
            activation_path: r.activation_path,
            memory_origin: memory.memory_origin,
            provenance: memory.provenance,
            fsrs_state: memory.fsrs.state,
            fsrs_stability: memory.fsrs.stability,
            last_accessed: memory.last_accessed.toISOString(),
            updated_at: memory.updated_at.toISOString(),
            links: edges.slice(0, 10).map((e) => ({
              target_id: e.target_id,
              relation: e.relation,
              weight: e.weight,
            })),
          },
        };
      }),
    );

    void now;
    const filtered = results
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => b.compositeScore - a.compositeScore);

    return {
      tier: 'L2',
      namespace: resolvedNs,
      hyde_used: useHyde,
      count: filtered.length,
      memories: filtered.map((r) => r.data),
    };
  },
};
