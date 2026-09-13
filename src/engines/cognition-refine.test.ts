/**
 * Refine phase inputs (#86).
 *
 * Refine used to fall back to the evidence text of a memory's `related` edges
 * whenever nothing had clustered onto it. Edge evidence is the connect phase's
 * description of the *neighbouring* memory, so the fallback rewrote definitions
 * to include the neighbour's content — on one live store, 21 memories in a run,
 * 12 of them within an hour of a manual correction. Refine now only rewrites a
 * memory that gained direct evidence this run, never a faded one, and uses edge
 * evidence only when the caller opts in.
 */

import { describe, it, expect, vi } from 'vitest';
import { dreamPhaseA } from './cognition.js';
import { newFSRSState } from './fsrs.js';
import { SqliteCortexStore } from '../stores/sqlite.js';
import type { EmbedProvider } from '../core/embed.js';
import type { LLMProvider } from '../core/llm.js';
import type { Memory } from '../core/types.js';

const SKY = [1, 0, 0];
const SEA = [0, 1, 0];
const CLOUD = [0, 0, 1];
const SUN = [0, 0.6, 0.8];

function makeEmbed(): EmbedProvider {
  return { embed: vi.fn(async (text: string) => (/sea/i.test(text) ? SEA : SKY)) };
}

function makeLLM(): LLMProvider & { generate: ReturnType<typeof vi.fn> } {
  return {
    name: 'fake',
    modelId: 'fake',
    generate: vi.fn(async () =>
      'The sky is blue on clear days, and the sea below it is deep and cold according to the new evidence.'),
    generateJSON: vi.fn(async () => ({ category: 'belief', valid: true })),
  } as unknown as LLMProvider & { generate: ReturnType<typeof vi.fn> };
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
    tags: [],
    fsrs: newFSRSState(),
    ...overrides,
  };
}

async function seedNeighbourWithEdge(store: SqliteCortexStore): Promise<{ skyId: string; seaId: string }> {
  const skyId = await store.putMemory(memory({}));
  const seaId = await store.putMemory(memory({
    name: 'The sea is deep',
    definition: 'The sea is deep and cold.',
    embedding: SEA,
  }));
  await store.putEdge({
    source_id: skyId,
    target_id: seaId,
    relation: 'related',
    weight: 0.8,
    evidence: 'The sea is deep and cold, which relates to the sky being blue.',
    created_at: new Date(),
  });
  return { skyId, seaId };
}

describe('refine phase evidence sources', () => {
  it('leaves a memory alone when nothing clustered onto it, even if it has related edges', async () => {
    const store = new SqliteCortexStore(':memory:');
    const llm = makeLLM();
    const { skyId } = await seedNeighbourWithEdge(store);

    const result = await dreamPhaseA(store, makeEmbed(), llm);

    expect(result.refine.refined).toBe(0);
    expect(llm.generate).not.toHaveBeenCalled();
    const sky = await store.getMemory(skyId);
    expect(sky?.definition).toBe('The sky is blue on clear days.');
    expect(await store.getBeliefHistory(skyId)).toHaveLength(0);
  });

  it('uses edge evidence only when refine_from_edges is set', async () => {
    const store = new SqliteCortexStore(':memory:');
    const llm = makeLLM();
    const { skyId } = await seedNeighbourWithEdge(store);

    const result = await dreamPhaseA(store, makeEmbed(), llm, { refine_from_edges: true });

    expect(result.refine.refined).toBe(1);
    const history = await store.getBeliefHistory(skyId);
    expect(history).toHaveLength(1);
    expect(history[0].reason).toBe('Dream refinement from 1 edge evidence strings');
    expect(history[0].reason).not.toMatch(/observations/);
  });

  it('refines from directly clustered observations and names them as such', async () => {
    const store = new SqliteCortexStore(':memory:');
    const llm = makeLLM();
    const skyId = await store.putMemory(memory({}));
    // Two edges so the cluster phase treats the schema as established.
    const a = await store.putMemory(memory({ name: 'Clouds', definition: 'Clouds are white.', embedding: CLOUD }));
    const b = await store.putMemory(memory({ name: 'Sun', definition: 'The sun is bright.', embedding: SUN }));
    for (const target of [a, b]) {
      await store.putEdge({ source_id: skyId, target_id: target, relation: 'supports', weight: 0.5, evidence: 'sky things', created_at: new Date() });
    }
    await store.putObservation({
      content: 'The sky is blue on clear days and the deep sea reflects it.',
      source_file: '', source_section: '', salience: 0.5, processed: false,
      prediction_error: null, created_at: new Date(), updated_at: new Date(),
      embedding: SKY, keywords: [],
    });

    const result = await dreamPhaseA(store, makeEmbed(), llm);

    expect(result.cluster.clustered).toBe(1);
    expect(result.refine.refined).toBe(1);
    const history = await store.getBeliefHistory(skyId);
    expect(history[0].reason).toBe('Dream refinement from 1 observations');
  });

  it('never refines a faded memory, even when edge evidence is allowed', async () => {
    // findNearest already excludes faded memories, so nothing can cluster onto
    // one; the edge path is the only way a faded memory reached refine.
    const store = new SqliteCortexStore(':memory:');
    const llm = makeLLM();
    const fadedId = await store.putMemory(memory({ faded: true, salience: 0.3 }));
    const seaId = await store.putMemory(memory({ name: 'The sea is deep', definition: 'The sea is deep and cold.', embedding: SEA }));
    await store.putEdge({
      source_id: fadedId, target_id: seaId, relation: 'related', weight: 0.8,
      evidence: 'The sea is deep and cold, which relates to the sky being blue.', created_at: new Date(),
    });

    const result = await dreamPhaseA(store, makeEmbed(), llm, { refine_from_edges: true });

    expect(result.refine.refined).toBe(0);
    expect(llm.generate).not.toHaveBeenCalled();
    expect((await store.getMemory(fadedId))?.definition).toBe('The sky is blue on clear days.');
    expect(await store.getBeliefHistory(fadedId)).toHaveLength(0);
  });
});
