/**
 * Tests for evolution_resolve — status transitions against a real in-memory
 * SQLite store, including the round trip through evolve and evolution_list.
 */

import { describe, it, expect, vi } from 'vitest';
import { evolutionResolveTool } from './evolution-resolve.js';
import { evolveTool } from './evolve.js';
import { evolutionListTool } from './evolution-list.js';
import { SqliteCortexStore } from '../stores/sqlite.js';
import type { ToolContext } from '../mcp/tools.js';

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

async function proposeOne(ctx: ToolContext): Promise<string> {
  const res = await evolveTool.handler(
    { change: 'Ship instrumentation with commitments', trigger: 'reflective audit' },
    ctx,
  );
  return res['id'] as string;
}

describe('evolution_resolve', () => {
  it('applies a proposal and stamps applied_at', async () => {
    const store = new SqliteCortexStore(':memory:');
    const ctx = makeContext(store);
    const id = await proposeOne(ctx);

    const res = await evolutionResolveTool.handler(
      { id, status: 'applied', note: 'adopted in profile v0.8.1' },
      ctx,
    );

    expect(res['error']).toBeUndefined();
    expect(res['status']).toBe('applied');
    expect(res['previous_status']).toBe('proposed');
    expect(res['applied_at']).toEqual(expect.any(String));
    expect(res['note']).toBe('adopted in profile v0.8.1');
  });

  it('moves the proposal out of the proposed list and into applied', async () => {
    const store = new SqliteCortexStore(':memory:');
    const ctx = makeContext(store);
    const id = await proposeOne(ctx);

    const before = await evolutionListTool.handler({ status: 'proposed' }, ctx);
    expect(before['count']).toBe(1);

    await evolutionResolveTool.handler({ id, status: 'applied' }, ctx);

    const proposed = await evolutionListTool.handler({ status: 'proposed' }, ctx);
    expect(proposed['count']).toBe(0);

    const applied = await evolutionListTool.handler({ status: 'applied' }, ctx);
    expect(applied['count']).toBe(1);
    const row = (applied['evolutions'] as Record<string, unknown>[])[0];
    expect(row['applied_at']).toEqual(expect.any(String));
    expect(row['resolved_at']).toEqual(expect.any(String));
  });

  it('rejects a proposal without stamping applied_at', async () => {
    const store = new SqliteCortexStore(':memory:');
    const ctx = makeContext(store);
    const id = await proposeOne(ctx);

    const res = await evolutionResolveTool.handler(
      { id, status: 'rejected', note: 'superseded' },
      ctx,
    );

    expect(res['status']).toBe('rejected');
    expect(res['applied_at']).toBeNull();
  });

  it('refuses to revert something that was never applied', async () => {
    const store = new SqliteCortexStore(':memory:');
    const ctx = makeContext(store);
    const id = await proposeOne(ctx);

    const res = await evolutionResolveTool.handler({ id, status: 'reverted' }, ctx);

    expect(res['error']).toMatch(/only an applied evolution can be reverted/);
  });

  it('allows revert after apply and preserves the original applied_at', async () => {
    const store = new SqliteCortexStore(':memory:');
    const ctx = makeContext(store);
    const id = await proposeOne(ctx);

    const applied = await evolutionResolveTool.handler({ id, status: 'applied' }, ctx);
    const appliedAt = applied['applied_at'] as string;

    const reverted = await evolutionResolveTool.handler(
      { id, status: 'reverted', note: 'did not hold up' },
      ctx,
    );

    expect(reverted['status']).toBe('reverted');
    expect(reverted['previous_status']).toBe('applied');
    // The historical record that it was once in force must survive the revert.
    expect(reverted['applied_at']).toBe(appliedAt);
  });

  it('refuses a no-op transition to the same status', async () => {
    const store = new SqliteCortexStore(':memory:');
    const ctx = makeContext(store);
    const id = await proposeOne(ctx);

    await evolutionResolveTool.handler({ id, status: 'applied' }, ctx);
    const again = await evolutionResolveTool.handler({ id, status: 'applied' }, ctx);

    expect(again['error']).toMatch(/already applied/);
  });

  it('lists legacy superseded records instead of silently falling back to proposed', async () => {
    const store = new SqliteCortexStore(':memory:');
    const ctx = makeContext(store);
    // Written directly: no tool mints `superseded`, but real stores contain it.
    await store.put('evolutions', {
      change: 'a legacy record',
      trigger: 'bulk backfill',
      confidence: 'medium',
      status: 'superseded',
      created_at: new Date().toISOString(),
    });
    await proposeOne(ctx);

    const res = await evolutionListTool.handler({ status: 'superseded' }, ctx);
    expect(res['count']).toBe(1);
    expect((res['evolutions'] as Record<string, unknown>[])[0]?.['change']).toBe('a legacy record');
  });

  it('validates inputs and unknown ids', async () => {
    const store = new SqliteCortexStore(':memory:');
    const ctx = makeContext(store);

    expect((await evolutionResolveTool.handler({ status: 'applied' }, ctx))['error']).toMatch(/id is required/);
    expect((await evolutionResolveTool.handler({ id: 'x' }, ctx))['error']).toMatch(/status is required/);
    expect((await evolutionResolveTool.handler({ id: 'x', status: 'proposed' }, ctx))['error']).toMatch(/status must be one of/);
    expect((await evolutionResolveTool.handler({ id: 'nope', status: 'applied' }, ctx))['error']).toMatch(/not found/);
  });
});
