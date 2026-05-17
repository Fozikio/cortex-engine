/**
 * Integration tests for migrate-cmd.
 *
 * Most cases use the SQLite <-> JSON path because both backends are local and
 * exercise the iteration adapters that migrate-cmd uses for stages the public
 * CortexStore interface doesn't expose (signals, beliefs, generic).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  migrate,
  MIGRATION_STAGES,
  assertCompatibility,
  loadCheckpoint,
  saveCheckpoint,
  parseArgs,
  verifyMigration,
} from './migrate-cmd.js';
import { SqliteCortexStore } from '../stores/sqlite.js';
import { JsonCortexStore } from '../stores/json.js';
import type { Memory, Observation, Edge, OpsEntry, Signal, BeliefEntry } from '../core/types.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function fsrs(): Memory['fsrs'] {
  return {
    stability: 3.1262, difficulty: 7.2102, reps: 0, lapses: 0,
    state: 'new', last_review: null,
  };
}

function makeMemory(id: string, opts: Partial<Memory> = {}): Memory {
  const now = new Date('2026-05-16T10:00:00.000Z');
  return {
    id, name: `name-${id}`, definition: `def-${id}`,
    category: 'topic', salience: 0.5, confidence: 0.5,
    access_count: 0, created_at: now, updated_at: now, last_accessed: now,
    source_files: [], embedding: [0.1, 0.2, 0.3], tags: ['t'],
    fsrs: fsrs(), ...opts,
  };
}

function makeObservation(id: string, opts: Partial<Observation> = {}): Observation {
  const now = new Date('2026-05-16T10:00:00.000Z');
  return {
    id, content: `obs-${id}`, source_file: 'f.md', source_section: 's',
    salience: 0.5, processed: false, prediction_error: null,
    created_at: now, updated_at: now, embedding: null,
    keywords: ['k'], content_type: 'declarative', ...opts,
  };
}

function makeEdge(id: string, src: string, tgt: string): Edge {
  return {
    id, source_id: src, target_id: tgt, relation: 'extends',
    weight: 0.5, evidence: 'why', created_at: new Date('2026-05-16T10:00:00.000Z'),
  };
}

function makeOps(id: string, opts: Partial<OpsEntry> = {}): OpsEntry {
  const now = new Date('2026-05-16T10:00:00.000Z');
  return {
    id, content: `ops-${id}`, type: 'log', status: 'active',
    project: null, session_ref: 'sess', keywords: [],
    created_at: now, updated_at: now, expires_at: now, ...opts,
  };
}

function makeSignal(id: string): Signal {
  return {
    id, type: 'CONTRADICTION', description: `sig-${id}`,
    concept_ids: ['m1', 'm2'], priority: 0.5, resolved: false,
    created_at: new Date('2026-05-16T10:00:00.000Z'),
    resolution_note: null,
  };
}

function makeBelief(id: string, conceptId: string): BeliefEntry {
  return {
    id, concept_id: conceptId, old_definition: 'old',
    new_definition: 'new', reason: 'because',
    changed_at: new Date('2026-05-16T10:00:00.000Z'),
  };
}

async function seedStore(store: SqliteCortexStore | JsonCortexStore): Promise<{
  memoryIds: string[];
  observationIds: string[];
  edgeIds: string[];
  opsIds: string[];
  signalIds: string[];
  beliefIds: string[];
  genericIds: string[];
}> {
  const memoryIds = ['mem-1', 'mem-2', 'mem-3'];
  for (const id of memoryIds) {
    await store.upsertMemory(makeMemory(id));
  }

  const observationIds = ['obs-1', 'obs-2'];
  for (const id of observationIds) {
    await store.upsertObservation(makeObservation(id));
  }

  const edgeIds = ['edge-1', 'edge-2'];
  await store.upsertEdge(makeEdge('edge-1', 'mem-1', 'mem-2'));
  await store.upsertEdge(makeEdge('edge-2', 'mem-2', 'mem-3'));

  const opsIds = ['ops-1', 'ops-2'];
  await store.upsertOpsEntry(makeOps('ops-1', { project: 'alpha' }));
  await store.upsertOpsEntry(makeOps('ops-2', { project: null }));

  const signalIds = ['sig-1', 'sig-2'];
  for (const id of signalIds) {
    await store.upsertSignal(makeSignal(id));
  }

  const beliefIds = ['bel-1', 'bel-2'];
  await store.upsertBelief(makeBelief('bel-1', 'mem-1'));
  await store.upsertBelief(makeBelief('bel-2', 'mem-1'));

  const id1 = await store.put('threads', { id: 'thr-1', title: 'first', open: true });
  const id2 = await store.put('threads', { id: 'thr-2', title: 'second', open: false });

  return {
    memoryIds, observationIds, edgeIds, opsIds, signalIds, beliefIds,
    genericIds: [id1, id2],
  };
}

// ─── Test harness ─────────────────────────────────────────────────────────────

describe('migrate', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cortex-migrate-'));
  });

  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  function paths() {
    return {
      sqlite1: join(tmp, 'src.db'),
      sqlite2: join(tmp, 'dst.db'),
      json1: join(tmp, 'mid.json'),
      checkpoint: join(tmp, '.cortex-migrate-state.json'),
    };
  }

  // ─── Golden-path round trip ────────────────────────────────────────────────

  it('round-trip: sqlite -> json -> fresh sqlite preserves ids and data', async () => {
    const p = paths();

    const src = new SqliteCortexStore(p.sqlite1);
    const seeded = await seedStore(src);

    await migrate({
      from: `sqlite:${p.sqlite1}`,
      to: `json:${p.json1}`,
      checkpointPath: p.checkpoint,
      logger: () => {},
    });

    // First leg lands everything in JSON
    const mid = new JsonCortexStore(p.json1);
    expect((await mid.getAllMemories()).map(m => m.id).sort()).toEqual(seeded.memoryIds.slice().sort());
    expect(mid.listAllSignals().map(s => s.id).sort()).toEqual(seeded.signalIds.slice().sort());

    // Second leg copies the JSON into a fresh SQLite
    await migrate({
      from: `json:${p.json1}`,
      to: `sqlite:${p.sqlite2}`,
      checkpointPath: p.checkpoint,
      logger: () => {},
    });

    const dst = new SqliteCortexStore(p.sqlite2);
    const dstMems = await dst.getAllMemories();
    expect(dstMems.map(m => m.id).sort()).toEqual(seeded.memoryIds.slice().sort());

    // ID-equality + value-equality memory by memory
    for (const id of seeded.memoryIds) {
      const a = await src.getMemory(id);
      const b = await dst.getMemory(id);
      expect(b).not.toBeNull();
      expect(b!.id).toBe(a!.id);
      expect(b!.name).toBe(a!.name);
      expect(b!.embedding).toEqual(a!.embedding);
    }

    // Generic docs round-trip
    const dstThread1 = await dst.get('threads', 'thr-1');
    expect(dstThread1).toMatchObject({ id: 'thr-1', title: 'first', open: true });

    // Verification mode is clean across the full round-trip
    const report = await verifyMigration(src, dst);
    expect(report.ok).toBe(true);
    expect(report.perKind.memories.srcCount).toBe(report.perKind.memories.dstCount);
    expect(report.perKind.signals.srcCount).toBe(report.perKind.signals.dstCount);
    expect(report.perKind.generic.srcCount).toBe(report.perKind.generic.dstCount);
  });

  // ─── Resume from checkpoint ────────────────────────────────────────────────

  it('resumes from a checkpoint that marks memories done', async () => {
    const p = paths();

    const src = new SqliteCortexStore(p.sqlite1);
    await seedStore(src);

    // Pre-write a checkpoint claiming memories+observations are already done
    // but later stages (edges, ops, signals, beliefs, generic) are not.
    const preCheckpoint = {
      startedAt: new Date().toISOString(),
      srcUrl: `sqlite:${p.sqlite1}`,
      dstUrl: `json:${p.json1}`,
      memories: 'done',
      observations: 'done',
      edges: null,
      ops: null,
      signals: null,
      beliefs: null,
      generic: null,
    };
    saveCheckpoint(p.checkpoint, preCheckpoint);

    await migrate({
      from: `sqlite:${p.sqlite1}`,
      to: `json:${p.json1}`,
      resume: true,
      checkpointPath: p.checkpoint,
      logger: () => {},
    });

    // Memories were skipped because checkpoint said 'done', so the JSON store
    // should NOT have memories.
    const mid = new JsonCortexStore(p.json1);
    expect(await mid.getAllMemories()).toHaveLength(0);
    expect(mid.listAllObservations()).toHaveLength(0);
    // But edges, ops, signals, beliefs, generic were not 'done', so they migrated.
    expect(mid.listAllSignals()).toHaveLength(2);
    expect(mid.listAllBeliefs()).toHaveLength(2);

    // Checkpoint should be removed on success.
    expect(existsSync(p.checkpoint)).toBe(false);
  });

  it('refuses to resume against a different source URL', async () => {
    const p = paths();
    new SqliteCortexStore(p.sqlite1); // create files

    saveCheckpoint(p.checkpoint, {
      startedAt: new Date().toISOString(),
      srcUrl: `sqlite:/some/other/db.sqlite`,
      dstUrl: `json:${p.json1}`,
      memories: null, observations: null, edges: null, ops: null,
      signals: null, beliefs: null, generic: null,
    });

    await expect(migrate({
      from: `sqlite:${p.sqlite1}`,
      to: `json:${p.json1}`,
      resume: true,
      checkpointPath: p.checkpoint,
      logger: () => {},
    })).rejects.toThrow(/different source/);
  });

  // ─── Compatibility failure ────────────────────────────────────────────────

  it('aborts before any writes when embedding dimensions differ', async () => {
    const p = paths();
    const src = new SqliteCortexStore(p.sqlite1);
    await src.upsertMemory(makeMemory('m1', { embedding: [1, 2, 3, 4] })); // dim=4

    const dst = new SqliteCortexStore(p.sqlite2);
    await dst.upsertMemory(makeMemory('m-dst', { embedding: [1, 2, 3] })); // dim=3

    await expect(migrate({
      from: `sqlite:${p.sqlite1}`,
      to: `sqlite:${p.sqlite2}`,
      allowMerge: true, // skip the "non-empty" guard so we test the embedding check
      checkpointPath: p.checkpoint,
      logger: () => {},
    })).rejects.toThrow(/Embedding dimension mismatch/);

    // Confirm destination still has only its original memory (no new writes).
    const after = await dst.getAllMemories();
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe('m-dst');
  });

  it('aborts when destination is non-empty without --allow-merge', async () => {
    const p = paths();
    new SqliteCortexStore(p.sqlite1);
    const dst = new SqliteCortexStore(p.sqlite2);
    await dst.upsertMemory(makeMemory('existing'));

    await expect(migrate({
      from: `sqlite:${p.sqlite1}`,
      to: `sqlite:${p.sqlite2}`,
      checkpointPath: p.checkpoint,
      logger: () => {},
    })).rejects.toThrow(/not empty.*--allow-merge/);
  });

  // ─── Namespace rename ─────────────────────────────────────────────────────

  it('rewrites OpsEntry.project under --rename-namespace', async () => {
    const p = paths();
    const src = new SqliteCortexStore(p.sqlite1);
    await src.upsertOpsEntry(makeOps('ops-a', { project: 'alpha' }));
    await src.upsertOpsEntry(makeOps('ops-b', { project: 'beta' }));

    await migrate({
      from: `sqlite:${p.sqlite1}`,
      to: `json:${p.json1}`,
      renameNamespace: { src: 'alpha', dst: 'gamma' },
      checkpointPath: p.checkpoint,
      logger: () => {},
    });

    const mid = new JsonCortexStore(p.json1);
    const ops = await mid.queryOps({});
    const byId = new Map(ops.map(o => [o.id, o]));
    expect(byId.get('ops-a')?.project).toBe('gamma');
    expect(byId.get('ops-b')?.project).toBe('beta');
  });

  // ─── Dry run ──────────────────────────────────────────────────────────────

  it('--dry-run validates without writing', async () => {
    const p = paths();
    const src = new SqliteCortexStore(p.sqlite1);
    await seedStore(src);

    // Destination file should not exist before the call.
    expect(existsSync(p.json1)).toBe(false);

    await migrate({
      from: `sqlite:${p.sqlite1}`,
      to: `json:${p.json1}`,
      dryRun: true,
      checkpointPath: p.checkpoint,
      logger: () => {},
    });

    // JsonCortexStore writes an empty container on construction. That's a
    // read of capabilities, not a migrated write, so the file may exist but
    // must contain zero memories.
    if (existsSync(p.json1)) {
      const data = JSON.parse(readFileSync(p.json1, 'utf-8')) as { memories: Record<string, unknown> };
      expect(Object.keys(data.memories ?? {})).toHaveLength(0);
    }
    expect(existsSync(p.checkpoint)).toBe(false);
  });

  // ─── parseArgs ────────────────────────────────────────────────────────────

  it('parseArgs accepts the documented flags', () => {
    const args = parseArgs([
      '--from', 'sqlite:./src.db',
      '--to', 'json:./out.json',
      '--namespace', 'alpha',
      '--rename-namespace', 'alpha=beta',
      '--resume', '--verify', '--allow-merge',
      '--batch-size', '50',
    ]);
    expect(args.from).toBe('sqlite:./src.db');
    expect(args.to).toBe('json:./out.json');
    expect(args.namespace).toBe('alpha');
    expect(args.renameNamespace).toEqual({ src: 'alpha', dst: 'beta' });
    expect(args.resume).toBe(true);
    expect(args.verify).toBe(true);
    expect(args.allowMerge).toBe(true);
    expect(args.batchSize).toBe(50);
  });

  it('parseArgs rejects an invalid --rename-namespace value', () => {
    expect(() => parseArgs(['--rename-namespace', 'noequals'])).toThrow(/<src>=<dst>/);
  });

  it('parseArgs rejects unknown flags', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(/Unknown migrate flag/);
  });

  // ─── Compatibility helper ─────────────────────────────────────────────────

  it('assertCompatibility passes for two empty same-schema stores', async () => {
    const p = paths();
    const src = new SqliteCortexStore(p.sqlite1);
    const dst = new SqliteCortexStore(p.sqlite2);
    await expect(assertCompatibility(src, dst, { allowMerge: false })).resolves.toBeUndefined();
  });

  // ─── Checkpoint helpers ───────────────────────────────────────────────────

  it('saveCheckpoint writes atomically and loadCheckpoint reads it back', () => {
    const path = join(tmp, '.cp.json');
    const cp = {
      startedAt: '2026-05-16T00:00:00Z',
      srcUrl: 'sqlite:./a.db', dstUrl: 'json:./b.json',
      memories: 'done', observations: null, edges: null,
      ops: null, signals: null, beliefs: null, generic: null,
    };
    saveCheckpoint(path, cp);
    expect(existsSync(path)).toBe(true);
    expect(loadCheckpoint(path)).toEqual(cp);
  });

  it('loadCheckpoint returns null for malformed JSON', () => {
    const path = join(tmp, '.cp-bad.json');
    writeFileSync(path, '{not valid json');
    expect(loadCheckpoint(path)).toBeNull();
  });

  // ─── Migration stage order ────────────────────────────────────────────────

  it('MIGRATION_STAGES runs in dependency-safe order', () => {
    expect(MIGRATION_STAGES).toEqual([
      'memories', 'observations', 'edges', 'ops', 'signals', 'beliefs', 'generic',
    ]);
  });
});
