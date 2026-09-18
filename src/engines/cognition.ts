/**
 * Cognition engine — 8-phase dream consolidation cycle.
 *
 * Implements the full dream cycle as pure functions: storage-agnostic,
 * provider-injected. Each phase is isolated so a single phase failure
 * does not abort the whole cycle.
 *
 * Phases:
 *   Phase A (NREM analog — compression and binding):
 *     1. Cluster   — route unprocessed observations to nearest memories
 *     2. Refine    — update memory definitions from new observations
 *     3. Create    — promote unclustered observations to new memories
 *
 *   Phase B (REM analog — cross-association and integration):
 *     4. Connect   — discover edges between recently active memories
 *     5. Score     — FSRS passive review for memories in review/learning
 *     6. Abstract  — cross-domain pattern synthesis
 *     7. Hindsight — audit entrenched memories for silent confidence hardening
 *     8. Report    — narrative summary of the full cycle
 *
 * Exported entry points:
 *   dreamPhaseA()      — run NREM phases only (cluster -> refine -> create)
 *   dreamPhaseB()      — run REM phases only  (connect -> score -> abstract -> hindsight -> report)
 *   dreamConsolidate() — run all 8 phases (backward-compatible)
 */

import type { CortexStore } from '../core/store.js';
import type { EmbedProvider } from '../core/embed.js';
import type { LLMProvider } from '../core/llm.js';
import type { Memory, MemoryCategory, Observation, EdgeRelation, BeliefEntry, Edge } from '../core/types.js';
import { extractKeywords } from './keywords.js';
import { deriveName, deriveNameHeuristic, NAME_MAX_LEN } from './naming.js';
import { scheduleNext, newFSRSState, elapsedDaysSince } from './fsrs.js';
import { computeFiedlerValue, detectPESaturation } from './graph-metrics.js';
import type { PESaturationResult } from './graph-metrics.js';
import { safeStoreRead, type PhaseStats } from './_safe.js';
import { cosineSimilarity } from './memory.js';
import {
  assessThought,
  hasConceptPlaceholder,
  stripMarkdownFormatting,
  substituteConceptPlaceholders,
} from './thought-quality.js';
import { checkRewrite } from './rewrite-guard.js';
import {
  REFINE_DEFINITION,
  EDGE_REVALIDATE,
  CLASSIFY_CATEGORY,
  EDGE_DISCOVER_PAIR,
  EDGE_DISCOVER_GRAPH,
  ABSTRACT_SYNTHESIS,
  HINDSIGHT_REVIEW,
  DREAM_REPORT,
  MEMORY_CATEGORIES,
} from './prompts.js';
import { normalizeSalience } from './salience.js';

// Module-level counter shared across dream phases. dreamConsolidate /
// dreamPhaseA / dreamPhaseB reset it at the top of the cycle and read it
// at the bottom to surface DreamResult.failures. Not thread-safe across
// concurrent dream() calls — cortex-engine treats consolidation as serial.
const _dreamStats: PhaseStats = { failures: 0 };

/**
 * A `source` memory is a verbatim mirror of something outside the store (#114:
 * a repo's files, exports and doc sections). It sits in the graph like any
 * other memory — edge discovery, retrieval and spread activation all see it —
 * but no phase that *changes* a memory or *derives* one from it may pick it:
 * cluster does not merge an observation into it, refine and hindsight do not
 * rewrite it, score does not reschedule it, abstract does not sample it. The
 * source is right by construction and re-mirrored when the source changes;
 * a rewrite could only make it wrong. Same shape as the `faded` filters, for
 * a different reason.
 */
