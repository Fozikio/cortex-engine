# Changelog

## [Unreleased]

### Added

- **Provider selection from the environment, for containers that ship no config file.** `CORTEX_STORE`, `CORTEX_EMBED`, `CORTEX_LLM` and `CORTEX_SQLITE_PATH` override the config file (env wins, twelve-factor style). Before this, a hosted image with no `cortex.config.yaml` fell through to the defaults and got `llm: ollama` — the health check reported green and every LLM-backed tool failed at first use. Unknown values are ignored with a warning rather than crashing the service. The "no config file" message now prints the effective providers instead of asserting "sqlite + ollama".
- `railway.json` and `docs/deploy-railway.md`: a hosted REST deployment with one volume and an API-key LLM provider, no Ollama.

### Fixed

- `docker-compose.yml` claimed the REST port could be used as a `.mcp.json` URL. It cannot; the REST server exposes no MCP transport.

## [1.6.0] — 2026-09-13

### Added

- **Digest carries document provenance and refuses to store fiction as fact.** (#84)

  `digestDocument` parsed frontmatter for salience and dropped `type` and `tags`. So an observation extracted from a style-transfer exercise, a cross-model debate, a dream journal or a self-roast was stored with the same `declarative` content type and the same provenance shape as one from a journal. On one live store a sentence the agent wrote *imitating its owner* — "he learned more about my music in 20 minutes than most people" — was extracted as a fact about the owner, promoted to a memory, and refined by a later dream into "uniquely talented … distinct learning capability". The trace back to the file was only possible because `source_files` existed; nothing said *what kind* of file.

  Observations now carry `source_type` (frontmatter `type`, lower-cased) and `source_tags`. `classifyDocument` decides from them whether the document's claims are the author's facts: a `type` of workshop / experiment / creative / fiction / draft / exercise, or a tag among experiments, style-transfer, impersonation, cross-model, debate, dreams, humor, satire, fiction, roleplay, makes it *speculation*, and every observation the document produces that would have been `declarative` is stored `speculative` instead — so dream never refines a fact out of it. Implemented as one store wrapper around the whole pipeline (`withDocProvenance`) rather than a parameter threaded through four steps and six write sites. `treat_as: 'fact' | 'speculation'` on `DigestOptions`, the `digest` tool and `fozikio digest --treat-as` override the decision in either direction.

  The extract prompt now keeps the speaker in the item ("GPT-4o argued that…", "Written in Virgil's voice: …") instead of normalising another voice's claim into a bare statement.

  SQLite gains two nullable columns via the existing `addColumn` migration; JSON and Firestore stores carry the fields as-is. Existing observations are untouched (`source_type` null).

## [1.5.3] — 2026-09-13

### Fixed

- **The within-run abstraction dedupe shipped in 1.5.2 was set where it caught nothing.** Its default of 0.82 was a guess. Measured on the live store that motivated it (qwen3-embedding:0.6b): the paraphrase pairs from one run score 0.615–0.693 against each other; a later run's five genuinely distinct abstractions top out at 0.539. Default is now 0.60, sitting between the two measured sets, and `abstraction_dedupe_threshold` is a namespace config key passed through by the `dream` tool, because other embedding models spread scores differently and the right line is a per-deployment measurement. (#83)

## [1.5.2] — 2026-09-13

### Fixed

- **Abstract no longer stores the model's title line as a memory name.** The synthesis prompt was answered with `Pattern: *Silent Success as a Structural Failure Mode*` followed by a newline and the explanation more often than not. The name was "the first sentence", the title line has no sentence punctuation, so the stored name was the label, its asterisks, the newline and the opening of the explanation — 100 characters of scaffolding — and the definition began with the same label. `stripMarkdownFormatting` only knew `**bold**`. A new `parseAbstraction` splits a `Pattern:` / `Pattern Name:` / `Abstraction:` line (or the one-line `Pattern: X — …` form) into name and body, drops `Explanation:`-style body labels, strips single-asterisk and underscore emphasis, and names plain prose through the same 60-character heuristic every other mint path uses. A title with no body is not an abstraction and is skipped. The prompt (v2) now asks for plain prose with no title line; the parser is the defence for when it gets one anyway. (#83)
- **Abstract no longer mints the same synthesis several times in one run.** Attempts sample overlapping memories and the model restates the idea in new words; those paraphrases sat below the store-wide 0.88 novelty threshold (which also only looks at what was already stored before the run). Each attempt is now also compared against the abstractions written earlier in the same run and skipped at `abstraction_dedupe_threshold` (default 0.82). Two live runs each produced five abstractions of which at least two were pairs. (#83)
- **Abstract no longer samples faded memories.** Fading lowers salience on purpose; an abstraction that cites a faded memory re-attaches `exemplifies` edges to it and pulls it back into the graph — four such edges in one run, two of them onto the fabricated memory that started the 2026-09-13 audit. Refine and connect got the same exclusion in 1.5.1. (#83)

## [1.5.1] — 2026-09-13

### Fixed

- **Dream refine no longer rewrites memories from their neighbours.** When nothing had clustered onto a recently-touched memory, refine fell back to the `evidence` text of its `related` edges — the connect phase's description of the *other* memory — and asked the model to fold that into the definition. On a live 638-memory store one run rewrote 21 memories that way, 12 of them within an hour of a manual `believe()` (which bumps `updated_at` and so guarantees selection): numbers, quotations and first person dropped, the neighbour's named entities added, and in two cases the dream's own similarity scores ("0.69 to 0.77") written into a `value` memory as content. Refine now rewrites only memories that gained direct observations this run; the edge fallback is opt-in via `DreamOptions.refine_from_edges`, and its belief-history reason says "edge evidence strings" instead of "observations" when it is used. (#86, the mechanism behind #85)
- Refine and connect skip `faded` memories. Fading is a deliberate signal to stop elaborating a memory; the same run re-elaborated three faded ones and gave one of them 14 new edges. Hindsight already excluded them.
- `refine-definition` prompt bumped to v2: keep the existing claim, preserve numbers, dates, quotations, names and voice, do not generalise a specific fact into a category description, do not add subjects the observations do not mention, never mention similarity scores or the consolidation process.

## [1.5.0] — 2026-09-13

### Changed

- **Node 22 is now the floor: `engines.node` is `>=22`.** npm only warns on an `engines` mismatch unless `engine-strict` is set, so a Node 20 install is not refused outright — but `better-sqlite3` 13 will not build there, so it fails at install either way. `fozikio doctor` now enforces the same floor. (#76)

  Node 20 reached end-of-life on 2026-04-30 and nothing should still be shipping to it, but the reason to move now is mechanical: `better-sqlite3` 13 declares `node >=22`, and `vitest` 5 cannot run against `better-sqlite3` 11 — its changed worker lifecycle tears down the addon on a null N-API env (`Assertion failed: (env) != nullptr`, SIGABRT, Linux only). So the two Dependabot bumps that had been failing CI for a week were one decision, not two, and this release makes it deliberately rather than letting a dependency-group merge make it silently. The `Node 20 Compat` CI job is now `Node 22 Compat` — same purpose, one floor higher.

- `better-sqlite3` `^11.7.0` → `^13.0.3` (runtime). Replaces `bindings`/`prebuild-install` with `node-addon-api`; the lockfile drops ~50 transitive packages.
- `vitest` `^4.1.0` → `^5.0.0` (dev). 326/326 pass; verified on the Linux runner, not just locally, because that is where the old combination failed.

## [1.4.2] — 2026-09-10

### Changed

- The README's "Known advisories" section told readers to expect three moderate `@hono/node-server` advisories and to treat audit noise from that chain as "expected and safe to ignore". The section's own exit condition had been met — `@modelcontextprotocol/sdk` 1.30.0 accepts `@hono/node-server` 2.x — and a fresh install reports 0 vulnerabilities. Rewritten, and the SDK floor raised to `^1.30.0` so the clean audit is a property of the package rather than of install timing. (#75)

### Fixed

- **The markdown gate was anchored to the start of the text, so `abstract` leaked bold into definitions and names.** (#54)

  The check was `/^(#{1,6}\s|\*\*)/`. It caught a thought that *opens* with `**` and missed one where the bold lands anywhere later — which is the shape `abstract` reliably produces: `The unifying pattern is **"Persistence through Structure"** — a principle where...`. Five such rows were accepted in a single run. Because names are derived from definitions, the asterisks propagated into the label too, so the stored `name` was literally `The unifying pattern is **"Persistence through Structure"**`. The gate did fire elsewhere in the same run, which is exactly what made it look like a working check.

  It now matches **paired** emphasis anywhere and headings at any line start. Paired only, deliberately: a lone `*` is ordinary punctuation and a lone `#` is an issue reference, and widening a check from position 0 to anywhere is worth nothing if it starts rejecting prose.

  The start-anchoring argument that governs the meta-text openers does not transfer here, and the difference is worth naming. That rule protects a memory that legitimately *quotes* meta-text while reporting a finding — matching anywhere would stop dream ever recording its own failure modes. A quoted `**bold**` carries no such meaning: the content survives stripping intact. So `abstract` now **strips rather than rejects**, via the new `stripMarkdownFormatting`. A rejected refinement is cheap because the previous definition survives; a rejected abstraction leaves nothing in its place, and discarding a real cross-domain synthesis over its punctuation is the more expensive error. `refine` still rejects.

- **`connect` wrote `Concept A`/`Concept B` into edge evidence, and `refine` read it back as source material.** (#53)

  The connect prompt labels its inputs positionally and the model's answer was stored verbatim — 2,665 of 3,259 edges (82%) in one live store. `refine` consumes edge evidence as source material, so the model echoed the labels straight into definitions, where the placeholder gate added in 1.4.1 rejected the whole refinement. The gate held; that was never in doubt. The cost landed as a rejection rate: 6 of 8 rejections in one 30-row dream run were placeholder leaks. Every rejection is a refinement thrown away, so consolidation does progressively less useful work while reporting success.

  Both directions are now fixed by one rule. `connect` substitutes the concepts' real names before writing evidence, and `refine` applies the same substitution to evidence written before this change — so the 2,665 existing rows are repaired on read and **no backfill or migration is needed**. `getEdgesFrom` always returns the refined memory as the source, which is slot A; only a row that actually carries a placeholder pays for the slot-B lookup, and that count trends to zero as the store fills with edges written by the fixed phase. A slot with no name available is left exactly as it was — a partial map must not invent a subject, and the survivor still meets the placeholder gate downstream rather than being silently stored. A name that is *itself* contaminated counts as no name at all, which is the part that matters for the rows already damaged: contamination propagates, a leaked definition yields a leaked name, and feeding that name back as ground truth re-contaminates the repair — one live row was named `Concept A describes the agent's capacity to retain…`. Substituting it would swap one placeholder for a longer one, so it is withheld and the gate catches the row instead.

- **`connect` reported zero edges for a phase that had failed outright.**

  `_safe.ts` exists to replace "inline `.catch(() => fallback)` patterns that previously hid store failures behind zero-result returns", and `safeStoreRead` was threaded through cluster, refine, hindsight, fiedler and pe-saturation when it was written. `connect` was never converted: three bare catches returned `{ edges_discovered: 0 }`, and the per-pair and per-edge handlers dropped their errors entirely without touching the counter. A connect phase that failed completely was indistinguishable from one that honestly found nothing, and `DreamResult.failures` under-reported by exactly the amount that mattered. Both variants now route through `safeStoreRead` / `dreamFailure`. The same one-line omission in `abstract`'s outer handler is fixed alongside it.

  This is the bug class 1.4.0 was named for, still sitting in the phase that release did not reach.

- **The web dashboard stopped shipping at 1.2.2 and nothing noticed for four releases.**

  Checked against every published tarball: 1.0.0 and 1.2.1 each contain 8 files under `public/`; 1.2.2, 1.3.0, 1.4.0 and 1.4.1 contain none. The boundary is exactly the release that introduced OIDC trusted publishing.

  `public/` is a build artefact from [Fozikio/dashboard](https://github.com/Fozikio/dashboard) — gitignored here, produced by hand. While publishing ran from a laptop the directory existed on disk, so `files: ["public"]` picked it up. Once publishing moved into `publish.yml` it began running on a fresh `actions/checkout`, where `public/` has never existed. **`npm publish` does not error on a `files` entry that is absent; it silently omits it.** Four green releases, four tarballs missing a documented feature, and a README that kept promising it.

  Two changes, and deliberately not a third. `public` is dropped from `files`, because it ships nothing — it goes back in at the same time as a build step that produces it, never before. The README now describes what is actually true. **The serving path in `src/rest/server.ts` is left exactly as it is**: it is the seam a replacement plugs into, it is already correct (same-origin API, `path.relative` containment check), and deleting it would only make the next dashboard harder to attach. What a replacement needs is tracked in #59.

### Added

- **`npm run verify:package` — a publish preflight that fails when any `files` entry resolves to nothing.**

  Wired into `publish.yml` after the build (`dist` does not exist before it) and ahead of `npm publish`. This is the check that would have turned the four silent regressions above into one red build.

  It covers every entry rather than the one that already broke: `hooks`, `skills`, `reflex-rules` and `scripts/nli-service` could each vanish from a tarball the same way, and today the only way to find out would be a user reporting it against a published version. A directory that contains no files at any depth counts as missing, since it packs to the same nothing — checking only the immediate entries would wave through a tree of empty subdirectories, which is the guard's own failure mode. Glob entries are left to npm — reimplementing its matching rules would risk a check that disagrees with the packer, which is worse than no check — and any skip is printed rather than passing quietly.

### Security

- **Cleared all 5 open advisories: `fast-uri`, `hono`, `brace-expansion`, `nanoid`, `qs`.** `npm audit` reports 0.

  Dependabot's open group PR raised `fast-uri` to 3.1.5, which clears 1 of its 5 advisories — the other four need 3.1.6 (two SSRF, an IDN canonicalization bypass, and percent-encoded scheme confusion). Override floors are now set at the fixed versions rather than the versions that happened to be current, and the three advisories outside that PR's group are covered too: `brace-expansion` (via firebase-admin → gaxios → rimraf → glob → minimatch), `qs` (via @modelcontextprotocol/sdk → express), and `nanoid` (dev-only, via vitest → vite → postcss).

### Changed

- `cortex.db-shm` and `cortex.db-wal` are no longer tracked. They were committed in 7e95ee9 and stayed in the tree because `.gitignore` listed `cortex.db`, which does not match the sidecars. Contents were schema DDL only — no memories, no user rows — so this is stale build residue rather than a disclosure. The ignore rule is now `cortex.db*`.

- The README's hono `serve-static` advisory note attributed the hardened static-file implementation to "the dashboard". The reasoning is unchanged and now stronger: the published package ships no static assets at all, so the path is inert unless a user supplies their own.


## [1.4.1] — 2026-08-01

### The gate that wasn't there

1.4.0 was named for silent failures, and shipped with one of its own. It fixed the token budget that let `refine` write empty and truncated definitions — that fix holds, and no truncation appeared in any verification run since. What it did not fix was the failure underneath, which was never the budget: **nothing checked whether what consolidation wrote was about anything.**

The evidence is a store repaired from 301 damaged definitions down to zero, then handed to `dream` on a copy. It came back with two rows silently regressed — a specific, grounded definition about SQLite-backed semantic indexes rewritten into "The memory concept involves rapid embedding of observations through optimized processing", and another that stored its own prompt scaffolding as though `Concept A` and `Concept B` were the subject. Both passed every check the engine had.

### Fixed

- **The thought-quality gate accepted refinements that describe the memory instead of its subject.**

  **Grounding cannot catch this class, structurally.** This failure is a *paraphrase* of the definition it replaces, so it keeps that definition's vocabulary and scores well — the case above scored 0.32 with zero generic-marker hits. `groundingScore` measures whether a thought is derived from its evidence; it has nothing to say about whether the thought has a subject. So `assessThought` now treats self-referential meta-text openers and leaked `Concept A`/`Concept B` scaffolding as form failures, rejected unconditionally alongside truncation and markdown leakage rather than weighed against grounding.

  The opener check is **anchored to the start of the text, deliberately**. A legitimate memory may quote this phrasing mid-sentence — a finding about memory corruption necessarily cites the corrupt text — and matching anywhere would stop the engine ever recording its own failure modes, which is exactly the knowledge worth keeping. The regression corpus in `thought-quality.test.ts` holds the real 2026-07-31 texts verbatim, including the legitimate row that must keep passing.

  Left unfixed and worth naming: a rejected refinement leaves the existing row untouched, so a definition that is *already* meta-text stays that way. The gate stops new damage; it does not repair old.

## [1.4.0] — 2026-07-30

### The silent-failure release

Every fix here addresses the same shape of bug: a mechanism that reported success, or reported nothing at all, while doing nothing. An identity ledger whose entries could never leave `proposed`. LLM calls that spent their whole token budget on hidden reasoning and returned an empty string. Two separate guards against exactly that, both inert — one matching a tag format the provider no longer emits, the other a soft switch the model no longer honours, sitting under a comment asserting it worked. Consolidation monitoring that read a timestamp nothing ever wrote, so a store with 3,131 processed observations was indistinguishable from one that had never consolidated at all.

None of these announced themselves, and each was found by checking a mechanism against reality rather than reading its description. That is the same principle the new service supervision applies at runtime: a service is up when its endpoint answers, not when its process exists.

### Added

- **Service supervision** (`src/services/`) — `fozikio` now manages the two daemons the default install depends on: ollama and the bundled NLI cross-encoder. `up`, `down`, `status`, and `service <start|stop|restart|status|logs>` spawn them detached, capture output to `~/.fozikio/logs/`, track PIDs in `~/.fozikio/run/`, and wait on an HTTP probe before reporting ready. `up --watch` supervises continuously: exponential backoff, a circuit breaker after five failed restarts, and a notification hook (`FOZIKIO_NOTIFY_URL` / `FOZIKIO_NOTIFY_CMD`) so repeated restarts escalate rather than being hidden. **A service is up when its endpoint answers, not when its process exists** — a live process that has stopped responding reports `degraded`. That is the failure this exists to catch: ollama dies silently, every semantic tool then fails while ops, threads and journal keep working, and the outage reads as "cortex is fine" until a query comes back empty. Services started outside fozikio are reported as such and are never killed.
- **`fozikio doctor`** — checks runtime, config, store, NLI wiring and both services, and prints a concrete remedy for each failure rather than only naming it. Exits 1 on any error, so it works as a cron gate. Catches the silent case where `nli.enabled` is set but no URL is reachable, which degrades adjudication to the LLM invisibly.
- **`fozikio update`** — compares the installed version against the registry. Reports only; it never installs.
- **Interactive shell** — a bare `fozikio` on a TTY opens a session: a prompt with tab completion over the command tree, history, and a filterable palette on an empty enter. Commands run in-process and errors are contained, so a bad command reports and returns to the prompt instead of ending the session. `serve` and `nli` are refused inside it with a pointer to the supervised equivalent, because both block forever. Falls back to help when piped.
- **`fozikio dashboard`** — the live service and memory view, with keys to start, stop, restart and tail logs. Reachable from the shell or directly.
- **Noun-verb command tree** — `fozikio memory <health|vitals|report|anomalies|wander|maintain|digest>` and `fozikio service <verb>`. The previous flat spellings (`fozikio health`, …) remain permanent hidden aliases: not deprecated, no warning, because cron jobs and published docs invoke them directly.
- **`evolution_resolve` — identity evolutions can finally leave `proposed`.** `evolve` wrote `status: 'proposed'` and nothing in the engine could ever write another value, yet `evolution_list` accepted `applied`, `rejected`, and `reverted` as filters and returned an `applied_at` field. Three of four documented statuses were unreachable through the tool surface, so the ledger only ever grew: adopting a change in practice left the record permanently claiming it was still pending. (Resolved records *can* exist — a live store was found holding 39 `applied` — but every one carried an `applied_at` identical to the millisecond, the signature of a one-off bulk backfill written outside the tools, not something an agent could do during a session.) The new tool transitions a proposal with an optional note, stamps `applied_at` on apply, records `previous_status`, and refuses to revert an evolution that was never applied — a revert with no corresponding apply reads as history that never happened. `applied_at` survives a later revert as the record of when the change had been in force. `evolution_list` now also returns `resolved_at` and `note`, so a resolution is visible rather than merely stored. Brings the tool count to 60.

### Changed

- **CLI internals rebuilt on a shared framework** (`src/cli/`) — one `util.parseArgs`-based parser replaces the ten hand-rolled `parseArgs()` implementations the commands each carried, so unknown flags now fail loudly instead of being silently ignored. Colour, symbols, tables, box-drawing, spinners, prompts and menus are shared, TTY-aware, and honour `NO_COLOR` / `FORCE_COLOR` / `--no-color`. Help is generated from the same tree the router walks, so the two can no longer drift. No new runtime dependencies; `engines` stays at `>=20`.
- **Colour is emitted directly rather than through `util.styleText`** — styleText runs its own TTY check against `process.stdout` and silently returns text unstyled when that check fails, overriding an explicit `--color` or `FORCE_COLOR` whenever output was piped. Detection now lives in one place. This also sidesteps `styleText` not existing before Node 20.12, which is below the declared engine floor.
- **NLI provisioning helpers moved** to `src/services/nli-env.ts` so the registry, doctor and supervisor can use them without importing a command module. `bin/nli-cmd.ts` re-exports them; `fozikio nli` is unchanged.
- **Memory `name` is now a real label, not a raw text truncation.** All three creation paths (`goal_set`, high-salience `observe` promotion, and the dream `create` phase) previously derived `name` by slicing the definition — `goal_set` did a raw mid-word `slice(0, 60)` with no word boundary and no ellipsis, so names rendered as broken fragments (`…verifiable tr`), and the paths named identical-length memories inconsistently. A new `engines/naming.ts` centralises naming: `deriveName(text, llm)` mints a genuine short concept label via the LLM at creation time (the intended behaviour), falling back to `deriveNameHeuristic(text)` — first-sentence preference, word-boundary truncation, ellipsis on elision — whenever the LLM is unavailable, errors, or returns nothing usable. Adds the versioned `label-concept` prompt.

### Fixed

- **CI ran `tsc` only, on ubuntu only.** The vitest suite was configured but never executed by the merge gate, and nothing ever ran on Windows — where detached spawning, `taskkill` and PID handling all differ. Adds a `Test` job across `ubuntu-latest` and `windows-latest`. The existing `Type Check` job keeps its exact name so required-status-check rules continue to match.
- **Every Ollama LLM call was returning empty or truncated output on the default model.** `qwen3:14b` is a reasoning model, and its reasoning tokens are drawn from the same `num_predict` budget as the answer. Measured directly: at `num_predict: 300`, thinking consumed all 300 tokens, `response` came back **empty** with `done_reason: length`, in 17.3s. The identical call with `think: false` answered completely in 50 tokens and 3.1s. Every engine call site is bounded — `naming.ts` caps at 32 tokens, `social-draft` at 100, `reflect` at 300 — so all were silently degraded. `deriveName()` in particular could never have succeeded on Ollama; it fell through to its heuristic fallback on every call while appearing to work. Both `generate` and `generateJSON` now send the native `think: false`.
- **The two existing defences were both inert.** `stripThinking()` matches inline `<think>...</think>` blocks, but current Ollama returns reasoning in a separate `thinking` field that never matches — it stripped nothing while the answer was already gone. `generateJSON` prefixed prompts with `/no_think`, the legacy qwen3 soft switch, measured identical to sending nothing (300 tokens into `thinking`, empty `response`) — so JSON calls were parsing an empty string while the comment above them claimed they were protected. That prefix also leaked a literal `/no_think` line into the prompt for every model that does not implement it. `stripThinking()` is retained for models that genuinely inline their reasoning, with its actual scope documented.
- **`dream` never recorded that it ran, so consolidation monitoring could never fire.** `sleep_pressure` and `consolidation_status` both answer "when did consolidation last happen" by reading a `dream_state` doc and falling back to a `consolidation_history` collection — and **nothing in the engine wrote either one**. Both tools therefore returned `last_dream_at_iso: null` and `hours_since_dream: null` permanently, no matter how many times `dream` had actually run, which inverts the meaning of the signal: a store that had consolidated thousands of observations was indistinguishable from one that had never consolidated at all. `consolidation_status` also derives its `last_dream` summary and `quality_trend` from the same collection, so both were always empty. Verified against a live store: 3,131 of 3,137 observations processed, and the `system` and `consolidation_history` collections holding zero rows. `dream` now appends a history entry with the per-phase counts, totals, duration, integration rate and failure count, written after the cycle so a failed run leaves no false entry. `consolidation_quality` is deliberately left absent rather than filled with a stand-in, since `dreamConsolidate` does not compute one and both readers already treat it as nullable.

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
