# Storage backends

cortex-engine ships three implementations of the `CortexStore` interface. They share the same wire format for entities and the same migration path, but they target very different deployment shapes.

| Property | `sqlite:` | `firestore:` | `json:` |
|---|---|---|---|
| **Intended use** | Local development, single-process MCP server, small-to-mid agents | Cloud-hosted multi-region agents | Backup, restore, migration staging, tests |
| **Latency** | Microseconds (in-process) | 10–100ms per RPC | Microseconds (in-memory) |
| **Persistence** | WAL-journaled file | Cloud Firestore | Single JSON file, atomic temp+rename |
| **Vector search** | Brute-force cosine (sufficient < 10k memories) | Firestore native `findNearest` | Brute-force cosine |
| **Concurrent writers** | Serialized via per-store Promise mutex + WAL + `busy_timeout=5000` | Native Firestore transactions | Single in-process owner; not shareable |
| **Cross-process safe** | No (single-process invariant) | Yes | No |
| **Transactions** | Manual `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` with re-entry guard | `runTransaction` + `FirestoreTxnProxy` (reads-before-writes) | Snapshot-on-enter, in-memory rollback |
| **Setup cost** | None (default) | GCP project, ADC or service account | None |
| **Dependencies** | `better-sqlite3` (in `dependencies`) | `@google-cloud/firestore`, `firebase-admin` (optional peer deps) | None |
| **Suitable for production** | Yes (single-process agent) | Yes (any topology) | No (memory-bound, no concurrency story) |

## When to pick which

**SQLite** is the default and the right answer for ~90% of agents. A single MCP server backed by a local `cortex.db` file gives you microsecond reads, WAL-journaled writes, and `busy_timeout` coverage for checkpoint contention. There is no separate service to operate. Vector search is brute-force cosine but stays well under 10 ms up to ~10k memories on commodity hardware. The invariant: one cortex-engine process per database file.

**Firestore** is for agents that need to be reachable from multiple processes, run on Cloud Run or another ephemeral compute surface, or have data already living in Google Cloud. Native vector search via `findNearest` scales beyond what SQLite's brute-force cosine can serve. Transactions go through `runTransaction` with the reads-before-writes constraint Firestore imposes — scans inside a transaction throw, so wrap multi-write composites cleanly.

**JSON** is a tool, not a backend. Use it for:
- `fozikio migrate --to json:./backup.json` to snapshot a SQLite or Firestore store before risky operations.
- The destination half of integration tests that need to assert against the full entity graph.
- Manually inspecting cortex state — a `json:` store opens in any editor.

Do not host a live agent on JSON. It rewrites the entire file on every write and holds the full dataset in memory.

## URL syntax

The migration tool and the URL factory accept these forms:

```
sqlite:./cortex.db
sqlite:/abs/path/cortex.db?namespace=anthems
firestore:my-gcp-project
firestore:my-gcp-project?database=my-named-db&namespace=anthems
json:./backup.json
json:/abs/path/snapshot.json
```

The `?namespace=` query parameter binds the store to a table/collection prefix; omit it for the legacy un-prefixed default.

## Migrating between backends

```bash
# SQLite → JSON (backup)
fozikio migrate --from sqlite:./cortex.db --to json:./snapshot.json --verify

# JSON → SQLite (restore into a fresh location)
fozikio migrate --from json:./snapshot.json --to sqlite:./restored.db

# SQLite → Firestore (when ready to go cloud)
fozikio migrate --from sqlite:./cortex.db --to firestore:my-project --verify

# Resume an interrupted migration
fozikio migrate --from sqlite:./cortex.db --to firestore:my-project --resume

# Rename the namespace during copy
fozikio migrate --from sqlite:./cortex.db --to sqlite:./new.db \
  --rename-namespace anthems=songs
```

All migrations are:
- **ID-preserving** — links and references survive intact.
- **Idempotent** — re-running with `--resume` produces the same result as a successful first run.
- **Fail-fast on schema mismatch** — refuses to migrate between stores with incompatible `schemaVersion` or `embeddingDimension` before writing anything to the destination.

See [`docs/superpowers/specs/2026-05-16-store-migration-design.md`](superpowers/specs/2026-05-16-store-migration-design.md) for the full design.

## Limitations

- **Firestore migration is currently stubbed.** Source/destination iteration for signals, beliefs, edges, ops, and observations narrows on `SqliteCortexStore` / `JsonCortexStore` via `instanceof`. A Firestore endpoint in either direction will throw a clear "not implemented for store class FirestoreCortexStore" error. This is on the roadmap; in the meantime, route via JSON if you need to move data into or out of Firestore.

- **All three backends require matching embedding dimensions.** Switching from `embed: built-in` (384d) to `embed: vertex` (768d) is not a migration — it is a re-embedding job. Use `fozikio maintain re-embed` against the destination after migration.