const isSource = (m: Pick<Memory, 'memory_origin'>): boolean => m.memory_origin === 'source';
function resetDreamStats(): void { _dreamStats.failures = 0; }
function dreamFailure(label: string, err: unknown): void {
  console.error(`[dream:${label}]`, err);
  _dreamStats.failures++;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DreamResult {
  phases: {
    cluster: { clustered: number; unclustered: number };
    refine: { refined: number };
    create: { created: number };
    connect: { edges_discovered: number };
    score: { scored: number };
    report: { text: string };
    abstract: { abstractions: number };
    hindsight?: { reviewed: number; revised: number; declined?: number };
  };
  total_processed: number;
  duration_ms: number;
  /** clustered / (clustered + unclustered) */
  integration_rate: number;
  /**
   * Algebraic connectivity of the memory graph (Fiedler value).
   * Higher = more integrated knowledge. 0 = disconnected or too few nodes.
   * Computed during dreamConsolidate() and dreamPhaseB().
   * Undefined when running dreamPhaseA() alone or when skip_fiedler is set.
   */
  fiedler_value?: number;
  /**
   * Prediction-error saturation analysis for identity observations.
   * Undefined when store does not support the required queries or skip_pe_saturation is set.
   */
  pe_saturation?: PESaturationResult;
  /** Count of catch sites that swallowed an error during this cycle. */
  failures: number;
}

export interface DreamOptions {
  /** Max observations to process in cluster phase (default: 50) */
  observation_limit?: number;
  /** Max unclustered to create as memories (default: 10) */
  create_limit?: number;
  /** Max abstraction attempts in REM phase (default: 5) */
  abstraction_attempts?: number;
  /** Similarity threshold for clustering (default: 0.70) */
  cluster_threshold?: number;
  /** Similarity threshold for detecting duplicate abstractions (default: 0.88) */
  abstraction_novelty_threshold?: number;
  /**
   * Similarity threshold between abstractions minted in the *same* run
   * (default: 0.60). Attempts sample overlapping memories, so one run can
   * produce the same synthesis several times in different words. An attempt
   * whose embedding is at least this similar to an abstraction already
   * written this run is skipped. (#83)
   *
   * The default is measured, not guessed: on a live store with
   * qwen3-embedding:0.6b, the paraphrase pairs one run produced scored
   * 0.615–0.693 against each other, while a run of five genuinely distinct
   * abstractions topped out at 0.539 — the 0.82 first shipped in 1.5.2 would
   * have skipped none of the duplicates. Other embedding models spread
   * scores differently; set `abstraction_dedupe_threshold` in the namespace
   * config after measuring a run's pairwise similarities.
   */
  abstraction_dedupe_threshold?: number;
  /** Namespace config merge threshold */
  similarity_merge?: number;
  /** Namespace config link threshold */
  similarity_link?: number;
  /**
   * If true, skip Fiedler value computation during dreamConsolidate/dreamPhaseB.
   * Useful for large graphs where the O(n*iter) pass is too slow.
   */
  skip_fiedler?: boolean;
  /**
   * If true, skip PE saturation detection.
   */
  skip_pe_saturation?: boolean;
  /**
   * Dream strategy:
   * - 'sequential' (default): many small LLM calls, each with a local view.
   * - 'long-context': one large LLM call per phase with the full memory graph visible.
   *   Requires a model with a large context window (e.g. kimi, gemini).
   *   Produces better edge discovery and abstractions on larger memory graphs.
   */
  strategy?: 'sequential' | 'long-context';
  /**
   * Max memories to include in a single long-context pass (default: 200).
   * Reduce if hitting token limits with a smaller model.
   */
  long_context_memory_limit?: number;
  /**
   * If true, skip the hindsight review phase.
   */
  skip_hindsight?: boolean;
  /**
   * If true, refine may fall back to the evidence text of a memory's `related`
   * edges when no observation clustered onto it this run. Off by default: edge
   * evidence is the connect phase's description of the *neighbouring* memory,
   * and handing it to the refine prompt as "new observations" folds the
   * neighbour's content into this memory's definition. On a live store that
   * rewrote 21 memories in one run — 12 of them within an hour of a manual
   * correction — with numbers, quotations and first person dropped and the
   * neighbour's named entities added. A memory nothing new was learned about
   * should be left alone. (#86)
   */
  refine_from_edges?: boolean;
  /**
   * Max number of entrenched memories to audit in the hindsight phase (default: 5).
   * Each memory requires one LLM call, so keep this low for cost/latency.
   */
  hindsight_max_review?: number;
  /**
   * Minimum FSRS stability (days) for a memory to be a hindsight candidate (default: 21).
   * Memories below this threshold are not yet entrenched enough to warrant review.
   */
  hindsight_stability_threshold?: number;
  /**
   * Minimum number of FSRS reps for a hindsight candidate (default: 4).
   * Ensures the memory has been reinforced multiple times before being questioned.
   */
  hindsight_min_reps?: number;
}

// ─── Phase result types ───────────────────────────────────────────────────────
// Exported so callers of dreamPhaseA / dreamPhaseB can type their return values.

export interface ClusterPhaseResult {
  clustered: number;
  unclustered: number;
  /** Observations that had no near-enough memory to cluster into. */
  unclusteredObs: Observation[];
  /** Content from clustered observations, keyed by memory ID. Used by Phase 2. */
  clusteredEvidence: Map<string, string[]>;
}

export interface RefinePhaseResult {
  refined: number;
}

export interface CreatePhaseResult {
  created: number;
}

export interface ConnectPhaseResult {
  edges_discovered: number;
}

export interface ScorePhaseResult {
  scored: number;
}

export interface AbstractPhaseResult {
  abstractions: number;
}

export interface ReportPhaseResult {
  text: string;
}

export interface HindsightPhaseResult {
  /** Number of entrenched memories audited. */
  reviewed: number;
  /** Number of memories where confidence was reduced or definition was revised. */
  revised: number;
  /**
   * Number of proposed rewrites the guard refused because they dropped a
   * number or quotation, shifted first person to third, restated the name
   * as an opener, or added entities or hedges the cited evidence does not
   * contain. The old definition is kept and no belief row is written. (#98)
   */
  declined: number;
}

// ─── Phase 1: Cluster ─────────────────────────────────────────────────────────

/**
 * How many neighbours cluster asks for per observation. One was enough when
 * every memory was a candidate; source memories are not (#114), and a store
 * that mirrors a repo can hold several of them nearer an observation than
 * the organic memory it belongs with.
 */
const CLUSTER_NEIGHBOURS = 5;

/**
 * Route unprocessed observations to the nearest existing memory that is not
 * a source mirror. Observations above cluster_threshold are linked and marked
 * processed. The rest are returned as unclustered for later phases.
 */
async function clusterObservations(
  store: CortexStore,
  _embed: EmbedProvider,
  options: DreamOptions,
): Promise<ClusterPhaseResult> {
  const limit = options.observation_limit ?? 50;
  const threshold = options.cluster_threshold ?? 0.70;

  let clustered = 0;
  const unclusteredObs: Observation[] = [];
  const clusteredEvidence = new Map<string, string[]>();

  const observations = await safeStoreRead(
    store.getUnprocessedObservations(limit),
    [] as Observation[],
    'cluster:fetch',
    _dreamStats,
  );

  // Sort by creation time — biological memory consolidation replays in temporal order.
  observations.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());

  for (const obs of observations) {
    // Skip observations without embeddings — nothing to cluster on.
    if (!obs.embedding || obs.embedding.length === 0) {
      unclusteredObs.push(obs);
      continue;
    }

    try {
      // A source memory never absorbs an observation (#114): clustering
      // onto it would touch it and hand its text to refine as evidence for
      // a rewrite. The candidate is the nearest memory that is not a mirror,
      // so an observation restating a mirrored file still joins the organic
      // memory about that file when there is one; a few neighbours are
      // fetched because a mirror of any size fills the top of the ranking.
      // When no such neighbour clears the threshold the observation is novel
      // as far as the graph's own memories go: it goes to create and becomes
      // its own memory, and connect can link it to the mirror afterwards.
      const neighbours = await store.findNearest(obs.embedding, CLUSTER_NEIGHBOURS);
      const nearest = neighbours.filter((n) => !isSource(n.memory));

      if (nearest.length > 0 && nearest[0].score >= threshold) {
        const nearestMemoryId = nearest[0].memory.id;

        // Schema congruence check: a dense neighborhood (5+ edges) signals a
        // well-established schema — cluster normally. A sparse neighborhood
        // (<2 edges) with only borderline similarity risks premature generalisation
        // from a single observation, so keep it episodic instead.
        const edges = await store.getEdgesFrom(nearestMemoryId);
        const edgeDensity = edges.length;

        if (edgeDensity < 2 && nearest[0].score < threshold + 0.10) {
          // Sparse schema + borderline similarity → don't cluster, keep as episodic.
          unclusteredObs.push(obs);
          continue;
        }

        // Touch memory + mark observation processed must commit together.
        // A partial commit leaves an observation perpetually reprocessable
        // or a memory whose access count is wrong for the cluster.
        await store.withTransaction(async (txn) => {
          await txn.touchMemory(nearestMemoryId, {});
          await txn.markObservationProcessed(obs.id);
        });

        // Preserve evidence for Phase 2 — clustered content is the highest
        // information loss point; store it so refineMemories can use it.
        const existing = clusteredEvidence.get(nearestMemoryId) ?? [];
        existing.push(obs.content);
        clusteredEvidence.set(nearestMemoryId, existing);

        clustered++;
      } else {
        unclusteredObs.push(obs);
      }
    } catch (err) {
      // Don't let a single observation kill the phase.
      console.error(`[dream:cluster] Failed to process observation ${obs.id}:`, err);
      unclusteredObs.push(obs);
    }
  }

  return {
    clustered,
    unclustered: unclusteredObs.length,
    unclusteredObs,
    clusteredEvidence,
  };
}

// ─── Phase 2: Refine ──────────────────────────────────────────────────────────

/**
 * For memories accessed recently that have accumulated new clustered observations,
 * ask the LLM to rewrite the definition incorporating the new evidence.
 *
 * Faded memories are never refined: fading is a deliberate signal that the
 * definition should stop being elaborated, and refining one re-elaborates it.
 * Source memories are never refined either: the definition is a verbatim
 * mirror, and the only correct rewrite is the next mirror (#114).
 */
