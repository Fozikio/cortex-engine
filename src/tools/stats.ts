/**
 * stats — get memory statistics for a namespace.
 */

import type { ToolDefinition } from '../mcp/tools.js';
import type { CortexStore } from '../core/store.js';
import { optStr } from './_helpers.js';

export const statsTool: ToolDefinition = {
  name: 'stats',
  category: 'meta',
  description: 'Returns counts and metadata for a namespace — total memories, unprocessed observations, active tools, and basic identity info.',
  whenToUse: 'You want a quick high-level health summary of the cortex namespace.',
  doNotUse: 'You want consolidation-specific health — use consolidation_status.',
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
