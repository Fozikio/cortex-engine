/**
 * store-url.ts — parse and instantiate stores from URL-like strings used by
 * `fozikio migrate` to identify source and destination stores.
 *
 * Supported forms:
 *   sqlite:./relative/path.db
 *   sqlite:/absolute/path.db?namespace=foo
 *   firestore:my-gcp-project
 *   firestore:my-gcp-project?database=my-db&namespace=foo
 *   json:./backup.json
 */

import type { CortexStore } from '../core/store.js';
import type { CortexConfig } from '../core/config.js';

export type StoreKind = 'sqlite' | 'firestore' | 'json';

export interface ParsedStoreUrl {
  kind: StoreKind;
  options: {
    /** sqlite/json: filesystem path. */
    path?: string;
    /** firestore: GCP project id. */
    projectId?: string;
    /** firestore: database id (defaults to '(default)' when unset). */
    databaseId?: string;
    /** Namespace prefix to bind the store to. */
    namespace?: string;
  };
}

const KIND_PREFIX_RE = /^(sqlite|firestore|json):/;

/**
 * Parse a store URL. Throws a clear error if the scheme is missing/unknown so
 * callers (CLI) can surface it directly to the user without wrapping.
 */
export function parseStoreUrl(url: string): ParsedStoreUrl {
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error(`Invalid store URL: expected a non-empty string, got ${typeof url}`);
  }

  const match = KIND_PREFIX_RE.exec(url);
  if (!match) {
    throw new Error(
      `Invalid store URL "${url}": expected one of sqlite:..., firestore:..., json:...`,
    );
  }

  const kind = match[1] as StoreKind;
  const rest = url.slice(match[0].length);

  // We don't use the WHATWG URL parser because sqlite/json schemes carry raw
  // filesystem paths that it would mangle (Windows drive letters, leading ./).
  const qIdx = rest.indexOf('?');
  const head = qIdx === -1 ? rest : rest.slice(0, qIdx);
  const queryStr = qIdx === -1 ? '' : rest.slice(qIdx + 1);

  if (head.length === 0) {
    throw new Error(`Invalid store URL "${url}": missing target after "${kind}:"`);
  }

  const query = parseQuery(queryStr);
  const namespace = query.get('namespace') ?? undefined;

  switch (kind) {
    case 'sqlite':
      return { kind, options: { path: head, namespace } };

    case 'json':
      return { kind, options: { path: head, namespace } };

    case 'firestore':
      return {
        kind,
        options: {
          projectId: head,
          databaseId: query.get('database') ?? undefined,
          namespace,
        },
      };

    default:
      // KIND_PREFIX_RE bounds `kind`, so this branch is unreachable.
      throw new Error(`Unsupported store kind: ${String(kind)}`);
  }
}

function parseQuery(qs: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!qs) return out;
  for (const part of qs.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq === -1) {
      out.set(decodeURIComponent(part), '');
    } else {
      out.set(decodeURIComponent(part.slice(0, eq)), decodeURIComponent(part.slice(eq + 1)));
    }
  }
  return out;
}

/**
 * Build a `CortexStore` for the URL. SQLite and Firestore are delegated to
 * `createStore()` after synthesizing a minimal `CortexConfig`. JSON is created
 * directly because it isn't part of the runtime config schema.
 */
export async function createStoreFromUrl(url: string): Promise<CortexStore> {
  const parsed = parseStoreUrl(url);

  if (parsed.kind === 'json') {
    if (!parsed.options.path) {
      throw new Error(`json store URL "${url}" has no path`);
    }
    const { JsonCortexStore } = await import('../stores/json.js');
    return new JsonCortexStore(parsed.options.path, parsed.options.namespace);
  }

  if (parsed.kind === 'sqlite') {
    if (!parsed.options.path) {
      throw new Error(`sqlite store URL "${url}" has no path`);
    }
    // Bypass the shared store factory so the namespace from the URL flows
    // through. The factory only honours store_options.sqlite_path and never
    // passes a namespace to the SqliteCortexStore constructor.
    const { SqliteCortexStore } = await import('../stores/sqlite.js');
    return new SqliteCortexStore(parsed.options.path, parsed.options.namespace);
  }

  // Firestore. Reuse the factory for firebase-admin initialization, then if
  // the URL asked for a namespace, rebuild a scoped store (the factory always
  // binds namespace='' so its result is unscoped).
  const { createStore } = await import('./store-factory.js');
  const cfg: CortexConfig = {
    store: 'firestore',
    embed: 'built-in',
    llm: 'ollama',
    namespaces: {},
    store_options: {
      gcp_project_id: parsed.options.projectId,
      firestore_database_id: parsed.options.databaseId,
    },
  };
  const base = await createStore(cfg);

  if (parsed.options.namespace) {
    const { getApps } = await import('firebase-admin/app');
    if (getApps().length === 0) {
      throw new Error('firebase-admin app not initialised; cannot scope firestore by namespace');
    }
    const { getFirestore, FieldValue } = await import('firebase-admin/firestore');
    const db = parsed.options.databaseId
      ? getFirestore(parsed.options.databaseId)
      : getFirestore();
    const { FirestoreCortexStore } = await import('../stores/firestore.js');
    return new FirestoreCortexStore(db, parsed.options.namespace, FieldValue);
  }

  return base;
}
