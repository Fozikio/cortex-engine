/**
 * migrate-cmd.ts — one-way clone between two CortexStore backends.
 *
 * Implements `fozikio migrate --from <url> --to <url> [options]`. Backed by
 * the spec at docs/superpowers/specs/2026-05-16-store-migration-design.md.
 *
 * The CortexStore interface intentionally exposes only the access patterns
 * that engines need at runtime — there is no "list all signals" or
 * "list all generic collections" method, because no engine code wants those.
 * Migration is the one caller that does, so we reach into the concrete store
 * classes (SQLite, JSON, Firestore) for iteration. That is a deliberate trade
 * to keep the public interface lean.
 */

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { CortexStore } from '../core/store.js';
import { SqliteCortexStore } from '../stores/sqlite.js';
import { JsonCortexStore } from '../stores/json.js';
import { createStoreFromUrl } from './store-url.js';
import type {
  Memory,
  Observation,
  Edge,
  OpsEntry,
  Signal,
  BeliefEntry,
} from '../core/types.js';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface MigrateOptions {
  from: string;
  to: string;
  /** Only migrate this namespace (currently informational — the URL controls namespace). */
  namespace?: string;
  /** Rewrite the source namespace to a different destination namespace string in entity data. */
  renameNamespace?: { src: string; dst: string };
  /** Resume from .cortex-migrate-state.json instead of starting fresh. */
  resume?: boolean;
  /** After migration, sample-diff source vs destination. */
  verify?: boolean;
  /** Read source + validate compatibility, do not write anything. */
  dryRun?: boolean;
  /** Allow migrating into a destination that already has data. */
  allowMerge?: boolean;
  /** Items per checkpoint flush (default 100). */
  batchSize?: number;
  /** Override the checkpoint file path (default ./.cortex-migrate-state.json). */
  checkpointPath?: string;
  /** Stream progress messages somewhere other than stderr. */
  logger?: (line: string) => void;
}

export type MigrationStage =
  | 'memories'
  | 'observations'
  | 'edges'
  | 'ops'
  | 'signals'
  | 'beliefs'
  | 'generic';

export const MIGRATION_STAGES: readonly MigrationStage[] = [
  'memories', 'observations', 'edges', 'ops', 'signals', 'beliefs', 'generic',
] as const;

interface Checkpoint {
  startedAt: string;
  srcUrl: string;
  dstUrl: string;
  /** Per stage: 'done' once finished, or the last id processed mid-stage, or null when untouched. */
  memories: string | null;
  observations: string | null;
  edges: string | null;
  ops: string | null;
  signals: string | null;
  beliefs: string | null;
  generic: string | null;
}

export interface VerifyReport {
  ok: boolean;
  perKind: Record<MigrationStage, {
    srcCount: number;
    dstCount: number;
    sampleMismatches: { id: string; reason: string }[];
  }>;
}

const DEFAULT_CHECKPOINT_PATH = '.cortex-migrate-state.json';
const DEFAULT_BATCH_SIZE = 100;

// ─── Entry point ──────────────────────────────────────────────────────────────