async function refineMemories(
  store: CortexStore,
  embed: EmbedProvider,
  llm: LLMProvider,
  options: DreamOptions,
  clusteredEvidence?: Map<string, string[]>,
): Promise<RefinePhaseResult> {
  let refined = 0;

  const recentMemories = await safeStoreRead(
    store.getRecentMemories(7, 100),
    [] as Memory[],
    'refine:fetch',
    _dreamStats,
  );

  for (const memory of recentMemories) {
    if (memory.faded || isSource(memory)) continue;
    try {
      // Direct evidence from Phase 1 clustering is what refine exists for.
      const directEvidence = clusteredEvidence?.get(memory.id) ?? [];

      // Edge evidence describes the neighbour, not this memory, so it is only
      // used when the caller opts in (see DreamOptions.refine_from_edges) and
      // only when nothing clustered directly.
      const edgeEvidence: string[] = [];
      if (directEvidence.length === 0 && options.refine_from_edges) {
        const edges = await store.getEdgesFrom(memory.id);
        const relatedEdges = edges.filter((e) => e.relation === 'related');
        // Edge evidence written before the connect-phase fix below carries the
        // prompt's positional labels instead of concept names — 82% of rows in one
        // live store. Feeding that back makes the model echo "Concept A" into the
        // definition, where the placeholder gate rejects the whole refinement, so
        // consolidation does less and less work while reporting success.
        // Substituting on read repairs those rows without a backfill. getEdgesFrom
        // returns `memory` as the source, which is slot A; only a contaminated row
        // pays for the slot-B lookup, and that count trends to zero as the store
        // fills with edges written by the fixed connect phase.
        for (const edge of relatedEdges.slice(0, 10)) {
          if (!edge.evidence) continue;
          if (!hasConceptPlaceholder(edge.evidence)) {
            edgeEvidence.push(edge.evidence);
            continue;
          }
          const target = await safeStoreRead(
            store.getMemory(edge.target_id),
            null,
            `refine:placeholder-target:${edge.target_id}`,
            _dreamStats,
          );
          edgeEvidence.push(
            substituteConceptPlaceholders(edge.evidence, { A: memory.name, B: target?.name }),
          );
        }
      }
      const allEvidence = [...directEvidence, ...edgeEvidence];

      if (allEvidence.length === 0) continue;

      const usableEvidence = allEvidence.slice(0, 10);
      const prompt = REFINE_DEFINITION.build({
        definition: memory.definition,
        observations: usableEvidence,
      });

      const newDefinition = await llm.generate(prompt, {
        temperature: 0.1,
        maxTokens: 300,
      });

      if (!newDefinition || newDefinition.trim() === memory.definition.trim()) continue;

      // Structural quality gate: a refined definition must be grounded in the
      // definition + evidence it was derived from, complete, and free of
      // generic LLM filler. Replaces the old string-blocklist-only check.
      const quality = assessThought(newDefinition, {
        evidence: [memory.definition, ...usableEvidence],
      });
      if (!quality.ok) {
        console.error(`[dream:refine] Rejected refinement for ${memory.id}: ${quality.reasons.join('; ')}`);
        continue;
      }

      // Embed before the transaction — LLM calls inside withTransaction
      // would hold the writer mutex open. See docs/concurrency.md.
      const totalEvidence = allEvidence.length;
      const newEmbedding = await embed.embed(newDefinition.trim());

      // Belief log + memory update must commit together: a half-applied
      // refinement leaves the audit trail referencing a stale definition.
      // The reason names the evidence kind so the history is honest about
      // whether a rewrite came from observations or from edge prose.
      const reason = directEvidence.length > 0
        ? `Dream refinement from ${totalEvidence} observations`
        : `Dream refinement from ${totalEvidence} edge evidence strings`;
      await store.withTransaction(async (txn) => {
        await txn.putBelief({
          concept_id: memory.id,
          old_definition: memory.definition,
          new_definition: newDefinition.trim(),
          reason,
          changed_at: new Date(),
        });
        await txn.updateMemory(memory.id, {
          definition: newDefinition.trim(),
          embedding: newEmbedding,
          updated_at: new Date(),
        });
      });

      refined++;

      // Re-validate edges from this refined memory — definitions have changed,
      // so relationships that held before may no longer be accurate.
      try {
        const existingEdges = await store.getEdgesFrom(memory.id);
        for (const edge of existingEdges.slice(0, 5)) {
          if (edge.relation === 'related') continue; // skip generic edges

          const targetMem = await store.getMemory(edge.target_id);
          if (!targetMem) continue;

          const validationPrompt = EDGE_REVALIDATE.build({
            updatedDefinition: newDefinition.trim(),
            targetName: targetMem.name,
            targetDefinition: targetMem.definition,
            relation: edge.relation,
            evidence: edge.evidence,
          });

          const validation = await llm.generateJSON<{ valid: boolean; reason: string }>(
            validationPrompt, { temperature: 0.1 }
          );

          if (validation && !validation.valid) {
            // Downweight invalid edge via generic update — putEdge creates new docs.
            await store.update('edges', edge.id, {
              weight: edge.weight * 0.3,
              evidence: `[invalidated] ${validation.reason}. Original: ${edge.evidence}`,
            });
          }
        }
      } catch (err) {
        dreamFailure('refine:edge-revalidate', err);
      }
    } catch (err) {
      dreamFailure('refine:memory', err);
      continue;
    }
  }

  return { refined };
}

// ─── Phase 3: Create ──────────────────────────────────────────────────────────

/**
 * Promote unclustered observations to first-class memories.
 * Category is inferred by the LLM; embedding reuses the observation's.
 */
async function createFromUnclustered(
  store: CortexStore,
  embed: EmbedProvider,
  llm: LLMProvider,
  unclusteredObs: Observation[],
  options: DreamOptions,
): Promise<CreatePhaseResult> {
  const createLimit = options.create_limit ?? 10;
  let created = 0;

  // Only promote declarative observations to memories.
  // Interrogative (questions) and speculative (hypotheses) stay as observations —
  // they shouldn't become knowledge nodes in the memory graph.
  const declarativeObs = unclusteredObs.filter(
    obs => !obs.content_type || obs.content_type === 'declarative' || obs.content_type === 'reflective',
  );

  // Mark non-declarative observations as processed so they don't re-enter the pipeline
  const nonDeclarativeObs = unclusteredObs.filter(
    obs => obs.content_type === 'interrogative' || obs.content_type === 'speculative',
  );
  for (const obs of nonDeclarativeObs) {
    try {
      await store.markObservationProcessed(obs.id);
    } catch (err) {
      dreamFailure('create:mark-non-declarative', err);
    }
  }

  console.error(
    `[dream:create] ${unclusteredObs.length} unclustered → ` +
    `${declarativeObs.length} declarative/reflective, ${nonDeclarativeObs.length} non-declarative, ` +
    `${unclusteredObs.length - declarativeObs.length - nonDeclarativeObs.length} no content_type. ` +
    `Promoting up to ${createLimit}.`
  );

  const candidates = declarativeObs.slice(0, createLimit);

  for (const obs of candidates) {
    try {
      // A caller that wrote this observation with an explicit category (#114,
      // e.g. observe()/notice() called with `category`) has already stated it
      // verbatim — inferring one would second-guess a curated writer, so skip
      // the classify call entirely.
      let category: MemoryCategory;
      if (obs.category) {
        category = obs.category;
      } else {
        // Infer category — try LLM first, fall back to content_type-based heuristic.
        category = 'observation';
        try {
          const rawCategory = await llm.generate(
            CLASSIFY_CATEGORY.build({ content: obs.content }),
            { temperature: 0, maxTokens: 20 },
          );

          const inferred = rawCategory.trim().toLowerCase() as MemoryCategory;
          category = MEMORY_CATEGORIES.includes(inferred) ? inferred : 'observation';
        } catch (err) {
          dreamFailure(`create:classify:${obs.id}`, err);
          // LLM classification failed — fall back to content_type heuristic so the
          // observation can still be promoted, but the failure is no longer silent.
          category = obs.content_type === 'reflective' ? 'insight' : 'belief';
        }
      }

      // Reuse existing embedding or generate a fresh one.
      let embedding = obs.embedding;
      if (!embedding || embedding.length === 0) {
        embedding = await embed.embed(obs.content);
      }

      // Same reasoning as category: a name the writer already stated verbatim
      // skips the LLM naming call.
      const name = obs.name ?? await deriveName(obs.content, llm);

      // Atomic: promote the observation and mark it processed in one shot.
      // Without this, a crash between the two writes leaves an orphan memory
      // whose source observation gets re-promoted on the next dream cycle.
      await store.withTransaction(async (txn) => {
        await txn.putMemory({
          name,
          definition: obs.content,
          category,
          salience: normalizeSalience(obs.salience),
          confidence: 0.5,
          access_count: 0,
          created_at: new Date(),
          updated_at: new Date(),
          last_accessed: new Date(),
          source_files: obs.source_file ? [obs.source_file] : [],
          embedding,
          tags: obs.tags ?? (obs.keywords.length > 0 ? obs.keywords : extractKeywords(obs.content)),
          fsrs: newFSRSState(),
          memory_origin: 'dream',
        });
        await txn.markObservationProcessed(obs.id);
      });
      created++;
    } catch (err) {
      dreamFailure(`create:promote:${obs.id}`, err);
      // Mark as processed anyway to prevent infinite re-processing of broken observations.
      try {
        await store.markObservationProcessed(obs.id);
      } catch (markErr) {
        dreamFailure(`create:mark-failed:${obs.id}`, markErr);
      }
      continue;
    }
  }

  return { created };
}

// ─── Phase 4: Connect ─────────────────────────────────────────────────────────

