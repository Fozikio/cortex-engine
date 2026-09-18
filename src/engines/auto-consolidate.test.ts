/**
 * Tests for SessionConsolidator — threshold-triggered background Phase A.
 *
 * The trigger is the store's own unprocessed-row count (#114), not a count
 * of notifyObservation() calls this process happened to make — a namespace
 * shared with a CLI can have rows processed out from under it between calls.
 * `getUnprocessedObservations` always resolves empty here so dreamPhaseA's
 * cluster/refine/create phases short-circuit with no embed/llm calls (the
 * call itself is the "Phase A ran" signal); `countUnprocessedObservations`
 * is the independent, test-controlled row count that decides whether that
 * call happens at all.
 */

import { describe, it, expect, vi } from 'vitest';
import { SessionConsolidator, AUTO_THRESHOLD } from './auto-consolidate.js';
import type { CortexStore } from '../core/store.js';
import type { NamespaceManager } from '../namespace/manager.js';
import type { EmbedProvider } from '../core/embed.js';
import type { LLMProvider } from '../core/llm.js';

/** A store double whose unprocessed-row count a test can seed and drain. */
function makeMockStore(initialUnprocessed = 0): CortexStore & { unprocessed: number } {
  const state = { unprocessed: initialUnprocessed };
  return {
    // Phase A entry point — empty result short-circuits cluster/refine/create
    // so no embed/llm calls happen. The call itself is the trigger signal.
    getUnprocessedObservations: vi.fn(() => Promise.resolve([])),
    // Drives notifyObservation's threshold check, independent of the above.
    countUnprocessedObservations: vi.fn(() => Promise.resolve(state.unprocessed)),
    markObservationProcessed: vi.fn(() => {
      state.unprocessed = Math.max(0, state.unprocessed - 1);
      return Promise.resolve();
    }),
    getEdgesForMemories: vi.fn(() => Promise.resolve([])),
    findNearest: vi.fn(() => Promise.resolve([])),
    getAllMemories: vi.fn(() => Promise.resolve([])),
    get unprocessed() { return state.unprocessed; },
    set unprocessed(n: number) { state.unprocessed = n; },
  } as unknown as CortexStore & { unprocessed: number };
}

function makeManager(stores: Record<string, CortexStore>): NamespaceManager {
  return {
    getStore: vi.fn((ns?: string) => stores[ns ?? 'default']),
    getConfig: vi.fn(() => ({
      description: 'test',
      cognitive_tools: [],
      collections_prefix: '',
      similarity_merge: 0.85,
      similarity_link: 0.5,
    })),
    getNamespaceNames: vi.fn(() => Object.keys(stores)),
    getDefaultNamespace: vi.fn(() => 'default'),
  } as unknown as NamespaceManager;
}

