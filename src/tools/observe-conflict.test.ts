/**
 * Tests for observe-time implicit-conflict detection — a new observation that
 * lands near an existing memory is adjudicated against it before the merge
 * gate can reinforce the memory it disputes.
 *
 * Uses a real in-memory SQLite store; NLI/LLM/embed are mocked.
 */

import { describe, it, expect, vi } from 'vitest';
import { observeTool } from './observe.js';
import { SqliteCortexStore } from '../stores/sqlite.js';
import type { ToolContext } from '../mcp/tools.js';
import type { Memory } from '../core/types.js';
import type { NLIResult } from '../core/nli.js';

const EMBEDDING = [1, 0, 0];

function makeMemory(): Omit<Memory, 'id'> {
  const now = new Date();
  return {
    name: 'User location',
    definition: 'The user lives in Paris.',
    category: 'belief',
    salience: 0.6,
    confidence: 0.8,
    access_count: 3,
    created_at: now,
    updated_at: now,
    last_accessed: now,
    source_files: [],
    embedding: EMBEDDING,
    tags: ['paris'],
    fsrs: { stability: 10, difficulty: 5, reps: 3, lapses: 0, state: 'review', last_review: now },
  };
}

function makeContext(
  store: SqliteCortexStore,
  nliResult?: NLIResult,
  llmVerdict?: { verdict: string; confidence: number; reasoning?: string },
): ToolContext {
  return {
    namespaces: {
      getStore: vi.fn(() => store),
      getDefaultNamespace: vi.fn(() => 'default'),
      // Same-embedding observations score 1.0 similarity → merge band.
      getConfig: vi.fn(() => ({})),
    },
    embed: { embed: vi.fn(async () => EMBEDDING), name: 'fake-embed' },
    llm: {
      name: 'fake-llm',
      modelId: 'fake-model',
      generate: vi.fn(async () => ''),
      generateJSON: vi.fn(async () => llmVerdict ?? { verdict: 'genuine', confidence: 0.9 }),
    },
    session: { getProvenance: vi.fn(() => undefined) },
    triggers: { getTriggersForEventInNamespace: vi.fn(() => []) },
    bridges: { getRulesForEvent: vi.fn(() => []) },
    allTools: [],
    nli: nliResult
      ? { name: 'fake-nli', classify: vi.fn(async () => nliResult) }
      : undefined,
    llmTier: 'high',
  } as unknown as ToolContext;
}

const CONTRADICTION_NLI: NLIResult = {
  label: 'contradiction',
  scores: { contradiction: 0.95, entailment: 0.01, neutral: 0.04 },
};

const NEUTRAL_NLI: NLIResult = {
  label: 'neutral',
  scores: { contradiction: 0.05, entailment: 0.15, neutral: 0.8 },
};

describe('observe-time conflict detection', () => {
  it('flags a genuine contradiction instead of merging into the disputed memory', async () => {
    const store = new SqliteCortexStore(':memory:');
    const memId = await store.putMemory(makeMemory());
    // LLM supersession check returns genuine → NLI verdict stands.
    const ctx = makeContext(store, CONTRADICTION_NLI, { verdict: 'genuine', confidence: 0.9 });

    const result = await observeTool.handler(
      { text: 'The user does not live in Paris anymore.', salience: 0.5 },
      ctx,
    );

    expect(result.action).toBe('contradiction');
    expect(result.nearest_id).toBe(memId);

    // Confidence penalty applied to the disputed memory.
    const memory = await store.getMemory(memId);
    expect(memory!.confidence).toBeLessThan(0.8);

    // CONTRADICTION signal is recorded and surfaced.
    const signals = await store.getSignals({ resolved: false, type: 'CONTRADICTION' });
    expect(signals).toHaveLength(1);
    expect(signals[0].concept_ids).toContain(memId);
    expect(signals[0].observation_id).toBe(result.id);
  });

  it('classifies temporal succession as superseded with no confidence penalty', async () => {
    const store = new SqliteCortexStore(':memory:');
    const memId = await store.putMemory(makeMemory());
    // NLI flags contradiction; LLM reclassifies as succession.
    const ctx = makeContext(store, CONTRADICTION_NLI, {
      verdict: 'supersedes',
      confidence: 0.85,
      reasoning: 'State change over time',
    });

    const result = await observeTool.handler(
      { text: 'The user moved to Berlin last month.', salience: 0.5 },
      ctx,
    );

    expect(result.action).toBe('superseded');

    // No penalty: a superseded belief was not wrong.
    const memory = await store.getMemory(memId);
    expect(memory!.confidence).toBeCloseTo(0.8);

    const tensions = await store.getSignals({ resolved: false, type: 'TENSION' });
    expect(tensions).toHaveLength(1);
    expect(tensions[0].description).toContain('believe(valid_from)');
  });

  it('falls through to the normal merge path when NLI finds no conflict', async () => {
    const store = new SqliteCortexStore(':memory:');
    await store.putMemory(makeMemory());
    const ctx = makeContext(store, NEUTRAL_NLI);

    const result = await observeTool.handler(
      { text: 'The user lives in Paris.', salience: 0.5 },
      ctx,
    );

    expect(result.action).toBe('merged');
    expect(await store.getSignals({ resolved: false })).toHaveLength(0);
  });

  it('skips the check entirely when no NLI provider is configured', async () => {
    const store = new SqliteCortexStore(':memory:');
    await store.putMemory(makeMemory());
    const ctx = makeContext(store, undefined);

    const result = await observeTool.handler(
      { text: 'The user does not live in Paris anymore.', salience: 0.5 },
      ctx,
    );

    // No NLI → cheap write path, ordinary merge behavior.
    expect(result.action).toBe('merged');
  });

  it('respects check_conflict: false', async () => {
    const store = new SqliteCortexStore(':memory:');
    await store.putMemory(makeMemory());
    const ctx = makeContext(store, CONTRADICTION_NLI);

    const result = await observeTool.handler(
      { text: 'The user does not live in Paris anymore.', salience: 0.5, check_conflict: false },
      ctx,
    );

    expect(result.action).toBe('merged');
  });
});