interface EdgeDiscoveryResponse {
  relation: EdgeRelation | null;
  evidence?: string;
}

/**
 * For recently updated memories, check each pair and create edges when
 * the LLM detects a meaningful relationship that does not yet exist.
 */
async function discoverEdges(
  store: CortexStore,
  llm: LLMProvider,
  _options: DreamOptions,
): Promise<ConnectPhaseResult> {
  let edges_discovered = 0;

  const recentMemories = await safeStoreRead(
    store.getRecentMemories(7, 100),
    [] as Memory[],
    'connect:fetch',
    _dreamStats,
  );

  // Faded memories stay out of edge discovery: an intentionally faded memory
  // that keeps gaining edges is being re-amplified through the graph even
  // though its salience was lowered on purpose. Cap to avoid O(n²) explosion.
  const recent = recentMemories.filter((m) => !m.faded).slice(0, 15);

  if (recent.length < 2) return { edges_discovered: 0 };

  // Embedding pre-filter: below this cosine similarity, two memories share so
  // little semantic ground that an LLM relationship check is not worth the
  // call. Kept deliberately low — genuine contradictions and tensions are
  // still topically similar; only true non-sequiturs fall under it.
  const PAIR_SIMILARITY_FLOOR = 0.2;

  for (let i = 0; i < recent.length; i++) {
    for (let j = i + 1; j < recent.length; j++) {
      const memA = recent[i];
      const memB = recent[j];

      try {
        if (
          memA.embedding?.length && memB.embedding?.length &&
          memA.embedding.length === memB.embedding.length &&
          cosineSimilarity(memA.embedding, memB.embedding) < PAIR_SIMILARITY_FLOOR
        ) {
          continue;
        }

        // Check if an edge already exists in either direction.
        const edgesFromA = await store.getEdgesFrom(memA.id);
        const alreadyConnected = edgesFromA.some(
          (e) => e.target_id === memB.id || e.source_id === memB.id,
        );
        if (alreadyConnected) continue;

        const prompt = EDGE_DISCOVER_PAIR.build({
          nameA: memA.name, definitionA: memA.definition,
          nameB: memB.name, definitionB: memB.definition,
        });

        const result = await llm.generateJSON<EdgeDiscoveryResponse>(prompt, {
          temperature: 0.2,
        });

        if (result.relation !== null && result.relation !== undefined) {
          const validRelations: EdgeRelation[] = [
            'extends', 'refines', 'contradicts', 'tensions-with',
            'questions', 'supports', 'exemplifies', 'caused', 'related',
          ];
          if (!validRelations.includes(result.relation)) continue;

          await store.putEdge({
            source_id: memA.id,
            target_id: memB.id,
            relation: result.relation,
            weight: 0.7,
            // Store the concepts' names, not the prompt's positional labels.
            // refine reads this back as source material, so scaffolding left
            // here becomes scaffolding in a definition.
            evidence: substituteConceptPlaceholders(result.evidence ?? '', {
              A: memA.name,
              B: memB.name,
            }),
            created_at: new Date(),
          });

          edges_discovered++;
        }
      } catch (err) {
        dreamFailure('connect:pair', err);
        continue;
      }
    }
  }

  return { edges_discovered };
}

// ─── Phase 4 (long-context): Connect ──────────────────────────────────────────

interface LongContextEdge {
  source_id: string;
  target_id: string;
  relation: EdgeRelation;
  evidence: string;
}

/**
 * Long-context variant of discoverEdges.
 *
 * Instead of N² pairwise calls (each seeing only 2 memories), makes a single
 * LLM call with the full memory graph visible. The model can find transitive
 * patterns, cross-domain contradictions, and causal chains that the pairwise
 * approach structurally cannot detect.
 *
 * Works best with large-context models (kimi-k2, gemini-2.5-pro, etc.).
 * Cap via options.long_context_memory_limit if needed (default: 200).
 */
async function discoverEdgesLongContext(
  store: CortexStore,
  llm: LLMProvider,
  options: DreamOptions,
): Promise<ConnectPhaseResult> {
  const memoryLimit = options.long_context_memory_limit ?? 200;
  let edges_discovered = 0;

  const recentMemories = await safeStoreRead(
    store.getRecentMemories(30, memoryLimit),
    [] as Memory[],
    'connect:fetch-long-context',
    _dreamStats,
  );

  if (recentMemories.length < 2) return { edges_discovered: 0 };

  const memoryIds = recentMemories.map((m) => m.id);
  const memoryMap = new Map(recentMemories.map((m) => [m.id, m]));

  // Fetch all edges between these memories so the model sees the current graph.
  let existingEdgeSet = new Set<string>();
  let existingEdgeLines = 'None.';
  try {
    const existingEdges = await store.getEdgesForMemories(memoryIds);
    existingEdgeSet = new Set(
      existingEdges.flatMap((e) => [
        `${e.source_id}:${e.target_id}`,
        `${e.target_id}:${e.source_id}`,
      ]),
    );
    if (existingEdges.length > 0) {
      existingEdgeLines = existingEdges
        .map((e) => `  ${e.source_id} --[${e.relation}]--> ${e.target_id}: ${e.evidence}`)
        .join('\n');
    }
  } catch (err) {
    // Proceed without existing edge context — model may suggest duplicates,
    // but we validate before writing so it's safe. Still recorded: degraded
    // input costs prompt budget and edge quality, so it must not be invisible.
    dreamFailure('connect:existing-edges', err);
  }

  const validRelations: EdgeRelation[] = [
    'extends', 'refines', 'contradicts', 'tensions-with',
    'questions', 'supports', 'exemplifies', 'caused', 'related',
  ];

  const memoryLines = recentMemories
    .map((m) => `[${m.id}] (${m.category}) ${m.name}: ${m.definition}`)
    .join('\n');

  const prompt = EDGE_DISCOVER_GRAPH.build({
    memoryLines,
    memoryCount: recentMemories.length,
    existingEdgeLines,
  });

  let discovered: LongContextEdge[];
  try {
    discovered = await llm.generateJSON<LongContextEdge[]>(prompt, { temperature: 0.2 });
    if (!Array.isArray(discovered)) {
      dreamFailure('connect:generate', new Error('model returned a non-array edge list'));
      return { edges_discovered: 0 };
    }
  } catch (err) {
    dreamFailure('connect:generate', err);
    return { edges_discovered: 0 };
  }

  for (const edge of discovered) {
    try {
      if (!memoryMap.has(edge.source_id) || !memoryMap.has(edge.target_id)) continue;
      if (edge.source_id === edge.target_id) continue;
      if (!validRelations.includes(edge.relation)) continue;

      const key = `${edge.source_id}:${edge.target_id}`;
      if (existingEdgeSet.has(key)) continue;

      await store.putEdge({
        source_id: edge.source_id,
        target_id: edge.target_id,
        relation: edge.relation,
        weight: 0.7,
        // The graph prompt names its nodes, but a model may still answer in
        // the positional idiom. Normalise on the way in either way.
        evidence: substituteConceptPlaceholders(edge.evidence ?? '', {
          A: memoryMap.get(edge.source_id)?.name,
          B: memoryMap.get(edge.target_id)?.name,
        }),
        created_at: new Date(),
      });

      // Mark both directions to prevent duplicates within this batch.
      existingEdgeSet.add(key);
      existingEdgeSet.add(`${edge.target_id}:${edge.source_id}`);

      edges_discovered++;
    } catch (err) {
      dreamFailure('connect:write', err);
      continue;
    }
  }

  return { edges_discovered };
}

// ─── Phase 5: Score ───────────────────────────────────────────────────────────

/**
 * Passive FSRS review for memories currently in 'review' or 'learning' state.
 * Recent access = rating 3 (Good); otherwise rating 2 (Hard).
 *
 * Source memories are not scheduled (#114): a mirror that nobody has queried
 * lately is not a belief going stale, and rating it Hard would let its
 * retrievability decay under the code it mirrors. It keeps whatever FSRS
 * state it was written with.
 */
