/**
 * Tests for queryCrossTool — cross-namespace read-only search.
 */

import { describe, it, expect, vi } from 'vitest';
import { queryCrossTool } from './query-cross.js';
import type { ToolContext } from '../mcp/tools.js';
import type { CortexStore } from '../core/store.js';
import type { EmbedProvider } from '../core/embed.js';
import type { NamespaceManager } from '../namespace/manager.js';
import type { NamespaceConfig } from '../core/config.js';
import type { SearchResult } from '../core/types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSearchResult(
  id: string,
  score: number,
  category = 'observation',
): SearchResult {
  return {
    memory: {
      id,
      name: `Memory ${id}`,
      definition: `Definition of ${id}`,
      category: category as SearchResult['memory']['category'],
      salience: 0.5,
      confidence: 0.8,
      access_count: 0,
      updated_at: new Date(),
      tags: [],
      fsrs: {
        stability: 1,
        difficulty: 0.5,
        reps: 0,
        lapses: 0,
        state: 'new',
        last_review: null,
      },
    },
    score,
    distance: 1 - score,
  };
}

function makeMockStore(results: SearchResult[]): CortexStore {
  return {
    findNearest: vi.fn(() => Promise.resolve(results)),
    putMemory: vi.fn(),
    getMemory: vi.fn(),
    updateMemory: vi.fn(),
    touchMemory: vi.fn(),
    getAllMemories: vi.fn(),
    getRecentMemories: vi.fn(),
    putObservation: vi.fn(),
    getUnprocessedObservations: vi.fn(),
    markObservationProcessed: vi.fn(),
    putEdge: vi.fn(),
    getEdgesFrom: vi.fn(),
    getEdgesForMemories: vi.fn(),
    appendOps: vi.fn(),
    queryOps: vi.fn(),
    updateOps: vi.fn(),
    putSignal: vi.fn(),
    putBelief: vi.fn(),
    getBeliefHistory: vi.fn(),
    put: vi.fn(),
    get: vi.fn(),
    update: vi.fn(),
    query: vi.fn(),
  } as unknown as CortexStore;
}

interface StoreMap {
  [ns: string]: CortexStore;
}

interface ConfigMap {
  [ns: string]: NamespaceConfig;
}

function makeContext(opts: {
  stores: StoreMap;
  configs: ConfigMap;
  queryableNamespaces: string[];
  defaultNamespace: string;
}): ToolContext {
  const namespaces = {
    getStore: vi.fn((ns?: string) => opts.stores[ns ?? opts.defaultNamespace]),
    getConfig: vi.fn((ns?: string) => {
      const key = ns ?? opts.defaultNamespace;
      const cfg = opts.configs[key];
      if (!cfg) throw new Error(`Unknown namespace: ${key}`);
      return cfg;
    }),
    getQueryableNamespaces: vi.fn(() => opts.queryableNamespaces),
    getDefaultNamespace: vi.fn(() => opts.defaultNamespace),
    getNamespaceNames: vi.fn(() => Object.keys(opts.stores)),
    getActiveTools: vi.fn(() => new Set<string>()),
    isToolActive: vi.fn(() => true),
  } as unknown as NamespaceManager;

  const embed: EmbedProvider = {
    embed: vi.fn(() => Promise.resolve([1, 0, 0])),
  };

  return {
    namespaces,
    embed,
    llm: {} as ToolContext['llm'],
    session: {} as ToolContext['session'],
    triggers: {} as ToolContext['triggers'],
    bridges: {} as ToolContext['bridges'],
    allTools: [],
  };
}

