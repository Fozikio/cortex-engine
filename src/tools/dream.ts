/**
 * dream — run the 7-phase memory consolidation cycle.
 */

import type { ToolDefinition, ToolContext } from '../mcp/tools.js';
import { optStr, optNum } from './_helpers.js';
import { dreamConsolidate } from '../engines/cognition.js';

const CONSOLIDATION_HISTORY = 'consolidation_history';

export const dreamTool: ToolDefinition = {
  name: 'dream',
  category: 'consolidation',
  description: 'Runs the 7-phase consolidation cycle: cluster, refine, mint, link, FSRS review, cross-domain synthesis, narrative summary. Heavyweight — run on schedule.',
  whenToUse: 'You want to process accumulated observations into long-term memories.',
  doNotUse: 'You only need to ingest one document (use digest) or reflect on identity (use ruminate).',
  inputSchema: {
    type: 'object',
    properties: {
      namespace: { type: 'string', description: 'Namespace to consolidate (defaults to default namespace)' },
      limit: { type: 'number', description: 'Max observations to process in the cluster phase (default: 20)' },
    },
  },
  async handler(args: Record<string, unknown>, ctx: ToolContext) {
    const namespace = optStr(args, 'namespace');
    const limit = optNum(args, 'limit', 20);

    const store = ctx.namespaces.getStore(namespace);
    const nsConfig = ctx.namespaces.getConfig(namespace);

    const result = await dreamConsolidate(store, ctx.embed, ctx.llm, {
      observation_limit: limit,
      similarity_merge: nsConfig.similarity_merge,
      similarity_link: nsConfig.similarity_link,
    });

    // Record the run. sleep_pressure and consolidation_status both read this
    // collection to answer "when did consolidation last happen" — and nothing
    // wrote it, so both reported last_dream_at: null forever no matter how many
    // times dream had actually run. consolidation_status also builds its quality
    // trend from these rows, so with no writer the trend was always empty.
    // Written after the cycle, so a failed run leaves no false entry.
    //
    // consolidation_quality is deliberately absent: dreamConsolidate does not
    // compute one and the readers treat it as nullable. Writing a stand-in
    // would be inventing a metric.
    await store.put(CONSOLIDATION_HISTORY, {
      at: new Date().toISOString(),
      phase1_clustered: result.phases.cluster.clustered,
      phase2_refined: result.phases.refine.refined,
      phase3_created: result.phases.create.created,
      phase4_edges: result.phases.connect.edges_discovered,
      phase5_scored: result.phases.score.scored,
      phase7_abstractions: result.phases.abstract.abstractions,
      total_observations: result.total_processed,
      unclustered_count: result.phases.cluster.unclustered,
      duration_ms: result.duration_ms,
      integration_rate: result.integration_rate,
      failures: result.failures,
    });

    return {
      namespace: namespace ?? ctx.namespaces.getDefaultNamespace(),
      ...result.phases,
      total_processed: result.total_processed,
      duration_ms: result.duration_ms,
      integration_rate: result.integration_rate,
    };
  },
};
