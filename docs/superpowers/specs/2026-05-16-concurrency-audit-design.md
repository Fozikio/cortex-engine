# Concurrency audit + safe defaults

**Status:** Draft for review
**Date:** 2026-05-16
**Owner:** idapixl
**Related specs:** [2026-05-16-store-migration-design.md], [2026-05-16-tool-discovery-design.md]

## Problem

`SqliteCortexStore` already enables WAL and foreign keys but never sets `busy_timeout`, so two concurrent writers hit `SQLITE_BUSY` instantly instead of waiting through normal checkpoint contention. Multi-step writes (dream consolidation, digest pipeline, putMemory + putEdge chains) run as separate `await`s, so a mid-sequence failure leaves the store with orphans (memories without edges, observations marked processed without resulting memories). The audit reviewer flagged this as the most credible critique.

The fix is small but the *interface* implication is real: there is no public way for a tool author to compose multi-write operations atomically, so even after fixing the known call-sites, the next bug is one PR away.

## Goals

1. Eliminate the `busy_timeout = 0` footgun.
2. Make multi-step writes atomic across both backends.
3. Give tool authors a public, store-agnostic `withTransaction(fn)` primitive so future composite operations are safe by default.
4. Document the concurrency model so future contributors know the invariants.

## Non-goals

- Distributed locking across multiple cortex-engine processes (out of scope — MCP servers are single-process).
- Optimistic concurrency control on `updateMemory` (callers can layer this on top of `withTransaction` if needed).
- Replacing `better-sqlite3` with `libsql` or another driver.

## Design

### Interface change — `CortexStore.withTransaction`

Add to `src/core/store.ts`:

```ts
export interface CortexStore {
  // ... existing methods ...

  /**
   * Run `fn` inside a backend-native transaction. All writes performed via
   * the passed store proxy commit atomically on resolve; any thrown error
   * rolls back. Nested calls coalesce into the outermost transaction.
   */
  withTransaction<T>(fn: (txn: CortexStore) => Promise<T>): Promise<T>;
}
```

**SQLite implementation.** Wraps `db.transaction(() => { ... })` from `better-sqlite3`. The proxy passed to `fn` is `this` — synchronous SQL ops inside the closure are captured by the existing transaction object. `better-sqlite3` does *not* support async work inside `db.transaction()`, so the implementation runs the user closure synchronously by awaiting it ahead of starting the transaction is not viable. We resolve this by adopting `better-sqlite3`'s deferred/immediate transaction pattern: collect operations in a buffer, then commit. For now, the practical constraint is documented as "no awaits inside `withTransaction` that touch external systems" — store ops themselves are all synchronous under the async wrapper, so this works.

**Firestore implementation.** Wraps `db.runTransaction(fn)`. The proxy is a `FirestoreCortexStore` instance bound to the transaction handle. The same `CortexStore` interface is implemented but writes go through `txn.set/update` instead of `ref.set/update`.

### Constructor change

In `SqliteCortexStore` constructor, immediately after `pragma('journal_mode = WAL')`:

```ts
this.db.pragma('busy_timeout = 5000');
```

5000ms is the standard value — long enough to ride out checkpoint contention, short enough to fail visibly on a real deadlock.

### Call-site audit (must be wrapped in `withTransaction`)

The following call-sites perform multi-entity writes today and must be migrated:

1. **`tools/dream.ts` consolidation flow** — reads unprocessed observations, writes memories, writes edges, marks observations processed. Currently four separate awaits. Migration: wrap the entire consolidation step inside `store.withTransaction(async (txn) => { ... })`.
2. **`engines/digest.ts`** — same structural shape as dream.
3. **`engines/cognition.ts`** — observation→memory promotion path.
4. **`tools/link.ts`** — single `putEdge`, low risk, but verify no chained writes.
5. **`tools/believe.ts`** — writes a belief entry alongside a memory update; needs wrapping.

Each call-site change is mechanical: introduce the wrapper, replace the per-step awaits.

### Documentation

Two new artifacts:
- **`docs/concurrency.md`** — full concurrency model: WAL semantics, `busy_timeout` rationale, transaction scope, multi-process warning, Firestore vs SQLite divergences.
- **CLAUDE.md `## Concurrency invariants` section** — concise: "all multi-step writes must use `withTransaction`. Single-process MCP server is the supported deployment. Multi-process safety is not provided."

### Testing

New test file `src/stores/concurrency.test.ts`:

- `busy_timeout` is set to 5000 after constructor (read via `db.pragma('busy_timeout', { simple: true })`).
- `withTransaction` commits atomically on success — write A + write B both visible after resolve.
- `withTransaction` rolls back on throw — neither A nor B visible after reject.
- Parallel-writer stress test — spawn 16 promises calling `withTransaction` to increment a shared counter via read-modify-write; assert final count is exact (no lost updates).
- Firestore equivalent uses the firestore emulator (existing test infra).

## Error handling

- `SQLITE_BUSY` during `busy_timeout`'s 5s window auto-retries internally; only surfaces if contention exceeds the window. This is the desired loud-fail.
- `withTransaction` throw → automatic rollback via `better-sqlite3`/`runTransaction`.
- Calling `withTransaction` from within another `withTransaction` on SQLite: `better-sqlite3` raises a clear error. We do *not* auto-coalesce (would hide bugs). Firestore allows nesting but we explicitly forbid it in the contract.

## Rollout

Single PR, since the interface change forces every `CortexStore` implementer to update simultaneously. Migration of call-sites can land in the same PR or follow-ups, but the prerequisite is the interface + impl + tests.

## Out of scope (this spec)

- Optimistic locking layer.
- Cross-process coordination.
- Async-friendly transaction API (would require rewriting on top of `better-sqlite3`'s mutex or switching drivers).

## Risk notes

- **Sync-only constraint on SQLite.** `better-sqlite3` is synchronous under the async wrapper. `withTransaction(fn)` cannot do meaningful awaits inside `fn` if those awaits touch external systems (LLM calls, network) — only store ops are safe. We document this; ideally we'd lint it but that's deferred.
- **Firestore parity.** Firestore's transactional model requires reads-before-writes; if a wrapped flow does write-then-read-then-write, it must be restructured. The migration audit of dream/digest will surface any such cases.
