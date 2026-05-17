# Concurrency model

cortex-engine targets single-process deployment (one MCP server, one REST
process, one CLI invocation). Inside that process, multiple requests can
land on the same store concurrently. This document describes the
invariants that make that safe.

## Storage-level invariants

### WAL + `busy_timeout = 5000`

`SqliteCortexStore` opens its database with `journal_mode = WAL` and
`busy_timeout = 5000`. The combination matters:

- **WAL** lets readers and a single writer proceed in parallel. Without
  WAL, any reader blocks every writer.
- **`busy_timeout = 5000`** tells SQLite to wait up to 5 seconds before
  returning `SQLITE_BUSY` when the writer lock is contested. Without it,
  two concurrent writers race straight to `SQLITE_BUSY` on the first
  contention point (e.g. a WAL checkpoint), so the second one fails
  immediately.

5000ms is the standard value — long enough to ride out a checkpoint,
short enough to surface a real deadlock visibly.

### Single-process assumption

cortex-engine does not provide cross-process coordination. Two MCP server
processes pointed at the same SQLite file will see corruption only in
the loosest sense (WAL prevents file-level corruption) but they will
race each other's transactions and produce inconsistent state. Run one
process per database file.

For Firestore the question does not arise — multiple processes against
the same Firestore database is the normal mode, and Firestore handles
the cross-process semantics.

## `withTransaction` contract

```ts
store.withTransaction(async (txn) => { ... });
```

All writes performed through `txn` commit atomically when the closure
resolves. A thrown error rolls everything back.

### SQLite implementation

Manual `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` driven by a
Promise-chained mutex on the store instance. better-sqlite3's own
`db.transaction()` wrapper is synchronous and commits the moment its
sync callback returns — it cannot survive an `await` suspension inside
an `async` user closure. Manual BEGIN/COMMIT lets the closure await
store ops correctly.

The Promise-chained mutex is required because better-sqlite3 has no
internal queueing for concurrent `BEGIN` statements; two concurrent
calls would throw `SQLITE_ERROR: cannot start a transaction within a
transaction`. The mutex serializes them, so transactions run one at a
time per store instance regardless of how many callers race them.

**Hard constraint on the closure body**: do not `await` external systems
(LLM calls, network, timers). They hold the transaction open and block
every other writer through the queue. Store operations are fine — they
are synchronous under their `async` wrapper, so the awaits resolve on
the same tick.

If you need data from an LLM/network/embedder for the writes, fetch it
*before* the transaction and pass it into the closure. Example:

```ts
const embedding = await embed.embed(text);            // outside
await store.withTransaction(async (txn) => {
  await txn.putBelief({ ... });
  await txn.updateMemory(id, { embedding, ... });     // inside
});
```

### Firestore implementation

Wraps `db.runTransaction()`. The proxy passed to the closure
(`FirestoreTxnProxy`) routes writes through `txn.set/update/delete` so
they commit atomically and reads through `txn.get` so they participate
in Firestore's optimistic concurrency check.

Firestore transactions have stricter shape constraints than SQLite:

- **Reads-before-writes within the closure** — after the first write, no
  more reads are allowed.
- **No queries that scan** — `findNearest`, `query`, `countDocuments`,
  `getRecent*`, `getAll*`, `getEdgesForMemories`, `queryOps`,
  `getBeliefHistory`, `getUnprocessedObservations`, `getEdgesFrom` all
  throw inside a transaction. Perform those reads outside, pass the IDs
  in.
- **Automatic retries** — Firestore may rerun the closure if it loses an
  optimistic concurrency race. Keep the closure idempotent.

### Nesting

Nested `withTransaction` calls are forbidden on both backends and throw
`Nested withTransaction is not supported`. Compose multi-step writes
into a single outer transaction instead of trying to nest.

## When to use `withTransaction`

Wrap any operation that performs more than one write whose intermediate
state would be a bug if observed:

| Pattern | Why it needs a transaction |
| --- | --- |
| `putMemory` + `markObservationProcessed` | Orphan memory if the second fails; observation re-promoted if the first did. |
| `putBelief` + `updateMemory` | Belief audit row pointing at a memory whose definition was never updated. |
| `putMemory` + multiple `putEdge` | Abstraction memory with partial provenance edges. |
| Read-modify-write counters (e.g. ops status with versioning) | Lost updates under contention. |

Single-write operations (`putMemory` alone, `putEdge` alone,
`markObservationProcessed` alone) do not need a transaction — the store
method already issues exactly one statement, which SQLite/Firestore
treat as atomic.

## What we do NOT provide

- **Cross-process locking.** One cortex-engine process per database.
- **Optimistic concurrency control** on individual `updateMemory` calls.
  Callers who need it can read-then-update inside `withTransaction`.
- **Async-safe transaction APIs that allow LLM calls inside.** This
  would require switching SQLite drivers or rewriting the engine on top
  of a connection pool.

## Testing

`src/stores/concurrency.test.ts` covers:

- `busy_timeout` is set to 5000 after construction.
- `withTransaction` commits multi-step writes atomically.
- `withTransaction` rolls back on throw.
- Nested `withTransaction` is rejected with a clear error.
- 16 parallel read-modify-write increments produce the exact expected
  final count (no lost updates).