export async function migrate(opts: MigrateOptions): Promise<void> {
  const log = opts.logger ?? ((line: string) => process.stderr.write(line + '\n'));
  const checkpointPath = resolve(opts.checkpointPath ?? DEFAULT_CHECKPOINT_PATH);
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;

  const src = await createStoreFromUrl(opts.from);
  const dst = await createStoreFromUrl(opts.to);

  await assertCompatibility(src, dst, { allowMerge: opts.allowMerge ?? false });

  if (opts.dryRun) {
    log(`[migrate] dry-run: compatibility OK (${opts.from} -> ${opts.to})`);
    return;
  }

  const fresh: Checkpoint = {
    startedAt: new Date().toISOString(),
    srcUrl: opts.from,
    dstUrl: opts.to,
    memories: null,
    observations: null,
    edges: null,
    ops: null,
    signals: null,
    beliefs: null,
    generic: null,
  };

  const checkpoint = opts.resume
    ? (loadCheckpoint(checkpointPath) ?? fresh)
    : fresh;

  if (opts.resume && checkpoint.srcUrl !== opts.from) {
    throw new Error(
      `Checkpoint at ${checkpointPath} was started against srcUrl=${checkpoint.srcUrl}, ` +
      `but --from is ${opts.from}. Refusing to resume against a different source.`,
    );
  }
  if (opts.resume && checkpoint.dstUrl !== opts.to) {
    throw new Error(
      `Checkpoint at ${checkpointPath} was started against dstUrl=${checkpoint.dstUrl}, ` +
      `but --to is ${opts.to}. Refusing to resume against a different destination.`,
    );
  }

  for (const stage of MIGRATION_STAGES) {
    if (checkpoint[stage] === 'done') {
      log(`[migrate] skip ${stage} (already done)`);
      continue;
    }
    await migrateStage(src, dst, stage, checkpoint, {
      batchSize,
      checkpointPath,
      renameNamespace: opts.renameNamespace,
      log,
    });
    checkpoint[stage] = 'done';
    saveCheckpoint(checkpointPath, checkpoint);
  }

  if (opts.verify) {
    const report = await verifyMigration(src, dst);
    if (!report.ok) {
      const failed = Object.entries(report.perKind)
        .filter(([, v]) => v.srcCount !== v.dstCount || v.sampleMismatches.length > 0)
        .map(([k, v]) => `${k}: src=${v.srcCount} dst=${v.dstCount} mismatches=${v.sampleMismatches.length}`)
        .join('; ');
      log(`[migrate] verification FAILED: ${failed}`);
      throw new Error(`Verification failed: ${failed}`);
    }
    log('[migrate] verification OK');
  }

  if (existsSync(checkpointPath)) {
    try { unlinkSync(checkpointPath); } catch { /* best effort */ }
  }
  log('[migrate] done');
}

// ─── Compatibility ────────────────────────────────────────────────────────────

export async function assertCompatibility(
  src: CortexStore,
  dst: CortexStore,
  opts: { allowMerge: boolean },
): Promise<void> {
  const [srcCaps, dstCaps] = await Promise.all([src.getCapabilities(), dst.getCapabilities()]);

  if (srcCaps.schemaVersion !== dstCaps.schemaVersion) {
    throw new Error(
      `Schema version mismatch: src=${srcCaps.schemaVersion} dst=${dstCaps.schemaVersion}. ` +
      `Cannot migrate between incompatible store versions.`,
    );
  }

  if (
    srcCaps.embeddingDimension !== 0 &&
    dstCaps.embeddingDimension !== 0 &&
    srcCaps.embeddingDimension !== dstCaps.embeddingDimension
  ) {
    throw new Error(
      `Embedding dimension mismatch: src=${srcCaps.embeddingDimension} dst=${dstCaps.embeddingDimension}. ` +
      `Migrated embeddings would be unsearchable in the destination.`,
    );
  }

  if (!opts.allowMerge && (await dstHasData(dst))) {
    throw new Error(
      `Destination ${dstCaps.backend} store is not empty. Pass --allow-merge to migrate into a populated store.`,
    );
  }
}

async function dstHasData(dst: CortexStore): Promise<boolean> {
  // These two use the public interface and work for any backend.
  const memories = await dst.getAllMemories();
  if (memories.length > 0) return true;
  const ops = await dst.queryOps({ limit: 1 });
  if (ops.length > 0) return true;

  // The remaining checks rely on instanceof-narrowed adapters that throw
  // for backends without iteration support (today: Firestore). If we can't
  // inspect them, fall back to the memories+ops emptiness signal — the
  // operator can still pass --allow-merge to force the migration.
  try {
    const obs = listAllObservations(dst);
    if (obs.length > 0) return true;
    const edges = listAllEdges(dst);
    if (edges.length > 0) return true;
    const signals = listAllSignals(dst);
    if (signals.length > 0) return true;
    const beliefs = listAllBeliefs(dst);
    if (beliefs.length > 0) return true;
    const generic = snapshotGeneric(dst);
    for (const coll of Object.keys(generic)) {
      if (Object.keys(generic[coll]).length > 0) return true;
    }
  } catch {
    process.stderr.write(
      `[migrate] Destination backend ${dst.constructor.name} does not support pre-flight emptiness check ` +
      `for observations/edges/signals/beliefs/generic. Memories + ops looked empty; proceeding. ` +
      `Pass --allow-merge if you know the destination has data in unchecked tables.\n`,
    );
  }
  return false;
}

