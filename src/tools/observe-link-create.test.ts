/**
 * Tests for observe creating a memory on a `link` decision when salience is
 * explicit (#114) — the codebase-mind mirror writes ruling-backed
 * observations with a hand-picked salience, and every related entry after
 * the first should not silently queue for dream() just because it landed
 * in the link band instead of novel. Auto-scored salience must not trigger
 * this path — the writer has to mean it.
 */

import { describe, it, expect, vi } from 'vitest';
import { observeTool } from './observe.js';
import { SqliteCortexStore } from '../stores/sqlite.js';
import type { ToolContext } from '../mcp/tools.js';

// [1, 0] vs [0.8, 0.6]: cosine similarity 0.8, which (with the density
// adjustment predictionErrorGate applies) lands between the adaptive link
// and merge thresholds — decision 'link', not 'merge' or 'novel'.
function embedFor(text: string): number[] {
  return text.includes('weather') ? [0.8, 0.6] : [1, 0];
}

function makeContext(store: SqliteCortexStore): ToolContext {
  return {
    namespaces: {
      getStore: vi.fn(() => store),
      getDefaultNamespace: vi.fn(() => 'default'),
      getConfig: vi.fn(() => ({})),
    },
    embed: { embed: vi.fn(async (text: string) => embedFor(text)), name: 'fake-embed' },
    llm: {
      name: 'fake-llm',
      modelId: 'fake-model',
      generate: vi.fn(async () => 'Derived Name'),
      generateJSON: vi.fn(async () => ({ composite: 0.9 })),
    },
    session: { getProvenance: vi.fn(() => undefined) },
    triggers: { getTriggersForEventInNamespace: vi.fn(() => []) },
    bridges: { getRulesForEvent: vi.fn(() => []) },
    allTools: [],
    nli: undefined,
    llmTier: 'high',
  } as unknown as ToolContext;
}

describe('observe creates on link with explicit salience', () => {
  it('creates and links when the gate says link', async () => {
    const store = new SqliteCortexStore(':memory:', 'test');
    const ctx = makeContext(store);
    const first = await observeTool.handler({ text: 'The raccoon never says the Guild.', salience: 0.85 }, ctx);
    expect(first['action']).toBe('created');
    const second = await observeTool.handler({ text: 'The raccoon speaks of the Guild as weather.', salience: 0.85 }, ctx);
    expect(second['action']).toBe('created');
    expect(second['decision']).toBe('link');
    const edges = await store.getEdgesFrom(second['memory_id'] as string);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.target_id).toBe(first['memory_id']);
    expect(edges[0]?.relation).toBe('related');
    expect(edges[0]?.source_id).toBe(second['memory_id']);
    expect(edges[0]?.weight).toBe(0.8);
    expect(edges[0]?.evidence).toBe('observe: link at 0.80');
  });

  it('still queues on link when salience was auto-scored', async () => {
    const store = new SqliteCortexStore(':memory:', 'test');
    const ctx = makeContext(store);
    const first = await observeTool.handler({ text: 'The raccoon never says the Guild.', salience: 0.85 }, ctx);
    expect(first['action']).toBe('created');
    // No salience given — auto-scored via llm.generateJSON, which the fake
    // context always answers with composite: 0.9. Even though that is >=
    // 0.7 and the gate says link, this must NOT create a memory: only an
    // explicit salience opts into the create-on-link path.
    const second = await observeTool.handler({ text: 'The raccoon speaks of the Guild as weather.' }, ctx);
    expect(second['action']).toBe('linked');
    expect(second['decision']).toBe('link');
    expect(second['memory_id']).toBeUndefined();
  });

  it('still merges on merge', async () => {
    const store = new SqliteCortexStore(':memory:', 'test');
    const ctx = makeContext(store);
    const first = await observeTool.handler({ text: 'The raccoon never says the Guild.', salience: 0.85 }, ctx);
    expect(first['action']).toBe('created');
    const second = await observeTool.handler({ text: 'The raccoon never says the Guild.', salience: 0.85 }, ctx);
    expect(second['action']).toBe('merged');
  });
});