function nsConfig(queryable: boolean): NamespaceConfig {
  return {
    description: 'test',
    cognitive_tools: ['query'],
    collections_prefix: '',
    queryable,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('queryCrossTool', () => {
  it('returns empty when no namespaces are queryable', async () => {
    const ctx = makeContext({
      stores: { caller: makeMockStore([]) },
      configs: { caller: nsConfig(false) },
      queryableNamespaces: [],
      defaultNamespace: 'caller',
    });

    const result = await queryCrossTool.handler({ text: 'hello' }, ctx);
    expect(result).toMatchObject({
      query: 'hello',
      namespaces_searched: [],
      results: [],
      total: 0,
    });
  });

  it('respects queryable flag — only searches queryable namespaces', async () => {
    const storeA = makeMockStore([makeSearchResult('a1', 0.9)]);
    const storeB = makeMockStore([makeSearchResult('b1', 0.8)]);
    const storeC = makeMockStore([makeSearchResult('c1', 0.7)]);

    const ctx = makeContext({
      stores: { caller: makeMockStore([]), A: storeA, B: storeB, C: storeC },
      configs: {
        caller: nsConfig(false),
        A: nsConfig(true),
        B: nsConfig(true),
        C: nsConfig(false),
      },
      queryableNamespaces: ['A', 'B'],
      defaultNamespace: 'caller',
    });

    const result = (await queryCrossTool.handler({ text: 'test' }, ctx)) as {
      namespaces_searched: string[];
      results: Array<{ source_namespace: string }>;
    };

    expect(result.namespaces_searched).toContain('A');
    expect(result.namespaces_searched).toContain('B');
    expect(result.namespaces_searched).not.toContain('C');
    expect(storeA.findNearest).toHaveBeenCalled();
    expect(storeB.findNearest).toHaveBeenCalled();
    expect(storeC.findNearest).not.toHaveBeenCalled();
  });

  it('target_namespace targets single queryable namespace', async () => {
    const storeA = makeMockStore([makeSearchResult('a1', 0.9)]);
    const storeB = makeMockStore([makeSearchResult('b1', 0.8)]);

    const ctx = makeContext({
      stores: { caller: makeMockStore([]), A: storeA, B: storeB },
      configs: {
        caller: nsConfig(false),
        A: nsConfig(true),
        B: nsConfig(true),
      },
      queryableNamespaces: ['A', 'B'],
      defaultNamespace: 'caller',
    });

    const result = (await queryCrossTool.handler(
      { text: 'test', target_namespace: 'A' },
      ctx,
    )) as {
      namespaces_searched: string[];
      results: Array<{ source_namespace: string }>;
    };

    expect(result.namespaces_searched).toEqual(['A']);
    expect(storeA.findNearest).toHaveBeenCalled();
    expect(storeB.findNearest).not.toHaveBeenCalled();
  });

  it('rejects non-queryable target with error', async () => {
    const ctx = makeContext({
      stores: { caller: makeMockStore([]), X: makeMockStore([]) },
      configs: {
        caller: nsConfig(false),
        X: nsConfig(false),
      },
      queryableNamespaces: [],
      defaultNamespace: 'caller',
    });

    const result = await queryCrossTool.handler(
      { text: 'test', target_namespace: 'X' },
      ctx,
    );
    expect(result).toMatchObject({ error: "Namespace 'X' is not queryable" });
  });

  it('min_score filtering works', async () => {
    const storeA = makeMockStore([
      makeSearchResult('a1', 0.9),
      makeSearchResult('a2', 0.2), // below default 0.3
      makeSearchResult('a3', 0.5),
    ]);

    const ctx = makeContext({
      stores: { caller: makeMockStore([]), A: storeA },
      configs: { caller: nsConfig(false), A: nsConfig(true) },
      queryableNamespaces: ['A'],
      defaultNamespace: 'caller',
    });

    const result = (await queryCrossTool.handler(
      { text: 'test', min_score: 0.4 },
      ctx,
    )) as { results: Array<{ id: string; score: number }> };

    expect(result.results).toHaveLength(2);
    expect(result.results.every((r) => r.score >= 0.4)).toBe(true);
  });

  it('read-only: touchMemory and updateMemory never called on mock stores', async () => {
    const storeA = makeMockStore([makeSearchResult('a1', 0.9)]);

    const ctx = makeContext({
      stores: { caller: makeMockStore([]), A: storeA },
      configs: { caller: nsConfig(false), A: nsConfig(true) },
      queryableNamespaces: ['A'],
      defaultNamespace: 'caller',
    });

    await queryCrossTool.handler({ text: 'test' }, ctx);

    expect(storeA.touchMemory).not.toHaveBeenCalled();
    expect(storeA.updateMemory).not.toHaveBeenCalled();
  });

  it("skips caller's own namespace", async () => {
    const callerStore = makeMockStore([makeSearchResult('c1', 0.95)]);

    const ctx = makeContext({
      stores: { caller: callerStore },
      configs: { caller: nsConfig(true) },
      queryableNamespaces: ['caller'],
      defaultNamespace: 'caller',
    });

    const result = (await queryCrossTool.handler({ text: 'test' }, ctx)) as {
      namespaces_searched: string[];
      results: unknown[];
    };

    expect(result.namespaces_searched).toEqual([]);
    expect(result.results).toEqual([]);
    expect(callerStore.findNearest).not.toHaveBeenCalled();
  });
});