async function scoreMemories(
  store: CortexStore,
  _options: DreamOptions,
): Promise<ScorePhaseResult> {
  let scored = 0;

  let allMemories: Memory[];
  try {
    allMemories = await store.getAllMemories();
  } catch {
    return { scored: 0 };
  }

  const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
  const oneDayAgo = Date.now() - 1 * 24 * 60 * 60 * 1000;

  const reviewable = allMemories.filter((m) => {
    if (isSource(m)) return false;
    if (m.fsrs.state !== 'review' && m.fsrs.state !== 'learning' && m.fsrs.state !== 'relearning') {
      return false;
    }

    // Skip memories not yet due for review
    if (m.fsrs.last_review) {
      const elapsed = elapsedDaysSince(m.fsrs.last_review);
      // Use stability as proxy for interval (FSRS: retrievability = e^(-elapsed/stability))
      // Review when elapsed >= 80% of stability (20% tolerance window)
      const dueThreshold = m.fsrs.stability * 0.8;

      // Learning/relearning have shorter intervals — minimum 0.5 days
      const minThreshold = (m.fsrs.state === 'learning' || m.fsrs.state === 'relearning') ? 0.5 : 1.0;

      if (elapsed < Math.max(minThreshold, dueThreshold)) {
        return false;
      }
    }

    return true;
  });

  // Batch-fetch edges for contradiction detection
  const reviewableIds = reviewable.map((m) => m.id);
  const contradictionSet: Set<string> = new Set();
  try {
    const edges = await store.getEdgesForMemories(reviewableIds);
    for (const edge of edges) {
      if (edge.relation === 'contradicts' || edge.relation === 'tensions-with') {
        contradictionSet.add(edge.source_id);
        contradictionSet.add(edge.target_id);
      }
    }
  } catch {
    // Edge fetch failed — proceed without contradiction signal
  }

  // Unresolved CONTRADICTION signals also count: contradict() records
  // observation-vs-memory conflicts as signals, not edges (observations are
  // not graph nodes), so edge scanning alone misses them.
  try {
    const openContradictions = await store.getSignals({ resolved: false, type: 'CONTRADICTION' });
    for (const signal of openContradictions) {
      for (const conceptId of signal.concept_ids) contradictionSet.add(conceptId);
    }
  } catch {
    // Signal fetch failed — proceed with edge-based detection only
  }

  for (const memory of reviewable) {
    try {
      const elapsed = elapsedDaysSince(memory.fsrs.last_review);
      // Relearning memories use stricter 1-day window (already lapsed once)
      const accessWindow = memory.fsrs.state === 'relearning' ? oneDayAgo : threeDaysAgo;
      const recentlyAccessed = memory.last_accessed.getTime() >= accessWindow;

      // Composite rating: base + retrieval quality signals
      let rating: 1 | 2 | 3 | 4 = recentlyAccessed ? 3 : 2;

      // Boost: direct, high-confidence retrieval → Easy
      if (
        memory.last_retrieval_score !== undefined &&
        memory.last_retrieval_score > 0.92 &&
        (memory.last_hop_count === undefined || memory.last_hop_count === 0)
      ) {
        rating = Math.min(4, rating + 1) as 1 | 2 | 3 | 4;
      }

      // Penalize: weak or indirect retrieval → harder
      if (
        (memory.last_retrieval_score !== undefined && memory.last_retrieval_score < 0.75) ||
        (memory.last_hop_count !== undefined && memory.last_hop_count > 0)
      ) {
        rating = Math.max(1, rating - 1) as 1 | 2 | 3 | 4;
      }

      // Penalize: contradicted memories are harder to retrieve correctly
      if (contradictionSet.has(memory.id)) {
        rating = Math.max(1, rating - 1) as 1 | 2 | 3 | 4;
      }

      const scheduled = scheduleNext(memory.fsrs, rating, elapsed);

      // updateMemory, NOT touchMemory: passive dream review is maintenance,
      // not access. touchMemory would refresh last_accessed, which the next
      // cycle's "recently accessed → rating 3" rule reads — dreams would then
      // reinforce every memory they score, manufacturing exactly the silent
      // confidence-hardening the hindsight phase exists to catch. Only real
      // retrieval (query/validate) may count as access.
      await store.updateMemory(memory.id, {
        fsrs: {
          stability: scheduled.stability,
          difficulty: scheduled.difficulty,
          reps: memory.fsrs.reps + 1,
          lapses: memory.fsrs.lapses,
          state: scheduled.state,
          last_review: new Date(),
        },
      });

      scored++;
    } catch {
      continue;
    }
  }

  return { scored };
}

// ─── Phase 6: Abstract (REM) ──────────────────────────────────────────────────

/**
 * Split an abstraction response into a label and a body.
 *
 * Models answer the synthesis prompt with a title line more often than not —
 * `Pattern: *Silent Success*`, `Pattern Name: X` followed by `Explanation: …`,
 * or `Pattern: X — explanation` on one line. Stored verbatim, that scaffolding
 * became the memory's name *and* the opening of its definition, complete with
 * asterisks and newlines, because the name was "the first sentence" and the
 * title line has no sentence punctuation to stop at. (#83)
 *
 * Returns null when nothing but a title is present: a label with no body is
 * not an abstraction.
 */
export function parseAbstraction(raw: string): { name: string; definition: string } | null {
  const text = stripMarkdownFormatting(raw ?? '').trim();
  if (!text) return null;

  const LABEL_LINE = /^(?:pattern(?:\s+name)?|abstraction|principle|title|name)\s*:\s*(.+)$/i;
  const BODY_LABEL = /^(?:explanation|abstraction|why it matters|the pattern|pattern)\s*:\s*/i;

  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  let name = '';
  let bodyLines = lines;

  const titleMatch = lines[0]?.match(LABEL_LINE);
  if (titleMatch) {
    let title = titleMatch[1].trim();
    bodyLines = lines.slice(1);
    // One-line form: "Pattern: X — the explanation follows the dash."
    if (bodyLines.length === 0) {
      const parts = title.split(/\s+[—–]\s+|\s+-{1,2}\s+/);
      if (parts.length > 1) {
        title = parts[0].trim();
        bodyLines = [parts.slice(1).join(' — ').trim()];
      }
    }
    name = title;
  }

  const definition = bodyLines
    .map((l) => l.replace(BODY_LABEL, '').trim())
    .filter((l) => l.length > 0)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!definition) return null;

  name = name.replace(/\s+/g, ' ').replace(/[\s.!?;:,]+$/, '').trim();
  if (!name) name = deriveNameHeuristic(definition);
  else if (name.length > NAME_MAX_LEN) name = deriveNameHeuristic(name);

  return { name, definition };
}

/**
 * REM sleep phase: sample recent memories across categories and attempt
 * to synthesize higher-level cross-domain abstractions.
 *
 * Exported for tests; dream callers go through dreamPhaseB / dreamConsolidate.
 */
