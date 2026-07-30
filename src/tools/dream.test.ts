/**
 * Tests that dream records its run to consolidation_history.
 *
 * sleep_pressure and consolidation_status both answer "when did consolidation
 * last happen" from that collection. Nothing wrote it, so both reported null
 * forever regardless of how many times dream had run — a monitoring signal
 * that could never fire. These assert the writer exists and that the readers
 * actually pick it up.
 */

import { describe, it, expect, vi } from 'vitest';
import { dreamTool } from './dream.js';
import { sleepPressureTool } from './sleep-pressure.js';
import { SqliteCortexStore } from '../stores/sqlite.js';
import type { ToolContext } from '../mcp/tools.js';

vi.mock('../engines/cognition.js', () => ({
  dreamConsolidate: vi.fn(async () => ({
    phases: {
      cluster: { clustered: 7, unclustered: 3 },
      refine: { refined: 2 },
      create: { created: 4 },
      connect: { edges_discovered: 9 },
      score: { scored: 5 },
      report: { text: 'a narrative' },
      abstract: { abstractions: 1 },
    },
    total_processed: 10,
    duration_ms: 1234,
    integration_rate: 0.7,
    failures: 0,
  })),
}));

function makeContext(store: SqliteCortexStore): ToolContext {
  return {
    namespaces: {
      getStore: vi.fn(() => store),
      getDefaultNamespace: vi.fn(() => 'default'),
      getConfig: vi.fn(() => ({ similarity_merge: 0.9, similarity_link: 0.7 })),
    },
    embed: {},
    llm: {},
    session: {},
    triggers: {},
    bridges: {},
    allTools: [],
  } as unknown as ToolContext;
}

describe('dream run recording', () => {
  it('writes a consolidation_history entry with the phase counts', async () => {
    const store = new SqliteCortexStore(':memory:');
    const ctx = makeContext(store);

    await dreamTool.handler({}, ctx);

    const history = await store.query('consolidation_history', [], { limit: 10 });
    expect(history).toHaveLength(1);

    const row = history[0] as Record<string, unknown>;
    expect(row['phase1_clustered']).toBe(7);
    expect(row['unclustered_count']).toBe(3);
    expect(row['phase3_created']).toBe(4);
    expect(row['phase4_edges']).toBe(9);
    expect(row['phase7_abstractions']).toBe(1);
    expect(row['total_observations']).toBe(10);
    expect(row['duration_ms']).toBe(1234);
    expect(row['integration_rate']).toBe(0.7);
    expect(typeof row['at']).toBe('string');
  });

  it('makes sleep_pressure report a real last-dream time instead of null', async () => {
    const store = new SqliteCortexStore(':memory:');
    const ctx = makeContext(store);

    const before = await sleepPressureTool.handler({}, ctx);
    expect(before['last_dream_at_iso']).toBeNull();

    await dreamTool.handler({}, ctx);

    const after = await sleepPressureTool.handler({}, ctx);
    expect(after['last_dream_at_iso']).toEqual(expect.any(String));
    expect(after['hours_since_dream']).toEqual(expect.any(Number));
  });

  it('records one entry per run', async () => {
    const store = new SqliteCortexStore(':memory:');
    const ctx = makeContext(store);

    await dreamTool.handler({}, ctx);
    await dreamTool.handler({}, ctx);

    const history = await store.query('consolidation_history', [], { limit: 10 });
    expect(history).toHaveLength(2);
  });
});
