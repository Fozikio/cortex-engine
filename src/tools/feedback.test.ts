/**
 * Tests for the feedback tool — asymmetric trust scoring against a real
 * in-memory SQLite store (transactions + feedback_log included).
 */

import { describe, it, expect, vi } from 'vitest';
import { feedbackTool } from './feedback.js';
import { SqliteCortexStore } from '../stores/sqlite.js';
import type { ToolContext } from '../mcp/tools.js';
import type { Memory } from '../core/types.js';

function makeMemory(confidence: number): Omit<Memory, 'id'> {
  const now = new Date();
  return {
    name: 'Test memory',
    definition: 'A fact under evaluation',
    category: 'topic',
    salience: 0.5,
    confidence,
    access_count: 0,
    created_at: now,
    updated_at: now,
    last_accessed: now,
    source_files: [],
    embedding: [0.1, 0.2, 0.3],
    tags: [],
    fsrs: { stability: 1, difficulty: 5, reps: 0, lapses: 0, state: 'new', last_review: null },
  };
}

function makeContext(store: SqliteCortexStore): ToolContext {
  return {
    namespaces: {
      getStore: vi.fn(() => store),
      getDefaultNamespace: vi.fn(() => 'default'),
    },
    embed: {},
    llm: {},
    session: {},
    triggers: {},
    bridges: {},
    allTools: [],
  } as unknown as ToolContext;
}

describe('feedbackTool', () => {
  it('helpful: +0.05 confidence and access reinforced', async () => {
    const store = new SqliteCortexStore(':memory:');
    const id = await store.putMemory(makeMemory(0.5));

    const result = await feedbackTool.handler({ id, helpful: true }, makeContext(store));

    expect(result).toMatchObject({ helpful: true, confidence_before: 0.5 });
    const memory = await store.getMemory(id);
    expect(memory!.confidence).toBeCloseTo(0.55);
    expect(memory!.access_count).toBe(1);
  });

  it('unhelpful: -0.10 confidence and access NOT reinforced', async () => {
    const store = new SqliteCortexStore(':memory:');
    const id = await store.putMemory(makeMemory(0.5));

    await feedbackTool.handler({ id, helpful: false }, makeContext(store));

    const memory = await store.getMemory(id);
    expect(memory!.confidence).toBeCloseTo(0.4);
    expect(memory!.access_count).toBe(0);
  });

  it('clamps confidence at the floor (0.05)', async () => {
    const store = new SqliteCortexStore(':memory:');
    const id = await store.putMemory(makeMemory(0.1));

    await feedbackTool.handler({ id, helpful: false }, makeContext(store));

    expect((await store.getMemory(id))!.confidence).toBeCloseTo(0.05);
  });

  it('clamps confidence at the ceiling (1.0)', async () => {
    const store = new SqliteCortexStore(':memory:');
    const id = await store.putMemory(makeMemory(0.98));

    await feedbackTool.handler({ id, helpful: true }, makeContext(store));

    expect((await store.getMemory(id))!.confidence).toBeCloseTo(1.0);
  });

  it('writes a feedback_log entry with before/after values', async () => {
    const store = new SqliteCortexStore(':memory:');
    const id = await store.putMemory(makeMemory(0.5));

    await feedbackTool.handler({ id, helpful: false, note: 'stale info' }, makeContext(store));

    const log = await store.query('feedback_log', []);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      memory_id: id,
      helpful: false,
      note: 'stale info',
      confidence_before: 0.5,
    });
    expect(log[0]['confidence_after'] as number).toBeCloseTo(0.4);
  });

  it('returns an error for unknown memory ids', async () => {
    const store = new SqliteCortexStore(':memory:');

    const result = await feedbackTool.handler(
      { id: 'no-such-id', helpful: true },
      makeContext(store),
    );

    expect(result).toMatchObject({ error: 'Memory not found: no-such-id' });
  });

  it('rejects a missing helpful flag', async () => {
    const store = new SqliteCortexStore(':memory:');
    const id = await store.putMemory(makeMemory(0.5));

    await expect(
      feedbackTool.handler({ id }, makeContext(store)),
    ).rejects.toThrow('Missing required boolean argument: helpful');
  });
});