// ─── Stage runner ─────────────────────────────────────────────────────────────

interface StageContext {
  batchSize: number;
  checkpointPath: string;
  renameNamespace?: { src: string; dst: string };
  log: (line: string) => void;
}

async function migrateStage(
  src: CortexStore,
  dst: CortexStore,
  stage: MigrationStage,
  checkpoint: Checkpoint,
  ctx: StageContext,
): Promise<void> {
  const lastId = checkpoint[stage] && checkpoint[stage] !== 'done' ? checkpoint[stage] : null;

  switch (stage) {
    case 'memories': {
      const items = await src.getAllMemories();
      await runBatched(items, lastId, ctx, stage, checkpoint, async m => dst.upsertMemory(m));
      return;
    }
    case 'observations': {
      const items = listAllObservations(src);
      await runBatched(items, lastId, ctx, stage, checkpoint, async o => dst.upsertObservation(o));
      return;
    }
    case 'edges': {
      const items = listAllEdges(src);
      await runBatched(items, lastId, ctx, stage, checkpoint, async e => dst.upsertEdge(e));
      return;
    }
    case 'ops': {
      const items = listAllOps(src);
      await runBatched(items, lastId, ctx, stage, checkpoint, async o => dst.upsertOpsEntry(o));
      return;
    }
    case 'signals': {
      const items = listAllSignals(src);
      await runBatched(items, lastId, ctx, stage, checkpoint, async s => dst.upsertSignal(s));
      return;
    }
    case 'beliefs': {
      const items = listAllBeliefs(src);
      await runBatched(items, lastId, ctx, stage, checkpoint, async b => dst.upsertBelief(b));
      return;
    }
    case 'generic': {
      const generic = snapshotGeneric(src);
      // generic has no "last id" semantics that bridge collections, so resume
      // collapses to all-or-nothing for this stage.
      let count = 0;
      for (const [collection, docs] of Object.entries(generic)) {
        for (const [id, doc] of Object.entries(docs)) {
          await dst.put(collection, { ...doc, id });
          count += 1;
          if (count % ctx.batchSize === 0) {
            checkpoint.generic = id;
            saveCheckpoint(ctx.checkpointPath, checkpoint);
          }
        }
      }
      ctx.log(`[migrate] generic: copied ${count} docs`);
      return;
    }
    default: {
      // Exhaustiveness fence — TS will flag a new stage that doesn't land in a case.
      const exhaustive: never = stage;
      throw new Error(`Unhandled migration stage: ${String(exhaustive)}`);
    }
  }
}

async function runBatched<T extends { id: string }>(
  items: T[],
  lastId: string | null,
  ctx: StageContext,
  stage: MigrationStage,
  checkpoint: Checkpoint,
  upsert: (item: T) => Promise<void>,
): Promise<void> {
  let skipping = lastId !== null;
  let count = 0;

  for (const item of items) {
    if (skipping) {
      if (item.id === lastId) skipping = false;
      continue;
    }
    const renamed = applyNamespaceRename(item, stage, ctx.renameNamespace);
    await upsert(renamed as T);
    count += 1;
    if (count % ctx.batchSize === 0) {
      checkpoint[stage] = item.id;
      saveCheckpoint(ctx.checkpointPath, checkpoint);
    }
  }

  ctx.log(`[migrate] ${stage}: copied ${count}`);
}

// ─── Iteration adapters ───────────────────────────────────────────────────────
// CortexStore exposes per-entity reads that are good enough for engines but
// not exhaustive. These adapters reach into the concrete classes so migration
// can see everything.

function listAllObservations(store: CortexStore): Observation[] {
  if (store instanceof JsonCortexStore) return store.listAllObservations();
  if (store instanceof SqliteCortexStore) return readAllFromSqlite<Observation>(store, 'observations');
  throw unsupported(store, 'observations');
}

