/**
 * dream — run the 7-phase memory consolidation cycle.
 */

import type { ToolDefinition, ToolContext } from '../mcp/tools.js';
import { optStr, optNum } from './_helpers.js';
import { dreamConsolidate } from '../engines/cognition.js';

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

    return {
      namespace: namespace ?? ctx.namespaces.getDefaultNamespace(),
      ...result.phases,
      total_processed: result.total_processed,
      duration_ms: result.duration_ms,
      integration_rate: result.integration_rate,
    };
  },
};
