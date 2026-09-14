/**
 * The dream create phase normalises an observation's salience at promotion.
 *
 * Observations written before 1.7.1 by digest and reflect carry 1–10. Rather
 * than rewrite the observations table, the one place that turns an observation
 * into a memory folds the legacy scale, so a store with unprocessed legacy
 * rows mints correctly scaled memories on its next dream.
 */

import { describe, it, expect, vi } from 'vitest';
import { dreamPhaseA } from './cognition.js';
import { SqliteCortexStore } from '../stores/sqlite.js';
import type { EmbedProvider } from '../core/embed.js';
import type { LLMProvider } from '../core/llm.js';

const embed: EmbedProvider = { embed: vi.fn(async () => [1, 0, 0]) };
const llm = {
  name: 'fake', modelId: 'fake',
  generate: vi.fn(async () => 'observation'),
  generateJSON: vi.fn(async () => ({})),
} as unknown as LLMProvider;

describe('dream create phase salience', () => {
  it('mints a legacy 7.0 observation as a 0.7 memory', async () => {
    const store = new SqliteCortexStore(':memory:');
    await store.putObservation({
      content: 'Context LOD is live in production with session context loaded in tiers.',
      source_file: 'journal/2026-03-25.md', source_section: 'summary', salience: 7, processed: false,
      prediction_error: null, created_at: new Date(), updated_at: new Date(), embedding: [1, 0, 0], keywords: ['context'],
      content_type: 'declarative',
    });

    const result = await dreamPhaseA(store, embed, llm, {});
    expect(result.create.created).toBe(1);

    const [memory] = await store.getAllMemories();
    expect(memory.salience).toBeCloseTo(0.7);
    expect(memory.memory_origin).toBe('dream');
  });

  it('leaves a correctly scaled observation alone', async () => {
    const store = new SqliteCortexStore(':memory:');
    await store.putObservation({
      content: 'A properly scored observation about the graph.',
      source_file: '', source_section: '', salience: 0.45, processed: false,
      prediction_error: null, created_at: new Date(), updated_at: new Date(), embedding: [1, 0, 0], keywords: [],
      content_type: 'declarative',
    });
    await dreamPhaseA(store, embed, llm, {});
    const [memory] = await store.getAllMemories();
    expect(memory.salience).toBeCloseTo(0.45);
  });
});
