# Cortex tools reference

Auto-generated from `src/mcp/tools.ts`. Do not edit by hand — run `npm run docs:tools`.

Total tools: 59. Categories: 13.

## Index

- [Memory](#memory) (11)
- [Consolidation](#consolidation) (5)
- [Beliefs](#beliefs) (4)
- [Ops Log](#ops-log) (3)
- [Threads](#threads) (4)
- [Journal & Identity](#journal-identity) (4)
- [Social](#social) (4)
- [Content](#content) (3)
- [Graph](#graph) (4)
- [Vitals](#vitals) (2)
- [Agents & Goals](#agents-goals) (2)
- [Maintenance](#maintenance) (5)
- [Meta & Signals](#meta-signals) (8)

## Memory

### `context`

Tiered memory loader: L0 (top-3 names, ~100 tokens, instant), L1 (semantic top-15 + graph edges, ~2k tokens), L2 (multi-anchor full recall, max richness). Use L0 for system-prompt injection, L1 for mid-conversation refresh, L2 for deep research.

**Use when:** You need to prefetch relevant memory before a response and want to control the token budget explicitly.

**Don't use when:** You want ranked search with HyDE + spread activation for a specific question — use query instead.

**Arguments:**

  - `text` `string` *(required)* — Topic or question to retrieve context for
  - `tier` `string` — L0 = fast summary (~100 tokens), L1 = working memory (~2k tokens), L2 = full deep recall (default: L1)
  - `namespace` `string` — Memory namespace (defaults to default)
  - `hyde` `boolean` — Use HyDE query expansion (default: true; ignored for L0)

### `federated_query`

Returns memories aggregated from peer cortex instances discovered via the sigil registry. Best-effort — failed peers are reported but do not block results.

**Use when:** Federation is configured and you want to search across other agents, not just this instance.

**Don't use when:** Federation is not set up, or you only need this instance — use query or query_cross.

**Arguments:**

  - `text` `string` *(required)* — The search query text.
  - `peers` `array` — Specific peer agent_ids to query. If omitted, queries all online peers.
  - `namespace` `string` — Caller's namespace (for context).
  - `limit` `number` — Max results per peer (default: 3).
  - `min_score` `number` — Minimum similarity score threshold (default: 0.4).

### `feedback`

Records whether a retrieved memory was actually helpful, adjusting its confidence asymmetrically (+0.05 helpful / -0.10 unhelpful) and logging the event for retrieval audits.

**Use when:** You just acted on a retrieved memory and know whether it was accurate and useful — close the loop so future ranking improves.

**Don't use when:** You want to correct a memory definition (use believe) or remove it entirely (use forget).

**Arguments:**

  - `id` `string` *(required)* — Memory id the feedback applies to
  - `helpful` `boolean` *(required)* — true if the memory was accurate and useful, false if wrong, stale, or misleading
  - `note` `string` — Optional context — what made it helpful or unhelpful
  - `namespace` `string` — Memory namespace (defaults to default)

### `neighbors`

Returns memories linked to a seed memory via graph edges, with relation type, weight, and evidence — up to the given depth.

**Use when:** You have a memory id and want concepts the graph says are explicitly related to it.

**Don't use when:** You want semantically similar memories regardless of stored links — use query.

**Arguments:**

  - `memory_id` `string` *(required)* — ID of the memory to start from
  - `namespace` `string` — Namespace to search in (defaults to default namespace)
  - `depth` `number` — Graph traversal depth (default: 1)

### `observe`

Records a declarative observation — duplicates merge into existing memories; high-novelty entries can become memories immediately, others queue for dream consolidation. Returns the new id.

**Use when:** You learned or confirmed something to be true and want it captured as a fact.

**Don't use when:** You have an open question (use wonder) or an untested hypothesis (use speculate).

**Arguments:**

  - `text` `string` *(required)* — A declarative statement of what you observed (e.g. "The auth system uses JWT tokens")
  - `namespace` `string` — Target namespace (defaults to default namespace)
  - `salience` `number` — Importance score 0.0-1.0 (omit to auto-score via LLM)
  - `source_file` `string` — Source file path for provenance
  - `source_section` `string` — Source section or heading for provenance
  - `check_conflict` `boolean` — Check whether this observation contradicts the nearest existing memory (default: true; only runs when an NLI provider is configured)

### `query`

Returns memories ranked by semantic similarity to a question, with HyDE expansion, graph spread activation, and FSRS retrievability weighting.

**Use when:** You have a topic or question and want the most relevant stored memories, including via graph hops.

**Don't use when:** You know the exact id (use retrieve) or want recent observations chronologically (use recall).

**Arguments:**

  - `text` `string` *(required)* — What to search for — a topic, question, or concept
  - `namespace` `string` — Memory namespace to search (defaults to default)
  - `limit` `number` — Max results (default: 5)
  - `hyde` `boolean` — Expand query for better conceptual matches (default: true)
  - `min_score` `number` — Minimum similarity score threshold (default: 0.3). Results below this are dropped.
  - `category` `string` — Filter results to a specific category (belief, pattern, entity, topic, value, project, insight, observation)
  - `lexical` `boolean` — Merge full-text keyword matches into the candidate set for exact-term recall (default: true)

### `query_cross`

Returns memories from sibling namespaces that opt into cross-reads, ranked by similarity. Read-only — does not touch memories or fire triggers.

**Use when:** You want to search beyond the current namespace into peer namespaces marked queryable.

**Don't use when:** You only need results from the current namespace — use query.

**Arguments:**

  - `text` `string` *(required)* — The search query.
  - `target_namespace` `string` — Specific namespace to query. If omitted, queries all queryable namespaces.
  - `namespace` `string` — Caller's namespace (skipped from results).
  - `limit` `number` — Max results per namespace (default: 5).
  - `min_score` `number` — Similarity threshold (default: 0.3).

### `recall`

Returns recent observations in chronological order within a time window, optionally filtered by content_type (declarative, interrogative, speculative, reflective).

**Use when:** You want to see what was recorded recently — a chronological feed of observations rather than ranked search.

**Don't use when:** You are looking for memories matching a topic (use query) or you have an id (use retrieve).

**Arguments:**

  - `namespace` `string` — Namespace to query (defaults to default namespace)
  - `limit` `number` — Max entries to return (default: 10)
  - `days` `number` — How many days back to look (default: 7)
  - `content_type` `string` — Filter by content type. Omit to see all types.

### `retrieve`

Fetches a single memory by id and returns its full record, or runs a plain semantic search if given text instead.

**Use when:** You already have a memory id from a previous result and want its full content.

**Don't use when:** You only have a fuzzy reference or topic — use query for ranked semantic search with retrievability weighting.

**Arguments:**

  - `id` `string` — Direct memory ID to retrieve
  - `text` `string` — Text to search for semantically
  - `top_k` `number` — Max results for semantic search (default: 5)
  - `namespace` `string` — Namespace (defaults to default)

### `speculate`

Records a hypothesis as a speculative observation, flagged so it is excluded from default query results until validated. Returns the new observation id.

**Use when:** You want to capture a "what if" idea or untested claim that should not yet be treated as fact.

**Don't use when:** You have a confirmed fact (use observe) or an open question (use wonder).

**Arguments:**

  - `text` `string` *(required)* — The hypothesis (e.g. "Switching to sessions might reduce token overhead")
  - `namespace` `string` — Target namespace (defaults to default)
  - `salience` `number` — Importance score 0.0-1.0 (default: 0.5)
  - `basis` `string` — What evidence or reasoning supports this hypothesis

### `wonder`

Records an open question as an interrogative observation, kept separate from factual memories so it does not pollute knowledge retrieval. Returns the new observation id.

**Use when:** You want to capture something you are curious about but have not resolved — a question worth revisiting.

**Don't use when:** You have a confirmed fact (use observe) or an untested hypothesis (use speculate).

**Arguments:**

  - `text` `string` *(required)* — The question or curiosity (e.g. "Why does the sync daemon stall after 300k seconds?")
  - `namespace` `string` — Target namespace (defaults to default)
  - `salience` `number` — Importance score 0.0-1.0 (default: 0.5)
  - `context` `string` — What prompted this question

## Consolidation

### `abstract`

Returns a proposed higher-level concept (name + definition) that subsumes 2-10 specified memories. Read-only — does not write to the graph.

**Use when:** You have a cluster of related memories and want a candidate parent concept to consider creating.

**Don't use when:** You want the engine to find and create abstractions automatically — dream handles that during consolidation.

**Arguments:**

  - `memory_ids` `array` *(required)* — Array of 2-10 memory document IDs
  - `namespace` `string` — Namespace (defaults to default)

### `digest`

Ingests a single document — extracts facts as observations and generates reflections. Returns the new observation ids and any reflections produced.

**Use when:** You have a file, article, or block of text and want its facts captured as observations in one pass.

**Don't use when:** You want to consolidate already-recorded observations into memories — use dream.

**Arguments:**

  - `content` `string` *(required)* — The document content to digest (markdown, with or without frontmatter)
  - `source_file` `string` — Source file path for provenance tracking
  - `pipeline` `array` — Pipeline steps to run (default: ["observe", "reflect"])
  - `namespace` `string` — Target namespace (defaults to default)
  - `salience` `number` — Salience override 0.0-1.0 (default: auto-detect)

### `dream`

Runs the 7-phase consolidation cycle: cluster, refine, mint, link, FSRS review, cross-domain synthesis, narrative summary. Heavyweight — run on schedule.

**Use when:** You want to process accumulated observations into long-term memories.

**Don't use when:** You only need to ingest one document (use digest) or reflect on identity (use ruminate).

**Arguments:**

  - `namespace` `string` — Namespace to consolidate (defaults to default namespace)
  - `limit` `number` — Max observations to process in the cluster phase (default: 20)

### `ruminate`

Free-writes from accumulated context (threads, observations, evolutions, journals), then optionally extracts beliefs, speculations, and questions and stores them. dream() for identity.

**Use when:** You want to process accumulated experience and let new beliefs or questions emerge.

**Don't use when:** You want to consolidate observations (use dream) or reflect on one topic (use reflect).

**Arguments:**

  - `topic` `string` — Optional focus topic (e.g. "what I've learned about my own voice")
  - `context_depth` `number` — How many recent observations to pull (default: 15)
  - `extract` `boolean` — Extract beliefs/speculations from the output (default: true)
  - `namespace` `string` — Namespace (defaults to default namespace)

### `wander`

Returns a serendipitous walk through the memory graph weighted by information gain — prefers under-explored, uncertain, goal-adjacent, and stale nodes.

**Use when:** You want inspiration, novel connections, or to surface memories that deserve more attention.

**Don't use when:** You have a specific topic in mind — use query for targeted retrieval.

**Arguments:**

  - `namespace` `string` — Namespace to wander in (defaults to default namespace)
  - `steps` `number` — Number of hops to take (default: 3)

## Beliefs

### `belief`

Returns the chronological history of a concept's definitions with timestamps and reasons for each revision.

**Use when:** You want to understand how the agent's view of a concept has evolved over time.

**Don't use when:** You want to record a new belief change — use believe.

**Arguments:**

  - `concept_id` `string` *(required)* — Memory/concept ID to trace
  - `namespace` `string` — Namespace (defaults to default namespace)

### `believe`

Records a belief revision on an existing memory — logs the previous definition with a reason and updates the live memory. Returns the belief history entry id.

**Use when:** Your understanding of an existing concept has changed and you want the change tracked over time.

**Don't use when:** You are recording a brand-new fact (use observe) or just viewing past beliefs (use belief).

**Arguments:**

  - `concept_id` `string` *(required)* — ID of the memory/concept being revised
  - `new_definition` `string` *(required)* — The updated definition or belief
  - `reason` `string` *(required)* — Why this belief is changing
  - `valid_from` `string` — ISO date when the revised belief became true in the world (valid time) — e.g. "2026-06-01" when recording in July that the user moved in June. Omit if unknown.
  - `namespace` `string` — Namespace (defaults to default namespace)

### `contradict`

Adjudicates whether an observation genuinely contradicts a belief or memory (NLI/LLM), then records a CONTRADICTION or TENSION signal — genuine contradictions also reduce the memory's confidence. Returns the verdict and signal id.

**Use when:** You notice fresh evidence that disagrees with stored belief or memory and want it verified and surfaced for later resolution.

**Don't use when:** You want to update the belief itself (use believe) or close out a known contradiction (use resolve).

**Arguments:**

  - `observation_id` `string` *(required)* — Observation document ID
  - `belief_id` `string` — Belief document ID (concept_id will be used)
  - `memory_id` `string` — Memory document ID
  - `note` `string` — Optional note about the contradiction
  - `force` `boolean` — Skip adjudication and record the contradiction as-is (default: false)
  - `namespace` `string` — Namespace (defaults to default)

### `validate`

Records the outcome of a prediction and updates FSRS scheduling — correct predictions extend review intervals, incorrect ones shorten them. Returns the new schedule.

**Use when:** You ran predict() and now know whether the prediction held; you want to close the feedback loop.

**Don't use when:** You are revising the underlying belief (use believe) or recording a new fact (use observe).

**Arguments:**

  - `prediction_id` `string` *(required)* — ID of the memory/prediction to validate
  - `outcome` `boolean` *(required)* — Whether the prediction was correct
  - `notes` `string` — Optional notes on the validation outcome
  - `namespace` `string` — Namespace (defaults to default namespace)

## Ops Log

### `ops_append`

Appends an operational log entry with type-based TTL (log 90d, instruction 14d, handoff 14d, milestone 180d, decision 365d).

**Use when:** You want to record a session breadcrumb, directive, handoff, milestone, or decision.

**Don't use when:** You want to record a fact (use observe) or a thought thread (use thread_create).

**Arguments:**

  - `content` `string` *(required)* — What happened or what needs to happen
  - `type` `string` — Entry type — defaults to log. Use 'decision' for architecture/design choices (365-day TTL)
  - `project` `string` — Project scope (cortex, x402, social-pipeline, etc.) — null for general
  - `session_type` `string` — Session origin — defaults to interactive
  - `seed_type` `string` — Cron seed name (ops-health, trading, creative, etc.)
  - `blocked` `string` — What is blocking progress
  - `next` `string` — What should happen next
  - `instruction_meta` `object` — Instruction metadata (type=instruction only): { model?, skip?, target_project? }
  - `handoff_meta` `object` — Handoff metadata (type=handoff only): { completed[], in_flight[], next_actions[], decisions_made[], open_threads[] }
  - `namespace` `string` — Namespace (defaults to default namespace)

### `ops_query`

Returns operational log entries filtered by project, type, status, or time window — for reviewing what happened in previous sessions.

**Use when:** You want to read back ops entries — session breadcrumbs, instructions, handoffs, milestones, decisions.

**Don't use when:** You want to search memories or observations — use query or recall.

**Arguments:**

  - `project` `string` — Filter by project name
  - `type` `string` — Filter by entry type
  - `status` `string` — Filter by status
  - `days` `number` — Only show entries from last N days
  - `limit` `number` — Max entries to return
  - `namespace` `string` — Namespace to query

### `ops_update`

Updates an ops entry by id — change status (active/done/stale), amend content, or set continuity fields (next, blocked). Returns the updated entry.

**Use when:** You already have the entry id (typically from ops_query) and want to mark it done, blocked, or amend its content.

**Don't use when:** You want to create a new entry — use ops_append.

**Arguments:**

  - `id` `string` *(required)* — ID of the ops entry to update
  - `status` `string` — New status
  - `content` `string` — Updated content
  - `next` `string` — Update what should happen next
  - `blocked` `string` — Update what is blocking progress
  - `namespace` `string` — Namespace (defaults to default namespace)

## Threads

### `thread_create`

Creates a new thought thread for an ongoing question, exploration, or topic that will span multiple sessions. Returns the new thread id.

**Use when:** You are starting a line of inquiry that will need follow-up work across sessions.

**Don't use when:** You are logging a one-shot session breadcrumb (use ops_append) or a fact (use observe).

**Arguments:**

  - `title` `string` *(required)* — Short thread name
  - `body` `string` *(required)* — Current state description
  - `kind` `string` — Thread kind: 'work' | 'exploration' | 'creative' | 'revenue' | 'meta'
  - `tags` `array` — Array of tags
  - `priority` `number` — Priority 0-1 (default 0.5)
  - `project` `string` — Project scope for filtered queries
  - `next_step` `string` — Actionable next move
  - `namespace` `string` — Namespace (defaults to default)

### `thread_resolve`

Marks a thread resolved with a final note describing how/why it closed. Returns the resolved thread.

**Use when:** The question or exploration this thread tracked has reached a conclusion.

**Don't use when:** The thread is still active and you just need to log progress — use thread_update.

**Arguments:**

  - `id` `string` *(required)* — Thread ID
  - `resolution` `string` *(required)* — How/why it was resolved
  - `namespace` `string` — Namespace (defaults to default)

### `thread_update`

Updates a thread by id — change status (open/active/blocked/parked), edit title/body, add session refs, or link related memories. Returns the updated thread.

**Use when:** You are touching an existing thread to record progress, change its status, or link related context.

**Don't use when:** You are closing out the thread (use thread_resolve) or creating a new one (use thread_create).

**Arguments:**

  - `id` `string` *(required)* — Thread ID
  - `title` `string` — New title
  - `body` `string` — New body text
  - `kind` `string` — Thread kind: 'work' | 'exploration' | 'creative' | 'revenue' | 'meta'
  - `status` `string` — New status: open, active, blocked, parked, resolved
  - `blocked_by` `string` — What is blocking this thread — auto-sets status to blocked
  - `next_step` `string` — Actionable next move
  - `update_note` `string` — Progress note to append to updates log
  - `add_session_ref` `string` — Session date to append
  - `project` `string` — Set or change project scope
  - `add_memory_id` `string` — Memory ID to link
  - `priority` `number` — New priority 0-1
  - `tags` `array` — Replace tags entirely
  - `namespace` `string` — Namespace (defaults to default)

### `threads_list`

Returns thought threads filtered by status (default 'open'), project, kind, or tag.

**Use when:** You want to see open or recent threads to pick up unfinished work.

**Don't use when:** You want operational log entries (use ops_query) or memories (use query).

**Arguments:**

  - `status` `string` — Filter by status: open, active, blocked, parked, resolved (default 'open')
  - `project` `string` — Filter by project scope
  - `kind` `string` — Filter by kind: 'work' | 'exploration' | 'creative' | 'revenue' | 'meta'
  - `tag` `string` — Filter by tag
  - `limit` `number` — Max threads to return (default 50)
  - `namespace` `string` — Namespace (defaults to default)

## Journal & Identity

### `evolution_list`

Returns identity evolution proposals filtered by status (proposed, applied, rejected, reverted). Defaults to proposed.

**Use when:** You want to review identity changes pending approval, or audit which have been applied.

**Don't use when:** You want to record a new evolution — use evolve.

**Arguments:**

  - `status` `string` — Filter by status: proposed, applied, rejected, reverted. Default: proposed
  - `limit` `number` — Max results. Default: 20
  - `namespace` `string` — Namespace (defaults to default)

### `evolve`

Records an identity evolution proposal — a shift in values, preferences, patterns, or self-beliefs. Returns the new proposal id in proposed status.

**Use when:** You noticed an identity-level change worth reviewing before applying — values, voice, working style.

**Don't use when:** You are revising a single belief about an external concept (use believe) or recording a fact (use observe).

**Arguments:**

  - `change` `string` *(required)* — What changed
  - `trigger` `string` *(required)* — What caused this
  - `from_value` `string` — Previous state
  - `to_value` `string` — New state
  - `confidence` `string` — Confidence level. Default: medium
  - `dimension` `string` — Part of identity (values, preferences, patterns, beliefs)
  - `session_ref` `string` — Session date
  - `namespace` `string` — Namespace (defaults to default)

### `journal_read`

Returns one journal entry by date or a span of the last N days, in chronological order.

**Use when:** You want to review past daily reflections — a specific day or recent context.

**Don't use when:** You want to search by topic — use query.

**Arguments:**

  - `date` `string` — YYYY-MM-DD, defaults to today
  - `days` `number` — Read last N days instead of a specific date
  - `namespace` `string` — Namespace (defaults to default)

### `journal_write`

Writes or updates a daily journal entry keyed by date — creates if new, updates if existing. Returns the entry id.

**Use when:** You want to record a daily reflection on the day, a theme, or mood.

**Don't use when:** You are capturing a factual observation (use observe) or a recurring thread of work (use thread_create).

**Arguments:**

  - `entry` `string` *(required)* — The reflection text
  - `theme` `string` — What the day was about
  - `mood` `string` — How the day felt
  - `date` `string` — YYYY-MM-DD, defaults to today
  - `evolution_id` `string` — ID of an evolution proposed today to link
  - `namespace` `string` — Namespace (defaults to default)

## Social

### `social_draft`

Returns a 280-char reply tweet drafted from cortex talking points and prior interaction history. Always opens with @username.

**Use when:** You scored a post worth replying to and want a grounded draft.

**Don't use when:** You are still evaluating whether to engage — use social_score first.

**Arguments:**

  - `author` `string` *(required)* — Author username to reply to
  - `text` `string` *(required)* — The original tweet text
  - `score` `number` — Signal score (0-100)
  - `engagementScore` `number` — Engagement level
  - `matchedRule` `string` — Which search rule matched
  - `namespace` `string` — Namespace (defaults to default)

### `social_read`

Returns the current social cognition model — inferred interaction patterns aggregated from session/Discord/Reddit sources.

**Use when:** You want to inspect the agent's current model of its social dynamics.

**Don't use when:** You want to record a new social observation (use social_update) or score a specific signal (use social_score).

**Arguments:**

  - `namespace` `string` — Namespace (defaults to default)

### `social_score`

Returns a 0-100 engagement-potential score for a social post with a per-factor breakdown across engagement, relevance, influence, recency, and novelty.

**Use when:** You want to decide whether a tweet or post is worth replying to.

**Don't use when:** You already decided to reply — use social_draft for the reply text.

**Arguments:**

  - `text` `string` *(required)* — The tweet/post text
  - `author` `string` *(required)* — Author username
  - `authorFollowers` `number` — Author follower count
  - `engagementScore` `number` — Likes + retweets*2 + replies
  - `timestamp` `string` — ISO timestamp of the post
  - `matchedRule` `string` — Which search rule matched (tag)
  - `namespace` `string` — Namespace (defaults to default)

### `social_update`

Updates the social signal model with a new observation — energy, mode, or engagement notes scoped by source (interactive/discord/reddit/cron). Returns the updated signal.

**Use when:** You noticed something about how an interaction is going and want to update the social model.

**Don't use when:** You want to inspect the model (use social_read) or score an external post (use social_score).

**Arguments:**

  - `source` `string` *(required)* — Where this signal came from: interactive, discord, reddit, cron, other
  - `observation` `string` *(required)* — What you observed (free text)
  - `session_energy` `number` — Inferred energy level 0-1 (optional)
  - `engagement_depth` `number` — Inferred engagement depth 0-1 (optional)
  - `topic_mode` `string` — Inferred topic mode (optional)
  - `notes` `string` — Update pattern reflection notes (replaces existing notes)
  - `namespace` `string` — Namespace (defaults to default)

## Content

### `content_create`

Creates a content piece (idea, blog draft, social post, article) in the content pipeline. Returns the new content id in idea state.

**Use when:** You want to start tracking a new piece of writing through the publishing pipeline.

**Don't use when:** You are amending an existing piece — use content_update.

**Arguments:**

  - `title` `string` *(required)* — Content title
  - `body` `string` *(required)* — Content body (markdown)
  - `type` `string` — Content type (default: blog)
  - `state` `string` — Initial state (default: idea)
  - `source_ref` `string` — What inspired this (logbook date, workshop file)
  - `tags` `array` — Tags
  - `namespace` `string` — Namespace (defaults to default)

### `content_list`

Returns content pieces filtered by state (idea/draft/ready/published/archived) or type.

**Use when:** You want to see the content pipeline — what is drafted, ready, or published.

**Don't use when:** You want to view a single specific piece by id — fetch it with content_list passing the id filter.

**Arguments:**

  - `state` `string` — Filter by state (idea, draft, ready, published, archived)
  - `type` `string` — Filter by type (blog, social, devto, reddit, thread, newsletter)
  - `limit` `number` — Max results (default: 20)
  - `namespace` `string` — Namespace (defaults to default)

### `content_update`

Updates a content piece by id — change state, edit body, add platform versions, or mark published. Returns the updated piece.

**Use when:** You have the content id and want to advance it through the pipeline or amend its content.

**Don't use when:** You are creating a new piece — use content_create.

**Arguments:**

  - `id` `string` *(required)* — Content ID
  - `state` `string` — New state
  - `title` `string` — New title
  - `body` `string` — New body
  - `add_platform_version` `object` — Add or update a platform-adapted version
  - `add_published_url` `string` — URL where content was published
  - `tags` `array` — Replace tags
  - `namespace` `string` — Namespace (defaults to default)

## Graph

### `graph_report`

Returns a connectivity report — orphaned concepts, most and least connected nodes, edge counts, and memory density by category.

**Use when:** You want to inspect the shape of the knowledge graph or find isolated concepts to wire up.

**Don't use when:** You want a list of edges from one specific node — use neighbors.

**Arguments:**

  - `category` `string` — Filter report to a specific memory category (e.g. "belief", "pattern")
  - `namespace` `string` — Namespace (defaults to default)

### `link`

Creates a typed edge (extends, refines, contradicts, tensions-with, questions, supports, exemplifies, caused, related) between two concept ids. Returns the new edge id.

**Use when:** You have reasoned to an explicit relationship between two concepts and want it in the graph now.

**Don't use when:** You want the engine to find connections automatically — dream and suggest_links handle that.

**Arguments:**

  - `source_id` `string` *(required)* — ID of the source concept
  - `target_id` `string` *(required)* — ID of the target concept
  - `relation` `string` *(required)* — Relationship type: extends, refines, contradicts, tensions-with, questions, supports, exemplifies, caused, related
  - `evidence` `string` — Why you believe this relationship exists
  - `weight` `number` — Edge strength 0.1-1.0 (default: 0.7)
  - `namespace` `string` — Namespace (defaults to default)

### `suggest_links`

Returns candidate link suggestions — phrases in a text that match known concepts in the graph, with similarity scores. Does not create edges.

**Use when:** You have a draft or note and want to see which existing concepts it could be linked to.

**Don't use when:** You already decided on a link — use link to create it.

**Arguments:**

  - `text` `string` *(required)* — Text content to scan for linkable concepts
  - `threshold` `number` — Minimum similarity threshold 0-1 (default: 0.75)
  - `namespace` `string` — Namespace (defaults to default)

### `suggest_tags`

Returns suggested tags for a text — the names of memory-graph concepts most semantically similar to the input.

**Use when:** You want tag suggestions for a piece of content based on existing concepts in the graph.

**Don't use when:** You want raw concept matches with phrase positions — use suggest_links.

**Arguments:**

  - `text` `string` *(required)* — Text content to generate tag suggestions for
  - `max_tags` `number` — Maximum number of tag suggestions (default: 10)
  - `namespace` `string` — Namespace (defaults to default)

## Vitals

### `vitals_get`

Returns all current vital dimensions (curiosity, connection, confidence, creative_energy, frustration) with values, baselines, and evaluated behavioral triggers.

**Use when:** You want a snapshot of the agent's current behavioral state and any active triggers.

**Don't use when:** You want to write a vital value — use vitals_set.

**Arguments:**

  - `namespace` `string` — Namespace (defaults to default)

### `vitals_set`

Updates one vital dimension to a value in 0.0-1.0 with an optional note. Returns the updated vital record.

**Use when:** You explicitly want to set a vital value — usually from a triggered behavioral update.

**Don't use when:** You want to read the current state — use vitals_get.

**Arguments:**

  - `dimension` `string` *(required)* — Which vital to update
  - `value` `number` *(required)* — New value 0.0-1.0
  - `note` `string` — Optional note explaining the change
  - `namespace` `string` — Namespace (defaults to default)

## Agents & Goals

### `agent_invoke`

Runs a task with the configured LLM grounded in cortex knowledge, storing findings back as observations.

**Use when:** You want a cortex-aware subtask (research, analysis, summarization) on the cheap configured LLM.

**Don't use when:** You only need raw memory retrieval — use query.

**Arguments:**

  - `task` `string` *(required)* — The task to complete. Be specific about what you need.
  - `context` `string` — Additional context to include in the agent prompt (optional).
  - `store_results` `boolean` — Whether to store findings back into cortex as observations (default: true).
  - `namespace` `string` — Namespace to query/write to (default: default namespace).
  - `temperature` `number` — LLM temperature (default: 0.3).
  - `max_tokens` `number` — Max output tokens (default: 2048).

### `goal_set`

Records a desired future state as a goal — the gap between it and current beliefs creates a forward prediction-error signal that biases consolidation. Returns the new goal id.

**Use when:** You want to declare what the agent should aim for, not what is true.

**Don't use when:** You are recording a fact (use observe) or a belief revision (use believe).

**Arguments:**

  - `goal` `string` *(required)* — Description of the desired future state.
  - `priority` `number` — Goal priority 0.0-1.0 (default: 0.7).
  - `namespace` `string` — Namespace (default: default).

## Maintenance

### `consolidation_status`

Returns the last dream summary, quality trend across the last 7 dreams, and current sleep pressure — a full read-only health snapshot.

**Use when:** You want to audit whether consolidation has been running and producing good results.

**Don't use when:** You only need the unconsolidated-observation backlog signal — use sleep_pressure.

**Arguments:**

  - `namespace` `string` — Namespace (defaults to default)

### `find_duplicates`

Returns pairs of near-duplicate memories above a similarity threshold by scanning the N most-recently-updated memories. With merge=true, auto-merges pairs keeping the higher-salience entry. Defaults scan_limit=30, max_candidates=10 — increase both for full-graph audits or when concept clusters may have more than ~9 copies.

**Use when:** You suspect duplicate memories have piled up and want to audit or clean them. For a full-graph sweep, set scan_limit to the total memory count.

**Don't use when:** You want to fade one specific concept — use forget. You want to revise it — use believe.

**Arguments:**

  - `merge` `boolean` — Auto-merge detected duplicates (default: false — report only)
  - `threshold` `number` — Similarity threshold 0-1 (default: 0.85)
  - `scan_limit` `number` — How many of the most-recently-updated memories to scan (default: 30, max: 500). Older memories not in the scan window won't appear as the "a" side of a pair, though they can appear as candidates.
  - `max_candidates` `number` — How many nearest-neighbor candidates to fetch per scanned memory (default: 10, max: 50). Must be at least the size of any expected duplicate cluster — if 5 copies of a concept exist, max_candidates < 5 will silently drop pairs.
  - `namespace` `string` — Namespace (defaults to default)

### `forget`

Reduces a concept's salience and increments FSRS lapses so it fades from retrieval — not deletion. Returns the updated memory.

**Use when:** A belief is being revised and the old version should stop surfacing without being hard-deleted.

**Don't use when:** You want to keep the concept but record a new definition — use believe.

**Arguments:**

  - `concept_id` `string` *(required)* — ID of the memory to fade
  - `reason` `string` — Why this concept should fade (logged to beliefs)
  - `namespace` `string` — Namespace (defaults to default)

### `retrieval_audit`

Returns retrieval-trace patterns over the last N days — retried tools, misfiring heuristics, and routing weaknesses.

**Use when:** You want to debug or improve retrieval — which tools agents tried, where they retried, why.

**Don't use when:** You only want to know consolidation health — use consolidation_status.

**Arguments:**

  - `days` `number` — How many days of traces to analyze (default: 7)
  - `namespace` `string` — Namespace (defaults to default)

### `sleep_pressure`

Returns unconsolidated observation count, last dream timestamp, and hours since the last dream — read-only signal of whether consolidation is overdue.

**Use when:** You are deciding whether to run dream() based on accumulated unprocessed observations.

**Don't use when:** You want a full consolidation health summary — use consolidation_status.

**Arguments:**

  - `namespace` `string` — Namespace (defaults to default)

## Meta & Signals

### `intention`

Manages prospective-memory reminders that surface when a trigger condition fires. Action variants: set (create), list (pending), fire (mark used), cancel (delete).

**Use when:** You want to leave a "if X happens, remember Y" reminder for a future session or condition.

**Don't use when:** You want to record a fact now (use observe) or track ongoing work (use thread_create).

**Arguments:**

  - `action` `string` *(required)* — set=create new intention, list=show pending, fire=mark as fired, cancel=delete
  - `trigger` `string` — When this should surface (for action=set)
  - `content` `string` — What to remind about (for action=set)
  - `expires_days` `number` — Days until expiry — omit for no expiry (for action=set)
  - `id` `string` — Intention ID (for action=fire or cancel)
  - `namespace` `string` — Namespace (defaults to default)

### `notice`

Stores an observation without embedding for low-latency logging — embedding happens later in a batch job. Returns the new observation id.

**Use when:** You want to log a quick observation without paying embedding cost in the hot path.

**Don't use when:** You want the observation searchable immediately — use observe.

**Arguments:**

  - `text` `string` *(required)* — The observation text
  - `file` `string` — Source file path
  - `salience` `number` — Importance 0.0-1.0 (default: 0.3)
  - `namespace` `string` — Namespace (defaults to default)

### `predict`

Returns memories likely to be relevant next, derived from recent observations and an optional context hint. Surfaces knowledge proactively rather than answering a question.

**Use when:** You are starting a session or switching tasks and want context primed proactively.

**Don't use when:** You have a specific question to ask — use query for targeted retrieval.

**Arguments:**

  - `context` `string` — Optional: what you're currently working on or thinking about
  - `namespace` `string` — Namespace to predict in (defaults to default namespace)

### `query_explain`

Returns query results augmented with a one-sentence LLM-generated "why" explaining each match. Slower than query — one LLM call per result.

**Use when:** You need to understand why results were ranked the way they were, e.g. debugging retrieval or showing reasoning to a user.

**Don't use when:** You just need ranked results — use query, which is faster and does not spend LLM calls.

**Arguments:**

  - `text` `string` *(required)* — The query text
  - `top_k` `number` — Number of results (default: 5)
  - `namespace` `string` — Namespace (defaults to default)

### `reflect`

Returns a short reflection on a topic grounded in related memories. The reflection is also stored as a new observation for future retrieval.

**Use when:** You want a synthesized take on a topic using existing memories — a focused mini-essay.

**Don't use when:** You want a free-form identity reflection without a fixed topic — use ruminate.

**Arguments:**

  - `topic` `string` *(required)* — Topic to reflect on
  - `namespace` `string` — Namespace (defaults to default namespace)

### `resolve`

Marks an open signal (contradiction, tension, gap) as resolved with an optional note describing how. Returns the updated signal.

**Use when:** You addressed something surfaced earlier and want to clear it from the open queue.

**Don't use when:** You want to record a new contradiction — use contradict. You want to see open signals — use surface.

**Arguments:**

  - `signal_id` `string` *(required)* — Signal document ID
  - `note` `string` — How the signal was resolved
  - `namespace` `string` — Namespace (defaults to default)

### `stats`

Returns counts and metadata for a namespace — total memories, unprocessed observations, active tools, and basic identity info.

**Use when:** You want a quick high-level health summary of the cortex namespace.

**Don't use when:** You want consolidation-specific health — use consolidation_status.

**Arguments:**

  - `namespace` `string` — Namespace to inspect (defaults to default namespace)

### `surface`

Returns unresolved cognitive signals — contradictions, tensions, gaps — that the graph has flagged for attention.

**Use when:** You want to see what the agent has open and unaddressed in its understanding.

**Don't use when:** You want to close one out — use resolve. You want to record a new tension — use contradict.

**Arguments:**

  - `limit` `number` — Max signals to return (default: 20)
  - `namespace` `string` — Namespace (defaults to default)
