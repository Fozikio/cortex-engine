/**
 * Shared helpers for the generic collection API and for rows written through
 * it before a kind had first-class reads.
 *
 * SQLite and JSON keep typed kinds (observations, beliefs) in their own
 * tables/maps and everything else in a generic collection store. Firestore
 * has one collection per kind, so reads through either API agree there and
 * the split is only visible on the local stores (#122, #123). Rows that
 * predate the typed reads — `notice` observations, Firestore-migrated belief
 * revisions — live in the generic collection with loose shapes; these
 * converters read them back as typed records.
 */

import type {
  BeliefEntry,
  Observation,
  ObservationFilters,
  QueryFilter,
} from '../core/types.js';

/**
 * A comparable timestamp for a date-like value: Date, ISO-8601 string, or a
 * serialized Firestore Timestamp ({_seconds,_nanoseconds} / {seconds,nanoseconds}).
 * Returns null for anything else.
 */
export function toMillis(v: unknown): number | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? null : ms;
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const sec = typeof o['_seconds'] === 'number' ? o['_seconds'] : o['seconds'];
    const ns = typeof o['_nanoseconds'] === 'number' ? o['_nanoseconds'] : o['nanoseconds'];
    if (typeof sec === 'number') return sec * 1000 + (typeof ns === 'number' ? Math.floor(ns / 1e6) : 0);
  }
  return null;
}

function toDateOr(v: unknown, fallback: Date): Date {
  const ms = toMillis(v);
  return ms === null ? fallback : new Date(ms);
}

/**
 * Range comparison for generic query filters. Numbers compare as numbers;
 * dates compare as timestamps whatever mix of Date / ISO string / Firestore
 * Timestamp each side is in. Before this, `created_at >= <Date>` never
 * matched on SQLite or JSON because only numbers were compared.
 */
function compareRange(v: unknown, op: '<' | '<=' | '>' | '>=', value: unknown): boolean {
  let a: number | null;
  let b: number | null;
  if (typeof v === 'number' && typeof value === 'number') {
    a = v; b = value;
  } else {
    a = toMillis(v); b = toMillis(value);
    if (a === null || b === null) return false;
  }
  switch (op) {
    case '<': return a < b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '>=': return a >= b;
  }
}

/** Does a generic document satisfy one query filter? */
export function matchesFilter(doc: Record<string, unknown>, f: QueryFilter): boolean {
  const v = doc[f.field];
  switch (f.op) {
    case '==': return v === f.value;
    case '!=': return v !== f.value;
    case '<': case '<=': case '>': case '>=': return compareRange(v, f.op, f.value);
    case 'in': return Array.isArray(f.value) && (f.value as unknown[]).includes(v);
    case 'array-contains': return Array.isArray(v) && (v as unknown[]).includes(f.value);
    default: return true;
  }
}

/** Convert a generic-collection observation doc (e.g. written by an older `notice`) into an Observation. */
export function genericDocToObservation(doc: Record<string, unknown>): Observation {
  const createdAt = toDateOr(doc['created_at'], new Date(0));
  const strArray = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.map(String) : undefined;
  return {
    id: String(doc['id'] ?? ''),
    content: typeof doc['content'] === 'string' ? doc['content'] : '',
    source_file: typeof doc['source_file'] === 'string' ? doc['source_file'] : '',
    source_section: typeof doc['source_section'] === 'string' ? doc['source_section'] : '',
    salience: typeof doc['salience'] === 'number' ? doc['salience'] : 0.5,
    processed: doc['processed'] === true,
    prediction_error: typeof doc['prediction_error'] === 'number' ? doc['prediction_error'] : null,
    created_at: createdAt,
    updated_at: toDateOr(doc['updated_at'], createdAt),
    embedding: Array.isArray(doc['embedding']) ? (doc['embedding'] as number[]) : null,
    keywords: strArray(doc['keywords']) ?? [],
    content_type: (doc['content_type'] as Observation['content_type']) ?? 'declarative',
    name: typeof doc['name'] === 'string' ? doc['name'] : undefined,
    category: (doc['category'] as Observation['category']) ?? undefined,
    tags: strArray(doc['tags']),
  };
}

/** Convert a generic-collection belief doc (e.g. migrated from Firestore) into a BeliefEntry. */
export function genericDocToBelief(doc: Record<string, unknown>): BeliefEntry {
  const nullableDate = (v: unknown): Date | null => {
    const ms = toMillis(v);
    return ms === null ? null : new Date(ms);
  };
  return {
    id: String(doc['id'] ?? ''),
    concept_id: typeof doc['concept_id'] === 'string' ? doc['concept_id'] : '',
    old_definition: typeof doc['old_definition'] === 'string' ? doc['old_definition'] : '',
    new_definition: typeof doc['new_definition'] === 'string' ? doc['new_definition'] : '',
    reason: typeof doc['reason'] === 'string' ? doc['reason'] : '',
    changed_at: toDateOr(doc['changed_at'], new Date(0)),
    valid_from: nullableDate(doc['valid_from']),
    valid_to: nullableDate(doc['valid_to']),
  };
}

/** Does an observation satisfy the typed filters (everything but limit/order)? */
export function matchesObservationFilters(o: Observation, f: ObservationFilters): boolean {
  if (f.since && o.created_at.getTime() < f.since.getTime()) return false;
  if (f.until && o.created_at.getTime() >= f.until.getTime()) return false;
  if (f.content_type && (o.content_type ?? 'declarative') !== f.content_type) return false;
  if (f.processed !== undefined && o.processed !== f.processed) return false;
  if (f.has_prediction_error && o.prediction_error == null) return false;
  return true;
}

/** Order by created_at (default newest first) and apply the limit. */
export function orderObservations(list: Observation[], f: ObservationFilters): Observation[] {
  const dir = f.order === 'asc' ? 1 : -1;
  list.sort((a, b) => dir * (a.created_at.getTime() - b.created_at.getTime()));
  return f.limit !== undefined ? list.slice(0, f.limit) : list;
}
