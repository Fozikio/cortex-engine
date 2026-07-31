---
name: cortex-memory
version: 1.1.0
description: Persistent cognitive memory for AI agents — query, record, review, and consolidate knowledge across sessions with spreading activation, FSRS scheduling, and NLI contradiction detection.
author: idapixl
tags: [memory, cognition, mcp, agents, knowledge-graph, spaced-repetition, code-review, fsrs]
---

# Cortex Memory

Persistent memory engine for AI agents. Knowledge survives across sessions — recall what you learned last week, track evolving beliefs, detect contradictions, and build a knowledge graph over time.

**Source:** [github.com/Fozikio/cortex-engine](https://github.com/Fozikio/cortex-engine) (MIT) | [npm](https://www.npmjs.com/package/@fozikio/cortex-engine)

## Prerequisites

This skill requires [cortex-engine](https://github.com/Fozikio/cortex-engine) running as an MCP server. Install it separately before using this skill:

```bash
npm install -g @fozikio/cortex-engine
```

> **Install the scoped package, unpinned.** The unscoped `cortex-engine` on npm is the old name and is deprecated — but old versions of it still resolve, so pinning one installs an ancient engine that works just well enough to hide the problem. Always use `@fozikio/cortex-engine`, and let it take the latest.

Then initialize and start:

```bash
fozikio init my-agent    # scaffold a workspace
fozikio up               # start ollama + nli, wait until they answer
fozikio serve            # start the MCP server (stdio)
```

If anything goes wrong, `fozikio doctor` diagnoses the install and tells you how to fix it.

Runs locally with SQLite + Ollama. No cloud accounts needed. The skill instructions below are read-only — they teach your agent how to use cortex tools, they don't execute anything.

## Managing the services

`cortex-engine` 1.4.0+ ships a service supervisor, so you do not have to babysit Ollama:

| Command | What it does |
|---|---|
| `fozikio up` | start every service and wait until it actually answers |
| `fozikio status` | service health (HTTP probe, not PID liveness); exits 1 if unhealthy |
| `fozikio doctor` | diagnose the install and say how to fix what is broken |
| `fozikio dashboard` | live service and memory view |
| `fozikio down` | stop services it started |

`status` and `up` use an HTTP probe rather than checking whether a process exists, because a wedged process still holds the port. They also **adopt rather than kill**: if fozikio did not start a process, it will not stop it — which matters when the Ollama desktop app or another agent already owns `:11434`.

## Core Loop

**Read before you write.** Always check what you already know before adding more.

### Search

```
query("authentication architecture decisions")
```

Be specific. `query("JWT token expiry policy")` beats `query("auth")`. Results include relevance scores and connected concepts.

Explore around a result:
```
neighbors(memory_id)
```

### Record

**Facts** — things you confirmed:
```
observe("The API rate limits at 1000 req/min per API key, not per user")
```

**Questions** — unresolved:
```
wonder("Why does the sync daemon stall after 300k seconds?")
```

**Hypotheses** — unconfirmed ideas:
```
speculate("Connection pooling might fix the timeout issues")
```

### Update beliefs

```
believe(concept_id, "Revised understanding based on new evidence", "reason")
```

### Track work across sessions

```
ops_append("Finished auth refactor, tests passing", project="api-v2")
ops_query(project="api-v2")  # pick up where you left off
```

## Memory-Grounded Reviews

Review code or designs by comparing against accumulated knowledge:

1. **Ground:** `query("the domain being reviewed")` — load past decisions and patterns
2. **Compare:** Does the work align with or diverge from established patterns?
3. **Record:** `observe()` new patterns, `wonder()` about unclear choices, `believe()` updated understanding
4. **Output:**

```markdown
## Review — Grounded in Memory

### Aligned with known patterns
- [matches cortex context]

### Divergences
- [what differs, intentional or accidental]

### New patterns to capture
- [novel approaches worth observing]
```

## Session Pattern

1. **Start:** `query()` the topic you're working on
2. **During:** `observe()` facts, `wonder()` questions as they come up
3. **End:** `ops_append()` what you did and what's unfinished
4. **Periodically:** `dream()` to consolidate memories (compress, abstract, prune)

## Available Tools

**60 tools** across 13 categories. Run `fozikio tools` for the full list with descriptions.

| Category | Count | Tools |
|---|---|---|
| **memory** | 11 | context, federated_query, feedback, neighbors, observe, query, query_cross, recall, retrieve, speculate, wonder |
| **consolidation** | 5 | abstract, digest, dream, ruminate, wander |
| **beliefs** | 4 | belief, believe, contradict, validate |
| **ops** | 3 | ops_append, ops_query, ops_update |
| **threads** | 4 | thread_create, thread_resolve, thread_update, threads_list |
| **journal** | 5 | evolution_list, evolution_resolve, evolve, journal_read, journal_write |
| **social** | 4 | social_draft, social_read, social_score, social_update |
| **content** | 3 | content_create, content_list, content_update |
| **graph** | 4 | link, resolve, suggest_links, suggest_tags |
| **vitals** | 2 | vitals_get, vitals_set |
| **agents** | 2 | agent_invoke, intention |
| **maintenance** | 5 | find_duplicates, forget, goal_set, notice, surface |
| **meta** | 8 | consolidation_status, graph_report, predict, query_explain, retrieval_audit, sleep_pressure, stats, suggest |

### Beyond the basics

- **threads** — multi-session explorations. A thread is something you want to keep thinking about, distinct from an ops log entry recording what happened.
- **journal / evolution** — identity change over time. `evolve()` proposes a shift; `evolution_resolve()` applies, rejects, or reverts it, so the ledger reflects what was actually adopted rather than only what was suggested.
- **beliefs** — `contradict()` adjudicates whether an observation genuinely conflicts with an existing memory (via NLI, falling back to the LLM) and records a CONTRADICTION or TENSION signal rather than silently overwriting.
- **meta** — `sleep_pressure()` and `consolidation_status()` tell you whether `dream()` is overdue; `retrieval_audit()` and `query_explain()` show why a query returned what it did.