export async function abstractCrossDomain(
  store: CortexStore,
  embed: EmbedProvider,
  llm: LLMProvider,
  options: DreamOptions,
): Promise<AbstractPhaseResult> {
  const attempts = options.abstraction_attempts ?? 5;
  const noveltyThreshold = options.abstraction_novelty_threshold ?? 0.88;
  const dedupeThreshold = options.abstraction_dedupe_threshold ?? 0.60;
  let abstractions = 0;
  // Embeddings of abstractions written in this run, for the within-run check.
  const writtenThisRun: number[][] = [];

  let allMemories: Memory[];
  try {
    allMemories = await store.getAllMemories();
  } catch {
    return { abstractions: 0 };
  }

  // Work from the 60 most recently updated memories. Faded memories are
  // excluded: fading lowers a memory's salience on purpose, and an
  // abstraction that cites it re-attaches edges to it and pulls it back into
  // the graph — one live run put four edges on intentionally faded rows.
  // Source memories are excluded too (#114): an abstraction is a belief
  // derived from its members, and a mirrored file is not a belief to
  // generalise from. An abstraction built on organic memories may still be
  // linked to a source memory by connect; it just never cites one as a member.
  const recent = allMemories
    .filter((m) => !m.faded && !isSource(m))
    .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime())
    .slice(0, 60);

  // Group by category.
  const byCategory = new Map<MemoryCategory, Memory[]>();
  for (const m of recent) {
    const group = byCategory.get(m.category) ?? [];
    group.push(m);
    byCategory.set(m.category, group);
  }

  const categories = Array.from(byCategory.keys());
  if (categories.length < 3) return { abstractions: 0 };

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      // Pick 4 different random categories (or as many as available, min 3).
      const shuffled = categories.sort(() => Math.random() - 0.5);
      const selected = shuffled.slice(0, Math.min(4, shuffled.length));

      // Pick one random memory from each selected category.
      const sampledMemories = selected.map((cat) => {
        const group = byCategory.get(cat)!;
        return group[Math.floor(Math.random() * group.length)];
      });

      const conceptLines = sampledMemories
        .map((m) => `[${m.category}] ${m.name}: ${m.definition}`)
        .join('\n\n');

      const result = await llm.generate(ABSTRACT_SYNTHESIS.build({ conceptLines }), {
        temperature: 0.4,
        maxTokens: 500,
      });

      const raw = result.trim();
      if (!raw || raw.includes('NO_ABSTRACTION')) continue;

      // Salvage formatting rather than reject on it. A rejected abstraction
      // leaves nothing in its place — unlike refine, where the previous
      // definition survives — so discarding a real cross-domain synthesis over
      // its asterisks or its title line is the more expensive error. Parsing
      // changes no content: the label becomes the name, the body becomes the
      // definition, and the markdown goes.
      const parsed = parseAbstraction(raw);
      if (!parsed) continue;
      const trimmed = parsed.definition;
      if (trimmed !== raw) {
        console.error('[dream:abstract] Normalised abstraction formatting (title line / markdown)');
      }

      // Structural quality gate. Abstractions legitimately introduce new
      // vocabulary (that's what abstraction is), so the grounding floor is
      // lower than refine's — but a real cross-domain pattern still names
      // the concepts it connects, while generic filler names nothing.
      const quality = assessThought(trimmed, {
        evidence: sampledMemories.map((m) => `${m.name} ${m.definition}`),
        minGrounding: 0.1,
      });
      if (!quality.ok) {
        console.error(`[dream:abstract] Rejected abstraction: ${quality.reasons.join('; ')}`);
        continue;
      }

      // Check novelty — don't store abstractions too similar to existing memories.
      const abstEmbedding = await embed.embed(trimmed);
      const nearest = await store.findNearest(abstEmbedding, 1);

      if (nearest.length > 0 && nearest[0].score >= noveltyThreshold) {
        // Too similar to an existing memory — skip.
        continue;
      }

      // Same idea twice in one run: attempts sample overlapping memories and
      // the model restates the same synthesis in new words. The store-wide
      // check above misses paraphrases; this one compares against what this
      // run has already written.
      if (writtenThisRun.some((e) => cosineSimilarity(e, abstEmbedding) >= dedupeThreshold)) {
        console.error('[dream:abstract] Skipped near-duplicate of an abstraction written earlier in this run');
        continue;
      }

      const memName = parsed.name;

      // Abstraction memory + its provenance edges land together. Otherwise
      // a partial commit produces an "insight" with no traceable sources.
      await store.withTransaction(async (txn) => {
        const abstractionId = await txn.putMemory({
          name: memName,
          definition: trimmed,
          category: 'insight',
          salience: 0.8,
          confidence: 0.6,
          access_count: 0,
          created_at: new Date(),
          updated_at: new Date(),
          last_accessed: new Date(),
          source_files: [],
          embedding: abstEmbedding,
          tags: extractKeywords(trimmed),
          fsrs: newFSRSState(),
          memory_origin: 'abstract',
        });
        for (const sourceMem of sampledMemories) {
          await txn.putEdge({
            source_id: abstractionId,
            target_id: sourceMem.id,
            relation: 'exemplifies',
            weight: 0.8,
            evidence: `Dream abstraction source: [${sourceMem.category}] ${sourceMem.name}`,
            created_at: new Date(),
          });
        }
      });

      writtenThisRun.push(abstEmbedding);
      abstractions++;
    } catch (err) {
      dreamFailure('abstract', err);
      continue;
    }
  }

  return { abstractions };
}

// ─── Phase 7: Report ──────────────────────────────────────────────────────────

// ─── Phase 7: Hindsight ───────────────────────────────────────────────────────

/**
 * A hindsight concern must name what grounds it: one of the connected concepts
 * the prompt listed, or the belief history when there is one. A citation that
 * matches nothing in the store is no citation — the model has no evidence
 * beyond what it was shown, so an ungrounded concern is an opinion. (#98)
 */
function groundedCitation(
  cited: unknown,
  neighbours: ReadonlyArray<{ name: string; definition: string }>,
  hasHistory: boolean,
): { label: string; evidence: string[] } | null {
  if (typeof cited !== 'string') return null;
  const wanted = cited.trim().toLowerCase();
  if (!wanted) return null;
  if (hasHistory && /\b(history|revision)/.test(wanted)) return { label: 'belief history', evidence: [] };
  const match = neighbours.find((n) => {
    const name = n.name.trim().toLowerCase();
    return name.length > 0 && (wanted.includes(name) || name.includes(wanted));
  });
  return match ? { label: match.name, evidence: [match.definition] } : null;
}

/**
 * Proactively audit memories that have silently hardened through unchallenged reinforcement.
 *
 * Targets memories in 'review' state with high stability, zero lapses, and no existing
 * contradiction/tension edges — i.e., beliefs that keep getting rated Easy without ever
 * being questioned. For each candidate, an LLM critically examines whether the confidence
 * is earned through diverse evidence or accumulated through narrow confirmation.
 *
 * The default outcome is no change. A concern counts only when the model cites a
 * connected concept or the belief history (#98); on one live store the phase had
 * revised five of five reviewed memories with reasons like "lacks contextual depth",
 * turning first person into third and adding qualifiers nothing in the store contained.
 *
 * When a grounded concern is found:
 *   - Confidence is reduced by up to 0.25
 *   - Definition is revised only if the rewrite passes `checkRewrite` (logged via putBelief);
 *     a rewrite that loses a specific is declined and the old definition kept
 *   - A TENSION signal is created for follow-up
 *
 * Memories already carrying contradiction/tension edges are skipped — Phase 5 handles those.
 */
