/**
 * JsonCortexStore — file-backed CortexStore implementation.
 *
 * Loads on construct, holds the entire dataset in memory, persists on every
 * write (atomic via temp-file + rename). Intended for backup, restore, and
 * the round-trip migration tests — not production scale.
 *
 * Vector search is the same brute-force cosine as SqliteCortexStore.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CortexStore, StoreCapabilities } from '../core/store.js';
import { CORTEX_STORE_SCHEMA_VERSION } from '../core/store.js';
import { validateNamespace } from './_validate.js';
import { lexicalSearch } from './_lexical.js';
import type {
  Memory,
  MemorySummary,
  Observation,
  Edge,
  OpsEntry,
  OpsFilters,
  Signal,
  SignalFilters,
  BeliefEntry,
  SearchResult,
  FSRSData,
  QueryFilter,
} from '../core/types.js';

// ─── On-disk schema ───────────────────────────────────────────────────────────

interface JsonStoreData {
  schemaVersion: number;
  namespace: string;
  memories: Record<string, Memory>;
  observations: Record<string, Observation>;
  edges: Record<string, Edge>;
  ops: Record<string, OpsEntry>;
  signals: Record<string, Signal>;
  beliefs: Record<string, BeliefEntry>;
  generic: Record<string, Record<string, Record<string, unknown>>>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `Embedding dimension mismatch: query has ${a.length} dims but stored has ${b.length} dims. ` +
      `Check that your embed provider matches the dimensions used when memories were stored.`,
    );
  }
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

/** JSON.parse reviver that turns ISO-8601 strings back into Date objects. */
function reviveDates(_key: string, value: unknown): unknown {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    return new Date(value);
  }
  return value;
}

function freshData(namespace: string): JsonStoreData {
  return {
    schemaVersion: CORTEX_STORE_SCHEMA_VERSION,
    namespace,
    memories: {},
    observations: {},
    edges: {},
    ops: {},
    signals: {},
    beliefs: {},
    generic: {},
  };
}

/** Convert a legacy generic-collection signal doc into a Signal. */
function genericDocToSignal(doc: Record<string, unknown>): Signal {
  const toDateSafe = (v: unknown): Date =>
    v instanceof Date ? v : typeof v === 'string' ? new Date(v) : new Date(0);
  return {
    id: String(doc.id ?? ''),
    type: doc.type as Signal['type'],
    description: typeof doc.description === 'string' ? doc.description : '',
    concept_ids: Array.isArray(doc.concept_ids) ? doc.concept_ids.map(String) : [],
    priority: typeof doc.priority === 'number' ? doc.priority : 0.5,
    resolved: doc.resolved === true,
    created_at: toDateSafe(doc.created_at),
    resolution_note: typeof doc.resolution_note === 'string' ? doc.resolution_note : null,
    resolved_at: doc.resolved_at == null ? null : toDateSafe(doc.resolved_at),
    observation_id: typeof doc.observation_id === 'string' ? doc.observation_id : undefined,
  };
}

function toMemorySummary(m: Memory): MemorySummary {
  return {
    id: m.id,
    name: m.name,
    definition: m.definition,
    category: m.category,
    salience: m.salience,
    confidence: m.confidence,
    access_count: m.access_count,
    updated_at: m.updated_at,
    tags: m.tags,
    fsrs: m.fsrs,
    provenance: m.provenance,
  };
}

