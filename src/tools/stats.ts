/**
 * stats — get memory statistics for a namespace.
 */

import type { ToolDefinition } from '../mcp/tools.js';
import type { CortexStore } from '../core/store.js';
import { optStr } from './_helpers.js';

export const statsTool: ToolDefinition = {
  name: 'stats',
  description: 'Get memory statistics — total memories, unprocessed observations, namespace info, and active tools.',
  inputSchema: {
    type: 'object',
    properties: {
      namespace: { type: 'string', description: 'Namespace to inspect (defaults to default namespace)' },
    },
  },
  async handler(args, ctx) {
    const namespace = optStr(args, 'namespace');
    const resolvedNs = namespace ?? ctx.namespaces.getDefaultNamespace();
    const store: CortexStore = ctx.namespaces.getStore(namespace);

    // Count memories
    const allMemories = await store.getAllMemories();
    const unprocessedObs = await store.getUnprocessedObservations(9999);

    // Namespace config
    const config = ctx.namespaces.getConfig(namespace);

    return {
      namespace: resolvedNs,
      namespaces: ctx.namespaces.getNamespaceNames(),
      default_namespace: ctx.namespaces.getDefaultNamespace(),
      memory_count: allMemories.length,
      unprocessed_observations: unprocessedObs.length,
      cognitive_tools: config.cognitive_tools,
      collections_prefix: config.collections_prefix,
    };
  },
};