const embed = { embed: vi.fn(() => Promise.resolve([1, 0, 0])) } as EmbedProvider;
const llm = {
  generate: vi.fn(() => Promise.resolve('')),
  generateJSON: vi.fn(() => Promise.resolve({})),
} as unknown as LLMProvider;

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('SessionConsolidator', () => {
  it('does not trigger below the threshold', async () => {
    const store = makeMockStore(AUTO_THRESHOLD - 1);
    const consolidator = new SessionConsolidator(makeManager({ default: store }), embed, llm);

    for (let i = 0; i < AUTO_THRESHOLD - 1; i++) {
      consolidator.notifyObservation('default');
    }
    await settle();

    expect(store.getUnprocessedObservations).not.toHaveBeenCalled();
  });

  it('triggers Phase A when the store reports at least AUTO_THRESHOLD unprocessed rows', async () => {
    const store = makeMockStore(AUTO_THRESHOLD);
    const consolidator = new SessionConsolidator(makeManager({ default: store }), embed, llm);

    consolidator.notifyObservation('default');
    await settle();

    expect(store.getUnprocessedObservations).toHaveBeenCalledTimes(1);
  });

  it('does not run Phase A when the observations were processed by someone else', async () => {
    // Ten observe() calls, but each row is promoted/processed by hand (as a
    // CLI would, via store.markObservationProcessed) before the next call —
    // the store never actually holds AUTO_THRESHOLD unprocessed rows at once.
    // The old call-counting trigger fired here regardless; it must not now.
    const store = makeMockStore(0);
    const consolidator = new SessionConsolidator(makeManager({ default: store }), embed, llm);

    for (let i = 0; i < AUTO_THRESHOLD; i++) {
      store.unprocessed += 1; // the observe() call's row lands
      consolidator.notifyObservation('default');
      await settle();
      await store.markObservationProcessed('irrelevant-in-this-fake'); // promoted by hand
      await settle();
    }

    expect(store.getUnprocessedObservations).not.toHaveBeenCalled();
  });

  it('runs Phase A when ten unprocessed rows exist, however many calls it took', async () => {
    const store = makeMockStore(AUTO_THRESHOLD);
    const consolidator = new SessionConsolidator(makeManager({ default: store }), embed, llm);

    consolidator.notifyObservation('default'); // one call, ten rows already sitting in the store
    await settle();

    expect(store.getUnprocessedObservations).toHaveBeenCalledTimes(1);
  });

  it('tracks namespaces independently', async () => {
    const storeA = makeMockStore(AUTO_THRESHOLD);
    const storeB = makeMockStore(AUTO_THRESHOLD - 1);
    const consolidator = new SessionConsolidator(
      makeManager({ a: storeA, b: storeB }), embed, llm,
    );

    consolidator.notifyObservation('a');
    consolidator.notifyObservation('b');
    await settle();

    expect(storeA.getUnprocessedObservations).toHaveBeenCalledTimes(1);
    expect(storeB.getUnprocessedObservations).not.toHaveBeenCalled();
  });

  it('guards against two overlapping threshold checks for the same namespace', async () => {
    const store = makeMockStore(AUTO_THRESHOLD);
    const countSpy = store.countUnprocessedObservations as unknown as ReturnType<typeof vi.fn>;
    const consolidator = new SessionConsolidator(makeManager({ default: store }), embed, llm);

    // Fired back to back, synchronously, the way two observe() calls in
    // quick succession would — the second must not start its own check
    // while the first is still reading the store.
    consolidator.notifyObservation('default');
    consolidator.notifyObservation('default');
    await settle();

    expect(countSpy).toHaveBeenCalledTimes(1);
    expect(store.getUnprocessedObservations).toHaveBeenCalledTimes(1);
  });

  it('does not start a second Phase A run while one is already in flight', async () => {
    let resolveFirstRun: (() => void) | undefined;
    const store = {
      // Hangs so the first Phase A run stays "in flight" until we release it.
      getUnprocessedObservations: vi.fn(() => new Promise((resolve) => {
        resolveFirstRun = () => resolve([]);
      })),
      countUnprocessedObservations: vi.fn(() => Promise.resolve(AUTO_THRESHOLD)),
      markObservationProcessed: vi.fn(() => Promise.resolve()),
      getEdgesForMemories: vi.fn(() => Promise.resolve([])),
      findNearest: vi.fn(() => Promise.resolve([])),
      getAllMemories: vi.fn(() => Promise.resolve([])),
    } as unknown as CortexStore;
    const consolidator = new SessionConsolidator(makeManager({ default: store }), embed, llm);

    consolidator.notifyObservation('default');
    await settle(); // threshold check resolves, Phase A starts and hangs on the store call

    consolidator.notifyObservation('default'); // the `running` guard should block this outright
    await settle();

    expect(store.getUnprocessedObservations).toHaveBeenCalledTimes(1);

    resolveFirstRun?.();
    await settle();
  });

  it('flush() drains namespaces with unprocessed rows', async () => {
    const storeA = makeMockStore(1); // below AUTO_THRESHOLD but nonzero
    const storeB = makeMockStore(0);
    const consolidator = new SessionConsolidator(
      makeManager({ a: storeA, b: storeB }), embed, llm,
    );

    await consolidator.flush();

    expect(storeA.getUnprocessedObservations).toHaveBeenCalledTimes(1);
    expect(storeB.getUnprocessedObservations).not.toHaveBeenCalled();
  });

  it('survives a Phase A run failing without throwing', async () => {
    const store = {
      getUnprocessedObservations: vi.fn(() => Promise.reject(new Error('boom'))),
      countUnprocessedObservations: vi.fn(() => Promise.resolve(AUTO_THRESHOLD)),
      markObservationProcessed: vi.fn(() => Promise.resolve()),
      getEdgesForMemories: vi.fn(() => Promise.resolve([])),
      findNearest: vi.fn(() => Promise.resolve([])),
      getAllMemories: vi.fn(() => Promise.resolve([])),
    } as unknown as CortexStore;
    const consolidator = new SessionConsolidator(makeManager({ default: store }), embed, llm);

    await expect(consolidator.flush()).resolves.toBeUndefined();
  });

  it('survives the threshold count itself failing without throwing', async () => {
    const store = {
      getUnprocessedObservations: vi.fn(() => Promise.resolve([])),
      countUnprocessedObservations: vi.fn(() => Promise.reject(new Error('boom'))),
      markObservationProcessed: vi.fn(() => Promise.resolve()),
      getEdgesForMemories: vi.fn(() => Promise.resolve([])),
      findNearest: vi.fn(() => Promise.resolve([])),
      getAllMemories: vi.fn(() => Promise.resolve([])),
    } as unknown as CortexStore;
    const consolidator = new SessionConsolidator(makeManager({ default: store }), embed, llm);

    consolidator.notifyObservation('default');
    await settle();

    expect(store.getUnprocessedObservations).not.toHaveBeenCalled();
  });
});