/** Deep clone via JSON round-trip; restores Date objects on the way out. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value), reviveDates) as T;
}

// ─── JsonCortexStore ──────────────────────────────────────────────────────────

export class JsonCortexStore implements CortexStore {
  private readonly path: string;
  private readonly ns: string;
  private data: JsonStoreData;

  constructor(filePath: string, namespace?: string) {
    validateNamespace(namespace);
    this.path = resolve(filePath);
    this.ns = namespace ?? '';
    this.data = this.load();
  }

  // ─── Persistence ───────────────────────────────────────────────────────────

  private load(): JsonStoreData {
    if (!existsSync(this.path)) {
      const data = freshData(this.ns);
      this.persistRaw(data);
      return data;
    }
    const raw = readFileSync(this.path, 'utf-8');
    if (!raw.trim()) return freshData(this.ns);
    const parsed = JSON.parse(raw, reviveDates) as Partial<JsonStoreData>;
    return {
      schemaVersion: parsed.schemaVersion ?? CORTEX_STORE_SCHEMA_VERSION,
      namespace: parsed.namespace ?? this.ns,
      memories: parsed.memories ?? {},
      observations: parsed.observations ?? {},
      edges: parsed.edges ?? {},
      ops: parsed.ops ?? {},
      signals: parsed.signals ?? {},
      beliefs: parsed.beliefs ?? {},
      generic: parsed.generic ?? {},
    };
  }

  /** Atomic write: serialize → write to temp → rename over the target. */
  private persistRaw(data: JsonStoreData): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    try {
      renameSync(tmp, this.path);
    } catch (err) {
      try { unlinkSync(tmp); } catch { /* best effort */ }
      throw err;
    }
  }

  private persist(): void {
    this.persistRaw(this.data);
  }

  // ─── Memory ────────────────────────────────────────────────────────────────

  async putMemory(memory: Omit<Memory, 'id'>): Promise<string> {
    const id = randomUUID();
    const full: Memory = { ...clone(memory), id };
    this.data.memories[id] = full;
    this.persist();
    return id;
  }

  async getMemory(id: string): Promise<Memory | null> {
    const m = this.data.memories[id];
    return m ? clone(m) : null;
  }

  async updateMemory(id: string, updates: Partial<Omit<Memory, 'id'>>): Promise<void> {
    const existing = this.data.memories[id];
    if (!existing) return;
    this.data.memories[id] = { ...existing, ...clone(updates), id };
    this.persist();
  }

  async findNearest(embedding: number[], limit: number): Promise<SearchResult[]> {
    return Object.values(this.data.memories)
      .filter(m => !m.faded && m.embedding && m.embedding.length > 0)
      .map(m => {
        const score = cosineSimilarity(embedding, m.embedding);
        return { memory: toMemorySummary(clone(m)), score, distance: 1 - score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async searchText(text: string, limit: number): Promise<SearchResult[]> {
    return lexicalSearch(Object.values(this.data.memories).map(m => clone(m)), text, limit);
  }

  async touchMemory(id: string, fsrsUpdates: Partial<FSRSData>): Promise<void> {
    const m = this.data.memories[id];
    if (!m) return;
    const now = new Date();
    m.access_count += 1;
    m.last_accessed = now;
    m.updated_at = now;
    m.fsrs = { ...m.fsrs, ...fsrsUpdates };
    this.persist();
  }

  async getAllMemories(): Promise<Memory[]> {
    return Object.values(this.data.memories).map(m => clone(m));
  }

  async getRecentMemories(days: number, limit: number): Promise<Memory[]> {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return Object.values(this.data.memories)
      .filter(m => m.updated_at.getTime() >= cutoff)
      .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime())
      .slice(0, limit)
      .map(m => clone(m));
  }

  // ─── Observation ───────────────────────────────────────────────────────────

  async putObservation(obs: Omit<Observation, 'id'>): Promise<string> {
    const id = randomUUID();
    const full: Observation = { ...clone(obs), id };
    this.data.observations[id] = full;
    this.persist();
    return id;
  }

  async getUnprocessedObservations(limit: number): Promise<Observation[]> {
    return Object.values(this.data.observations)
      .filter(o => !o.processed)
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
      .slice(0, limit)
      .map(o => clone(o));
  }

  async markObservationProcessed(id: string): Promise<void> {
    const obs = this.data.observations[id];
    if (!obs) return;
    obs.processed = true;
    obs.updated_at = new Date();
    this.persist();
  }

  // ─── Edge ──────────────────────────────────────────────────────────────────

  async putEdge(edge: Omit<Edge, 'id'>): Promise<string> {
    const id = randomUUID();
    const full: Edge = { ...clone(edge), id };
    this.data.edges[id] = full;
    this.persist();
    return id;
  }

  async getEdgesFrom(memoryId: string): Promise<Edge[]> {
    return Object.values(this.data.edges)
      .filter(e => e.source_id === memoryId)
      .map(e => clone(e));
  }

  async getEdgesForMemories(memoryIds: string[]): Promise<Edge[]> {
    if (memoryIds.length === 0) return [];
    const set = new Set(memoryIds);
    return Object.values(this.data.edges)
      .filter(e => set.has(e.source_id) || set.has(e.target_id))
      .map(e => clone(e));
  }

  // ─── Ops ───────────────────────────────────────────────────────────────────

  async appendOps(entry: Omit<OpsEntry, 'id'>): Promise<string> {
    const id = randomUUID();
    const full: OpsEntry = { ...clone(entry), id };
    this.data.ops[id] = full;
    this.persist();
    return id;
  }

  async queryOps(filters: OpsFilters): Promise<OpsEntry[]> {
    let entries = Object.values(this.data.ops);

    if (filters.type) entries = entries.filter(e => e.type === filters.type);
    if (filters.status) entries = entries.filter(e => e.status === filters.status);
    if (filters.project) entries = entries.filter(e => e.project === filters.project);
    if (filters.keyword) {
      const needle = filters.keyword.toLowerCase();
      entries = entries.filter(e =>
        e.content.toLowerCase().includes(needle) ||
        e.keywords.some(k => k.toLowerCase().includes(needle)),
      );
    }
    if (filters.days) {
      const cutoff = Date.now() - filters.days * 86400_000;
      entries = entries.filter(e => e.created_at.getTime() >= cutoff);
    }

    entries.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
    if (filters.limit) entries = entries.slice(0, filters.limit);
    return entries.map(e => clone(e));
  }

  async updateOps(id: string, updates: Partial<Omit<OpsEntry, 'id'>>): Promise<void> {
    const existing = this.data.ops[id];
    if (!existing) return;
    this.data.ops[id] = { ...existing, ...clone(updates), id, updated_at: new Date() };
    this.persist();
  }

  // ─── Signal ────────────────────────────────────────────────────────────────

  async putSignal(signal: Omit<Signal, 'id'>): Promise<string> {
    const id = randomUUID();
    const full: Signal = { ...clone(signal), id };
    this.data.signals[id] = full;
    this.persist();
    return id;
  }

  async getSignal(id: string): Promise<Signal | null> {
    const signal = this.data.signals[id];
    if (signal) return clone(signal);
    // Legacy: signals written through the generic collection API.
    const legacy = this.data.generic['signals']?.[id];
    return legacy ? genericDocToSignal(clone(legacy)) : null;
  }

  async getSignals(filters: SignalFilters = {}): Promise<Signal[]> {
    const signals = Object.values(this.data.signals).map(s => clone(s));

    // Merge legacy generic signals (dedup by id, first-class map wins).
    const seen = new Set(signals.map(s => s.id));
    for (const doc of Object.values(this.data.generic['signals'] ?? {})) {
      const signal = genericDocToSignal(clone(doc));
      if (!signal.id || seen.has(signal.id)) continue;
      signals.push(signal);
    }

    const filtered = signals.filter(s =>
      (filters.resolved === undefined || s.resolved === filters.resolved) &&
      (filters.type === undefined || s.type === filters.type));
    filtered.sort((a, b) =>
      b.priority - a.priority || b.created_at.getTime() - a.created_at.getTime());
    return filters.limit !== undefined ? filtered.slice(0, filters.limit) : filtered;
  }

  async updateSignal(id: string, updates: Partial<Omit<Signal, 'id'>>): Promise<void> {
    const existing = this.data.signals[id];
    if (existing) {
      this.data.signals[id] = { ...existing, ...clone(updates), id };
      this.persist();
      return;
    }
    // Legacy generic signal.
    await this.update('signals', id, clone(updates) as Record<string, unknown>);
  }

  // ─── Belief ────────────────────────────────────────────────────────────────

  async putBelief(entry: Omit<BeliefEntry, 'id'>): Promise<string> {
    const id = randomUUID();
    const full: BeliefEntry = { ...clone(entry), id };
    this.data.beliefs[id] = full;
    this.persist();
    return id;
  }

  async getBeliefHistory(conceptId: string): Promise<BeliefEntry[]> {
    return Object.values(this.data.beliefs)
      .filter(b => b.concept_id === conceptId)
      .sort((a, b) => a.changed_at.getTime() - b.changed_at.getTime())
      .map(b => clone(b));
  }

  // ─── Generic ───────────────────────────────────────────────────────────────

  async put(collection: string, doc: Record<string, unknown>): Promise<string> {
    const id = (doc['id'] as string) ?? randomUUID();
    if (!this.data.generic[collection]) this.data.generic[collection] = {};
    this.data.generic[collection][id] = { ...clone(doc), id };
    this.persist();
    return id;
  }

  async get(collection: string, id: string): Promise<Record<string, unknown> | null> {
    const doc = this.data.generic[collection]?.[id];
    return doc ? clone(doc) : null;
  }

  async update(collection: string, id: string, updates: Record<string, unknown>): Promise<void> {
    const existing = this.data.generic[collection]?.[id];
    if (!existing) throw new Error(`Document not found: ${collection}/${id}`);
    this.data.generic[collection][id] = { ...existing, ...clone(updates), id };
    this.persist();
  }

  async query(
    collection: string,
    filters: QueryFilter[],
    options?: { limit?: number; orderBy?: string; orderDir?: 'asc' | 'desc' },
  ): Promise<Record<string, unknown>[]> {
    const all = this.data.generic[collection] ? Object.values(this.data.generic[collection]) : [];
    let docs = all.map(d => clone(d));

    for (const f of filters) {
      docs = docs.filter(doc => {
        const v = doc[f.field];
        switch (f.op) {
          case '==': return v === f.value;
          case '!=': return v !== f.value;
          case '<': return typeof v === 'number' && typeof f.value === 'number' && v < f.value;
          case '<=': return typeof v === 'number' && typeof f.value === 'number' && v <= f.value;
          case '>': return typeof v === 'number' && typeof f.value === 'number' && v > f.value;
          case '>=': return typeof v === 'number' && typeof f.value === 'number' && v >= f.value;
          case 'in': return Array.isArray(f.value) && (f.value as unknown[]).includes(v);
          case 'array-contains': return Array.isArray(v) && (v as unknown[]).includes(f.value);
          default: return true;
        }
      });
    }

    if (options?.orderBy) {
      const field = options.orderBy;
      const dir = options.orderDir === 'desc' ? -1 : 1;
      docs.sort((a, b) => {
        const av = a[field], bv = b[field];
        if (av === bv) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        return av < bv ? -dir : dir;
      });
    }

    return options?.limit ? docs.slice(0, options.limit) : docs;
  }

  async countDocuments(collection: string, filters?: QueryFilter[]): Promise<number> {
    if (!filters || filters.length === 0) {
      return Object.keys(this.data.generic[collection] ?? {}).length;
    }
    const docs = await this.query(collection, filters);
    return docs.length;
  }

  async delete(collection: string, id: string): Promise<void> {
    if (this.data.generic[collection]?.[id]) {
      delete this.data.generic[collection][id];
      this.persist();
    }
  }

  // ─── Transactions ──────────────────────────────────────────────────────────
  // JSON store holds everything in memory; an atomic txn = snapshot the data,
  // run the body, and either persist the new snapshot on success or restore on
  // throw. Since reads/writes are synchronous against this.data, the body sees
  // mutations as it makes them.

  async withTransaction<T>(fn: (txn: CortexStore) => Promise<T>): Promise<T> {
    const snapshot = clone(this.data);
    try {
      const result = await fn(this);
      this.persist();
      return result;
    } catch (err) {
      // Restore in-memory state. No persist() needed — disk still holds
      // the pre-transaction snapshot because we only persist after fn
      // resolves successfully.
      this.data = snapshot;
      throw err;
    }
  }

  // ─── Upserts (ID-preserving) ───────────────────────────────────────────────

  async upsertMemory(memory: Memory): Promise<void> {
    this.data.memories[memory.id] = clone(memory);
    this.persist();
  }

  async upsertObservation(obs: Observation): Promise<void> {
    this.data.observations[obs.id] = clone(obs);
    this.persist();
  }

  async upsertEdge(edge: Edge): Promise<void> {
    this.data.edges[edge.id] = clone(edge);
    this.persist();
  }

  async upsertOpsEntry(entry: OpsEntry): Promise<void> {
    this.data.ops[entry.id] = clone(entry);
    this.persist();
  }

  async upsertSignal(signal: Signal): Promise<void> {
    this.data.signals[signal.id] = clone(signal);
    this.persist();
  }

  async upsertBelief(belief: BeliefEntry): Promise<void> {
    this.data.beliefs[belief.id] = clone(belief);
    this.persist();
  }

  // ─── Capabilities ─────────────────────────────────────────────────────────

  async getCapabilities(): Promise<StoreCapabilities> {
    const memories = Object.values(this.data.memories);
    const first = memories.find(m => m.embedding && m.embedding.length > 0);
    const embeddingDimension = first ? first.embedding.length : 0;
    const categories = [...new Set(memories.map(m => m.category as string))];

    return {
      schemaVersion: this.data.schemaVersion,
      embeddingDimension,
      categories,
      namespace: this.ns,
      backend: 'json',
    };
  }

  // ─── Migration helpers ─────────────────────────────────────────────────────
  // Used by migrate-cmd to iterate every entity in a stage without going
  // through the read-shaped API (which has filter-only or per-key access for
  // signals/beliefs/observations).

  /** Snapshot all entities of a given kind. The returned arrays are deep clones. */
  listAllSignals(): Signal[] {
    return Object.values(this.data.signals).map(s => clone(s));
  }

  listAllBeliefs(): BeliefEntry[] {
    return Object.values(this.data.beliefs).map(b => clone(b));
  }

  listAllObservations(): Observation[] {
    return Object.values(this.data.observations).map(o => clone(o));
  }

  listAllEdges(): Edge[] {
    return Object.values(this.data.edges).map(e => clone(e));
  }

  listAllOps(): OpsEntry[] {
    return Object.values(this.data.ops).map(o => clone(o));
  }

  /** Returns `{ collection: { id: doc } }` snapshot of the generic bucket. */
  snapshotGeneric(): Record<string, Record<string, Record<string, unknown>>> {
    return clone(this.data.generic);
  }
}
