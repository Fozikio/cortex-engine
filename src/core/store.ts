/**
 * CortexStore — storage abstraction for cortex-engine.
 *
 * Implementations: FirestoreCortexStore (cloud), SqliteCortexStore (local),
 * JsonCortexStore (file-backed, for backup/migration).
 * All methods operate on plain JS objects (no Firestore Timestamps, no VectorValue).
 */

import type {
  Memory,
  Observation,
  Edge,
  OpsEntry,
  OpsFilters,
  Signal,
  BeliefEntry,
  SearchResult,
  QueryFilter,
  FSRSData,
} from './types.js';

/**
 * Bumped when the CortexStore wire format changes in a way that breaks
 * round-trip migration. Used by getCapabilities() during migrate to refuse
 * incompatible source/destination pairs.
 */
export const CORTEX_STORE_SCHEMA_VERSION = 1;

export interface StoreCapabilities {
  /** Bumped on breaking interface/wire-format changes; see CORTEX_STORE_SCHEMA_VERSION. */
  schemaVersion: number;
  /** Length of the first stored memory's embedding, or 0 if the store is empty. */
  embeddingDimension: number;
  /** Distinct Memory.category values observed in the store (best-effort, may be empty). */
  categories: string[];
  /** The namespace prefix the store is bound to ('' for the default namespace). */
  namespace: string;
  /** Identifier for the backend implementation. */
  backend: 'sqlite' | 'firestore' | 'json';
}

export interface CortexStore {
  // ─── Memory ──────────────────────────────────────────────────────────────────

  /** Store a new memory, returns its ID. */
  putMemory(memory: Omit<Memory, 'id'>): Promise<string>;

  /** Get a memory by ID. */
  getMemory(id: string): Promise<Memory | null>;

  /** Update specific fields on a memory. */
  updateMemory(id: string, updates: Partial<Omit<Memory, 'id'>>): Promise<void>;

  /** Find k nearest memories by embedding vector. Returns sorted by similarity desc. */
  findNearest(embedding: number[], limit: number): Promise<SearchResult[]>;

  /**
   * Lexical full-text search over memory name/definition/tags. Complements
   * findNearest: catches exact-keyword matches that embeddings miss (IDs,
   * proper nouns, rare terms). SQLite uses FTS5/BM25; JSON and Firestore
   * fall back to token-overlap scoring. Scores are normalized to 0-1 but are
   * NOT comparable to cosine similarity — rank order is the contract.
   * Faded memories are excluded. An empty or stopword-only query returns [].
   */
  searchText(text: string, limit: number): Promise<SearchResult[]>;

  /** Increment access_count, update last_accessed and FSRS fields. */
  touchMemory(id: string, fsrsUpdates: Partial<FSRSData>): Promise<void>;

  /** Get all memories (for batch operations like dream scoring). Use with caution. */
  getAllMemories(): Promise<Memory[]>;

  /** Get memories updated within the last N days, limited to M results. */
  getRecentMemories(days: number, limit: number): Promise<Memory[]>;

  // ─── Observation ─────────────────────────────────────────────────────────────

  /** Store a new observation, returns its ID. */
  putObservation(obs: Omit<Observation, 'id'>): Promise<string>;

  /** Get unprocessed observations (for dream consolidation). */
  getUnprocessedObservations(limit: number): Promise<Observation[]>;

  /** Mark an observation as processed. */
  markObservationProcessed(id: string): Promise<void>;

  // ─── Edge ────────────────────────────────────────────────────────────────────

  /** Store a new edge, returns its ID. */
  putEdge(edge: Omit<Edge, 'id'>): Promise<string>;

  /** Get all edges originating from a memory. */
  getEdgesFrom(memoryId: string): Promise<Edge[]>;

  /** Get all edges (both directions) for a set of memory IDs. */
  getEdgesForMemories(memoryIds: string[]): Promise<Edge[]>;

