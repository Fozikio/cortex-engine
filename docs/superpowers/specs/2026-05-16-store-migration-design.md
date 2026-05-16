# Store-migration tooling

**Status:** Draft for review
**Date:** 2026-05-16
**Owner:** idapixl
**Related specs:** [2026-05-16-concurrency-audit-design.md], [2026-05-16-tool-discovery-design.md]

## Problem

`cortex-engine` ships two stores (SQLite, Firestore) behind a common `CortexStore` interface but offers no path between them. A developer who starts on local SQLite and grows into Firestore — the natural upgrade — has no migration tool. Worse, there's no backup format: a SQLite database is an opaque binary, and Firestore export requires GCP tooling. The audit reviewer made "abstract the persistence layer" their #1 recommendation; the interface is already abstract, but the *plumbing* that proves it (a migrator) is missing.

Building this also forces a latent API gap into the open: `putMemory/putObservation/...` mint UUIDs internally, so they can't preserve IDs across a clone. The fix elevates `CortexStore` from one-way ingest to a round-trip storage primitive.

## Goals

1. One-way clone between any pair of `CortexStore` backends, end-to-end (memories, observations, edges, ops, signals, beliefs, generic docs).
2. ID preservation so links and references survive intact.
3. Resumable on failure (checkpoint file).
4. Schema-mismatch detection that fails loudly before mutating the destination.
5. A JSON store target — round-trippable backup format, also the basis for the integration test.
6. Namespace remapping so users can consolidate or split workspaces during migration.
7. `--verify` mode that diffs source and destination after migration.

## Non-goals

- Bidirectional sync. Different product.
- Schema transformation across version gaps. A separate codemod tool will own that.
- Online migration with zero downtime. The contract is: stop the agent, migrate, restart.

## Design

### Interface change — upsert variants

The existing `putMemory/putObservation/...` methods mint UUIDs internally. Migration needs ID preservation. Two viable shapes:

**Option A — per-entity upsert methods:** `upsertMemory(memory: Memory): Promise<void>`, etc. Mirrors existing methods 1:1.

**Option B — generic `import(entity: Entity, data: ...): Promise<void>`:** single method dispatching on entity kind.

**Decision: A.** Generic dispatch hides type information and is unfriendly to callers. The cost is 6 new methods on the interface, but each is a thin wrapper around `INSERT OR REPLACE` (SQLite) / `ref.set(data, { merge: false })` (Firestore).

```ts
export interface CortexStore {
  // ... existing methods ...

  upsertMemory(memory: Memory): Promise<void>;
  upsertObservation(obs: Observation): Promise<void>;
  upsertEdge(edge: Edge): Promise<void>;
  upsertOpsEntry(entry: OpsEntry): Promise<void>;
  upsertSignal(signal: Signal): Promise<void>;
  upsertBelief(belief: BeliefEntry): Promise<void>;

  /** Returns store metadata for compatibility checks during migration. */
  getCapabilities(): Promise<StoreCapabilities>;
}

export interface StoreCapabilities {
  schemaVersion: number;          // bumped when interface changes break compat
  embeddingDimension: number;     // first memory's embedding length, or 0 if empty
  categories: string[];           // observed Memory.category values
  namespace: string;              // store's bound namespace
  backend: 'sqlite' | 'firestore' | 'json';
}
```

### New module — `src/bin/store-url.ts`

Parse store URLs:
- `sqlite:./cortex.db`
- `sqlite:/abs/path.db?namespace=foo`
- `firestore:my-gcp-project`
- `firestore:my-gcp-project?database=my-db&namespace=foo`
- `json:./backup.json`

```ts
export interface ParsedStoreUrl {
  kind: 'sqlite' | 'firestore' | 'json';
  options: {
    path?: string;
    projectId?: string;
    databaseId?: string;
    namespace?: string;
  };
}

export function parseStoreUrl(url: string): ParsedStoreUrl;
export async function createStoreFromUrl(url: string): Promise<CortexStore>;
```

`createStoreFromUrl` reuses `src/bin/store-factory.ts:createStore` after synthesizing a `CortexConfig` shape from the parsed URL.

### New module — `src/stores/json.ts`

A `CortexStore` implementation backed by a single JSON file. Loads on construct, holds in memory, persists on every write. Vector search is the same brute-force cosine as SQLite. Intended for backup, restore, and testing — not production scale.

Schema:
```json
{
  "schemaVersion": 1,
  "namespace": "",
  "memories": { "<id>": { ... } },
  "observations": { "<id>": { ... } },
  "edges": { "<id>": { ... } },
  "ops": { "<id>": { ... } },
  "signals": { "<id>": { ... } },
  "beliefs": { "<id>": { ... } },
  "generic": { "<collection>": { "<id>": { ... } } }
}
```