export async function hindsightReview(
  store: CortexStore,
  llm: LLMProvider,
  options: DreamOptions,
): Promise<HindsightPhaseResult> {
  const maxReview = options.hindsight_max_review ?? 5;
  const stabilityThreshold = options.hindsight_stability_threshold ?? 21;
  const minReps = options.hindsight_min_reps ?? 4;

  let reviewed = 0;
  let revised = 0;
  let declined = 0;

  let allMemories: Memory[];
  try {
    allMemories = await store.getAllMemories();
  } catch {
    return { reviewed: 0, revised: 0, declined: 0 };
  }

  // Candidates: well-entrenched (high stability), never challenged (zero lapses),
  // repeatedly reinforced (reps >= minReps), trusted (confidence >= 0.7), not
  // faded, not source (#114: a mirror's confidence is not earned through
  // reinforcement, so there is no hardening to audit and no rewrite to offer).
  const candidates = allMemories.filter(
    (m) =>
      m.fsrs.state === 'review' &&
      m.fsrs.stability >= stabilityThreshold &&
      m.fsrs.lapses === 0 &&
      m.fsrs.reps >= minReps &&
      m.confidence >= 0.7 &&
      !m.faded &&
      !isSource(m),
  );

  if (candidates.length === 0) return { reviewed: 0, revised: 0, declined: 0 };

  // Most entrenched first — those are the highest risk for silent hardening.
  const sample = candidates
    .sort((a, b) => b.fsrs.stability - a.fsrs.stability)
    .slice(0, maxReview);

  for (const memory of sample) {
    try {
      const [beliefHistory, edges] = await Promise.all([
        safeStoreRead(store.getBeliefHistory(memory.id), [] as BeliefEntry[], `hindsight:belief-history:${memory.id}`, _dreamStats),
        safeStoreRead(store.getEdgesFrom(memory.id), [] as Edge[], `hindsight:edges:${memory.id}`, _dreamStats),
      ]);

      // Skip memories already explicitly contradicted — Phase 5 scores those via contradiction penalty.
      const hasActiveChallenge = edges.some(
        (e) => e.relation === 'contradicts' || e.relation === 'tensions-with',
      );
      if (hasActiveChallenge) continue;

      const historyNote =
        beliefHistory.length > 0
          ? `Belief revisions: ${beliefHistory.length} (most recent reason: "${beliefHistory[beliefHistory.length - 1]?.reason ?? 'unknown'}")`
          : 'No belief revisions — this definition has never been challenged or updated.';

      // Fetch target names for edge context so the LLM can reason about structural
      // neighbourhood — and so a concern can be checked against what it cites.
      const neighbours: { name: string; definition: string }[] = [];
      const edgeLines = await Promise.all(
        edges.slice(0, 8).map(async (e) => {
          const target = await safeStoreRead(store.getMemory(e.target_id), null, `hindsight:target:${e.target_id}`, _dreamStats);
          if (target) neighbours.push({ name: target.name, definition: target.definition });
          const label = target ? `"${target.name}"` : e.target_id;
          return `${e.relation}: ${label}`;
        }),
      );
      const edgeSummary = edgeLines.join('\n') || 'none';

      const prompt = HINDSIGHT_REVIEW.build({
        name: memory.name,
        definition: memory.definition,
        category: memory.category,
        confidence: memory.confidence,
        stability: memory.fsrs.stability,
        reps: memory.fsrs.reps,
        lapses: memory.fsrs.lapses,
        historyNote,
        edgeSummary,
      });

      const result = await llm.generateJSON<{
        concern: string | null;
        cited: string | null;
        confidence_penalty: number;
        revised_definition: string | null;
        reason: string;
      }>(prompt, { temperature: 0.3 });

      if (!result) continue;

      reviewed++;

      // No change unless the concern is grounded in something the store holds.
      const citation = groundedCitation(result.cited, neighbours, beliefHistory.length > 0);
      if (!citation) continue;

      const penalty = Math.min(0.25, Math.max(0, result.confidence_penalty ?? 0));
      const newDef = result.revised_definition?.trim();
      let applyDefinition = Boolean(newDef) && newDef !== memory.definition.trim();

      // A rewrite must keep everything the old definition committed to; anything
      // new must come from the cited concept. Otherwise keep the old definition
      // and spend no belief row on it.
      if (applyDefinition && newDef) {
        const guard = checkRewrite({
          name: memory.name,
          old: memory.definition,
          next: newDef,
          evidence: citation.evidence,
          origin: memory.memory_origin,
        });
        if (!guard.ok) {
          console.error(`[dream:hindsight] Declined rewrite for ${memory.id} (cited "${citation.label}"): ${guard.reasons.join('; ')}`);
          declined++;
          applyDefinition = false;
        }
      }

      const applyConfidence = penalty > 0.05;
      if (!result.concern && !applyConfidence && !applyDefinition) continue;

      // Confidence + definition + belief log must commit as one unit
      // so the memory's confidence and definition never disagree with
      // the audit trail. Split paths if only one applies.
      if (applyConfidence && applyDefinition && newDef) {
        await store.withTransaction(async (txn) => {
          await txn.putBelief({
            concept_id: memory.id,
            old_definition: memory.definition,
            new_definition: newDef,
            reason: `[hindsight] ${result.reason}`,
            changed_at: new Date(),
          });
          await txn.updateMemory(memory.id, {
            confidence: Math.max(0.1, memory.confidence - penalty),
            definition: newDef,
            updated_at: new Date(),
          });
        });
      } else if (applyDefinition && newDef) {
        await store.withTransaction(async (txn) => {
          await txn.putBelief({
            concept_id: memory.id,
            old_definition: memory.definition,
            new_definition: newDef,
            reason: `[hindsight] ${result.reason}`,
            changed_at: new Date(),
          });
          await txn.updateMemory(memory.id, {
            definition: newDef,
            updated_at: new Date(),
          });
        });
      } else if (applyConfidence) {
        await store.updateMemory(memory.id, {
          confidence: Math.max(0.1, memory.confidence - penalty),
          updated_at: new Date(),
        });
      }

      // Surface the concern as a TENSION signal for follow-up.
      if (result.concern) {
        try {
          await store.putSignal({
            type: 'TENSION',
            description: `[hindsight] ${result.concern}`,
            concept_ids: [memory.id],
            priority: Math.min(0.8, penalty * 4 + 0.3),
            resolved: false,
            created_at: new Date(),
            resolution_note: null,
          });
        } catch {
          // Signal creation is best-effort — don't abort the loop.
        }
      }

      if (applyConfidence || applyDefinition) revised++;
    } catch {
      continue;
    }
  }

  return { reviewed, revised, declined };
}

/**
 * Generate a human-readable narrative of what the dream cycle accomplished.
 * Called last so it can include abstraction count, Fiedler value, PE stats, and hindsight results.
 */
async function generateReport(
  llm: LLMProvider,
  cluster: ClusterPhaseResult,
  refine: RefinePhaseResult,
  create: CreatePhaseResult,
  connect: ConnectPhaseResult,
  score: ScorePhaseResult,
  abstract: AbstractPhaseResult,
  hindsight: HindsightPhaseResult,
  fiedlerValue?: number,
  peSaturation?: PESaturationResult,
): Promise<ReportPhaseResult> {
  try {
    const fiedlerNote = fiedlerValue !== undefined
      ? ` Graph connectivity (Fiedler value): ${fiedlerValue.toFixed(4)}.`
      : '';
    const peNote = peSaturation
      ? ` PE saturation: mean_pe=${peSaturation.mean_pe.toFixed(3)}, trend=${peSaturation.trend}${peSaturation.saturated ? ' (SATURATED)' : ''}.`
      : '';
    const hindsightNote = hindsight.reviewed > 0
      ? ` Hindsight: ${hindsight.reviewed} entrenched memories audited, ${hindsight.revised} revised` +
        (hindsight.declined > 0 ? `, ${hindsight.declined} rewrites declined.` : '.')
      : '';

    const statsLine =
      `${cluster.clustered} observations clustered, ${refine.refined} memories refined, ` +
      `${create.created} new memories created, ${connect.edges_discovered} edges discovered, ` +
      `${score.scored} memories reviewed, ${abstract.abstractions} abstractions formed.` +
      fiedlerNote + peNote + hindsightNote;

    const text = await llm.generate(DREAM_REPORT.build({ statsLine }), {
      temperature: 0.7,
      maxTokens: 200,
    });

    return { text: text.trim() };
  } catch {
    const fiedlerNote = fiedlerValue !== undefined
      ? ` Fiedler=${fiedlerValue.toFixed(4)}.`
      : '';
    const hindsightNote = hindsight.reviewed > 0
      ? ` Hindsight: ${hindsight.reviewed} audited, ${hindsight.revised} revised.`
      : '';
    const fallback =
      `Dream cycle complete. ` +
      `Clustered ${cluster.clustered} observations, refined ${refine.refined} memories, ` +
      `created ${create.created} new memories, discovered ${connect.edges_discovered} edges, ` +
      `reviewed ${score.scored} memories, formed ${abstract.abstractions} abstractions.` +
      fiedlerNote + hindsightNote;
    return { text: fallback };
  }
}

