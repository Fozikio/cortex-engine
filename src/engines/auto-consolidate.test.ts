/**
 * Tests for SessionConsolidator — threshold-triggered background Phase A.
 */

import { describe, it, expect, vi } from 'vitest';
import { SessionConsolidator, AUTO_THRESHOLD } from './auto-consolidate.js';
import type { CortexStore } from '../core/store.js';
import type { NamespaceManager } from '../namespace/manager.js';
import type { EmbedProvider } from '../core/embed.js';
import type { LLMProvider } from '../core/llm.js';

function makeMockStore(): CortexStore {
  return {
    // Phase A entry point — empty result short-circuits cluster/refine/create
    // so no embed/llm calls happen. The call itself is the trigger signal.
    getUnprocessedObservations: vi.fn(() => Promise.resolve([])),
    getEdgesForMemories: vi.fn(() => Promise.resolve([])),
    findNearest: vi.fn(() => Promise.resolve([])),
    getAllMemories: vi.fn(() => Promise.resolve([])),
  } as unknown as CortexStore;
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
}

describe('SessionConsolidator', () => {
  it('does not trigger below the threshold', async () => {
    const store = makeMockStore();
    const consolidator = new SessionConsolidator(makeManager({ default: store }), embed, llm);

    for (let i = 0; i < AUTO_THRESHOLD - 1; i++) {
      consolidator.notifyObservation('default');
    }
    await settle();

    expect(store.getUnprocessedObservations).not.toHaveBeenCalled();
  });

  it('triggers Phase A exactly at the threshold', async () => {
    const store = makeMockStore();
    const consolidator = new SessionConsolidator(makeManager({ default: store }), embed, llm);

    for (let i = 0; i < AUTO_THRESHOLD; i++) {
      consolidator.notifyObservation('default');
    }
    await settle();

    expect(store.getUnprocessedObservations).toHaveBeenCalledTimes(1);
  });

  it('resets the counter after triggering — next trigger needs a full batch', async () => {
    const store = makeMockStore();
    const consolidator = new SessionConsolidator(makeManager({ default: store }), embed, llm);

    for (let i = 0; i < AUTO_THRESHOLD; i++) consolidator.notifyObservation('default');
    await settle();
    // A few more, below threshold — must not re-trigger
    for (let i = 0; i < 3; i++) consolidator.notifyObservation('default');
    await settle();

    expect(store.getUnprocessedObservations).toHaveBeenCalledTimes(1);
  });

  it('tracks namespaces independently', async () => {
    const storeA = makeMockStore();
    const storeB = makeMockStore();
    const consolidator = new SessionConsolidator(
      makeManager({ a: storeA, b: storeB }), embed, llm,
    );

    for (let i = 0; i < AUTO_THRESHOLD; i++) consolidator.notifyObservation('a');
    consolidator.notifyObservation('b');
    await settle();

    expect(storeA.getUnprocessedObservations).toHaveBeenCalledTimes(1);
    expect(storeB.getUnprocessedObservations).not.toHaveBeenCalled();
  });

  it('flush() drains namespaces with pending observations', async () => {
    const storeA = makeMockStore();
    const storeB = makeMockStore();
    const consolidator = new SessionConsolidator(
      makeManager({ a: storeA, b: storeB }), embed, llm,
    );

    consolidator.notifyObservation('a'); // below threshold — pending
    await consolidator.flush();

    expect(storeA.getUnprocessedObservations).toHaveBeenCalledTimes(1);
    expect(storeB.getUnprocessedObservations).not.toHaveBeenCalled();
  });

  it('survives store errors without throwing', async () => {
    const store = {
      getUnprocessedObservations: vi.fn(() => Promise.reject(new Error('boom'))),
      getEdgesForMemories: vi.fn(() => Promise.resolve([])),
      findNearest: vi.fn(() => Promise.resolve([])),
      getAllMemories: vi.fn(() => Promise.resolve([])),
    } as unknown as CortexStore;
    const consolidator = new SessionConsolidator(makeManager({ default: store }), embed, llm);

    for (let i = 0; i < AUTO_THRESHOLD; i++) consolidator.notifyObservation('default');
    await expect(consolidator.flush()).resolves.toBeUndefined();
  });
});
