/**
 * Tests for JsonCortexStore — basic CRUD, capabilities, persistence,
 * upserts (ID-preserving), and atomic transactions.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { JsonCortexStore } from './json.js';
import type { Memory, Observation, Edge, OpsEntry, Signal, BeliefEntry } from '../core/types.js';

function freshFsrs(): Memory['fsrs'] {
  return {
    stability: 3.1262,
    difficulty: 7.2102,
    reps: 0,
    lapses: 0,
    state: 'new',
    last_review: null,
  };
}

function freshMemory(overrides: Partial<Memory> = {}): Memory {
  const now = new Date('2026-05-16T10:00:00.000Z');
  return {
    id: randomUUID(),
    name: 'test-memory',
    definition: 'a definition',
    category: 'topic',
    salience: 0.5,
    confidence: 0.5,
    access_count: 0,
    created_at: now,
    updated_at: now,
    last_accessed: now,
    source_files: [],
    embedding: [0.1, 0.2, 0.3],
    tags: ['t1'],
    fsrs: freshFsrs(),
    ...overrides,
  };
}

describe('JsonCortexStore', () => {
  let tmp: string;
  let path: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cortex-json-'));
    path = join(tmp, 'cortex.json');
  });

  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('initialises an empty file on construct', async () => {
    const store = new JsonCortexStore(path);
    expect(existsSync(path)).toBe(true);
    const caps = await store.getCapabilities();
    expect(caps.backend).toBe('json');
    expect(caps.embeddingDimension).toBe(0);
    expect(caps.namespace).toBe('');
  });

  it('round-trips a memory via putMemory/getMemory', async () => {
    const store = new JsonCortexStore(path);
    const m = freshMemory();
    const id = await store.putMemory({ ...m, id: undefined as unknown as string });
    const got = await store.getMemory(id);
    expect(got?.id).toBe(id);
    expect(got?.name).toBe(m.name);
    expect(got?.embedding).toEqual(m.embedding);
    expect(got?.created_at).toBeInstanceOf(Date);
  });

  it('persists on write and reloads identical data', async () => {
    {
      const store = new JsonCortexStore(path);
      await store.putMemory({ ...freshMemory({ name: 'persisted' }), id: undefined as unknown as string });
    }
    const reopened = new JsonCortexStore(path);
    const all = await reopened.getAllMemories();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe('persisted');
    expect(all[0].created_at).toBeInstanceOf(Date);
  });

  it('upsertMemory preserves the supplied id', async () => {
    const store = new JsonCortexStore(path);
    const m = freshMemory({ id: 'mem-fixed-id' });
    await store.upsertMemory(m);
    const got = await store.getMemory('mem-fixed-id');
    expect(got?.id).toBe('mem-fixed-id');
  });

  it('upsertMemory replaces existing data', async () => {
    const store = new JsonCortexStore(path);
    await store.upsertMemory(freshMemory({ id: 'm1', name: 'first' }));
    await store.upsertMemory(freshMemory({ id: 'm1', name: 'second' }));
    const got = await store.getMemory('m1');
    expect(got?.name).toBe('second');
  });

  it('findNearest returns sorted cosine matches', async () => {
    const store = new JsonCortexStore(path);
    await store.upsertMemory(freshMemory({ id: 'a', embedding: [1, 0, 0] }));
    await store.upsertMemory(freshMemory({ id: 'b', embedding: [0, 1, 0] }));
    await store.upsertMemory(freshMemory({ id: 'c', embedding: [0.9, 0.1, 0] }));
    const results = await store.findNearest([1, 0, 0], 2);
    expect(results).toHaveLength(2);
    expect(results[0].memory.id).toBe('a');
    expect(results[1].memory.id).toBe('c');
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it('findNearest skips faded memories', async () => {
    const store = new JsonCortexStore(path);
    await store.upsertMemory(freshMemory({ id: 'live', embedding: [1, 0, 0] }));
    await store.upsertMemory(freshMemory({ id: 'dead', embedding: [1, 0, 0], faded: true }));
    const results = await store.findNearest([1, 0, 0], 5);
    expect(results.map(r => r.memory.id)).toEqual(['live']);
  });

  it('round-trips observations, edges, ops, signals, beliefs via upserts', async () => {
    const store = new JsonCortexStore(path);
    const now = new Date('2026-05-16T10:00:00.000Z');

    const obs: Observation = {
      id: 'obs-1', content: 'a thing', source_file: 'f.md', source_section: 's',
      salience: 0.5, processed: false, prediction_error: null,
      created_at: now, updated_at: now, embedding: null,
      keywords: ['k'], content_type: 'declarative',
    };
    await store.upsertObservation(obs);

    const edge: Edge = {
      id: 'edge-1', source_id: 'm1', target_id: 'm2', relation: 'extends',
      weight: 0.5, evidence: 'why', created_at: now,
    };
    await store.upsertEdge(edge);

    const ops: OpsEntry = {
      id: 'ops-1', content: 'log', type: 'log', status: 'active',
      project: null, session_ref: 'sess', keywords: [],
      created_at: now, updated_at: now, expires_at: now,
    };
    await store.upsertOpsEntry(ops);

    const signal: Signal = {
      id: 'sig-1', type: 'CONTRADICTION', description: 'x vs y',
      concept_ids: ['m1', 'm2'], priority: 0.5, resolved: false,
      created_at: now, resolution_note: null,
    };
    await store.upsertSignal(signal);

    const belief: BeliefEntry = {
      id: 'bel-1', concept_id: 'm1', old_definition: 'old',
      new_definition: 'new', reason: 'because', changed_at: now,
    };
    await store.upsertBelief(belief);

    expect(await store.getUnprocessedObservations(10)).toHaveLength(1);
    expect(await store.getEdgesFrom('m1')).toHaveLength(1);
    expect(await store.queryOps({})).toHaveLength(1);
    expect(await store.getBeliefHistory('m1')).toHaveLength(1);

    // Reopen and check signals + listAll helpers
    const reopened = new JsonCortexStore(path);
    expect(reopened.listAllSignals()).toHaveLength(1);
    expect(reopened.listAllBeliefs()).toHaveLength(1);
    expect(reopened.listAllObservations()).toHaveLength(1);
    expect(reopened.listAllEdges()).toHaveLength(1);
    expect(reopened.listAllOps()).toHaveLength(1);
  });

  it('getCapabilities reports embedding dimension from first memory', async () => {
    const store = new JsonCortexStore(path);
    await store.upsertMemory(freshMemory({ id: 'm1', embedding: [0.1, 0.2, 0.3, 0.4] }));
    const caps = await store.getCapabilities();
    expect(caps.embeddingDimension).toBe(4);
    expect(caps.categories).toContain('topic');
  });

  it('withTransaction rolls back on throw', async () => {
    const store = new JsonCortexStore(path);
    await store.upsertMemory(freshMemory({ id: 'before' }));

    await expect(store.withTransaction(async txn => {
      await txn.upsertMemory(freshMemory({ id: 'inside' }));
      throw new Error('boom');
    })).rejects.toThrow('boom');

    expect(await store.getMemory('inside')).toBeNull();
    expect(await store.getMemory('before')).not.toBeNull();
  });

  it('withTransaction commits on success', async () => {
    const store = new JsonCortexStore(path);
    await store.withTransaction(async txn => {
      await txn.upsertMemory(freshMemory({ id: 'txn-mem' }));
      return undefined;
    });
    expect(await store.getMemory('txn-mem')).not.toBeNull();
  });

  it('generic collections: put/get/query/delete/count', async () => {
    const store = new JsonCortexStore(path);
    const id = await store.put('threads', { topic: 'x', open: true });
    expect(await store.get('threads', id)).toMatchObject({ topic: 'x', open: true });

    await store.put('threads', { topic: 'y', open: false });

    expect(await store.countDocuments('threads')).toBe(2);

    const open = await store.query('threads', [{ field: 'open', op: '==', value: true }]);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ topic: 'x' });

    await store.delete('threads', id);
    expect(await store.get('threads', id)).toBeNull();
    expect(await store.countDocuments('threads')).toBe(1);
  });

  it('rejects invalid namespaces', () => {
    expect(() => new JsonCortexStore(path, 'bad/ns')).toThrow(/Invalid namespace/);
  });
});