function listAllEdges(store: CortexStore): Edge[] {
  if (store instanceof JsonCortexStore) return store.listAllEdges();
  if (store instanceof SqliteCortexStore) return readAllFromSqlite<Edge>(store, 'edges');
  throw unsupported(store, 'edges');
}

function listAllOps(store: CortexStore): OpsEntry[] {
  if (store instanceof JsonCortexStore) return store.listAllOps();
  if (store instanceof SqliteCortexStore) return readAllFromSqlite<OpsEntry>(store, 'ops');
  throw unsupported(store, 'ops');
}

function listAllSignals(store: CortexStore): Signal[] {
  if (store instanceof JsonCortexStore) return store.listAllSignals();
  if (store instanceof SqliteCortexStore) return readAllFromSqlite<Signal>(store, 'signals');
  throw unsupported(store, 'signals');
}

function listAllBeliefs(store: CortexStore): BeliefEntry[] {
  if (store instanceof JsonCortexStore) return store.listAllBeliefs();
  if (store instanceof SqliteCortexStore) return readAllFromSqlite<BeliefEntry>(store, 'beliefs');
  throw unsupported(store, 'beliefs');
}

function snapshotGeneric(store: CortexStore): Record<string, Record<string, Record<string, unknown>>> {
  if (store instanceof JsonCortexStore) return store.snapshotGeneric();
  if (store instanceof SqliteCortexStore) return readGenericFromSqlite(store);
  throw unsupported(store, 'generic');
}

function unsupported(store: CortexStore, kind: string): Error {
  return new Error(
    `Migration of ${kind} is not implemented for store class ${store.constructor.name}. ` +
    `Only SqliteCortexStore and JsonCortexStore are currently supported as src/dst.`,
  );
}

interface SqliteInternals {
  db: DatabaseType;
  ns: string;
  t(name: string): string;
}

function sqliteInternals(store: SqliteCortexStore): SqliteInternals {
  return store as unknown as SqliteInternals;
}

function readAllFromSqlite<T>(store: SqliteCortexStore, table: string): T[] {
  const internals = sqliteInternals(store);
  const tableName = internals.t(table);
  const rows = internals.db.prepare(`SELECT * FROM ${tableName}`).all() as Record<string, unknown>[];

  switch (table) {
    case 'observations': return rows.map(rowToObservation) as unknown as T[];
    case 'edges': return rows.map(rowToEdge) as unknown as T[];
    case 'ops': return rows.map(rowToOps) as unknown as T[];
    case 'signals': return rows.map(rowToSignal) as unknown as T[];
    case 'beliefs': return rows.map(rowToBelief) as unknown as T[];
    default: throw new Error(`unknown sqlite table for iteration: ${table}`);
  }
}

function readGenericFromSqlite(store: SqliteCortexStore): Record<string, Record<string, Record<string, unknown>>> {
  const internals = sqliteInternals(store);
  const tableName = internals.t('generic_docs');
  const rows = internals.db.prepare(`SELECT collection, id, data FROM ${tableName}`).all() as { collection: string; id: string; data: string }[];

  const out: Record<string, Record<string, Record<string, unknown>>> = {};
  for (const row of rows) {
    if (!out[row.collection]) out[row.collection] = {};
    try {
      out[row.collection][row.id] = JSON.parse(row.data) as Record<string, unknown>;
    } catch {
      out[row.collection][row.id] = { id: row.id };
    }
  }
  return out;
}

// ─── SQLite row → entity (mirrors sqlite.ts converters, but inline so we
// don't depend on private exports from there) ─────────────────────────────────

function toDate(s: unknown): Date {
  if (!s) return new Date();
  return s instanceof Date ? s : new Date(String(s));
}

function toDateOrNull(s: unknown): Date | null {
  if (s === null || s === undefined) return null;
  return toDate(s);
}

