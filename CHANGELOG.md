# Changelog

## [Unreleased]

### Changed

- **Memory `name` is now a real label, not a raw text truncation.** All three creation paths (`goal_set`, high-salience `observe` promotion, and the dream `create` phase) previously derived `name` by slicing the definition — `goal_set` did a raw mid-word `slice(0, 60)` with no word boundary and no ellipsis, so names rendered as broken fragments (`…verifiable tr`), and the paths named identical-length memories inconsistently. A new `engines/naming.ts` centralises naming: `deriveName(text, llm)` mints a genuine short concept label via the LLM at creation time (the intended behaviour), falling back to `deriveNameHeuristic(text)` — first-sentence preference, word-boundary truncation, ellipsis on elision — whenever the LLM is unavailable, errors, or returns nothing usable. Adds the versioned `label-concept` prompt.

## [1.3.0] — 2026-07-06

### The epistemic-loops release

A deep review concluded that the cognitive architecture was sound but its self-correction loops were severed at the joints: signals written to a table nothing read, contradictions recorded but never verified, the dream cycle rating its own maintenance as evidence of use, and evidence discarded at merge points. This release closes those loops.

### Added

- **First-class signal reads** — `CortexStore.getSignal(id)`, `getSignals(filters)`, `updateSignal(id, updates)` implemented in SQLite, Firestore, JSON, and `ScopedStore`. Fixes a split-brain bug where `putSignal` wrote a dedicated table on SQLite/JSON that `surface`/`resolve` never read — every SURPRISE and hindsight TENSION signal was invisible on the default backend. Legacy signals written through the generic collection API remain readable and updatable. `Signal` gains `resolved_at` and `observation_id`.
- **Contradiction adjudication** (`engines/adjudicate.ts`, [docs/nli-adjudication.md](docs/nli-adjudication.md)) — `contradict` now verifies the claimed conflict before recording it: NLI cross-encoder first (both directions), LLM fallback, graceful degradation to unverified tension. Genuine contradictions apply a confidence penalty scaled by adjudicator confidence; complementary/unrelated evidence records nothing. `force: true` preserves caller authority. Low-tier adjudicators (per `model_provenance.confidence_tiers`, resolved via the new `resolveModelTier()`) cannot declare genuine contradictions below 0.8 confidence — the first real consumer of capability tiers.
- **Observe-time implicit-conflict detection** — when an NLI provider is configured, `observe()` adjudicates observations that land in the merge/link band against the nearest memory before the gate can reinforce the memory they dispute (negations embed close to their affirmations). Genuine → `action: "contradiction"` + signal + penalty; succession → `action: "superseded"` + revision guidance. Opt out per call with `check_conflict: false`.
- **Bitemporal belief entries** — `BeliefEntry.valid_from`/`valid_to` (valid time) alongside `changed_at` (system time); `believe` accepts `valid_from`. New `supersedes` adjudication verdict distinguishes temporal succession ("moved to Berlin" vs "lives in Paris") from same-time contradiction: succession recommends revision and applies no penalty, because a superseded belief was not wrong.
- **NLI service bootstrap** (`scripts/nli-service/`, shipped in the npm package) — FastAPI cross-encoder service matching the `LocalNLIProvider` wire contract. `fozikio nli` runs it from an installed package: first run provisions a virtualenv at `~/.fozikio/nli-venv` and installs requirements, later runs start immediately (`--port/--host/--model/--venv/--reinstall`). Enable in the engine via `nli.enabled` config or `CORTEX_NLI_URL`.
- **Versioned prompt registry** (`engines/prompts.ts`) — every cognitive prompt in the engine (dream phases, HyDE, adjudication, salience scoring, reflect, abstract, query-explain, agent-invoke findings, ruminate) as typed, versioned templates with a pinned snapshot test forcing deliberate version bumps. Migrating ruminate also removes a latent `String.replace` bug where `$`-patterns or a literal placeholder in the gathered context could corrupt the prompt.
- **Structural thought-quality gate** (`engines/thought-quality.ts`) — dream refine/abstract output is judged by grounding (keyword overlap with the evidence it derives from) plus form checks; the empirical "foreign thought" marker lists survive as a weak corroborating signal instead of a model-specific veto.

