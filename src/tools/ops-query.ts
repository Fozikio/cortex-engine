/**
 * ops_query — search the operational log with filters.
 */

import type { ToolDefinition } from '../mcp/tools.js';
import type { OpsEntryType, OpsStatus } from '../core/types.js';
import { optStr, optNum } from './_helpers.js';

export const opsQueryTool: ToolDefinition = {
  name: 'ops_query',
  description: 'Search the operational log. Filter by project, entry type, status, or time window. Use to review what happened in previous sessions or check project progress.',
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'Filter by project name' },
      type: { type: 'string', enum: ['log', 'instruction', 'handoff', 'milestone', 'decision'], description: 'Filter by entry type' },
      status: { type: 'string', enum: ['active', 'done', 'stale'], description: 'Filter by status' },
      days: { type: 'number', description: 'Only show entries from last N days' },
      limit: { type: 'number', description: 'Max entries to return' },
      namespace: { type: 'string', description: 'Namespace to query' },
    },
  },
  async handler(args, ctx) {
    const namespace = optStr(args, 'namespace');
    const store = ctx.namespaces.getStore(namespace);

    const entries = await store.queryOps({
      project: optStr(args, 'project'),
      type: optStr(args, 'type') as OpsEntryType | undefined,
      status: optStr(args, 'status') as OpsStatus | undefined,
      days: args['days'] !== undefined ? optNum(args, 'days', 7) : undefined,
      limit: args['limit'] !== undefined ? optNum(args, 'limit', 20) : undefined,
    });

    return {
      namespace: namespace ?? ctx.namespaces.getDefaultNamespace(),
      count: entries.length,
      entries: entries.map(e => ({
        id: e.id,
        content: e.content,
        type: e.type,
        status: e.status,
        project: e.project,
        keywords: e.keywords,
        created_at: e.created_at,
      })),
    };
  },
};