function parseJSON<T>(s: unknown, fallback: T): T {
  if (typeof s !== 'string' || !s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

function parseEmbedding(data: unknown): number[] {
  if (!data) return [];
  if (Buffer.isBuffer(data)) {
    return Array.from(new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4));
  }
  if (typeof data === 'string') {
    try { return JSON.parse(data) as number[]; } catch { return []; }
  }
  return [];
}

function rowProv(r: Record<string, unknown>): { model_id: string; model_family: string; client: string; agent: string } | undefined {
  const id = r.prov_model_id;
  if (!id) return undefined;
  return {
    model_id: String(id),
    model_family: String(r.prov_model_family ?? ''),
    client: String(r.prov_client ?? ''),
    agent: String(r.prov_agent ?? ''),
  };
}

function rowToObservation(r: Record<string, unknown>): Observation {
  return {
    id: String(r.id),
    content: String(r.content ?? ''),
    source_file: String(r.source_file ?? ''),
    source_section: String(r.source_section ?? ''),
    salience: Number(r.salience ?? 0),
    processed: r.processed === 1 || r.processed === true,
    prediction_error: r.prediction_error == null ? null : Number(r.prediction_error),
    created_at: toDate(r.created_at),
    updated_at: toDate(r.updated_at),
    embedding: r.embedding ? parseEmbedding(r.embedding) : null,
    keywords: parseJSON<string[]>(r.keywords, []),
    content_type: (r.content_type as Observation['content_type']) ?? 'declarative',
    provenance: rowProv(r),
  };
}

function rowToEdge(r: Record<string, unknown>): Edge {
  return {
    id: String(r.id),
    source_id: String(r.source_id),
    target_id: String(r.target_id),
    relation: r.relation as Edge['relation'],
    weight: Number(r.weight ?? 1),
    evidence: String(r.evidence ?? ''),
    created_at: toDate(r.created_at),
  };
}

function rowToOps(r: Record<string, unknown>): OpsEntry {
  return {
    id: String(r.id),
    content: String(r.content ?? ''),
    type: r.type as OpsEntry['type'],
    status: r.status as OpsEntry['status'],
    project: r.project == null ? null : String(r.project),
    session_ref: String(r.session_ref ?? ''),
    keywords: parseJSON<string[]>(r.keywords, []),
    created_at: toDate(r.created_at),
    updated_at: toDate(r.updated_at),
    expires_at: toDate(r.expires_at),
    provenance: rowProv(r),
  };
}

function rowToSignal(r: Record<string, unknown>): Signal {
  return {
    id: String(r.id),
    type: r.type as Signal['type'],
    description: String(r.description ?? ''),
    concept_ids: parseJSON<string[]>(r.concept_ids, []),
    priority: Number(r.priority ?? 0.5),
    resolved: r.resolved === 1 || r.resolved === true,
    created_at: toDate(r.created_at),
    resolution_note: r.resolution_note == null ? null : String(r.resolution_note),
  };
}

function rowToBelief(r: Record<string, unknown>): BeliefEntry {
  return {
    id: String(r.id),
    concept_id: String(r.concept_id),
    old_definition: String(r.old_definition ?? ''),
    new_definition: String(r.new_definition ?? ''),
    reason: String(r.reason ?? ''),
    changed_at: toDate(r.changed_at),
  };
}

// Memory iteration also needs a SQLite path for verification — getAllMemories
// covers it, but expose a SQLite-direct read so it stays consistent with the
// other stages in the future.
function rowToMemory(r: Record<string, unknown>): Memory {
  return {
    id: String(r.id),
    name: String(r.name ?? ''),
    definition: String(r.definition ?? ''),
    category: r.category as Memory['category'],
    salience: Number(r.salience ?? 0.5),
    confidence: Number(r.confidence ?? 0.5),
    access_count: Number(r.access_count ?? 0),
    created_at: toDate(r.created_at),
    updated_at: toDate(r.updated_at),
    last_accessed: toDate(r.last_accessed),
    source_files: parseJSON<string[]>(r.source_files, []),
    embedding: parseEmbedding(r.embedding),
    tags: parseJSON<string[]>(r.tags, []),
    fsrs: {
      stability: Number(r.fsrs_stability ?? 3.1262),
      difficulty: Number(r.fsrs_difficulty ?? 7.2102),
      reps: Number(r.fsrs_reps ?? 0),
      lapses: Number(r.fsrs_lapses ?? 0),
      state: (r.fsrs_state as Memory['fsrs']['state']) ?? 'new',
      last_review: toDateOrNull(r.fsrs_last_review),
    },
    faded: r.faded === 1 || r.faded === true,
    salience_original: r.salience_original == null ? undefined : Number(r.salience_original),
    provenance: rowProv(r),
  };
}

// ─── Namespace rename ─────────────────────────────────────────────────────────

function applyNamespaceRename<T>(
  item: T,
  stage: MigrationStage,
  rename: { src: string; dst: string } | undefined,
): T {
  if (!rename) return item;
  // The namespace lives in the store's bound prefix, not in the entity row.
  // The only places it can leak into entity-level data are `OpsEntry.project`
  // (legacy projects sometimes mirrored the namespace) and the
  // `Memory.source_files` array — neither is part of the bound namespace
  // strictly speaking, but users running `--rename-namespace` expect these
  // to be rewritten too. Other entity kinds have no per-row namespace field.
  if (stage === 'ops') {
    const ops = item as unknown as OpsEntry;
    if (ops.project === rename.src) {
      return { ...ops, project: rename.dst } as unknown as T;
    }
  }
  return item;
}

// ─── Checkpoint ───────────────────────────────────────────────────────────────

export function loadCheckpoint(path: string): Checkpoint | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf-8');
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw) as Checkpoint;
  } catch {
    return null;
  }
}

