/**
 * recall — list recent observations in chronological order.
 */

import type { ToolDefinition } from '../mcp/tools.js';
import type { QueryFilter } from '../core/types.js';
import { optStr, optNum } from './_helpers.js';

export const recallTool: ToolDefinition = {
  name: 'recall',
  description: 'List recent observations in chronological order. Use query() to search by meaning, recall() to see what was recorded lately. Filter by content_type to see only facts, questions, or hypotheses.',
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

    // Query observations ordered by created_at desc within the time window
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const filters: QueryFilter[] = [
      { field: 'created_at', op: '>=', value: cutoff },
    ];
    if (contentType) {
      filters.push({ field: 'content_type', op: '==', value: contentType });
    }
    const observations = await store.query(
      'observations',
      filters,
      { limit, orderBy: 'created_at', orderDir: 'desc' },
    );

    return {
      namespace: namespace ?? ctx.namespaces.getDefaultNamespace(),
      days,
      content_type_filter: contentType ?? 'all',
      count: observations.length,
      observations: observations.map(o => ({
        id: o['id'],
        content: o['content'],
        salience: o['salience'],
        keywords: o['keywords'],
        content_type: o['content_type'] ?? 'declarative',
        source_file: o['source_file'],
        created_at: o['created_at'],
        processed: o['processed'],
        provenance: o['provenance'],
      })),
    };
  },
};
