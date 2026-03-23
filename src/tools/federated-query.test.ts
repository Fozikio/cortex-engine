/**
 * Tests for federated_query tool.
 *
 * Mocks FederationClient to avoid real network calls.
 */

import { describe, it, expect, vi } from 'vitest';
import { federatedQueryTool } from './federated-query.js';
import type { ToolContext } from '../mcp/tools.js';
import type { FederationClient, FederationPeer, FederationSearchResult } from '../federation/client.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePeer(id: string): FederationPeer {
  return {
    agent_id: id,
    name: `Agent ${id}`,
    cortex_url: `http://${id}:3000`,
    namespace: null,
    capabilities: [],
  };
}

function makeResult(agentId: string, score: number): FederationSearchResult {
  return {
    source_agent: agentId,
    source_namespace: null,
    id: `mem-${agentId}-${score}`,
    name: `Memory from ${agentId}`,
    definition: `Def from ${agentId}`,
    category: 'observation',
    score,
    confidence: 0.8,
  };
}

function mockFederationClient(overrides: Partial<FederationClient> = {}): FederationClient {
  return {
    discoverPeers: vi.fn().mockResolvedValue([]),
    queryPeer: vi.fn().mockResolvedValue([]),
    registerSelf: vi.fn().mockResolvedValue(true),
    heartbeat: vi.fn().mockResolvedValue(true),
    deregisterSelf: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as unknown as FederationClient;
}

function minimalCtx(federation?: FederationClient): ToolContext {
  return {
    namespaces: {} as ToolContext['namespaces'],
    embed: {} as ToolContext['embed'],
    llm: {} as ToolContext['llm'],
    session: {} as ToolContext['session'],
    triggers: {} as ToolContext['triggers'],
    bridges: {} as ToolContext['bridges'],
    allTools: [],
    federation,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('federated_query tool', () => {
  it('returns error when federation not configured', async () => {
    const ctx = minimalCtx(undefined);
    const result = await federatedQueryTool.handler({ text: 'hello' }, ctx);
    expect(result['error']).toMatch(/Federation not configured/);
  });

  it('queries all online peers when no specific peers requested', async () => {
    const peers = [makePeer('a1'), makePeer('a2')];
    const discoverPeers = vi.fn().mockResolvedValue(peers);
    const queryPeer = vi.fn().mockResolvedValue([makeResult('x', 0.8)]);
    const federation = mockFederationClient({ discoverPeers, queryPeer });
    const ctx = minimalCtx(federation);

    const result = await federatedQueryTool.handler({ text: 'hello' }, ctx);

    expect(discoverPeers).toHaveBeenCalled();
    expect(queryPeer).toHaveBeenCalledTimes(2);
    expect(result['peers_queried']).toEqual(['a1', 'a2']);
  });

  it('filters to specific peers when peers array provided', async () => {
    const peers = [makePeer('a1'), makePeer('a2'), makePeer('a3')];
    const discoverPeers = vi.fn().mockResolvedValue(peers);
    const queryPeer = vi.fn().mockResolvedValue([makeResult('x', 0.8)]);
    const federation = mockFederationClient({ discoverPeers, queryPeer });
    const ctx = minimalCtx(federation);

    const result = await federatedQueryTool.handler(
      { text: 'hello', peers: ['a1', 'a3'] },
      ctx,
    );

    expect(queryPeer).toHaveBeenCalledTimes(2);
    // Verify only a1 and a3 were queried (not a2)
    const queriedPeerUrls = queryPeer.mock.calls.map(
      (c: [FederationPeer, string, number]) => c[0].agent_id,
    );
    expect(queriedPeerUrls).toEqual(['a1', 'a3']);
    expect(result['peers_queried']).toEqual(['a1', 'a3']);
  });

  it('handles mixed success/failure — 2 succeed, 1 fails', async () => {
    const peers = [makePeer('a1'), makePeer('a2'), makePeer('a3')];
    const discoverPeers = vi.fn().mockResolvedValue(peers);
    const queryPeer = vi.fn()
      .mockResolvedValueOnce([makeResult('a1', 0.9)])
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce([makeResult('a3', 0.7)]);
    const federation = mockFederationClient({ discoverPeers, queryPeer });
    const ctx = minimalCtx(federation);

    const result = await federatedQueryTool.handler({ text: 'hello' }, ctx);

    expect(result['peers_queried']).toEqual(['a1', 'a3']);
    expect(result['peers_failed']).toEqual(['a2']);
    expect(result['total']).toBe(2);
  });

  it('aggregates and sorts results by score descending', async () => {
    const peers = [makePeer('a1'), makePeer('a2')];
    const discoverPeers = vi.fn().mockResolvedValue(peers);
    const queryPeer = vi.fn()
      .mockResolvedValueOnce([makeResult('a1', 0.5), makeResult('a1', 0.9)])
      .mockResolvedValueOnce([makeResult('a2', 0.7)]);
    const federation = mockFederationClient({ discoverPeers, queryPeer });
    const ctx = minimalCtx(federation);

    const result = await federatedQueryTool.handler({ text: 'hello' }, ctx);

    const results = result['results'] as FederationSearchResult[];
    expect(results).toHaveLength(3);
    expect(results[0]!.score).toBe(0.9);
    expect(results[1]!.score).toBe(0.7);
    expect(results[2]!.score).toBe(0.5);
  });

  it('respects min_score filtering', async () => {
    const peers = [makePeer('a1')];
    const discoverPeers = vi.fn().mockResolvedValue(peers);
    const queryPeer = vi.fn().mockResolvedValue([
      makeResult('a1', 0.9),
      makeResult('a1', 0.3), // below default 0.4 threshold
      makeResult('a1', 0.5),
    ]);
    const federation = mockFederationClient({ discoverPeers, queryPeer });
    const ctx = minimalCtx(federation);

    const result = await federatedQueryTool.handler({ text: 'hello' }, ctx);

    const results = result['results'] as FederationSearchResult[];
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.score >= 0.4)).toBe(true);
  });
});
