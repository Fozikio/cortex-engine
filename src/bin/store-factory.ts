/**
 * store-factory.ts — shared store + embed provider creation for CLI commands.
 *
 * Mirrors the logic in mcp/server.ts but returns a CortexStore directly,
 * without wiring up the full MCP server stack.
 */

import type { CortexConfig } from '../core/config.js';
import type { CortexStore } from '../core/store.js';
import type { EmbedProvider } from '../core/embed.js';
import { SqliteCortexStore } from '../stores/sqlite.js';

/**
 * Create and return a CortexStore from config.
 * Uses the default namespace prefix (empty string) — suitable for direct
 * CLI operations that don't need namespace scoping.
 */
export async function createStore(config: CortexConfig): Promise<CortexStore> {
  if (config.store === 'firestore') {
    const { getApps, initializeApp } = await import('firebase-admin/app');
    if (getApps().length === 0) {
      initializeApp({ projectId: config.store_options?.gcp_project_id });
    }
    const { getFirestore, FieldValue } = await import('firebase-admin/firestore');
    const db = config.store_options?.firestore_database_id
      ? getFirestore(config.store_options.firestore_database_id)
      : getFirestore();
    db.settings({ ignoreUndefinedProperties: true });

    const { FirestoreCortexStore } = await import('../stores/firestore.js');
    return new FirestoreCortexStore(db, '', FieldValue);
  }

  // Default: SQLite
  return new SqliteCortexStore(
    config.store_options?.sqlite_path ?? './cortex.db',
  );
}

/**
 * Create an EmbedProvider from config.
 * Mirrors createEmbedProvider() in mcp/server.ts.
 */
export async function createEmbedProvider(config: CortexConfig): Promise<EmbedProvider> {
  switch (config.embed) {
    case 'built-in': {
      const { BuiltInEmbedProvider } = await import('../providers/builtin-embed.js');
      return new BuiltInEmbedProvider();
    }
    case 'ollama': {
      const { OllamaEmbedProvider } = await import('../providers/ollama.js');
      return new OllamaEmbedProvider({
        model: config.embed_options?.ollama_model,
        baseUrl: config.embed_options?.ollama_url,
      });
    }
    case 'vertex': {
      const { PredictionServiceClient, helpers } = await import('@google-cloud/aiplatform');
      const { VertexEmbedProvider } = await import('../providers/vertex-embed.js');
      const location = config.embed_options?.vertex_location ?? 'us-central1';
      const client = new PredictionServiceClient({
        apiEndpoint: `${location}-aiplatform.googleapis.com`,
      });
      return new VertexEmbedProvider(
        {
          projectId: config.store_options?.gcp_project_id,
          location,
          model: config.embed_options?.vertex_model,
        },
        client,
        helpers,
      );
    }
    default:
      throw new Error(`Embed provider "${config.embed}" not supported for CLI commands`);
  }
}
