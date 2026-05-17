/**
 * Concurrency tests for SqliteCortexStore.withTransaction and busy_timeout.
 * See docs/concurrency.md for the invariants under test.
 */

import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import { SqliteCortexStore } from './sqlite.js';

interface StoreInternals {
  db: Database.Database;
}

function getDb(store: SqliteCortexStore): Database.Database {
  return (store as unknown as StoreInternals).db;
}

describe('SqliteCortexStore busy_timeout', () => {
  it('is set to 5000ms after construction', () => {
    const store = new SqliteCortexStore(':memory:');
    const value = getDb(store).pragma('busy_timeout', { simple: true });
    expect(value).toBe(5000);
  });
});

describe('SqliteCortexStore.withTransaction', () => {
  it('commits A + B atomically on resolve', async () => {
    const store = new SqliteCortexStore(':memory:');

    await store.withTransaction(async (txn) => {
      await txn.appendOps({
        content: 'A',
        type: 'log',
        status: 'active',
        project: null,
        session_ref: 't',
        keywords: [],
        created_at: new Date(),
        updated_at: new Date(),
        expires_at: new Date(Date.now() + 86400_000),
      });
      await txn.appendOps({
        content: 'B',
        type: 'log',
        status: 'active',
        project: null,
        session_ref: 't',
        keywords: [],
        created_at: new Date(),
        updated_at: new Date(),
        expires_at: new Date(Date.now() + 86400_000),
      });
    });

    const all = await store.queryOps({});
    const contents = all.map((e) => e.content).sort();
    expect(contents).toEqual(['A', 'B']);
  });

  it('rolls back A + B on throw', async () => {
    const store = new SqliteCortexStore(':memory:');

    // Seed one row outside the transaction so we can assert it survives.
    await store.appendOps({
      content: 'pre',
      type: 'log',
      status: 'active',
      project: null,
      session_ref: 't',
      keywords: [],
      created_at: new Date(),
      updated_at: new Date(),
      expires_at: new Date(Date.now() + 86400_000),
    });

    await expect(
      store.withTransaction(async (txn) => {
        await txn.appendOps({
          content: 'A',
          type: 'log',
          status: 'active',
          project: null,
          session_ref: 't',
          keywords: [],
          created_at: new Date(),
          updated_at: new Date(),
          expires_at: new Date(Date.now() + 86400_000),
        });
        await txn.appendOps({
          content: 'B',
          type: 'log',
          status: 'active',
          project: null,
          session_ref: 't',
          keywords: [],
          created_at: new Date(),
          updated_at: new Date(),
          expires_at: new Date(Date.now() + 86400_000),
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    const all = await store.queryOps({});
    const contents = all.map((e) => e.content).sort();
    expect(contents).toEqual(['pre']);
  });

  it('rejects nested withTransaction with a clear error', async () => {
    const store = new SqliteCortexStore(':memory:');

    await expect(
      store.withTransaction(async (txn) => {
        await txn.withTransaction(async () => { /* unreachable */ });
      }),
    ).rejects.toThrow(/Nested withTransaction/);
  });

  it('serializes parallel read-modify-write under contention', async () => {
    // Counter lives in the generic_docs collection so we can read/write it
    // through the public CortexStore API without leaning on internals.
    const store = new SqliteCortexStore(':memory:');
    await store.put('counters', { id: 'shared', v: 0 });

    const N = 16;
    const increments = Array.from({ length: N }, () =>
      store.withTransaction(async (txn) => {
        const row = await txn.get('counters', 'shared');
        const v = ((row as { v?: number } | null)?.v ?? 0) + 1;
        await txn.update('counters', 'shared', { v });
      }),
    );
    await Promise.all(increments);

    const final = await store.get('counters', 'shared');
    expect((final as { v: number }).v).toBe(N);
  });
});
