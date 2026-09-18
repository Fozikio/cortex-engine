/**
 * Tests for observe/notice accepting explicit `name`, `category`, `tags`
 * (#114) — a curated store (the codebase-mind rulings ledger) writes memories
 * verbatim and must not pay for a name the LLM makes up or a category a regex
 * guesses.
 */

import { describe, it, expect, vi } from 'vitest';
import { observeTool } from './observe.js';
import { SqliteCortexStore } from '../stores/sqlite.js';
import type { ToolContext } from '../mcp/tools.js';

const EMBEDDING = [1, 0, 0];

function makeContext(store: SqliteCortexStore): ToolContext {
  return {
    namespaces: {
      getStore: vi.fn(() => store),
      getDefaultNamespace: vi.fn(() => 'default'),
      getConfig: vi.fn(() => ({})),
    },
    embed: { embed: vi.fn(async () => EMBEDDING), name: 'fake-embed' },
    llm: {
      name: 'fake-llm',
      modelId: 'fake-model',
      generate: vi.fn(async () => 'Derived Name'),
      generateJSON: vi.fn(async () => ({ composite: 0.5 })),
    },
    session: { getProvenance: vi.fn(() => undefined) },
    triggers: { getTriggersForEventInNamespace: vi.fn(() => []) },
    bridges: { getRulesForEvent: vi.fn(() => []) },
    allTools: [],
    nli: undefined,
    llmTier: 'high',
  } as unknown as ToolContext;
}

describe('observe with explicit fields', () => {
  it('creates a memory with the given name, category and tags and never asks the LLM for a name', async () => {
    const store = new SqliteCortexStore(':memory:', 'test');
    const ctx = makeContext(store);
    const generate = vi.spyOn(ctx.llm, 'generate');
    const r = await observeTool.handler(
      { text: 'The raccoon never says the Guild.', salience: 0.85, name: 'The raccoon never says the Guild', category: 'belief', tags: ['voice', 'ruling'] },
      ctx,
    );
    expect(r.action).toBe('created');
    const m = await store.getMemory(r.memory_id as string);
    expect(m?.name).toBe('The raccoon never says the Guild');
    expect(m?.category).toBe('belief');
    expect(m?.tags).toEqual(['voice', 'ruling']);
    expect(generate).not.toHaveBeenCalled();
  });

  it('rejects an unknown category', async () => {
    const store = new SqliteCortexStore(':memory:', 'test');
    const r = await observeTool.handler({ text: 'x', salience: 0.9, category: 'nonsense' }, makeContext(store));
    expect(r.error).toMatch(/category/);
  });

  it('keeps the fields on a queued observation so Phase A can use them', async () => {
    const store = new SqliteCortexStore(':memory:', 'test');
    const r = await observeTool.handler(
      { text: 'Low salience thing.', salience: 0.2, name: 'Low', category: 'pattern', tags: ['t'] },
      makeContext(store),
    );
    expect(r.action).toBe('queued');
    const [obs] = await store.getUnprocessedObservations(1);
    expect(obs?.name).toBe('Low');
    expect(obs?.category).toBe('pattern');
    expect(obs?.tags).toEqual(['t']);
  });
});
