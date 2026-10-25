/**
 * recall — list recent observations in chronological order.
 */

import type { ToolDefinition } from '../mcp/tools.js';
import type { ObservationContentType } from '../core/types.js';
import { optStr, optNum } from './_helpers.js';

export const recallTool: ToolDefinition = {
  name: 'recall',
  category: 'memory',
  description: 'Returns recent observations in chronological order within a time window, optionally filtered by content_type (declarative, interrogative, speculative, reflective).',
  whenToUse: 'You want to see what was recorded recently — a chronological feed of observations rather than ranked search.',
  doNotUse: 'You are looking for memories matching a topic (use query) or you have an id (use retrieve).',
  inputSchema: {
    type: 'object',
    properties: {
      namespace: { type: 'string', description: 'Namespace to query (defaults to default namespace)' },
      limit: { type: 'number', description: 'Max entries to return (default: 10)' },
      days: { type: 'number', description: 'How many days back to look (default: 7)' },
      content_type: { type: 'string', enum: ['declarative', 'interrogative', 'speculative', 'reflective'], description: 'Filter by content type. Omit to see all types.' },
    },
  },
  async handler(args, ctx) {
    const namespace = optStr(args, 'namespace');
    const limit = optNum(args, 'limit', 10);
    const days = optNum(args, 'days', 7);
    const contentType = optStr(args, 'content_type');

    const store = ctx.namespaces.getStore(namespace);

    // Typed read (#122): observe/wonder/speculate write the typed table,
    // which the generic query('observations') never sees on SQLite/JSON.
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const observations = await store.queryObservations({
      since,
      content_type: contentType as ObservationContentType | undefined,
      limit,
    });

    return {
      namespace: namespace ?? ctx.namespaces.getDefaultNamespace(),
      days,
      content_type_filter: contentType ?? 'all',
      count: observations.length,
      observations: observations.map(o => ({
        id: o.id,
        content: o.content,
        salience: o.salience,
        keywords: o.keywords,
        content_type: o.content_type ?? 'declarative',
        source_file: o.source_file,
        created_at: o.created_at,
        processed: o.processed,
        provenance: o.provenance,
      })),
    };
  },
};
