/**
 * #85: refine runs the rewrite guard, cluster joins only above 0.75, and an
 * unlabelled abstraction gets a real name.
 *
 * The refine fixture is the shape one live run produced: an observation that
 * shared vocabulary with a memory (a paper summary vs. a memoir idea) joined
 * it, and refine dropped the memory's subject and appended the observation.
 * The signature gate called that clean; the guard has to refuse it.
 */

import { describe, it, expect, vi } from 'vitest';
import { dreamPhaseA, abstractCrossDomain } from './cognition.js';
import { newFSRSState } from './fsrs.js';
import { SqliteCortexStore } from '../stores/sqlite.js';
import type { EmbedProvider } from '../core/embed.js';
import type { LLMProvider } from '../core/llm.js';
import type { Memory, MemoryCategory } from '../core/types.js';

const MEMO = [1, 0, 0];
const OTHER_A = [0, 0, 1];
const OTHER_B = [0, 0.6, 0.8];

const MEMOIR_DEF =
  "Virgil's memoir-agent idea: feed someone's draft memoir into a cortex agent and write from the lived experience. A product direction nobody else could do.";

function memory(overrides: Partial<Omit<Memory, 'id'>>): Omit<Memory, 'id'> {
  const now = new Date();
  return {
    name: "Virgil's memoir-agent idea",
    definition: MEMOIR_DEF,
    category: 'belief',
    salience: 0.7,
    confidence: 0.7,
    access_count: 0,
    created_at: now,
    updated_at: now,
    last_accessed: now,
    source_files: [],
    embedding: MEMO,
    tags: [],
    fsrs: newFSRSState(),
    ...overrides,
  };
}

/** A memory with two outgoing edges, so cluster treats its schema as established. */
async function seedDenseMemoir(store: SqliteCortexStore): Promise<string> {
  const id = await store.putMemory(memory({}));
  const a = await store.putMemory(memory({ name: 'A', definition: 'Alpha is first.', embedding: OTHER_A }));
  const b = await store.putMemory(memory({ name: 'B', definition: 'Beta is second.', embedding: OTHER_B }));
  for (const target of [a, b]) {
    await store.putEdge({ source_id: id, target_id: target, relation: 'supports', weight: 0.5, evidence: 'x', created_at: new Date() });
  }
  return id;
}

async function observe(store: SqliteCortexStore, content: string, embedding: number[]): Promise<void> {
  await store.putObservation({
    content, source_file: '', source_section: '', salience: 0.5, processed: false,
    prediction_error: null, created_at: new Date(), updated_at: new Date(), embedding, keywords: [],
  });
}

function llmReturning(text: string): LLMProvider & { generate: ReturnType<typeof vi.fn> } {
  return {
    name: 'fake', modelId: 'fake',
    generate: vi.fn(async () => text),
    generateJSON: vi.fn(async () => ({ category: 'belief', valid: true })),
  } as unknown as LLMProvider & { generate: ReturnType<typeof vi.fn> };
}

const embed: EmbedProvider = { embed: vi.fn(async () => MEMO) };

/** Unit vector at cosine `c` from MEMO. */
const at = (c: number): number[] => [c, Math.sqrt(1 - c * c), 0];