### Changed

- **Dream score phase no longer counts as access.** Passive FSRS review previously called `touchMemory`, refreshing `last_accessed`/`updated_at` — the next cycle then read its own touch as "recently accessed → rating Good", so cron dreams reinforced every scored memory without real use (the exact silent hardening the hindsight phase audits for). Scoring now writes FSRS state only; access strength comes from genuine retrieval.
- **FSRS contradiction penalty now sees signal-based contradictions**, not just `contradicts` edges — observation-vs-memory conflicts are signals (observations are not graph nodes) and were previously invisible to scoring.
- **`observe` merge no longer discards content** — merged observations are stored unprocessed so the next dream cycle clusters them into the same memory and feeds the refine phase, converting duplicates into consolidation evidence.
- **Pairwise edge discovery pre-filters by embedding similarity** (cosine < 0.2 skipped), cutting most of the O(n²) LLM calls without touching contradiction-range pairs.

### Fixed

- `npm test` now works on Windows (vitest invoked via its `.mjs` entry instead of the POSIX bin shim); file-backed SQLite tests close handles before temp-dir cleanup (Windows `EBUSY`).


## [1.2.1] — 2026-05-17

### Fixed

- **CLI/MCP table-name asymmetry on `collections_prefix` values ending in `_`.** v1.2.0's `src/bin/namespace-resolver.ts` stripped a trailing underscore from `collections_prefix` before passing it to `SqliteCortexStore`, while `src/mcp/server.ts` had always passed the value verbatim. Both feed into the same `${this.ns}_${name}` table-name builder at `src/stores/sqlite.ts:301`, so for any prefix ending in `_` the two paths read and wrote *different* tables. A workspace whose `agent.yaml` set `collections_prefix: anthems_` would see MCP write to `anthems__memories` while `fozikio health --agent anthems` queried the empty `anthems_memories` — silent, identical-looking "zero-stat" output to the pre-v1.2.0 broken behaviour the resolver was introduced to fix. The resolver now returns `collections_prefix` verbatim, matching the MCP server's de facto behaviour. MCP wrote first, so its table layout is ground truth; aligning CLI to MCP preserves existing data with zero migration. `namespace-resolver.test.ts` updated to assert the new verbatim semantics (was: "prefers collections_prefix (trailing underscore stripped) when set").

## [1.2.0] — 2026-05-16

### The audit-driven release

An external code-and-architecture review of cortex-engine surfaced three credible critiques: missing concurrency primitives, no path between storage backends, and 27+ MCP tools competing for an LLM's attention with no disambiguation guidance. This release addresses all three as parallel implementation tracks, plus a fourth track that landed mid-flight when a user reported that CLI subcommands were silently dropping the agent namespace.

### Added

