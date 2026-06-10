# Systems Audit & Hermes Agent Research — June 2026

Audit of cortex-engine's storage and retrieval systems, cross-referenced
against [Hermes Agent](https://github.com/nousresearch/hermes-agent)
(Nous Research, MIT) — a comparable self-improving agent whose memory
subsystem solved several problems we had open.

## Audit findings (fixed)

| # | Finding | Severity | Fix |
|---|---------|----------|-----|
| 1 | `last_retrieval_score`, `last_hop_count`, `memory_origin` were silently dropped by the SQLite and Firestore backends. The dream pipeline's FSRS rating (`engines/cognition.ts`, score phase) reads these fields to boost/penalize review ratings — that feedback loop **never fired** on either production backend. | High | Persisted as real columns/fields in both backends, with `ALTER TABLE` migration shims for existing SQLite DBs. |
| 2 | Zero secondary indexes in the SQLite schema. Edge traversal (`getEdgesFrom`, `getEdgesForMemories`), unprocessed-observation fetches, recency queries, and belief history were all full table scans. | Medium | Six indexes added: `edges(source_id)`, `edges(target_id)`, `observations(processed, created_at)`, `memories(updated_at)`, `ops(created_at)`, `beliefs(concept_id)`. |
| 3 | Retrieval was embedding-only. Exact identifiers, proper nouns, and rare terms that embed poorly were unfindable even when stored verbatim. | Medium | FTS5 + hybrid recall (see below). |
| 4 | No mechanism for an agent to report that a retrieved memory was wrong. Bad memories stayed highly ranked until a dream-cycle hindsight review happened to catch them. | Medium | `feedback` tool (see below). |
| 5 | Observations recorded via `observe`/`wonder`/`speculate` sat unprocessed until someone ran `dream` manually or via cron. Sessions that ended before a dream cycle left knowledge stranded. | Medium | Auto-consolidation (see below). |

## Patterns borrowed from Hermes Agent

### 1. Holographic memory — FTS5 + asymmetric trust scoring

Hermes' Holographic provider pairs SQLite FTS5 full-text search with trust
scoring (+0.05 helpful / −0.10 unhelpful).

- **`searchText()`** on `CortexStore`: FTS5/BM25 on SQLite (external-content
  table, trigger-synced, `recursive_triggers=ON` so upserts stay in sync);
  weighted token-overlap fallback on JSON/Firestore.
- **Hybrid recall in `query`**: lexical hits are merged into the vector
  candidate set and re-scored by cosine, so ranking semantics stay uniform.
  Disable with `lexical: false`.
- **`feedback` tool**: asymmetric confidence adjustment. The asymmetry is
  the point — one bad retrieval costs twice what one good retrieval earns,
  so polluted memories decay out of top ranks quickly. Events log to
  `feedback_log` for correlation with `retrieval_audit` traces.

### 2. Automatic memory extraction (session sync)

Hermes syncs turns to memory after each response and extracts on session
end. `SessionConsolidator` (`engines/auto-consolidate.ts`):

- `observe`/`wonder`/`speculate` notify it after every write.
- At 10 pending observations per namespace, `dreamPhaseA` (NREM only:
  cluster → refine → create) runs in the background — non-blocking,
  best-effort, re-triggers if more arrive mid-run.
- `SIGTERM`/`SIGINT`/`beforeExit` flush all pending namespaces.
- REM phases (edges, abstraction, FSRS scoring, hindsight) intentionally
  stay in the scheduled `dream` cycle — they are LLM-heavy.

### 3. Tiered context loading (L0 → L1 → L2)

Hermes' OpenViking provider loads context progressively (~100 tokens →
~2k → full). The `context` tool mirrors this:

- **L0** (~100 tokens): top-3 by salience × FSRS retrievability, names +
  80-char snippets. One vector search, no LLM call. For per-turn
  system-prompt injection.
- **L1** (~2k tokens): semantic top-15 with definitions, tags, one-hop
  edges. Mid-conversation working-memory refresh.
- **L2** (full): multi-anchor retrieval (Borda count over 4 query
  reformulations) + 2-hop spreading activation + full metadata
  (provenance, FSRS state, activation paths). Deep research.

## Follow-up work (done)

- **Embedding storage format** (June 2026): SQLite now stores embeddings as
  raw `Float32Array` blobs (~4× smaller, parse-free reads). Legacy JSON-text
  rows are converted in place when the store is opened — idempotent, only
  text-typed rows are touched. Embeddings are float32-truncated on write, so
  cross-backend comparisons (e.g. `verifyMigration` for json→sqlite) compare
  at float32 precision via `Math.fround`.

## Known gaps (deliberately not addressed)

- **Brute-force ANN**: `findNearest` on SQLite scans every row. Documented
  as fine below 10k memories; beyond that, consider `sqlite-vec` or an HNSW
  sidecar.
- **Generic-collection queries**: `query()` on SQLite loads the entire
  collection and filters in JS. Acceptable for current collection sizes
  (threads, journal, vitals); revisit if any collection grows unbounded —
  `feedback_log` is the most likely candidate.
- **Firestore `searchText`** falls back to a full-collection scan. Swap in
  an external search index if cloud deployments grow.
