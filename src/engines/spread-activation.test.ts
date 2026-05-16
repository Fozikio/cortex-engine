/**
 * Regression test for the HyDE query crash:
 *   "Cannot read properties of undefined (reading 'length')"
 *
 * Bug: spreadActivation accessed memory.embedding.length without guarding
 * against the `number[] | null` type. After consolidation, some memories
 * may land with embedding = null, causing the query path to crash.
 *
 * Fix: add the null guard at memory.ts:191.
 */

import { describe, it, expect, vi } from 'vitest';
import { spreadActivation } from './memory.js';
import type { CortexStore } from '../core/store.js';
import type { Memory, SearchResult, Edge } from '../core/types.js';

function makeMemory(id: string, embedding: number[] | null): Memory {
  return {
    id,
    name: `Memory ${id}`,
    definition: `Definition of ${id}`,
    category: 'observation',
    salience: 0.5,
    confidence: 0.8,
    access_count: 0,
    created_at: new Date(),
    updated_at: new Date(),
    last_accessed: new Date(),
    source_files: [],
    embedding: embedding as number[],
    tags: [],
    fsrs: {
      stability: 1,
      difficulty: 0.5,
      reps: 0,
      lapses: 0,
      state: 'new',
      last_review: null,
    },
  };
}

function makeSearchResult(memory: Memory, score: number): SearchResult {
  return {
    memory: {
      id: memory.id,
      name: memory.name,
      definition: memory.definition,
      category: memory.category,
      salience: memory.salience,
      confidence: memory.confidence,
      access_count: memory.access_count,
      updated_at: memory.updated_at,
      tags: memory.tags,
      fsrs: memory.fsrs,
    },
    score,
    distance: 1 - score,
  };
}

describe('spreadActivation null-embedding regression', () => {
  it('does not crash when a neighbor has null embedding under HyDE query path', async () => {
    const memA = makeMemory('a', [1, 0]);
    const memB = makeMemory('b', null);
    const memories = new Map<string, Memory>([['a', memA], ['b', memB]]);

    const edgeAB: Edge = {
      id: 'e1',
      source_id: 'a',
      target_id: 'b',
      relation: 'related',
      weight: 1,
      evidence: 'test',
      created_at: new Date(),
    };
    const edges = new Map<string, Edge[]>([['a', [edgeAB]]]);

    const store = {
      findNearest: vi.fn(),
      getMemory: vi.fn((id: string) => Promise.resolve(memories.get(id) ?? null)),
      getEdgesFrom: vi.fn((id: string) => Promise.resolve(edges.get(id) ?? [])),
      getEdgesForMemories: vi.fn((ids: string[]) =>
        Promise.resolve(ids.flatMap((id) => edges.get(id) ?? [])),
      ),
      putMemory: vi.fn(),
      updateMemory: vi.fn(),
      touchMemory: vi.fn(),
      getAllMemories: vi.fn(),
      getRecentMemories: vi.fn(),
      putObservation: vi.fn(),
      getUnprocessedObservations: vi.fn(),
      markObservationProcessed: vi.fn(),
      putEdge: vi.fn(),
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

    const srA = makeSearchResult(memA, 0.9);

    const result = await spreadActivation(store, [srA], [1, 0]);

    expect(result.some((r) => r.memory.id === 'a')).toBe(true);
    expect(result.length).toBeGreaterThanOrEqual(1);
  });
});
