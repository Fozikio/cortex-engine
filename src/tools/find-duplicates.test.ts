/**
 * Tests for find_duplicates tool.
 *
 * Focus: the historical "4-copy cluster" bug where find_duplicates only
 * reported 3 pairs out of a true 4-copy cluster because hardcoded
 * findNearest(k=3) clipped one match. After the fix, max_candidates
 * exposes this width; default raised to 10.
 */

import { describe, it, expect, vi } from 'vitest';
import { findDuplicatesTool } from './find-duplicates.js';
import type { ToolContext } from '../mcp/tools.js';
import type { Memory } from '../core/types.js';

const NOW = new Date('2026-05-17T00:00:00.000Z');

function mem(id: string, name: string, updatedDaysAgo = 0, salience = 0.7): Memory {
  return {
    id,
    name,
    definition: `Definition of ${name}`,
    category: 'topic',
    salience,
    confidence: 0.7,
    access_count: 0,
    created_at: new Date(NOW.getTime() - updatedDaysAgo * 86400000),
    updated_at: new Date(NOW.getTime() - updatedDaysAgo * 86400000),
    last_accessed: NOW,
    source_files: [],
    embedding: [0.1, 0.2, 0.3],
    tags: [],
    fsrs: {
      stability: 3.1262,
      difficulty: 7.2102,
      reps: 0,
      lapses: 0,
      state: 'new',
      last_review: null,
    },
  };
}

function ctxWithStore(memories: Memory[]): ToolContext {
  const store = {
    getAllMemories: vi.fn().mockResolvedValue(memories),
    findNearest: vi.fn((_emb: number[], k: number) =>
      Promise.resolve(
        // Return memories ranked by id (deterministic) up to k, all scoring 1.0 (perfect duplicates)
        [...memories]
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, k)
          .map((m) => ({ memory: m, score: 1.0 })),
      ),
    ),
    getMemory: vi.fn((id: string) =>
      Promise.resolve(memories.find((m) => m.id === id) ?? null),
    ),
    updateMemory: vi.fn().mockResolvedValue(undefined),
  };
  return {
    namespaces: { getStore: () => store } as unknown as ToolContext['namespaces'],
    embed: {} as ToolContext['embed'],
    llm: {} as ToolContext['llm'],
    session: {} as ToolContext['session'],
    triggers: {} as ToolContext['triggers'],
    bridges: {} as ToolContext['bridges'],
    allTools: [],
  };
}

describe('find_duplicates', () => {
  it('finds all C(n,2) pairs in a perfect-duplicate cluster of 4', async () => {
    const cluster = [
      mem('a', 'On Taste'),
      mem('b', 'On Taste'),
      mem('c', 'On Taste'),
      mem('d', 'On Taste'),
    ];
    const ctx = ctxWithStore(cluster);
    const result = (await findDuplicatesTool.handler({}, ctx)) as {
      duplicates_found: number;
      pairs: Array<{ a: { id: string }; b: { id: string } }>;
    };
    // 4 memories, all perfect duplicates → C(4,2) = 6 unique pairs
    expect(result.duplicates_found).toBe(6);
    const pairKeys = result.pairs.map((p) => [p.a.id, p.b.id].sort().join(':')).sort();
    expect(pairKeys).toEqual(['a:b', 'a:c', 'a:d', 'b:c', 'b:d', 'c:d']);
  });

  it('regression: cold 4th copy used to be invisible (old k=3 + scan_limit clipped it)', async () => {
    // Real bug from 2026-05-17: 4 copies of "On Taste" existed; 3 were
    // recently touched (in scan window), the 4th had been sitting cold.
    // Old behavior: scan_limit=3 picks recent 3, findNearest(k=3) returns
    // those same 3 → cold 4th never appears as a candidate. Result: only
    // C(3,2)=3 pairs reported instead of the true C(4,2)=6.
    const cluster = [
      mem('a', 'On Taste', 0), // newest
      mem('b', 'On Taste', 0),
      mem('c', 'On Taste', 0),
      mem('d', 'On Taste', 60), // cold — touched 60 days ago
    ];
    const ctx = ctxWithStore(cluster);
    // max_candidates=2 → findNearest k=3, returns first 3 by id sort = [a,b,c]
    // scan_limit=3 → only [a,b,c] anchor scans
    // Result: 'd' is never seen anywhere. Pairs: (a,b),(a,c),(b,c) = 3.
    const result = (await findDuplicatesTool.handler(
      { scan_limit: 3, max_candidates: 2 },
      ctx,
    )) as { duplicates_found: number };
    expect(result.duplicates_found).toBe(3);

    // After fix: with larger max_candidates the cold 4th becomes visible
    // (as a candidate to the recent 3) even with scan_limit=3.
    const result2 = (await findDuplicatesTool.handler(
      { scan_limit: 3, max_candidates: 10 },
      ctxWithStore(cluster),
    )) as { duplicates_found: number };
    expect(result2.duplicates_found).toBe(6);
  });

  it('respects scan_limit: only scans top-N most-recently-updated', async () => {
    // Build 10 memories with different ages. Only the 3 newest should anchor scans.
    const memories = Array.from({ length: 10 }, (_, i) =>
      mem(`m${i}`, `Memory ${i}`, i /* days ago */),
    );
    const ctx = ctxWithStore(memories);
    const result = (await findDuplicatesTool.handler({ scan_limit: 3 }, ctx)) as {
      scanned: number;
      total_memories: number;
    };
    expect(result.scanned).toBe(3);
    expect(result.total_memories).toBe(10);
  });

  it('returns scanned + total_memories metadata for visibility', async () => {
    const ctx = ctxWithStore([mem('a', 'x'), mem('b', 'y')]);
    const result = (await findDuplicatesTool.handler({}, ctx)) as {
      scanned: number;
      total_memories: number;
    };
    expect(result.scanned).toBe(2);
    expect(result.total_memories).toBe(2);
  });

  it('clamps scan_limit and max_candidates to safe maxima', async () => {
    const memories = [mem('a', 'x')];
    const ctx = ctxWithStore(memories);
    const store = ctx.namespaces.getStore();
    await findDuplicatesTool.handler(
      { scan_limit: 99999, max_candidates: 99999 },
      ctx,
    );
    // findNearest should be called with k = MAX_CANDIDATES_CAP + 1 = 51, not 100000
    const firstCall = (store as unknown as { findNearest: { mock: { calls: unknown[][] } } })
      .findNearest.mock.calls[0];
    expect(firstCall[1]).toBeLessThanOrEqual(51);
  });

  it('handles empty store gracefully', async () => {
    const ctx = ctxWithStore([]);
    const result = (await findDuplicatesTool.handler({}, ctx)) as {
      duplicates_found: number;
      scanned: number;
    };
    expect(result.duplicates_found).toBe(0);
    expect(result.scanned).toBe(0);
  });
});
