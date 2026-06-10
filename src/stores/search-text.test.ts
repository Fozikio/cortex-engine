/**
 * Tests for searchText (FTS5 on SQLite, lexical fallback on JSON) and the
 * persistence of retrieval-feedback fields (last_retrieval_score,
 * last_hop_count, memory_origin) added in the Hermes-inspired hardening pass.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteCortexStore } from './sqlite.js';
import { JsonCortexStore } from './json.js';
import type { Memory } from '../core/types.js';

function makeMemory(overrides: Partial<Memory> = {}): Omit<Memory, 'id'> {
  const now = new Date();
  return {
    name: 'Test memory',
    definition: 'A memory about nothing in particular',
    category: 'topic',
    salience: 0.5,
    confidence: 0.5,
    access_count: 0,
    created_at: now,
    updated_at: now,
    last_accessed: now,
    source_files: [],
    embedding: [0.1, 0.2, 0.3],
    tags: [],
    fsrs: { stability: 1, difficulty: 5, reps: 0, lapses: 0, state: 'new', last_review: null },
    ...overrides,
  };
}

describe('SqliteCortexStore.searchText (FTS5)', () => {
  it('finds memories by keyword in name', async () => {
    const store = new SqliteCortexStore(':memory:');
    await store.putMemory(makeMemory({ name: 'Quantum entanglement basics' }));
    await store.putMemory(makeMemory({ name: 'Sourdough starter care' }));

    const results = await store.searchText('quantum', 5);

    expect(results).toHaveLength(1);
    expect(results[0].memory.name).toBe('Quantum entanglement basics');
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('finds memories by keyword in definition and tags', async () => {
    const store = new SqliteCortexStore(':memory:');
    await store.putMemory(makeMemory({
      name: 'Auth system',
      definition: 'The service uses JWT tokens with RS256 signing',
    }));
    await store.putMemory(makeMemory({
      name: 'Deploy pipeline',
      definition: 'CI runs on push',
      tags: ['kubernetes', 'helm'],
    }));

    expect((await store.searchText('JWT', 5))[0].memory.name).toBe('Auth system');
    expect((await store.searchText('kubernetes', 5))[0].memory.name).toBe('Deploy pipeline');
  });

  it('excludes faded memories', async () => {
    const store = new SqliteCortexStore(':memory:');
    await store.putMemory(makeMemory({ name: 'Visible quantum memory' }));
    await store.putMemory(makeMemory({ name: 'Faded quantum memory', faded: true }));

    const results = await store.searchText('quantum', 5);

    expect(results).toHaveLength(1);
    expect(results[0].memory.name).toBe('Visible quantum memory');
  });

  it('returns [] for empty or unmatched queries', async () => {
    const store = new SqliteCortexStore(':memory:');
    await store.putMemory(makeMemory({ name: 'Something' }));

    expect(await store.searchText('', 5)).toEqual([]);
    expect(await store.searchText('!!! ???', 5)).toEqual([]);
    expect(await store.searchText('zzzznonexistent', 5)).toEqual([]);
  });

  it('does not break on MATCH syntax characters in the query', async () => {
    const store = new SqliteCortexStore(':memory:');
    await store.putMemory(makeMemory({ name: 'Quote handling' }));

    // None of these may throw — tokens are quoted before reaching MATCH.
    await expect(store.searchText('"unbalanced', 5)).resolves.toBeDefined();
    await expect(store.searchText('a AND NOT (b', 5)).resolves.toBeDefined();
    await expect(store.searchText('col:value*', 5)).resolves.toBeDefined();
  });

  it('stays in sync after updateMemory', async () => {
    const store = new SqliteCortexStore(':memory:');
    const id = await store.putMemory(makeMemory({ name: 'Old topic name' }));

    await store.updateMemory(id, { name: 'Fresh xylophone research' });

    expect(await store.searchText('xylophone', 5)).toHaveLength(1);
    expect(await store.searchText('old topic', 5)).toHaveLength(0);
  });

  it('stays in sync after upsertMemory (INSERT OR REPLACE path)', async () => {
    const store = new SqliteCortexStore(':memory:');
    const id = await store.putMemory(makeMemory({ name: 'Original zebra entry' }));
    const memory = await store.getMemory(id);

    await store.upsertMemory({ ...memory!, name: 'Replaced walrus entry' });

    expect(await store.searchText('walrus', 5)).toHaveLength(1);
    expect(await store.searchText('zebra', 5)).toHaveLength(0);
  });

  it('rebuilds the FTS index for pre-existing databases', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cortex-fts-'));
    const dbPath = join(dir, 'test.db');
    try {
      // Seed with one store instance, search with a second (simulates a DB
      // created before the FTS table existed — the rebuild only fires when
      // the FTS table is first created, which happens in instance 1 here,
      // but reopening must not duplicate or lose rows).
      const store1 = new SqliteCortexStore(dbPath);
      await store1.putMemory(makeMemory({ name: 'Persistent giraffe fact' }));

      const store2 = new SqliteCortexStore(dbPath);
      const results = await store2.searchText('giraffe', 5);
      expect(results).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('JsonCortexStore.searchText (lexical fallback)', () => {
  it('finds matches and ranks name hits above definition hits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cortex-json-'));
    try {
      const store = new JsonCortexStore(join(dir, 'test.json'));
      await store.putMemory(makeMemory({
        name: 'Banana cultivation',
        definition: 'Growing tropical fruit',
      }));
      await store.putMemory(makeMemory({
        name: 'Grocery list',
        definition: 'Need to buy banana and milk',
      }));
      await store.putMemory(makeMemory({ name: 'Unrelated', definition: 'Nothing here' }));

      const results = await store.searchText('banana', 5);

      expect(results).toHaveLength(2);
      expect(results[0].memory.name).toBe('Banana cultivation');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('excludes faded memories', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cortex-json-'));
    try {
      const store = new JsonCortexStore(join(dir, 'test.json'));
      await store.putMemory(makeMemory({ name: 'Faded falcon', faded: true }));

      expect(await store.searchText('falcon', 5)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('retrieval-feedback field persistence (SQLite)', () => {
  it('persists memory_origin through putMemory', async () => {
    const store = new SqliteCortexStore(':memory:');
    const id = await store.putMemory(makeMemory({ memory_origin: 'dream' }));

    expect((await store.getMemory(id))!.memory_origin).toBe('dream');
  });

  it('persists last_retrieval_score and last_hop_count through updateMemory', async () => {
    const store = new SqliteCortexStore(':memory:');
    const id = await store.putMemory(makeMemory());

    await store.updateMemory(id, { last_retrieval_score: 0.93, last_hop_count: 1 });

    const memory = await store.getMemory(id);
    expect(memory!.last_retrieval_score).toBeCloseTo(0.93);
    expect(memory!.last_hop_count).toBe(1);
  });

  it('returns undefined for fields never set', async () => {
    const store = new SqliteCortexStore(':memory:');
    const id = await store.putMemory(makeMemory());

    const memory = await store.getMemory(id);
    expect(memory!.last_retrieval_score).toBeUndefined();
    expect(memory!.last_hop_count).toBeUndefined();
    expect(memory!.memory_origin).toBeUndefined();
  });

  it('survives an upsert round-trip', async () => {
    const store = new SqliteCortexStore(':memory:');
    const id = await store.putMemory(makeMemory({ memory_origin: 'abstract' }));
    await store.updateMemory(id, { last_retrieval_score: 0.8, last_hop_count: 2 });

    const memory = await store.getMemory(id);
    await store.upsertMemory(memory!);

    const after = await store.getMemory(id);
    expect(after!.memory_origin).toBe('abstract');
    expect(after!.last_retrieval_score).toBeCloseTo(0.8);
    expect(after!.last_hop_count).toBe(2);
  });
});
