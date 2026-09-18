/**
 * `memory_origin: 'source'` — mirrored verbatim, never consolidated (#114).
 *
 * A repo mirrored into the store (the codebase-mind) is the text, not a
 * belief about the text: dream may link it, retrieval may return it, spread
 * activation may pass through it, but no phase may rewrite its definition,
 * absorb a near-duplicate observation into it, reschedule it, or sample it as
 * a member of a cross-domain abstraction. The same shape `faded` has in every
 * candidate filter, for a different reason: a faded memory was lowered on
 * purpose; a source memory is right by construction and re-mirrored from the
 * source when the source changes.
 */

import { describe, it, expect, vi } from 'vitest';
import { abstractCrossDomain, dreamPhaseA, dreamPhaseB, hindsightReview } from './cognition.js';
import { checkRewrite } from './rewrite-guard.js';
import { newFSRSState } from './fsrs.js';
import { SqliteCortexStore } from '../stores/sqlite.js';
import type { EmbedProvider } from '../core/embed.js';
import type { LLMProvider } from '../core/llm.js';
import type { Memory, MemoryCategory } from '../core/types.js';

const SKY = [1, 0, 0];
const SEA = [0, 1, 0];
const CLOUD = [0, 0, 1];
const SUN = [0, 0.6, 0.8];
const RAIN = [0.6, 0, 0.8];
const WIND = [0.6, 0.8, 0];

const REWRITE =
  'The sky is blue on clear days, and the sea below it is deep and cold according to the new evidence.';

function makeLLM(text = REWRITE): LLMProvider & { generate: ReturnType<typeof vi.fn>; generateJSON: ReturnType<typeof vi.fn> } {
  return {
    name: 'fake',
    modelId: 'fake',
    generate: vi.fn(async () => text),
    generateJSON: vi.fn(async () => ({ valid: true })),
  } as unknown as LLMProvider & { generate: ReturnType<typeof vi.fn>; generateJSON: ReturnType<typeof vi.fn> };
}

function memory(overrides: Partial<Omit<Memory, 'id'>>): Omit<Memory, 'id'> {
  const now = new Date();
  return {
    name: 'The sky is blue',
    definition: 'The sky is blue on clear days.',
    category: 'belief',
    salience: 0.7,
    confidence: 0.7,
    access_count: 0,
    created_at: now,
    updated_at: now,
    last_accessed: now,
    source_files: [],
    embedding: SKY,
    tags: ['sky'],
    fsrs: newFSRSState(),
    ...overrides,
  };
}

