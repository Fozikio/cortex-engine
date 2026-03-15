/**
 * evolution_list — list evolution proposals with optional status filter.
 */

import type { ToolDefinition, ToolContext } from '../mcp/tools.js';
import type { QueryFilter } from '../core/types.js';

const COLLECTION = 'evolutions';

const VALID_STATUSES = ['proposed', 'applied', 'rejected', 'reverted'] as const;

export const evolutionListTool: ToolDefinition = {
  name: 'evolution_list',
  description: 'List evolution proposals. Filter by status (default: proposed).',
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        description: 'Filter by status: proposed, applied, rejected, reverted. Default: proposed',
      },
      limit: { type: 'number', description: 'Max results. Default: 20' },
      namespace: { type: 'string', description: 'Namespace (defaults to default)' },
    },
  },

  async handler(args: Record<string, unknown>, ctx: ToolContext): Promise<Record<string, unknown>> {
    const status =
      typeof args['status'] === 'string' &&
      (VALID_STATUSES as readonly string[]).includes(args['status'])
        ? args['status']
        : 'proposed';
    const limit =
      typeof args['limit'] === 'number' ? Math.min(args['limit'], 100) : 20;
    const namespace = typeof args['namespace'] === 'string' ? args['namespace'] : undefined;

    const store = ctx.namespaces.getStore(namespace);

    const filters: QueryFilter[] = [
      { field: 'status', op: '==', value: status },
    ];

    const docs = await store.query(COLLECTION, filters, {
      limit,
      orderBy: 'created_at',
      orderDir: 'desc',
    });

    const evolutions = docs.map((d) => ({
      id: d['id'] as string,
      change: d['change'] as string,
      trigger: d['trigger'] as string,
      from_value: (d['from_value'] as string | undefined) ?? null,
      to_value: (d['to_value'] as string | undefined) ?? null,
      confidence: d['confidence'] as string,
      status: d['status'] as string,
      dimension: (d['dimension'] as string | undefined) ?? null,
      session_ref: (d['session_ref'] as string | undefined) ?? null,
      created_at: d['created_at'] as string,
      applied_at: (d['applied_at'] as string | undefined) ?? null,
    }));

    return { status, count: evolutions.length, evolutions };
  },
};
