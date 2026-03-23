/**
 * query_cross — read-only cross-namespace memory search.
 *
 * Queries memories from other namespaces that have opted in via the
 * `queryable` flag. This is strictly read-only: no touchMemory,
 * no updateMemory, no triggers, no bridges.
 */

import type { ToolDefinition, ToolContext } from '../mcp/tools.js';

export const queryCrossTool: ToolDefinition = {
  name: 'query_cross',
  description:
    'Search memories across other namespaces that allow cross-namespace reads. ' +
    'Read-only — does not modify any memories or fire triggers/bridges. ' +
    'Use to discover relevant knowledge stored in sibling namespaces.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      text: {
        type: 'string',
        description: 'The search query.',
      },
      target_namespace: {
        type: 'string',
        description:
          'Specific namespace to query. If omitted, queries all queryable namespaces.',
      },
      namespace: {
        type: 'string',
        description: "Caller's namespace (skipped from results).",
      },
      limit: {
        type: 'number',
        description: 'Max results per namespace (default: 5).',
      },
      min_score: {
        type: 'number',
        description: 'Similarity threshold (default: 0.3).',
      },
    },
    required: ['text'],
  },

  async handler(args: Record<string, unknown>, ctx: ToolContext) {
    const text = typeof args['text'] === 'string' ? args['text'] : '';
    if (!text) return { error: 'text is required' };

    const targetNs =
      typeof args['target_namespace'] === 'string'
        ? args['target_namespace']
        : undefined;
    const callerNs =
      typeof args['namespace'] === 'string'
        ? args['namespace']
        : ctx.namespaces.getDefaultNamespace();
    const limit = typeof args['limit'] === 'number' ? args['limit'] : 5;
    const minScore =
      typeof args['min_score'] === 'number' ? args['min_score'] : 0.3;

    // Determine which namespaces to search
    let targets: string[];

    if (targetNs !== undefined) {
      // Validate it exists (getConfig throws for unknown)
      try {
        ctx.namespaces.getConfig(targetNs);
      } catch {
        return { error: `Unknown namespace: ${targetNs}` };
      }
      const cfg = ctx.namespaces.getConfig(targetNs);
      if (cfg.queryable !== true) {
        return { error: `Namespace '${targetNs}' is not queryable` };
      }
      targets = [targetNs];
    } else {
      targets = ctx.namespaces.getQueryableNamespaces();
    }

    // Skip caller's own namespace
    targets = targets.filter((ns) => ns !== callerNs);

    // Embed the query text
    const embedding = await ctx.embed.embed(text);

    // Search each target namespace
    const results: Array<{
      source_namespace: string;
      id: string;
      name: string;
      definition: string;
      category: string;
      score: number;
      confidence: number;
    }> = [];

    const namespacesSearched: string[] = [];

    for (const ns of targets) {
      namespacesSearched.push(ns);
      const store = ctx.namespaces.getStore(ns);
      const nearest = await store.findNearest(embedding, limit);

      for (const r of nearest) {
        if (r.score >= minScore) {
          results.push({
            source_namespace: ns,
            id: r.memory.id,
            name: r.memory.name,
            definition: r.memory.definition,
            category: r.memory.category,
            score: r.score,
            confidence: r.memory.confidence,
          });
        }
      }
    }

    return {
      query: text,
      namespaces_searched: namespacesSearched,
      results,
      total: results.length,
    };
  },
};
