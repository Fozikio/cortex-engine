/**
 * Typed observation and belief reads (#122, #123).
 *
 * observe/wonder/speculate write observations through putObservation and
 * believe writes typed belief entries; recall and contradict used to read
 * them back through the generic collection API, which on SQLite and JSON is
 * a different store, so recall always answered 0 and contradict always
 * answered "not found". These tests pin the typed reads on both local stores,
 * the legacy generic-collection fallback, and the two tools end to end.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { SqliteCortexStore } from './sqlite.js';
import { JsonCortexStore } from './json.js';
import type { CortexStore } from '../core/store.js';
import type { Memory, Observation } from '../core/types.js';
import type { ToolContext } from '../mcp/tools.js';
import { recallTool } from '../tools/recall.js';
import { contradictTool } from '../tools/contradict.js';
import { noticeTool } from '../tools/notice.js';

const DAY = 24 * 60 * 60 * 1000;
const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function jsonStore(): JsonCortexStore {
  const dir = mkdtempSync(join(tmpdir(), 'cortex-typed-reads-'));
  tmpDirs.push(dir);
  return new JsonCortexStore(join(dir, 'store.json'));
}

const STORES: Array<[string, () => CortexStore]> = [
  ['sqlite', () => new SqliteCortexStore(':memory:')],
  ['json', jsonStore],
];

function obs(content: string, overrides: Partial<Omit<Observation, 'id'>> = {}): Omit<Observation, 'id'> {
  const at = overrides.created_at ?? new Date();
  return {
    content,
    source_file: '',
    source_section: '',
    salience: 0.5,
    processed: false,
    prediction_error: null,
    created_at: at,
    updated_at: at,
    embedding: null,
    keywords: [],
    content_type: 'declarative',
    ...overrides,
  };
}

function memory(definition: string): Omit<Memory, 'id'> {
  const now = new Date();
  return {
    name: 'Tension floor',
    definition,
    category: 'belief',
    salience: 0.6,
    confidence: 0.8,
    access_count: 0,
    created_at: now,
    updated_at: now,
    last_accessed: now,
    source_files: [],
    embedding: [1, 0, 0],
    tags: [],
    fsrs: { stability: 10, difficulty: 5, reps: 1, lapses: 0, state: 'review', last_review: now },
  };
}

function ctxFor(store: CortexStore): ToolContext {
  return {
    namespaces: {
      getStore: vi.fn(() => store),
      getDefaultNamespace: vi.fn(() => 'default'),
      getConfig: vi.fn(() => ({})),
    },
    session: { getProvenance: vi.fn(() => undefined) },
    triggers: { getTriggersForEventInNamespace: vi.fn(() => []) },
    bridges: { getRulesForEvent: vi.fn(() => []) },
    allTools: [],
  } as unknown as ToolContext;
}

describe.each(STORES)('typed observation reads — %s store', (_name, make) => {
  it('getObservation finds an observation written by putObservation', async () => {
    const store = make();
    const id = await store.putObservation(obs('The tension floor sits at 0.8.'));
    const found = await store.getObservation(id);
    expect(found?.id).toBe(id);
    expect(found?.content).toBe('The tension floor sits at 0.8.');
    expect(await store.getObservation('missing')).toBeNull();
  });

  it('queryObservations filters by window and content_type, newest first, with a limit', async () => {
    const store = make();
    const now = Date.now();
    await store.putObservation(obs('old question', { content_type: 'interrogative', created_at: new Date(now - 10 * DAY) }));
    const q1 = await store.putObservation(obs('question one', { content_type: 'interrogative', created_at: new Date(now - 2 * DAY) }));
    const q2 = await store.putObservation(obs('question two', { content_type: 'interrogative', created_at: new Date(now - DAY) }));
    await store.putObservation(obs('a fact', { created_at: new Date(now - DAY) }));

    const since = new Date(now - 3 * DAY);
    const questions = await store.queryObservations({ since, content_type: 'interrogative' });
    expect(questions.map(o => o.id)).toEqual([q2, q1]);

    expect((await store.queryObservations({ since, limit: 1 })).length).toBe(1);
    expect((await store.queryObservations({ since, content_type: 'interrogative', order: 'asc' })).map(o => o.id))
      .toEqual([q1, q2]);
    expect((await store.queryObservations({ until: since })).map(o => o.content)).toEqual(['old question']);
  });

  it('queryObservations filters processed state and prediction_error presence', async () => {
    const store = make();
    const a = await store.putObservation(obs('scored', { prediction_error: 0.2 }));
    await store.putObservation(obs('unscored'));
    await store.markObservationProcessed(a);
    expect((await store.queryObservations({ processed: true })).map(o => o.id)).toEqual([a]);
    expect((await store.queryObservations({ has_prediction_error: true })).map(o => o.id)).toEqual([a]);
    expect((await store.queryObservations({ processed: false })).map(o => o.content)).toEqual(['unscored']);
  });

  it('reads legacy observations written through the generic collection API', async () => {
    const store = make();
    const legacyId = await store.put('observations', {
      content: 'noticed before notice wrote typed rows',
      source_file: 'x', source_section: '', salience: 0.3, processed: false,
      prediction_error: null, created_at: new Date().toISOString(), embedding: null, keywords: [],
    });
    await store.putObservation(obs('typed row'));

    const legacy = await store.getObservation(legacyId);
    expect(legacy?.content).toBe('noticed before notice wrote typed rows');
    expect(legacy?.created_at).toBeInstanceOf(Date);

    const all = await store.queryObservations({ since: new Date(Date.now() - DAY) });
    expect(all.map(o => o.content).sort()).toEqual(['noticed before notice wrote typed rows', 'typed row']);
  });

  it('getBelief finds typed entries; getBelief and getBeliefHistory read legacy generic entries', async () => {
    const store = make();
    const memId = await store.putMemory(memory('The tension floor is 0.8.'));
    const typedId = await store.putBelief({
      concept_id: memId, old_definition: 'The tension floor is 0.7.', new_definition: 'The tension floor is 0.8.',
      reason: 'retuned', changed_at: new Date('2026-09-01T00:00:00Z'),
    });
    // A Firestore-migrated revision: serialized Timestamp, stored generically.
    const legacyId = await store.put('beliefs', {
      concept_id: memId, old_definition: 'The tension floor is 0.6.', new_definition: 'The tension floor is 0.7.',
      reason: 'Dream refinement', changed_at: { _seconds: 1773684312, _nanoseconds: 483000000 },
    });

    expect((await store.getBelief(typedId))?.new_definition).toBe('The tension floor is 0.8.');
    const legacy = await store.getBelief(legacyId);
    expect(legacy?.concept_id).toBe(memId);
    expect(legacy?.changed_at.getTime()).toBe(1773684312483);
    expect(await store.getBelief('missing')).toBeNull();

    const history = await store.getBeliefHistory(memId);
    expect(history.map(b => b.id)).toEqual([legacyId, typedId]);
  });

  it('generic query range filters compare dates, not only numbers', async () => {
    const store = make();
    const now = Date.now();
    await store.put('threads', { title: 'old', updated_at: new Date(now - 10 * DAY).toISOString() });
    await store.put('threads', { title: 'new', updated_at: new Date(now - DAY).toISOString() });
    const recent = await store.query('threads', [
      { field: 'updated_at', op: '>=', value: new Date(now - 3 * DAY) },
    ]);
    expect(recent.map(d => d['title'])).toEqual(['new']);
    const older = await store.query('threads', [
      { field: 'updated_at', op: '<', value: new Date(now - 3 * DAY).toISOString() },
    ]);
    expect(older.map(d => d['title'])).toEqual(['old']);
  });
});

describe('recall and contradict on the SQLite store (#122, #123 repros)', () => {
  it('recall returns a wonder-style question by content_type (#122)', async () => {
    const store = new SqliteCortexStore(':memory:');
    const id = await store.putObservation(obs('Is the tension floor at 0.8 hiding a real tension?', { content_type: 'interrogative' }));
    await store.putObservation(obs('An unrelated fact.'));

    const result = await recallTool.handler({ content_type: 'interrogative', days: 2 }, ctxFor(store)) as {
      count: number; observations: Array<{ id: string; content_type: string }>;
    };
    expect(result.count).toBe(1);
    expect(result.observations[0]).toMatchObject({ id, content_type: 'interrogative' });
  });

  it('recall treats rows with no content_type as declarative', async () => {
    const store = new SqliteCortexStore(':memory:');
    const id = await store.putObservation(obs('pre-content_type row'));
    (store as unknown as { db: Database.Database }).db
      .prepare('UPDATE observations SET content_type = NULL WHERE id = ?').run(id);

    const result = await recallTool.handler({ content_type: 'declarative' }, ctxFor(store)) as { count: number };
    expect(result.count).toBe(1);
  });

  it('contradict finds an observe-style observation and a typed belief by id (#123)', async () => {
    const store = new SqliteCortexStore(':memory:');
    const memId = await store.putMemory(memory('The tension floor is 0.8.'));
    const beliefId = await store.putBelief({
      concept_id: memId, old_definition: 'The tension floor is 0.7.', new_definition: 'The tension floor is 0.8.',
      reason: 'retuned', changed_at: new Date(),
    });
    const obsId = await store.putObservation(obs('Playtests show the tension floor is really 0.5.'));

    const byBelief = await contradictTool.handler(
      { observation_id: obsId, belief_id: beliefId, force: true }, ctxFor(store),
    ) as { verdict?: string; signal_id?: string; error?: string };
    expect(byBelief.error).toBeUndefined();
    expect(byBelief.verdict).toBe('genuine');

    const signal = await store.getSignal(byBelief.signal_id!);
    expect(signal?.concept_ids).toEqual([memId]);
    expect(signal?.observation_id).toBe(obsId);

    const byMemory = await contradictTool.handler(
      { observation_id: obsId, memory_id: memId, force: true }, ctxFor(store),
    ) as { error?: string };
    expect(byMemory.error).toBeUndefined();
  });

  it('notice writes a typed observation that recall, contradict and consolidation all see', async () => {
    const store = new SqliteCortexStore(':memory:');
    const ctx = ctxFor(store);
    const { observation_id } = await noticeTool.handler({ text: 'Quick note.' }, ctx) as { observation_id: string };

    expect((await store.getObservation(observation_id))?.content).toBe('Quick note.');
    expect((await store.getUnprocessedObservations(10)).map(o => o.id)).toEqual([observation_id]);
    expect(await store.get('observations', observation_id)).toBeNull();

    const recalled = await recallTool.handler({}, ctx) as { count: number };
    expect(recalled.count).toBe(1);
  });
});