  // ─── Ops ─────────────────────────────────────────────────────────────────────

  /** Append an ops entry, returns its ID. */
  appendOps(entry: Omit<OpsEntry, 'id'>): Promise<string>;

  /** Query ops entries with composable filters. */
  queryOps(filters: OpsFilters): Promise<OpsEntry[]>;

  /** Update an ops entry (e.g., mark as done). */
  updateOps(id: string, updates: Partial<Omit<OpsEntry, 'id'>>): Promise<void>;

  // ─── Signal ──────────────────────────────────────────────────────────────────

  /** Store a signal, returns its ID. */
  putSignal(signal: Omit<Signal, 'id'>): Promise<string>;

  // ─── Belief ──────────────────────────────────────────────────────────────────

  /** Log a belief change. */
  putBelief(entry: Omit<BeliefEntry, 'id'>): Promise<string>;

  /** Get belief history for a concept. */
  getBeliefHistory(conceptId: string): Promise<BeliefEntry[]>;

  // ─── Generic ─────────────────────────────────────────────────────────────────

  /** Store a document in a named collection. Returns its ID. */
  put(collection: string, doc: Record<string, unknown>): Promise<string>;

  /** Get a document from a named collection by ID. */
  get(collection: string, id: string): Promise<Record<string, unknown> | null>;

  /**
   * Update a document in a named collection by ID. Merges updates.
   * Throws `Error("Document not found: ${collection}/${id}")` if the
   * document does not exist — both SQLite and Firestore backends honour
   * this contract.
   */
  update(collection: string, id: string, updates: Record<string, unknown>): Promise<void>;

  /** Query documents from a named collection with filters. */
  query(
    collection: string,
    filters: QueryFilter[],
    options?: { limit?: number; orderBy?: string; orderDir?: 'asc' | 'desc' }
  ): Promise<Record<string, unknown>[]>;

  /** Count documents in a named collection, optionally filtered. */
  countDocuments(collection: string, filters?: QueryFilter[]): Promise<number>;

  /** Delete a document from a named collection by ID. */
  delete(collection: string, id: string): Promise<void>;

  // ─── Transactions ────────────────────────────────────────────────────────────

  /**
   * Run `fn` inside a backend-native transaction. All writes commit atomically
   * on resolve; any thrown error rolls back. The proxy passed to `fn` is the
   * same store instance — call store methods on it normally.
   *
   * SQLite constraint: the body of `fn` MUST NOT await external systems
   * (LLM calls, network). Store operations themselves are safe because
   * better-sqlite3 is synchronous under the async wrapper.
   *
   * See docs/concurrency.md for the full contract.
   */
  withTransaction<T>(fn: (txn: CortexStore) => Promise<T>): Promise<T>;

  // ─── Upsert (ID-preserving) ─────────────────────────────────────────────────
  // Used by store-migration tooling. Unlike put*() which mints UUIDs, these
  // preserve the provided ID so links and references survive cloning.

  /** Insert or replace a memory by its existing ID. */
  upsertMemory(memory: Memory): Promise<void>;

  /** Insert or replace an observation by its existing ID. */
  upsertObservation(obs: Observation): Promise<void>;

  /** Insert or replace an edge by its existing ID. */
  upsertEdge(edge: Edge): Promise<void>;

  /** Insert or replace an ops entry by its existing ID. */
  upsertOpsEntry(entry: OpsEntry): Promise<void>;

  /** Insert or replace a signal by its existing ID. */
  upsertSignal(signal: Signal): Promise<void>;

  /** Insert or replace a belief entry by its existing ID. */
  upsertBelief(belief: BeliefEntry): Promise<void>;

  // ─── Capabilities ───────────────────────────────────────────────────────────

  /**
   * Return a snapshot of store metadata used by the migration tool to detect
   * incompatible source/destination pairs before mutating data.
   */
  getCapabilities(): Promise<StoreCapabilities>;
}
