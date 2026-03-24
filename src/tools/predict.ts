/**
 * predict — anticipate what memories might be relevant given current context.
 *
 * Looks at recent observations and an optional hint to surface
 * knowledge you might need next. Unlike query() which answers a
 * specific question, predict() surfaces knowledge proactively.
 */

import type { ToolDefinition, ToolContext } from '../mcp/tools.js';
import { optStr } from './_helpers.js';
import { hydeExpand, spreadActivation } from '../engines/memory.js';
import { retrievability, elapsedDaysSince } from '../engines/fsrs.js';

const LOOKBACK_HOURS = 24;
const TOP_K = 5;

export const predictTool: ToolDefinition = {
  name: 'predict',
  description: 'Anticipate what memories might be relevant given your current context. Looks at recent observations and an optional context hint to surface knowledge you might need next. Unlike query() which answers a specific question, predict() surfaces knowledge proactively. Best used at session start or when switching tasks.',
  inputSchema: {
    type: 'object',
    properties: {
      context: { type: 'string', description: "Optional: what you're currently working on or thinking about" },
      namespace: { type: 'string', description: 'Namespace to predict in (defaults to default namespace)' },
    },
  },
  async handler(args: Record<string, unknown>, ctx: ToolContext) {
    const contextHint = optStr(args, 'context') ?? '';
    const namespace = optStr(args, 'namespace');

    const store = ctx.namespaces.getStore(namespace);

    // Gather recent observations as implicit context
    const sinceDate = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000);
    let recentObs: Array<Record<string, unknown>> = [];
    try {
      recentObs = await store.query(
        'observations',
        [{ field: 'created_at', op: '>=', value: sinceDate }],
        { limit: 10, orderBy: 'created_at', orderDir: 'desc' },
      );
    } catch {
      // Observation query failure is non-fatal
    }

    const recentObservations = recentObs
      .map((d) => typeof d['content'] === 'string' ? d['content'] : '')
      .join(' ');

    // Build composite context: recent activity + optional hint
    const compositeContext = [recentObservations, contextHint]
      .filter(Boolean)
      .join('\n\n');

    if (!compositeContext.trim()) {
      return {
        predicted: [],
        context_used: { recent_observations: 0, hint_provided: false },
        namespace: namespace ?? ctx.namespaces.getDefaultNamespace(),
        note: 'No recent context to predict from. Pass context= to provide a hint.',
      };
    }

    // HyDE-expand the composite context and search
    const embedding = await hydeExpand(compositeContext, ctx.llm, ctx.embed);
    const initial = await store.findNearest(embedding, TOP_K * 2);
    const activated = await spreadActivation(store, initial, embedding, 1);

    // Temporal reranking — boost recently updated memories + FSRS retrievability
    const now = Date.now();
    const reranked = activated
      .map((r) => {
        // Temporal recency boost
        const updatedAt = r.memory.updated_at instanceof Date
          ? r.memory.updated_at.getTime()
          : typeof (r.memory.updated_at as { toMillis?: () => number }).toMillis === 'function'
            ? (r.memory.updated_at as { toMillis: () => number }).toMillis()
            : new Date(String(r.memory.updated_at)).getTime();
        const ageDays = (now - updatedAt) / (1000 * 60 * 60 * 24);
        const recency = Math.exp(-ageDays / 30);

        // FSRS retrievability factor
        const daysSince = elapsedDaysSince(r.memory.fsrs.last_review);
        const ret = retrievability(r.memory.fsrs.stability, daysSince);

        return {
          ...r,
          score: r.score * (1 + 0.3 * recency) * ret,
          retrievability: ret,
          recency,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_K);

    // Touch to reinforce
    await Promise.all(
      reranked.map((r) =>
        store.touchMemory(r.memory.id, {}).catch(() => { /* non-fatal */ })
      ),
    );

    return {
      predicted: reranked.map((r) => ({
        id: r.memory.id,
        name: r.memory.name,
        definition: r.memory.definition,
        category: r.memory.category,
        score: Math.round(r.score * 1000) / 1000,
        retrievability: Math.round(r.retrievability * 1000) / 1000,
      })),
      context_used: {
        recent_observations: recentObs.length,
        hint_provided: Boolean(contextHint),
      },
      namespace: namespace ?? ctx.namespaces.getDefaultNamespace(),
      count: reranked.length,
    };
  },
};
