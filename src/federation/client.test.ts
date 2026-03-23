/**
 * Tests for FederationClient — sigil discovery and peer querying.
 *
 * Mocks global fetch to avoid real network calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FederationClient } from './client.js';
import type { FederationPeer } from './client.js';

// ─── Setup ───────────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
});

function jsonResponse(data: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: () => Promise.resolve(data),
  } as unknown as Response;
}

// ─── discoverPeers ───────────────────────────────────────────────────────────

describe('FederationClient.discoverPeers', () => {
  it('parses sigil response correctly', async () => {
    const client = new FederationClient('http://sigil:8090', 'tok');
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        agents: [
          {
            agent_id: 'a1',
            name: 'Agent One',
            cortex_url: 'http://cortex1:3000',
            namespace: 'ns1',
            capabilities: ['query', 'observe'],
          },
          {
            agent_id: 'a2',
            name: 'Agent Two',
            cortex_url: 'http://cortex2:3000',
            namespace: null,
            capabilities: [],
          },
        ],
      }),
    );

    const peers = await client.discoverPeers();

    expect(peers).toHaveLength(2);
    expect(peers[0]).toEqual({
      agent_id: 'a1',
      name: 'Agent One',
      cortex_url: 'http://cortex1:3000',
      namespace: 'ns1',
      capabilities: ['query', 'observe'],
    });
    expect(peers[1]!.namespace).toBeNull();

    // Verify auth header was sent
    expect(mockFetch).toHaveBeenCalledWith(
      'http://sigil:8090/sigil/agents?status=online',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer tok',
        }),
      }),
    );
  });

  it('returns empty array on network error', async () => {
    const client = new FederationClient('http://sigil:8090');
    mockFetch.mockRejectedValueOnce(new Error('network down'));

    const peers = await client.discoverPeers();
    expect(peers).toEqual([]);
  });

  it('filters out peers without cortex_url', async () => {
    const client = new FederationClient('http://sigil:8090');
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        agents: [
          { agent_id: 'a1', name: 'With URL', cortex_url: 'http://c1:3000' },
          { agent_id: 'a2', name: 'No URL' },
          { agent_id: 'a3', name: 'Empty URL', cortex_url: '' },
        ],
      }),
    );

    const peers = await client.discoverPeers();
    expect(peers).toHaveLength(1);
    expect(peers[0]!.agent_id).toBe('a1');
  });
});

// ─── queryPeer ───────────────────────────────────────────────────────────────

describe('FederationClient.queryPeer', () => {
  const peer: FederationPeer = {
    agent_id: 'p1',
    name: 'Peer One',
    cortex_url: 'http://peer1:3000',
    namespace: 'ns1',
    capabilities: [],
  };

  it('parses cortex search response', async () => {
    const client = new FederationClient('http://sigil:8090');
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        results: [
          {
            id: 'mem1',
            name: 'Memory 1',
            definition: 'Def 1',
            category: 'observation',
            score: 0.9,
            confidence: 0.85,
          },
        ],
      }),
    );

    const results = await client.queryPeer(peer, 'test query', 5);

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      source_agent: 'p1',
      source_namespace: 'ns1',
      id: 'mem1',
      name: 'Memory 1',
      definition: 'Def 1',
      category: 'observation',
      score: 0.9,
      confidence: 0.85,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://peer1:3000/tool/query',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ text: 'test query', top_k: 5 }),
      }),
    );
  });

  it('returns empty array on peer failure', async () => {
    const client = new FederationClient('http://sigil:8090');
    mockFetch.mockRejectedValueOnce(new Error('peer offline'));

    const results = await client.queryPeer(peer, 'test', 5);
    expect(results).toEqual([]);
  });
});

// ─── registerSelf ────────────────────────────────────────────────────────────

describe('FederationClient.registerSelf', () => {
  it('sends correct POST body', async () => {
    const client = new FederationClient('http://sigil:8090', 'secret');
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

    const payload = {
      agent_id: 'my-agent',
      name: 'My Agent',
      cortex_url: 'http://localhost:3000',
      capabilities: ['query'],
      version: '1.0.0',
    };
    const result = await client.registerSelf(payload);

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://sigil:8090/sigil/agents/register',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(payload),
        headers: expect.objectContaining({
          Authorization: 'Bearer secret',
          'Content-Type': 'application/json',
        }),
      }),
    );
  });
});

// ─── heartbeat ───────────────────────────────────────────────────────────────

describe('FederationClient.heartbeat', () => {
  it('hits correct endpoint', async () => {
    const client = new FederationClient('http://sigil:8090', 'tok');
    mockFetch.mockResolvedValueOnce(jsonResponse({}));

    const result = await client.heartbeat('agent-42');

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://sigil:8090/sigil/agents/agent-42/heartbeat',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