describe('source-origin memories are never consolidated', () => {
  it('Phase A leaves a source memory untouched when a near-duplicate observation arrives', async () => {
    const store = new SqliteCortexStore(':memory:');
    const llm = makeLLM();
    const embed: EmbedProvider = { embed: vi.fn(async () => SKY) };
    const sourceId = await store.putMemory(memory({ memory_origin: 'source' }));
    // Same embedding as the source memory: cluster's nearest is the source at
    // score 1.0, well past the merge threshold.
    await store.putObservation({
      content: 'The sky is blue on clear days and the deep sea reflects it.',
      source_file: '', source_section: '', salience: 0.5, processed: false,
      prediction_error: null, created_at: new Date(), updated_at: new Date(),
      embedding: SKY, keywords: [],
      name: 'Sky over sea', category: 'observation', tags: ['sea'],
    });

    const result = await dreamPhaseA(store, embed, llm);

    // The source memory is the text: nothing about it moved.
    const source = await store.getMemory(sourceId);
    expect(source?.definition).toBe('The sky is blue on clear days.');
    expect(source?.name).toBe('The sky is blue');
    expect(source?.category).toBe('belief');
    expect(source?.tags).toEqual(['sky']);
    expect(await store.getBeliefHistory(sourceId)).toHaveLength(0);

    // The observation was not merged into it: it became its own memory.
    expect(result.cluster.clustered).toBe(0);
    expect(result.refine.refined).toBe(0);
    expect(result.create.created).toBe(1);
    const all = await store.getAllMemories();
    const minted = all.find((m) => m.id !== sourceId);
    expect(minted?.definition).toBe('The sky is blue on clear days and the deep sea reflects it.');
    expect(minted?.memory_origin).toBe('dream');
  });

  it('Phase A clusters onto the nearest organic memory when a source memory is nearer still', async () => {
    const store = new SqliteCortexStore(':memory:');
    const llm = makeLLM();
    const embed: EmbedProvider = { embed: vi.fn(async () => SKY) };
    const sourceId = await store.putMemory(memory({ memory_origin: 'source' }));
    // Close to SKY but not on it: the source memory is the top hit, the
    // organic one second, both past the merge threshold.
    const NEAR_SKY = [0.95, 0.3, 0];
    const organicId = await store.putMemory(memory({
      name: 'Blue skies', definition: 'Blue skies come with clear days.', embedding: NEAR_SKY, memory_origin: 'organic',
    }));
    // Two edges so the schema-congruence check treats the organic memory as established.
    for (const target of [await store.putMemory(memory({ name: 'Clouds', definition: 'Clouds are white.', embedding: CLOUD })), await store.putMemory(memory({ name: 'Sun', definition: 'The sun is bright.', embedding: SUN }))]) {
      await store.putEdge({ source_id: organicId, target_id: target, relation: 'supports', weight: 0.5, evidence: 'sky things', created_at: new Date() });
    }
    await store.putObservation({
      content: 'The sky is blue on clear days and the deep sea reflects it.',
      source_file: '', source_section: '', salience: 0.5, processed: false,
      prediction_error: null, created_at: new Date(), updated_at: new Date(),
      embedding: SKY, keywords: [],
    });

    const result = await dreamPhaseA(store, embed, llm);

    expect(result.cluster.clustered).toBe(1);
    expect(result.create.created).toBe(0);
    expect(result.refine.refined).toBe(1);
    expect((await store.getMemory(sourceId))?.definition).toBe('The sky is blue on clear days.');
    expect(await store.getBeliefHistory(sourceId)).toHaveLength(0);
    expect(await store.getBeliefHistory(organicId)).toHaveLength(1);
  });

  it('REM abstraction never takes a source memory as a cluster member', async () => {
    const store = new SqliteCortexStore(':memory:');
    // Three source memories and three organic ones, six categories, so the
    // phase samples four per attempt and, with source excluded, still has the
    // three categories it needs to abstract at all.
    const sourceIds = new Set<string>();
    const organicIds = new Set<string>();
    const seed = async (name: string, definition: string, category: MemoryCategory, embedding: number[], origin: Memory['memory_origin']) => {
      const id = await store.putMemory(memory({ name, definition, category, embedding, memory_origin: origin }));
      (origin === 'source' ? sourceIds : organicIds).add(id);
    };
    await seed('The sky is blue', 'The sky is blue on clear days.', 'belief', SKY, 'source');
    await seed('The sea is deep', 'The sea is deep and cold.', 'topic', SEA, 'source');
    await seed('Clouds are white', 'Clouds are white and drift.', 'value', CLOUD, 'source');
    await seed('The sun is bright', 'The sun is bright at noon.', 'pattern', SUN, 'organic');
    await seed('Rain is wet', 'Rain is wet and falls.', 'insight', RAIN, 'organic');
    await seed('Wind is loud', 'Wind is loud at night.', 'project', WIND, 'organic');

    // Distinct embedding per attempt so the within-run check does not short-circuit sampling.
    let n = 0;
    const embed: EmbedProvider = { embed: vi.fn(async () => { n++; return [Math.cos(n), Math.sin(n), 0.1 * n]; }) };
    const llm = makeLLM(
      'The sky, the sea, the clouds, the sun, the rain and the wind are one weather system. The blue sky, the deep sea, the white clouds, the bright sun, the wet rain and the loud wind each show a part of it, and that matters because no part explains the weather alone.',
    );

    const result = await abstractCrossDomain(store, embed, llm, { abstraction_attempts: 10, abstraction_dedupe_threshold: 1.01 });

    expect(result.abstractions).toBeGreaterThan(0);
    const minted = (await store.getAllMemories()).filter((m) => m.memory_origin === 'abstract');
    expect(minted.length).toBe(result.abstractions);
    for (const abs of minted) {
      const exemplifies = (await store.getEdgesFrom(abs.id)).filter((e) => e.relation === 'exemplifies');
      expect(exemplifies.length).toBeGreaterThan(0);
      for (const edge of exemplifies) {
        expect(sourceIds.has(edge.target_id)).toBe(false);
        expect(organicIds.has(edge.target_id)).toBe(true);
      }
    }
  });

  it('the score phase never reschedules a source memory', async () => {
    const store = new SqliteCortexStore(':memory:');
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const due = { ...newFSRSState(), state: 'review' as const, stability: 2, reps: 3, last_review: fiveDaysAgo };
    const sourceId = await store.putMemory(memory({ memory_origin: 'source', fsrs: due }));
    const organicId = await store.putMemory(memory({ name: 'The sea is deep', definition: 'The sea is deep and cold.', embedding: SEA, memory_origin: 'organic', fsrs: due }));

    const result = await dreamPhaseB(store, { embed: vi.fn(async () => SKY) }, makeLLM(), {
      skip_hindsight: true, skip_fiedler: true, skip_pe_saturation: true, abstraction_attempts: 0,
    });

    expect(result.score.scored).toBe(1);
    expect((await store.getMemory(organicId))?.fsrs.reps).toBe(4);
    const source = await store.getMemory(sourceId);
    expect(source?.fsrs.reps).toBe(3);
    expect(source?.fsrs.last_review?.getTime()).toBe(fiveDaysAgo.getTime());
  });

  it('hindsight never reviews a source memory, however entrenched', async () => {
    const store = new SqliteCortexStore(':memory:');
    const entrenched = { ...newFSRSState(), state: 'review' as const, stability: 40, reps: 8, last_review: new Date() };
    const sourceId = await store.putMemory(memory({ memory_origin: 'source', confidence: 0.95, fsrs: entrenched }));
    const llm = makeLLM();
    llm.generateJSON.mockResolvedValue({
      concern: 'never challenged', cited: 'belief history', confidence_penalty: 0.2,
      revised_definition: 'The sky is blue on clear days, generally.', reason: 'hardened',
    });

    const result = await hindsightReview(store, llm, {});

    expect(result.reviewed).toBe(0);
    expect(llm.generateJSON).not.toHaveBeenCalled();
    expect((await store.getMemory(sourceId))?.confidence).toBe(0.95);
  });

  it('the rewrite guard refuses any rewrite of a source memory outright', () => {
    const guard = checkRewrite({
      name: 'The sky is blue',
      old: 'The sky is blue on clear days.',
      next: 'The sky is blue on clear days and the deep sea reflects it.',
      evidence: ['The sky is blue on clear days and the deep sea reflects it.'],
      origin: 'source',
    });
    expect(guard.ok).toBe(false);
    expect(guard.reasons).toEqual(['source memory: mirrored verbatim, never rewritten']);

    // Same rewrite, any other origin: the text checks alone decide.
    expect(checkRewrite({
      name: 'The sky is blue',
      old: 'The sky is blue on clear days.',
      next: 'The sky is blue on clear days and the deep sea reflects it.',
      evidence: ['The sky is blue on clear days and the deep sea reflects it.'],
      origin: 'organic',
    }).ok).toBe(true);
  });
});