export function saveCheckpoint(path: string, checkpoint: Checkpoint): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(checkpoint, null, 2), 'utf-8');
  try {
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
}

// ─── Verification ─────────────────────────────────────────────────────────────

const VERIFY_SAMPLE_SIZE = 20;

export async function verifyMigration(src: CortexStore, dst: CortexStore): Promise<VerifyReport> {
  const report: VerifyReport = {
    ok: true,
    perKind: {
      memories: { srcCount: 0, dstCount: 0, sampleMismatches: [] },
      observations: { srcCount: 0, dstCount: 0, sampleMismatches: [] },
      edges: { srcCount: 0, dstCount: 0, sampleMismatches: [] },
      ops: { srcCount: 0, dstCount: 0, sampleMismatches: [] },
      signals: { srcCount: 0, dstCount: 0, sampleMismatches: [] },
      beliefs: { srcCount: 0, dstCount: 0, sampleMismatches: [] },
      generic: { srcCount: 0, dstCount: 0, sampleMismatches: [] },
    },
  };

  const srcMems = await src.getAllMemories();
  const dstMems = await dst.getAllMemories();
  report.perKind.memories.srcCount = srcMems.length;
  report.perKind.memories.dstCount = dstMems.length;
  await sampleCompare(srcMems, dstMems, (id) => dst.getMemory(id), 'memories', report);

  await diffKind('observations', listAllObservations(src), listAllObservations(dst), report);
  await diffKind('edges', listAllEdges(src), listAllEdges(dst), report);
  await diffKind('ops', listAllOps(src), listAllOps(dst), report);
  await diffKind('signals', listAllSignals(src), listAllSignals(dst), report);
  await diffKind('beliefs', listAllBeliefs(src), listAllBeliefs(dst), report);

  const srcGen = snapshotGeneric(src);
  const dstGen = snapshotGeneric(dst);
  const srcGenCount = Object.values(srcGen).reduce((a, c) => a + Object.keys(c).length, 0);
  const dstGenCount = Object.values(dstGen).reduce((a, c) => a + Object.keys(c).length, 0);
  report.perKind.generic.srcCount = srcGenCount;
  report.perKind.generic.dstCount = dstGenCount;
  if (srcGenCount !== dstGenCount) report.ok = false;

  for (const stage of MIGRATION_STAGES) {
    const v = report.perKind[stage];
    if (v.srcCount !== v.dstCount || v.sampleMismatches.length > 0) {
      report.ok = false;
    }
  }

  return report;
}