- **`CortexStore.withTransaction(fn)`** — backend-native atomic-write primitive for composing multi-step writes. SQLite uses manual `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` with a per-store Promise-chained mutex (better-sqlite3's own `db.transaction` rejects Promise returns and does not survive `await` suspensions). Firestore wraps `runTransaction` with a `FirestoreTxnProxy` routing writes through the transaction handle. Full contract in [`docs/concurrency.md`](docs/concurrency.md).
- **`CortexStore.upsertMemory(...)` and siblings** for `Observation`, `Edge`, `OpsEntry`, `Signal`, `BeliefEntry` — ID-preserving variants of `put*` for migration and restore. Implemented in SQLite, Firestore, JSON, and `ScopedStore`.
- **`CortexStore.getCapabilities()`** — `{ schemaVersion, embeddingDimension, categories, namespace, backend }` snapshot used by `migrate` to refuse incompatible source/destination pairs before mutating data.
- **`JsonCortexStore`** — a third storage backend backed by a single JSON file with atomic temp+rename persistence. Intended for backup, restore, and migration staging — not a production server-side store.
- **`fozikio migrate --from <url> --to <url>`** — new CLI command that clones data between any pair of supported backends. Supports `--namespace`, `--rename-namespace`, `--resume`, `--verify`, `--dry-run`, `--allow-merge`, `--batch-size`. Idempotent (upsert-by-ID), checkpointed (`.cortex-migrate-state.json`), fails loudly on schema mismatch.
- **`fozikio tools`** — new CLI for browsing the cognitive tool catalogue by category. Flags: `--category <cat>`, `--search <q>`, `--json`.
- **`GET /tools` and `GET /tools/:name`** REST endpoints returning structured `ToolMetadata`. The legacy `/api/tools` shape remains for back-compat.
- **`ToolDefinition.category` (required) + `whenToUse` (required) + `doNotUse` (optional)** — typed metadata on every tool. The MCP ListTools response composes these into the description string so the LLM has explicit disambiguation guidance. Categories: `memory`, `consolidation`, `beliefs`, `ops`, `threads`, `journal`, `social`, `content`, `graph`, `vitals`, `agents`, `maintenance`, `meta`.
- **`docs/concurrency.md`** — full concurrency model, transaction contract, SQLite-vs-Firestore divergences, when to call `withTransaction`.
- **`docs/tools-reference.md`** — auto-generated tool catalogue (57 tools by category). Regenerable via `npm run docs:tools`.
- **`docs/storage-backends.md`** — selection guide for SQLite / Firestore / JSON.
- **Design specs** for the three implementation tracks live in [`docs/superpowers/specs/`](docs/superpowers/specs/) for future reviewers.

### Changed

- **SQLite `busy_timeout = 5000`** is now set immediately after `journal_mode = WAL`. Concurrent writers ride out checkpoint contention for up to 5 seconds before surfacing `SQLITE_BUSY`.
- **Multi-step write paths use `withTransaction`** in `src/engines/cognition.ts` (`clusterObservations`, `refineMemories`, `createFromUnclustered`, `abstractCrossDomain`, `hindsightReview`), `src/tools/believe.ts`, `src/tools/forget.ts`, and `src/tools/observe.ts` (the high-salience-novel memory creation path). A mid-sequence failure during dream consolidation no longer leaves orphan memories, edges, or unprocessed observations.
- **All 57 tool descriptions rewritten** to a consistent quality bar: 1–2 sentences naming the return shape, paired with `whenToUse` / `doNotUse` for disambiguation. The memory cluster (`query`/`recall`/`retrieve`/`neighbors`/`wonder`/`speculate`/`observe`) received the heaviest review.
- **`createStore(config, namespace?)`** in `src/bin/store-factory.ts` accepts an optional namespace, threading it through to SQLite and Firestore constructors. Omitting the argument preserves the legacy empty-prefix behaviour.
- **`wonder` and `speculate` salience schema** corrected from `1-10 (default: 5)` to `0.0-1.0 (default: 0.5)` to match the actual `Observation.salience` storage range.

### Fixed

- **CLI subcommands no longer drop the agent namespace.** Previously `fozikio health`, `vitals`, `anomalies`, `maintain fix`, `report`, `digest`, and `wander` silently ignored both `--namespace` and `.fozikio/agent.yaml`'s `default_namespace`, returning zero-stat results in any workspace whose agent used a non-default namespace. They now resolve via `src/bin/namespace-resolver.ts`, honouring `--namespace`, `--agent`, then config default. Resolved namespace is printed to stderr.
- **Orphan-memory window during high-salience observation promotion** — `observe.ts` now wraps `putMemory` + `markObservationProcessed` in a transaction.
- **Audit-trail gap during forget** — `forget.ts` now wraps `updateMemory` + `putBelief` in a transaction so the fade is never visible without its belief log entry.
- **Confidence/definition split in hindsight review** — `cognition.ts:hindsightReview` now lands the confidence penalty and the definition revision (and the corresponding belief entry) in a single transaction when both apply.
- **JSON store rollback wrote an unnecessary file** — `JsonCortexStore.withTransaction` no longer calls `persist()` on the rollback path; disk still holds the pre-txn snapshot since the success path is what writes.
- **Migration to Firestore destinations fails earlier with a clearer message** — `dstHasData` now short-circuits the iterator-adapter checks for backends without iteration support, logging a stderr advisory instead of raising an opaque `unsupported` error.
- **Migration table-name drift risk** — `readAllFromSqlite` / `readGenericFromSqlite` now call `internals.t(table)` instead of duplicating the prefix-concatenation logic, so any future change to `SqliteCortexStore.t()` propagates correctly.

### Removed

- **Inlined `createStore` duplicates** in `vitals-cmd.ts` and `anomalies-cmd.ts`. Both now use the shared factory in `store-factory.ts`.

### Internal

- 73 new tests across six files: `src/stores/concurrency.test.ts` (5), `src/stores/json.test.ts` (13), `src/bin/store-url.test.ts` (16), `src/bin/migrate.test.ts` (14), `src/bin/namespace-resolver.test.ts` (16), `src/mcp/tools.test.ts` (9). Total suite is now 110 tests.
- **`ScopedStore`** passes through `withTransaction`, all `upsert*` methods, and `getCapabilities` to its inner store (no behaviour change; required for the type to still implement the extended interface).
- New `npm run docs:tools` regenerates `docs/tools-reference.md` from the canonical tool list.

### Known limitations

- **Firestore migration is stubbed.** The current iteration adapters narrow on `SqliteCortexStore` / `JsonCortexStore` via `instanceof`; a Firestore source or destination throws a clear "not implemented for class X" error. Add iterator methods to `CortexStore` and the Firestore branch when Firestore↔X migration becomes a need.
- **`JsonCortexStore` is not a production backend.** It loads the entire dataset into memory and rewrites the file on every write. Use it for backup, restore, migration, and tests.

---

## [1.1.1] — 2026-05-16

### Fixed

- **HyDE query crash on empty LLM output** — `query(hyde: true)` could crash with `Cannot read properties of undefined (reading 'length')` when a reasoning-mode LLM (qwen3, phi4-reasoning, etc.) consumed the entire `maxTokens` budget on the `<think>...</think>` block, leaving an empty final response. `stripThinking()` then yielded `""`, and `OllamaEmbedProvider.embed("")` returned `undefined` (Ollama returns `embeddings: []` for empty input, and `[][0]` is `undefined`). The undefined embedding propagated as the query vector and crashed on `.length` access in spread activation.

  Three layers of fix:
  - `hydeExpand` (`src/engines/memory.ts`) — prepends `/no_think` to suppress reasoning-mode output (mirroring the pattern `generateJSON` already used), and falls back to embedding the raw query if the LLM still produces empty output.
  - `OllamaEmbedProvider.embed` (`src/providers/ollama.ts`) — throws on empty input and validates the response has a non-empty embedding (fail-fast instead of returning `undefined`).
  - `spreadActivation` (`src/engines/memory.ts`) — defensive null guard on `memory.embedding.length`, matching the optional-chaining pattern already used elsewhere in the function (`Memory.embedding` is typed `number[] | null`).

### Added

- **HyDE fallback regression test** (`src/engines/hyde-fallback.test.ts`) — covers empty LLM output, whitespace-only output, and substantive output paths.
- **Spread-activation null-embedding regression test** (`src/engines/spread-activation.test.ts`) — covers the previously-unguarded `memory.embedding.length` access.
- **`scripts/verify-hyde-fix.mjs`** — standalone Node script that exercises the HyDE → findNearest → spreadActivation chain against a live SQLite store, useful for debugging future query path crashes.

---

## [1.1.0] — 2026-03-24

### Added

- **Kimi (Moonshot AI) provider** — `llm: kimi` is now a first-class config option. Set `MOONSHOT_API_KEY` and the engine auto-configures against `api.moonshot.cn/v1`. Optionally override the model via `llm_options.kimi_model` (default: `kimi-k2-0711-preview`).
- **Long-context dream strategy** — `DreamOptions.strategy: 'long-context'` replaces the Phase 4 (Connect) N² pairwise edge discovery with a single LLM call that sees the full memory graph (up to 200 nodes + all existing edges). The model finds transitive patterns, cross-domain contradictions, and causal chains that the sequential approach structurally cannot detect. Works with any large-context model; `long_context_memory_limit` controls the cap (default: 200).
- **Variable TTL for ops entries** — `ops_append` now uses type-based expiry: `log` 90 days, `instruction`/`handoff` 14 days, `milestone` 180 days, `decision` 365 days. Previously all entries expired after 30 days.
- **Expanded ops schema** — `ops_append` accepts `session_type`, `seed_type`, `blocked`, `next`, `instruction_meta`, and `handoff_meta` fields. `ops_query` returns these fields. `ops_update` supports `next` and `blocked`.
- **Thread creation warnings** — `thread_create` now returns warnings when `next_step` or `project` is missing, guiding agents toward higher-quality thread creation.

### Security

- **Timing-safe authentication** — REST server auth comparison uses `crypto.timingSafeEqual` to prevent timing attacks.
- **Plugin path sandboxing** — Plugin loader validates import paths against trusted directories, blocking loads from untrusted locations.
- **REST tool blocklist** — Destructive tools (`forget`, `dream`, `evolve`, `resolve`, `thread_resolve`) are blocked from the generic REST `/api/tools/:name` endpoint. They remain available via MCP (direct agent access).
- **SQLite namespace validation** — Namespace names must be alphanumeric/underscore only, preventing SQL injection via namespace parameter.
- **Parameterized SQLite queries** — `LIMIT` clause in ops queries is now parameterized instead of interpolated.
- **API key config warning** — `config-loader` warns when `openai_api_key` is found in config files instead of environment variables.

---

## [1.0.0] — 2026-03-23

### Major Release — Plugin Absorption

All cognitive tools are now built directly into cortex-engine. No separate plugin installs needed.

**Previously**, extending the engine required separate npm packages:

```bash
npm install @fozikio/tools-threads
npm install @fozikio/tools-journal
# etc.
```

**Now**, all 57 tools come with the core install:

```bash
npm install @fozikio/cortex-engine
```

### Absorbed packages

The following packages are now included in cortex-engine core and are no longer required as separate installs for v1.0.0+:

| Package | Tools Added |
|---------|------------|
| `@fozikio/tools-threads` | `thread_create`, `thread_update`, `thread_resolve`, `threads_list` |
| `@fozikio/tools-journal` | `journal_write`, `journal_read` |
| `@fozikio/tools-content` | `content_create`, `content_list`, `content_update` |
| `@fozikio/tools-evolution` | `evolve`, `evolution_list` |
| `@fozikio/tools-social` | `social_read`, `social_update`, `social_draft`, `social_score` |
| `@fozikio/tools-graph` | `graph_report`, `link`, `suggest_links`, `suggest_tags` |
| `@fozikio/tools-maintenance` | `retrieve`, `forget`, `find_duplicates`, `sleep_pressure`, `consolidation_status`, `retrieval_audit` |
| `@fozikio/tools-vitals` | `vitals_get`, `vitals_set`, `sleep_pressure` |
| `@fozikio/tools-reasoning` | `surface`, `ruminate`, `notice`, `intention`, `resolve`, `query_explain`, `contradict` |

### New in v1.0.0

- **57 cognitive tools** (up from 27 in v0.x)
- All tools live in individual files under `src/tools/` — easier to read, extend, and contribute to
- Richer implementations: `observe` now auto-scores via LLM, `predict` uses temporal reranking
- New store methods: `countDocuments()` and `delete()` on both SQLite and Firestore backends
- Shared `_helpers.ts` for argument parsing and event firing across all tools

### Migration from v0.x

If you were using separate `@fozikio/tools-*` packages, simply:

1. Update cortex-engine: `npm install @fozikio/cortex-engine@latest`
2. Remove the separate plugin installs — tools are now built-in
3. Remove plugin references from your `agent.yaml` config (if any)

The plugin system still works for custom extensions you've built yourself.

### Tools toggling

All tools can be enabled/disabled via the `cognitive_tools` config key in `agent.yaml`. By default, all 57 tools are enabled.

---

## [0.10.0] — 2026-03-23

- Final v0.x release before plugin absorption
- Published to npm as baseline before v1.0.0 consolidation

## [0.9.x and earlier]

See git log for full history.
