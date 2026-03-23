/**
 * federated_query — search memories across federated cortex instances via sigil.
 *
 * Discovers peers from the sigil registry and queries their cortex REST APIs
 * in parallel. Best-effort: peer failures are tracked but do not block results.
 */

import type { ToolDefinition, ToolContext } from '../mcp/tools.js';
import type { FederationSearchResult } from '../federation/client.js';

export const federatedQueryTool: ToolDefinition = {
  name: 'federated_query',
  description:
    'Search memories across federated cortex instances discovered via sigil. ' +
    'Queries peer agents in parallel and aggregates results by relevance score. ' +
    'Requires federation to be configured in cortex config.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      text: {
        type: 'string',
        description: 'The search query text.',
      },
      peers: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Specific peer agent_ids to query. If omitted, queries all online peers.',
      },
      namespace: {
        type: 'string',
        description: "Caller's namespace (for context).",
      },
      limit: {
        type: 'number',
        description: 'Max results per peer (default: 3).',
      },
      min_score: {
        type: 'number',
        description: 'Minimum similarity score threshold (default: 0.4).',
      },
    },
    required: ['text'],
  },

  async handler(args: Record<string, unknown>, ctx: ToolContext) {
    const text = typeof args['text'] === 'string' ? args['text'] : '';
    if (!text) return { error: 'text is required' };

    if (!ctx.federation) {
      return {
        error:
          'Federation not configured. Add federation settings to cortex config.',
      };
    }

    const limit = typeof args['limit'] === 'number' ? args['limit'] : 3;
    const minScore =
      typeof args['min_score'] === 'number' ? args['min_score'] : 0.4;
    const peerFilter = Array.isArray(args['peers'])
      ? (args['peers'] as unknown[]).filter(
          (p): p is string => typeof p === 'string',
        )
      : undefined;

    // Discover peers
    const allPeers = await ctx.federation.discoverPeers();

    // Filter to specific peers if requested
    const targetPeers =
      peerFilter !== undefined
        ? allPeers.filter((p) => peerFilter.includes(p.agent_id))
        : allPeers;

    // Query all peers in parallel
    const settled = await Promise.allSettled(
      targetPeers.map((p) =>
        ctx.federation!.queryPeer(p, text, limit).then((results) => ({
          agentId: p.agent_id,
          results,
        })),
      ),
    );

    const peersQueried: string[] = [];
    const peersFailed: string[] = [];
    const allResults: FederationSearchResult[] = [];

    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i]!;
      const peer = targetPeers[i]!;
      if (outcome.status === 'fulfilled') {
        peersQueried.push(peer.agent_id);
        for (const r of outcome.value.results) {
          if (r.score >= minScore) {
            allResults.push(r);
          }
        }
      } else {
        peersFailed.push(peer.agent_id);
      }
    }

    // Sort by score descending
    allResults.sort((a, b) => b.score - a.score);

    return {
      query: text,
      peers_queried: peersQueried,
      peers_failed: peersFailed,
      results: allResults,
      total: allResults.length,
    };
  },
};