async function diffKind<T extends { id: string }>(
  stage: MigrationStage,
  srcItems: T[],
  dstItems: T[],
  report: VerifyReport,
): Promise<void> {
  report.perKind[stage].srcCount = srcItems.length;
  report.perKind[stage].dstCount = dstItems.length;
  const dstById = new Map(dstItems.map(i => [i.id, i]));
  const sample = sampleN(srcItems, VERIFY_SAMPLE_SIZE);
  for (const s of sample) {
    const d = dstById.get(s.id);
    if (!d) {
      report.perKind[stage].sampleMismatches.push({ id: s.id, reason: 'missing in destination' });
      continue;
    }
    if (!deepEqualJson(s, d)) {
      report.perKind[stage].sampleMismatches.push({ id: s.id, reason: 'value diff' });
    }
  }
}

async function sampleCompare<T extends { id: string }>(
  srcItems: T[],
  dstItems: T[],
  fetchDst: (id: string) => Promise<T | null>,
  stage: MigrationStage,
  report: VerifyReport,
): Promise<void> {
  const dstById = new Map(dstItems.map(i => [i.id, i]));
  const sample = sampleN(srcItems, VERIFY_SAMPLE_SIZE);
  for (const s of sample) {
    let d = dstById.get(s.id);
    if (!d) {
      d = (await fetchDst(s.id)) ?? undefined;
    }
    if (!d) {
      report.perKind[stage].sampleMismatches.push({ id: s.id, reason: 'missing in destination' });
      continue;
    }
    if (!deepEqualJson(s, d)) {
      report.perKind[stage].sampleMismatches.push({ id: s.id, reason: 'value diff' });
    }
  }
}

function sampleN<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr.slice();
  const out: T[] = [];
  const taken = new Set<number>();
  while (out.length < n) {
    const i = Math.floor(Math.random() * arr.length);
    if (taken.has(i)) continue;
    taken.add(i);
    out.push(arr[i]);
  }
  return out;
}

function deepEqualJson(a: unknown, b: unknown): boolean {
  // Use JSON serialization (with date normalisation) so the comparison is
  // value-equal across Date vs ISO-string representations.
  return jsonNormalize(a) === jsonNormalize(b);
}

function jsonNormalize(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v instanceof Date) return v.toISOString();
    return v;
  }, 0);
}

// ─── CLI binding ──────────────────────────────────────────────────────────────

export async function runMigrate(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  if (!parsed.from || !parsed.to) {
    throw new Error('migrate requires --from <url> and --to <url>');
  }
  await migrate({
    from: parsed.from,
    to: parsed.to,
    namespace: parsed.namespace,
    renameNamespace: parsed.renameNamespace,
    resume: parsed.resume,
    verify: parsed.verify,
    dryRun: parsed.dryRun,
    allowMerge: parsed.allowMerge,
    batchSize: parsed.batchSize,
  });
}

interface ParsedMigrateArgs {
  from?: string;
  to?: string;
  namespace?: string;
  renameNamespace?: { src: string; dst: string };
  resume?: boolean;
  verify?: boolean;
  dryRun?: boolean;
  allowMerge?: boolean;
  batchSize?: number;
}

export function parseArgs(args: string[]): ParsedMigrateArgs {
  const out: ParsedMigrateArgs = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case '--from': out.from = args[++i]; break;
      case '--to': out.to = args[++i]; break;
      case '--namespace': out.namespace = args[++i]; break;
      case '--rename-namespace': {
        const v = args[++i];
        if (!v) throw new Error('--rename-namespace requires <src>=<dst>');
        const eq = v.indexOf('=');
        if (eq === -1) throw new Error(`--rename-namespace expected <src>=<dst>, got "${v}"`);
        out.renameNamespace = { src: v.slice(0, eq), dst: v.slice(eq + 1) };
        break;
      }
      case '--resume': out.resume = true; break;
      case '--verify': out.verify = true; break;
      case '--dry-run': out.dryRun = true; break;
      case '--allow-merge': out.allowMerge = true; break;
      case '--batch-size': {
        const n = parseInt(args[++i] ?? '', 10);
        if (!Number.isFinite(n) || n <= 0) throw new Error('--batch-size must be a positive integer');
        out.batchSize = n;
        break;
      }
      default:
        throw new Error(`Unknown migrate flag: ${a}`);
    }
  }
  return out;
}

// rowToMemory is exported only for use by tests that want a SQLite-direct
// memory iterator without depending on getAllMemories. Keeps the public CLI
// surface stable.
export const _internals = { rowToMemory };
