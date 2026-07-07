/**
 * Tests for SqliteCortexStore — regression coverage for embedding format handling.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteCortexStore } from './sqlite.js';
import type { Memory } from '../core/types.js';

interface StoreInternals {
  db: Database.Database;
}

function getDb(store: SqliteCortexStore): Database.Database {
  return (store as unknown as StoreInternals).db;
}

function insertMemoryWithRawEmbedding(
  store: SqliteCortexStore,
  id: string,
  embedding: Buffer | string,
): void {
  const now = new Date().toISOString();
  getDb(store)
    .prepare(
      `INSERT INTO memories (
        id, name, definition, category, salience, confidence, access_count,
        created_at, updated_at, last_accessed, source_files, embedding, tags
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, id, `${id} definition`, 'concept', 0.5, 0.5, 0, now, now, now, '[]', embedding, '[]');
}

describe('SqliteCortexStore.findNearest', () => {
  it('finds memories whose embedding is stored as a Float32Array BLOB', async () => {
    const store = new SqliteCortexStore(':memory:');
    const vector = [0.1, 0.2, 0.3, 0.4];
    const blob = Buffer.from(new Float32Array(vector).buffer);

    insertMemoryWithRawEmbedding(store, 'mem-blob', blob);

    const results = await store.findNearest(vector, 5);

    expect(results).toHaveLength(1);
    expect(results[0].memory.id).toBe('mem-blob');
    expect(results[0].score).toBeGreaterThan(0.99);
  });

  it('does not throw when some memories have empty embeddings', async () => {
    const store = new SqliteCortexStore(':memory:');
    const vector = [1, 0, 0, 0];
    const blob = Buffer.from(new Float32Array(vector).buffer);

    insertMemoryWithRawEmbedding(store, 'mem-empty', '[]');
    insertMemoryWithRawEmbedding(store, 'mem-good', blob);

    const results = await store.findNearest(vector, 5);

    expect(results.map(r => r.memory.id)).toContain('mem-good');
    expect(results.map(r => r.memory.id)).not.toContain('mem-empty');
  });
});

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

describe('embedding blob storage', () => {
  it('writes embeddings as BLOBs and reads them back at float32 precision', async () => {
    const store = new SqliteCortexStore(':memory:');
    const id = await store.putMemory(makeMemory({ embedding: [0.1, 0.2, 0.3] }));

    const stored = getDb(store)
      .prepare(`SELECT typeof(embedding) AS t FROM memories WHERE id = ?`)
      .get(id) as { t: string };
    expect(stored.t).toBe('blob');

    const memory = await store.getMemory(id);
    expect(memory!.embedding).toHaveLength(3);
    expect(memory!.embedding[0]).toBeCloseTo(0.1, 6);
    expect(memory!.embedding[1]).toBeCloseTo(0.2, 6);
    expect(memory!.embedding[2]).toBeCloseTo(0.3, 6);
  });

  it('updateMemory and upsertMemory also write BLOBs', async () => {
    const store = new SqliteCortexStore(':memory:');
    const id = await store.putMemory(makeMemory());

    await store.updateMemory(id, { embedding: [0.4, 0.5] });
    let row = getDb(store)
      .prepare(`SELECT typeof(embedding) AS t FROM memories WHERE id = ?`)
      .get(id) as { t: string };
    expect(row.t).toBe('blob');
    expect((await store.getMemory(id))!.embedding[0]).toBeCloseTo(0.4, 6);

    await store.upsertMemory({ ...(await store.getMemory(id))!, embedding: [0.6] });
    row = getDb(store)
      .prepare(`SELECT typeof(embedding) AS t FROM memories WHERE id = ?`)
      .get(id) as { t: string };
    expect(row.t).toBe('blob');
    expect((await store.getMemory(id))!.embedding[0]).toBeCloseTo(0.6, 6);
  });

  it('handles empty embeddings as zero-length BLOBs', async () => {
    const store = new SqliteCortexStore(':memory:');
    const id = await store.putMemory(makeMemory({ embedding: [] }));

    expect((await store.getMemory(id))!.embedding).toEqual([]);
  });

  it('stores observation embeddings as BLOBs and null stays null', async () => {
    const store = new SqliteCortexStore(':memory:');
    const now = new Date();
    const base = {
      content: 'obs', source_file: '', source_section: '', salience: 0.5,
      processed: false, prediction_error: null, created_at: now, updated_at: now,
      keywords: [], content_type: 'declarative' as const,
    };
    const withEmb = await store.putObservation({ ...base, embedding: [0.1, 0.9] });
    const withoutEmb = await store.putObservation({ ...base, embedding: null });

    const rows = getDb(store)
      .prepare(`SELECT id, typeof(embedding) AS t FROM observations`)
      .all() as { id: string; t: string }[];
    expect(rows.find(r => r.id === withEmb)!.t).toBe('blob');
    expect(rows.find(r => r.id === withoutEmb)!.t).toBe('null');

    const obs = (await store.getUnprocessedObservations(10)).find(o => o.id === withEmb);
    expect(obs!.embedding![1]).toBeCloseTo(0.9, 6);
  });
});

describe('legacy JSON-text embedding migration', () => {
  it('converts JSON-text embeddings to BLOBs when an existing DB is opened', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cortex-emb-'));
    const dbPath = join(dir, 'test.db');
    try {
      // Simulate a legacy row written by the pre-blob format.
      const store1 = new SqliteCortexStore(dbPath);
      insertMemoryWithRawEmbedding(store1, 'legacy', JSON.stringify([0.1, 0.2, 0.3]));
      getDb(store1).close();

      const store2 = new SqliteCortexStore(dbPath);
      const row = getDb(store2)
        .prepare(`SELECT typeof(embedding) AS t FROM memories WHERE id = 'legacy'`)
        .get() as { t: string };
      expect(row.t).toBe('blob');

      const memory = await store2.getMemory('legacy');
      expect(memory!.embedding).toHaveLength(3);
      expect(memory!.embedding[0]).toBeCloseTo(0.1, 6);

      // Migrated rows must remain searchable.
      const results = await store2.findNearest([0.1, 0.2, 0.3], 5);
      expect(results.map(r => r.memory.id)).toContain('legacy');
      getDb(store2).close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('converts legacy observation embeddings and leaves null untouched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cortex-emb-'));
    const dbPath = join(dir, 'test.db');
    try {
      const store1 = new SqliteCortexStore(dbPath);
      const now = new Date().toISOString();
      const insert = getDb(store1).prepare(
        `INSERT INTO observations (id, content, created_at, updated_at, embedding)
         VALUES (?, ?, ?, ?, ?)`,
      );
      insert.run('legacy-obs', 'text emb', now, now, JSON.stringify([1, 0]));
      insert.run('null-obs', 'no emb', now, now, null);
      getDb(store1).close();

      const store2 = new SqliteCortexStore(dbPath);
      const rows = getDb(store2)
        .prepare(`SELECT id, typeof(embedding) AS t FROM observations`)
        .all() as { id: string; t: string }[];
      expect(rows.find(r => r.id === 'legacy-obs')!.t).toBe('blob');
      expect(rows.find(r => r.id === 'null-obs')!.t).toBe('null');
      getDb(store2).close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent — reopening an already-converted DB changes nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cortex-emb-'));
    const dbPath = join(dir, 'test.db');
    try {
      const store1 = new SqliteCortexStore(dbPath);
      const id = await store1.putMemory(makeMemory({ embedding: [0.7, 0.8] }));
      getDb(store1).close();

      const store2 = new SqliteCortexStore(dbPath);
      const memory = await store2.getMemory(id);
      expect(memory!.embedding[0]).toBeCloseTo(0.7, 6);
      expect(memory!.embedding[1]).toBeCloseTo(0.8, 6);
      getDb(store2).close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('signals — first-class read/update', () => {
  it('round-trips putSignal through getSignal and getSignals', async () => {
    const store = new SqliteCortexStore(':memory:');
    const id = await store.putSignal({
      type: 'CONTRADICTION',
      description: 'obs disputes memory',
      concept_ids: ['mem-1'],
      priority: 0.8,
      resolved: false,
      created_at: new Date('2026-07-01T00:00:00Z'),
      resolution_note: null,
      observation_id: 'obs-1',
    });

    const signal = await store.getSignal(id);
    expect(signal).toMatchObject({
      id,
      type: 'CONTRADICTION',
      concept_ids: ['mem-1'],
      priority: 0.8,
      resolved: false,
      observation_id: 'obs-1',
    });

    // Regression: putSignal output must be visible to unresolved listing
    // (previously written to a table nothing read — see surface tool).
    const open = await store.getSignals({ resolved: false });
    expect(open.map((s) => s.id)).toContain(id);
  });

  it('updateSignal resolves a signal', async () => {
    const store = new SqliteCortexStore(':memory:');
    const id = await store.putSignal({
      type: 'TENSION',
      description: 'needs follow-up',
      concept_ids: [],
      priority: 0.5,
      resolved: false,
      created_at: new Date(),
      resolution_note: null,
    });

    const resolvedAt = new Date('2026-07-02T12:00:00Z');
    await store.updateSignal(id, {
      resolved: true,
      resolution_note: 'handled',
      resolved_at: resolvedAt,
    });

    const signal = await store.getSignal(id);
    expect(signal!.resolved).toBe(true);
    expect(signal!.resolution_note).toBe('handled');
    expect(signal!.resolved_at!.toISOString()).toBe(resolvedAt.toISOString());

    const open = await store.getSignals({ resolved: false });
    expect(open.map((s) => s.id)).not.toContain(id);
  });

  it('filters by type and applies limit with priority ordering', async () => {
    const store = new SqliteCortexStore(':memory:');
    await store.putSignal({
      type: 'GAP', description: 'low', concept_ids: [], priority: 0.2,
      resolved: false, created_at: new Date(), resolution_note: null,
    });
    await store.putSignal({
      type: 'CONTRADICTION', description: 'high', concept_ids: [], priority: 0.9,
      resolved: false, created_at: new Date(), resolution_note: null,
    });
    await store.putSignal({
      type: 'CONTRADICTION', description: 'mid', concept_ids: [], priority: 0.6,
      resolved: false, created_at: new Date(), resolution_note: null,
    });

    const contradictions = await store.getSignals({ type: 'CONTRADICTION' });
    expect(contradictions).toHaveLength(2);
    expect(contradictions[0].description).toBe('high');

    const limited = await store.getSignals({ resolved: false, limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0].description).toBe('high');
  });

  it('surfaces and updates legacy signals written through the generic API', async () => {
    const store = new SqliteCortexStore(':memory:');
    // Simulate a signal recorded by the old contradict tool.
    const legacyId = await store.put('signals', {
      type: 'CONTRADICTION',
      description: 'legacy signal',
      concept_ids: ['mem-9'],
      priority: 0.8,
      resolved: false,
      created_at: new Date().toISOString(),
      resolution_note: null,
      observation_id: 'obs-9',
    });

    const open = await store.getSignals({ resolved: false });
    const legacy = open.find((s) => s.id === legacyId);
    expect(legacy).toBeDefined();
    expect(legacy!.observation_id).toBe('obs-9');

    expect(await store.getSignal(legacyId)).not.toBeNull();

    await store.updateSignal(legacyId, { resolved: true, resolution_note: 'done' });
    const stillOpen = await store.getSignals({ resolved: false });
    expect(stillOpen.map((s) => s.id)).not.toContain(legacyId);
  });

  it('throws when updating a nonexistent signal', async () => {
    const store = new SqliteCortexStore(':memory:');
    await expect(store.updateSignal('no-such-id', { resolved: true }))
      .rejects.toThrow('Document not found');
  });
});

describe('beliefs — bitemporal fields', () => {
  it('round-trips valid_from and valid_to through putBelief/getBeliefHistory', async () => {
    const store = new SqliteCortexStore(':memory:');
    const validFrom = new Date('2026-06-01T00:00:00Z');

    await store.putBelief({
      concept_id: 'mem-1',
      old_definition: 'The user lives in Paris.',
      new_definition: 'The user lives in Berlin.',
      reason: 'Moved',
      changed_at: new Date('2026-07-06T10:00:00Z'),
      valid_from: validFrom,
      valid_to: null,
    });

    const history = await store.getBeliefHistory('mem-1');
    expect(history).toHaveLength(1);
    expect(history[0].valid_from!.toISOString()).toBe(validFrom.toISOString());
    expect(history[0].valid_to).toBeNull();
  });

  it('treats valid time as optional (legacy entries)', async () => {
    const store = new SqliteCortexStore(':memory:');
    await store.putBelief({
      concept_id: 'mem-2',
      old_definition: 'a',
      new_definition: 'b',
      reason: 'r',
      changed_at: new Date(),
    });

    const history = await store.getBeliefHistory('mem-2');
    expect(history[0].valid_from).toBeNull();
    expect(history[0].valid_to).toBeNull();
  });
});