### New module — `src/bin/migrate-cmd.ts`

Entry point. Pseudocode:

```ts
async function migrate(opts: MigrateOptions) {
  const src = await createStoreFromUrl(opts.from);
  const dst = await createStoreFromUrl(opts.to);

  await assertCompatibility(src, dst);  // throws on schemaVersion/embedDim mismatch

  const checkpoint = loadCheckpoint(opts.resume) ?? freshCheckpoint(opts);

  for (const stage of MIGRATION_STAGES) {
    if (checkpoint[stage] === 'done') continue;
    await migrateStage(src, dst, stage, checkpoint, opts);
    checkpoint[stage] = 'done';
    saveCheckpoint(checkpoint);
  }

  if (opts.verify) await verifyMigration(src, dst);

  fs.unlinkSync(CHECKPOINT_PATH);  // success → remove checkpoint
}
```

Stages run in dependency order: `memories → observations → edges → ops → signals → beliefs → generic`. Edges last because they reference memory IDs (defensive — IDs are preserved so order is hygienic, not strictly required).

### Checkpoint format

`.cortex-migrate-state.json` in CWD:

```json
{
  "startedAt": "2026-05-16T14:00:00Z",
  "srcUrl": "sqlite:./cortex.db",
  "dstUrl": "firestore:my-project",
  "memories": "done",
  "observations": "<last-id-processed>",
  "edges": null,
  "ops": null,
  "signals": null,
  "beliefs": null,
  "generic": null
}
```

`--resume` skips completed stages and seeks past the last processed ID within an in-progress stage. Each stage processes in batches of 100 with an upsert per item; the checkpoint is fsync'd after each batch.

### CLI shape

```
fozikio migrate --from <url> --to <url> [options]

Required:
  --from <url>         Source store URL (sqlite:..., firestore:..., json:...)
  --to <url>           Destination store URL

Options:
  --namespace <ns>     Only migrate this namespace (default: all)
  --rename-namespace <src>=<dst>   Rewrite namespace during copy
  --resume             Resume from .cortex-migrate-state.json
  --verify             After migration, diff source vs destination and report
  --dry-run            Read source, validate compatibility, exit (no writes)
  --batch-size <n>     Items per checkpoint flush (default: 100)
```

### Compatibility check

`assertCompatibility(src, dst)` fetches `getCapabilities()` from both and:
- Errors if `schemaVersion` differs (caller can future-add `--force` flag).
- Errors if `embeddingDimension` differs and both are non-zero (embeddings won't be searchable).
- Errors if `dst` already contains data and `--allow-merge` is not passed (default: refuse to migrate into a populated store, to prevent accidental clobber-then-realize).

### Verification mode

After all stages complete, `--verify` does:
- For each entity kind, count rows in `src` and `dst`; assert equal.
- Sample N=20 random IDs per kind, fetch from both, assert deep-equal.
- Report any drift to stderr with exit code 2.

Verification is sampled, not exhaustive, because exhaustive comparison would O(2n) the migration time. Sampling at 20 catches gross failures; full diff is an opt-in `--verify-exhaustive` follow-up.

### Testing

New `src/bin/migrate.test.ts`:

- Round-trip golden path: seed SQLite with mixed entities → migrate to JSON → migrate JSON back to a fresh SQLite → deep-equal both SQLite stores.
- ID preservation: assert IDs match across round trip.
- Resume from checkpoint: kill mid-migration (mock), re-run with `--resume`, assert success and identical result vs uninterrupted run.
- Compatibility failure: seed two SQLite stores with different embedding dimensions, assert migration aborts before any writes to dst.
- Namespace rename: migrate `ns=alpha` source to `ns=beta` dst, assert all entities land under `beta`.

## Error handling

- Source read failure → migration aborts, checkpoint preserved.
- Destination write failure → migration aborts mid-stage, checkpoint records last-successful-ID. `--resume` continues from there.
- Schema mismatch → abort *before* any destination write.
- Pre-existing data in destination without `--allow-merge` → abort with clear message.

## Rollout

Single PR (large but coherent). Subsequent PRs can add postgres or libsql adapters by implementing `CortexStore` — they'll work with `migrate` immediately.

## Out of scope (this spec)

- Bidirectional sync.
- Schema transformation between major versions.
- Encrypted JSON exports.
- Streaming migration for stores too large to fit in memory (current architecture already assumes in-memory load for `getAllMemories()`).
