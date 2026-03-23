/**
 * FederationClient — discovers peers via sigil and queries their cortex instances.
 * Best-effort: network failures are logged, not thrown.
 */

export interface FederationPeer {
  agent_id: string;
  name: string;
  cortex_url: string;
  namespace: string | null;
  capabilities: string[];
}

export interface FederationSearchResult {
  source_agent: string;
  source_namespace: string | null;
  id: string;
  name: string;
  definition: string;
  category: string;
  score: number;
  confidence: number;
}

export interface AgentRegistrationPayload {
  agent_id: string;
  name: string;
  cortex_url?: string;
  namespace?: string;
  capabilities?: string[];
  version?: string;
}

export class FederationClient {
  constructor(
    private readonly sigilUrl: string,
    private readonly sigilToken?: string,
  ) {}

  /** Discover online peers from sigil registry. */
  async discoverPeers(): Promise<FederationPeer[]> {
    try {
      const res = await fetch(`${this.sigilUrl}/sigil/agents?status=online`, {
        headers: { ...this.authHeaders(), 'Accept': 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return [];
      const body = (await res.json()) as { agents?: unknown[] };
      const agents = Array.isArray(body.agents) ? body.agents : [];
      return agents
        .filter((a): a is Record<string, unknown> => a !== null && typeof a === 'object')
        .filter((a) => typeof a['cortex_url'] === 'string' && a['cortex_url'] !== '')
        .map((a) => ({
          agent_id: String(a['agent_id'] ?? ''),
          name: String(a['name'] ?? ''),
          cortex_url: String(a['cortex_url']),
          namespace: typeof a['namespace'] === 'string' ? a['namespace'] : null,
          capabilities: Array.isArray(a['capabilities'])
            ? (a['capabilities'] as unknown[]).map(String)
            : [],
        }));
    } catch {
      return [];
    }
  }

  /** Query a peer's cortex REST API for memories. */
  async queryPeer(peer: FederationPeer, query: string, limit = 5): Promise<FederationSearchResult[]> {
    try {
      const res = await fetch(`${peer.cortex_url}/tool/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ text: query, top_k: limit }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return [];
      const body = (await res.json()) as { results?: unknown[] };
      const results = Array.isArray(body.results) ? body.results : [];
      return results
        .filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object')
        .map((r) => ({
          source_agent: peer.agent_id,
          source_namespace: peer.namespace,
          id: String(r['id'] ?? ''),
          name: String(r['name'] ?? ''),
          definition: String(r['definition'] ?? ''),
          category: String(r['category'] ?? ''),
          score: typeof r['score'] === 'number' ? r['score'] : 0,
          confidence: typeof r['confidence'] === 'number' ? r['confidence'] : 0,
        }));
    } catch {
      return [];
    }
  }

  /** Register this agent with sigil. */
  async registerSelf(reg: AgentRegistrationPayload): Promise<boolean> {
    try {
      const res = await fetch(`${this.sigilUrl}/sigil/agents/register`, {
        method: 'POST',
        headers: {
          ...this.authHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(reg),
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Send heartbeat to sigil. */
  async heartbeat(agentId: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.sigilUrl}/sigil/agents/${encodeURIComponent(agentId)}/heartbeat`, {
        method: 'POST',
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Deregister from sigil. */
  async deregisterSelf(agentId: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.sigilUrl}/sigil/agents/${encodeURIComponent(agentId)}`, {
        method: 'DELETE',
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Build auth headers. */
  private authHeaders(): Record<string, string> {
    if (!this.sigilToken) return {};
    return { 'Authorization': `Bearer ${this.sigilToken}` };
  }
}