// ─── Public: Phase A (NREM) ───────────────────────────────────────────────────

/**
 * Phase A (NREM analog): compression and binding.
 *
 * Run during or right after sessions to compress raw observations into the
 * memory graph. Does not perform cross-association or scoring — those are
 * Phase B concerns.
 *
 * Phases executed: Cluster -> Refine -> Create
 */
export async function dreamPhaseA(
  store: CortexStore,
  embed: EmbedProvider,
  llm: LLMProvider,
  options: DreamOptions = {},
): Promise<{ cluster: ClusterPhaseResult; refine: RefinePhaseResult; create: CreatePhaseResult; failures: number }> {
  resetDreamStats();
  const clusterResult = await clusterObservations(store, embed, options);
  const refineResult = await refineMemories(store, embed, llm, options, clusterResult.clusteredEvidence);
  const createResult = await createFromUnclustered(store, embed, llm, clusterResult.unclusteredObs, options);
  return { cluster: clusterResult, refine: refineResult, create: createResult, failures: _dreamStats.failures };
}

// ─── Public: Phase B (REM) ────────────────────────────────────────────────────

/**
 * Phase B (REM analog): cross-association and integration.
 *
 * Run in cron sessions for deep integration: edge discovery, FSRS scoring,
 * cross-domain abstraction, hindsight review, and report generation.
 *
 * Also computes the Fiedler value (graph health) and PE saturation unless
 * suppressed via options.skip_fiedler / options.skip_pe_saturation.
 *
 * Phases executed: Connect -> Score -> Abstract -> Hindsight -> Report
 */
export async function dreamPhaseB(
  store: CortexStore,
  embed: EmbedProvider,
  llm: LLMProvider,
  options: DreamOptions = {},
): Promise<{
  connect: ConnectPhaseResult;
  score: ScorePhaseResult;
  abstract: AbstractPhaseResult;
  hindsight: HindsightPhaseResult;
  report: ReportPhaseResult;
  fiedler_value: number | undefined;
  pe_saturation: PESaturationResult | undefined;
  failures: number;
}> {
  resetDreamStats();
  const connectResult = options.strategy === 'long-context'
    ? await discoverEdgesLongContext(store, llm, options)
    : await discoverEdges(store, llm, options);
  const scoreResult = await scoreMemories(store, options);
  const abstractResult = await abstractCrossDomain(store, embed, llm, options);

  // Phase 7 — Hindsight: audit entrenched memories for silent confidence hardening.
  const hindsightResult = options.skip_hindsight
    ? { reviewed: 0, revised: 0, declined: 0 }
    : await safeStoreRead(hindsightReview(store, llm, options), { reviewed: 0, revised: 0, declined: 0 }, 'hindsight', _dreamStats);

  // Graph health metrics — run in parallel for speed.
  const [fiedlerValue, peSaturation] = await Promise.all([
    options.skip_fiedler
      ? Promise.resolve(undefined)
      : safeStoreRead(computeFiedlerValue(store), undefined as number | undefined, 'fiedler', _dreamStats),
    options.skip_pe_saturation
      ? Promise.resolve(undefined)
      : safeStoreRead(detectPESaturation(store), undefined as PESaturationResult | undefined, 'pe-saturation', _dreamStats),
  ]);

  // Partial-cycle report: pass zero counts for NREM phases.
  const emptyCluster: ClusterPhaseResult = {
    clustered: 0,
    unclustered: 0,
    unclusteredObs: [],
    clusteredEvidence: new Map(),
  };
  const reportResult = await generateReport(
    llm,
    emptyCluster,
    { refined: 0 },
    { created: 0 },
    connectResult,
    scoreResult,
    abstractResult,
    hindsightResult,
    fiedlerValue,
    peSaturation,
  );

  return {
    connect: connectResult,
    score: scoreResult,
    abstract: abstractResult,
    hindsight: hindsightResult,
    report: reportResult,
    fiedler_value: fiedlerValue,
    pe_saturation: peSaturation,
    failures: _dreamStats.failures,
  };
}

// ─── Main: dreamConsolidate ───────────────────────────────────────────────────

/**
 * Run the full 8-phase dream consolidation cycle.
 *
 * Phase ordering:
 *   1 Cluster -> 2 Refine -> 3 Create -> 4 Connect -> 5 Score -> 6 Abstract -> 7 Hindsight -> 8 Report
 *
 * Report runs last so it can include all phase stats, Fiedler value, PE, and hindsight results.
 * A phase error is caught internally — the cycle continues with degraded output.
 *
 * Backward compatible: existing callers using dreamConsolidate() are unaffected.
 */
export async function dreamConsolidate(
  store: CortexStore,
  embed: EmbedProvider,
  llm: LLMProvider,
  options: DreamOptions = {},
): Promise<DreamResult> {
  const start = Date.now();
  resetDreamStats();

  // Phase 1 — Cluster
  const clusterResult = await clusterObservations(store, embed, options);

  // Phase 2 — Refine (receives clustered evidence from Phase 1)
  const refineResult = await refineMemories(store, embed, llm, options, clusterResult.clusteredEvidence);

  // Phase 3 — Create
  const createResult = await createFromUnclustered(
    store,
    embed,
    llm,
    clusterResult.unclusteredObs,
    options,
  );

  // Phase 4 — Connect
  const connectResult = options.strategy === 'long-context'
    ? await discoverEdgesLongContext(store, llm, options)
    : await discoverEdges(store, llm, options);

  // Phase 5 — Score
  const scoreResult = await scoreMemories(store, options);

  // Phase 6 — Abstract (REM)
  const abstractResult = await abstractCrossDomain(store, embed, llm, options);

  // Phase 7 — Hindsight: audit entrenched memories for silent confidence hardening.
  // Runs after scoring so recently contradiction-penalized memories are already handled.
  const hindsightResult = options.skip_hindsight
    ? { reviewed: 0, revised: 0, declined: 0 }
    : await safeStoreRead(hindsightReview(store, llm, options), { reviewed: 0, revised: 0, declined: 0 }, 'hindsight', _dreamStats);

  // Graph health metrics — run in parallel, don't block the report.
  const [fiedlerValue, peSaturation] = await Promise.all([
    options.skip_fiedler
      ? Promise.resolve(undefined)
      : safeStoreRead(computeFiedlerValue(store), undefined as number | undefined, 'fiedler', _dreamStats),
    options.skip_pe_saturation
      ? Promise.resolve(undefined)
      : safeStoreRead(detectPESaturation(store), undefined as PESaturationResult | undefined, 'pe-saturation', _dreamStats),
  ]);

  // Phase 8 — Report (runs last to include all phase stats)
  const reportResult = await generateReport(
    llm,
    clusterResult,
    refineResult,
    createResult,
    connectResult,
    scoreResult,
    abstractResult,
    hindsightResult,
    fiedlerValue,
    peSaturation,
  );

  const duration_ms = Date.now() - start;
  const total = clusterResult.clustered + clusterResult.unclustered;
  const integration_rate = total > 0 ? clusterResult.clustered / total : 0;

  return {
    phases: {
      cluster: { clustered: clusterResult.clustered, unclustered: clusterResult.unclustered },
      refine: { refined: refineResult.refined },
      create: { created: createResult.created },
      connect: { edges_discovered: connectResult.edges_discovered },
      score: { scored: scoreResult.scored },
      report: { text: reportResult.text },
      abstract: { abstractions: abstractResult.abstractions },
      hindsight: { reviewed: hindsightResult.reviewed, revised: hindsightResult.revised },
    },
    total_processed: clusterResult.clustered + createResult.created,
    duration_ms,
    integration_rate,
    fiedler_value: fiedlerValue,
    pe_saturation: peSaturation,
    failures: _dreamStats.failures,
  };
}