describe('refine runs the rewrite guard (#85)', () => {
  it('declines a refinement that drops the subject and appends the observation', async () => {
    const store = new SqliteCortexStore(':memory:');
    const id = await seedDenseMemoir(store);
    const paper = 'Generative Agents (Park et al., UIST 2023) keep a memory stream scored by recency, importance and relevance, and reflect when summed importance exceeds 150.';
    await observe(store, paper, at(0.9));
    const bled = `Feed someone's draft memoir into a cortex agent and write from the lived experience. A product direction nobody else could do. ${paper} Cortex differs in using FSRS retrievability, novelty gating and dream consolidation over a graph, but lacks evidence pointers in reflections and any importance-based reflection schedule.`;

    const result = await dreamPhaseA(store, embed, llmReturning(bled));

    expect(result.cluster.clustered).toBe(1);
    expect(result.refine.refined).toBe(0);
    expect(result.refine.declined).toBe(1);
    expect((await store.getMemory(id))?.definition).toBe(MEMOIR_DEF);
    expect(await store.getBeliefHistory(id)).toHaveLength(0);
  });

  it('declines a refinement that drops a version number', async () => {
    const store = new SqliteCortexStore(':memory:');
    const def = 'The agency check became an ops decision loaded at every session start (v0.8.1). It runs before anything else.';
    const id = await seedDenseMemoir(store);
    await store.updateMemory(id, { definition: def, name: 'Agency check wiring' });
    await observe(store, 'The agency check is logged with ops_append at session end.', at(0.9));

    const result = await dreamPhaseA(store, embed, llmReturning(
      'The agency check became an ops decision loaded at every session start, and it is logged with ops_append at session end.',
    ));

    expect(result.refine.declined).toBe(1);
    expect((await store.getMemory(id))?.definition).toBe(def);
  });

  it('still applies a refinement that integrates the evidence', async () => {
    const store = new SqliteCortexStore(':memory:');
    const id = await seedDenseMemoir(store);
    await observe(store, 'Virgil wants the memoir agent to keep the writer’s own voice.', at(0.9));
    const next = `${MEMOIR_DEF} It keeps the writer's own voice.`;

    const result = await dreamPhaseA(store, embed, llmReturning(next));

    expect(result.refine.refined).toBe(1);
    expect(result.refine.declined).toBe(0);
    expect((await store.getMemory(id))?.definition).toBe(next);
  });
});

describe('cluster join floor (#85)', () => {
  it('does not join an observation at 0.72 by default; it stays novel', async () => {
    const store = new SqliteCortexStore(':memory:');
    await seedDenseMemoir(store);
    await observe(store, 'A paper about agent memory streams.', at(0.72));

    const result = await dreamPhaseA(store, embed, llmReturning('unused'));

    expect(result.cluster.clustered).toBe(0);
    expect(result.cluster.unclustered).toBe(1);
  });

  it('joins at 0.72 when the namespace sets cluster_threshold 0.70', async () => {
    const store = new SqliteCortexStore(':memory:');
    await seedDenseMemoir(store);
    await observe(store, 'A paper about agent memory streams.', at(0.72));

    const result = await dreamPhaseA(store, embed, llmReturning(MEMOIR_DEF), { cluster_threshold: 0.70 });

    expect(result.cluster.clustered).toBe(1);
  });
});

describe('abstract names an unlabelled synthesis (#85)', () => {
  it('asks for a concept label instead of clipping the first clause', async () => {
    const store = new SqliteCortexStore(':memory:');
    const seeds: Array<[string, string, MemoryCategory, number[]]> = [
      ['The sky is blue', 'The sky is blue in clear weather.', 'belief', [1, 0, 0]],
      ['The sea is deep', 'The sea is deep and cold in any weather.', 'topic', [0, 1, 0]],
      ['Clouds are white', 'Clouds are white and drift with the weather.', 'value', [0, 0, 1]],
    ];
    const ids: string[] = [];
    for (const [name, definition, category, embedding] of seeds) {
      ids.push(await store.putMemory(memory({ name, definition, category, embedding })));
    }
    for (const [a, b] of [[0, 1], [0, 2], [1, 2]]) {
      await store.putEdge({ source_id: ids[a], target_id: ids[b], relation: 'related', weight: 0.5, evidence: 'weather', created_at: new Date() });
    }
    const synthesis =
      'The sky, the sea and the clouds are each read through the weather. The blue sky, the deep sea and the white clouds each show a part of it, and that matters because no part explains the weather alone.';
    const llm = {
      name: 'fake', modelId: 'fake',
      // No usable name in the JSON answer, no label line in the text: deriveName labels it.
      generateJSON: vi.fn(async () => ({
        mechanism: 'each changes with the weather',
        members: ['The sky is blue', 'The sea is deep', 'Clouds are white'],
        abstraction: synthesis,
      })),
      generate: vi.fn(async () => 'One Weather System'),
    } as unknown as LLMProvider;

    await abstractCrossDomain(store, { embed: vi.fn(async () => [0.5, 0.5, 0.5]) }, llm, { abstraction_attempts: 1 });

    const minted = (await store.getAllMemories()).find((m) => m.memory_origin === 'abstract');
    expect(minted?.name).toBe('One Weather System');
    expect(minted?.definition).toBe(synthesis);
  });
});
