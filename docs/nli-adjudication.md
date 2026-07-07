# Contradiction adjudication

How cortex-engine decides whether a claimed contradiction is real, and what
happens when it is. Covers the `contradict` tool, observe-time implicit-conflict
detection, verdict semantics (including temporal succession), model-tier caps,
and the local NLI service.

## Why adjudicate at all

A contradiction claim is an epistemic action with consequences: it erodes
confidence in a memory, penalizes its FSRS rating, and queues work for the
agent. Recording such claims on the caller's say-so lets a single confused
tool call (or a weak back-end model) corrode good beliefs. So every claim is
adjudicated before it becomes a signal — and the *authority* of the verdict
scales with the capability of whatever issued it.

The failure mode this defends against is well documented: agents are bad at
noticing when new evidence invalidates stored memory, especially **implicit
conflict** — invalidation without explicit negation ("moved to Berlin last
month" vs "lives in Paris"). See STALE (arXiv:2605.06527).

## The adjudication ladder

`adjudicateContradiction()` in `src/engines/adjudicate.ts`:

1. **NLI cross-encoder** (if configured) — a small local model trained on
   exactly this decision (contradiction / entailment / neutral). Both
   directions are classified (cross-encoders are asymmetric); the direction
   with the stronger contradiction score wins. Milliseconds, no API cost.
2. **Supersession check** — NLI has no time axis, so it labels temporal
   succession as contradiction. When NLI says *genuine* and an LLM is
   available, one LLM call gets the chance to reclassify the conflict as
   `supersedes`. This is the only case where the expensive check runs.
3. **LLM fallback** (if no NLI, or NLI errored) — structured-JSON adjudication
   via the versioned `adjudicate-contradiction` prompt.
4. **Degradation** — if nothing can decide, the claim is recorded as an
   *unverified tension* (method `none`), never trusted and never dropped.

### Verdicts

| Verdict | Meaning | Effect |
|---|---|---|
| `genuine` | Cannot both be true of the same time | CONTRADICTION signal (priority 0.8) + confidence penalty up to 0.15 × adjudicator confidence |
| `supersedes` | The world changed; belief was true, is now stale | TENSION signal (priority 0.4) recommending `believe()` with `valid_from`; **no penalty** — a superseded belief was not wrong |
| `tension` | Partial/scope conflict, or unverifiable | TENSION signal (priority 0.5) |
| `complementary` | Evidence supports the belief | Nothing recorded; use `believe`/`link` |
| `unrelated` | No logical relationship | Nothing recorded |

`contradict(..., force: true)` skips adjudication and records the
contradiction on the caller's authority (midpoint penalty applied).

### Model-tier caps

`config.model_provenance.confidence_tiers` assigns models to high/medium/low
tiers; `resolveModelTier()` maps the configured LLM onto them. A **low-tier
adjudicator may not declare a genuine contradiction below 0.8 confidence** —
the verdict is downgraded to `tension` (`tier_capped: true`). This is what
lets you run a cheap local model for back-end cognition without giving it the
authority to erode beliefs a frontier model created.

## Observe-time implicit-conflict detection

When an NLI provider is configured, `observe()` checks each observation that
lands near an existing memory (merge/link band, similarity ≥ link threshold)
against that memory before storing it. This band is exactly where conflicts
hide: negations embed close to their affirmations, so without the check,
"user no longer lives in Paris" would *reinforce* the Paris memory as a
duplicate.

- `genuine` → observation stored, CONTRADICTION signal, confidence penalty —
  returned as `action: "contradiction"`.
- `supersedes` → observation stored, TENSION signal recommending
  `believe(valid_from)` — returned as `action: "superseded"`.
- anything else → normal merge/link/queue flow.

Opt out per call with `check_conflict: false`. Without NLI configured the
check never runs — the write path stays cheap by construction.

## Bitemporal beliefs

`BeliefEntry` distinguishes **system time** (`changed_at` — when the engine
recorded the revision) from **valid time** (`valid_from`/`valid_to` — when the
belief was true in the world). `believe()` accepts `valid_from` so an agent
recording in July that the user moved in June can say so. By convention, an
entry's effective `valid_to` is the next entry's `valid_from` when its own
`valid_to` is null.

This is what makes `supersedes` a first-class outcome instead of a false
contradiction: succession updates the timeline, contradiction disputes a
moment on it. (Design lineage: bitemporal contradiction resolution for agent
memory, arXiv:2606.06240.)

## Running the NLI service

The service ships with the npm package:

```bash
fozikio nli
```

First run provisions a virtualenv at `~/.fozikio/nli-venv` and installs the
requirements; later runs start immediately. Then set `nli.enabled: true` in
config, or `CORTEX_NLI_URL=http://127.0.0.1:11435`. Everything degrades
gracefully when the service is down.

Manual setup and flags: [scripts/nli-service/README.md](../scripts/nli-service/README.md).
