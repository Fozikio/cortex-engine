/**
 * Tests for SqliteCortexStore — regression coverage for embedding format handling.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteCortexStore } from './sqlite.js';

interface StoreInternals {
  db: Database.Database;
}

function getDb(store: SqliteCortexStore): Database.Database {
  return (store as unknown as StoreInternals).db;
}

function insertMemoryWithRawEmbedding(
  store: SqliteCortexStore,
  id: string,
  embedding: Buffer | string,
): void {
  const now = new Date().toISOString();
  getDb(store)
    .prepare(
      `INSERT INTO memories (
        id, name, definition, category, salience, confidence, access_count,
        created_at, updated_at, last_accessed, source_files, embedding, tags
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, id, `${id} definition`, 'concept', 0.5, 0.5, 0, now, now, now, '[]', embedding, '[]');
}

describe('SqliteCortexStore.findNearest', () => {
  it('finds memories whose embedding is stored as a Float32Array BLOB', async () => {
    const store = new SqliteCortexStore(':memory:');
    const vector = [0.1, 0.2, 0.3, 0.4];
    const blob = Buffer.from(new Float32Array(vector).buffer);

    insertMemoryWithRawEmbedding(store, 'mem-blob', blob);

    const results = await store.findNearest(vector, 5);

    expect(results).toHaveLength(1);
    expect(results[0].memory.id).toBe('mem-blob');
    expect(results[0].score).toBeGreaterThan(0.99);
  });

  it('does not throw when some memories have empty embeddings', async () => {
    const store = new SqliteCortexStore(':memory:');
    const vector = [1, 0, 0, 0];
    const blob = Buffer.from(new Float32Array(vector).buffer);

    insertMemoryWithRawEmbedding(store, 'mem-empty', '[]');
    insertMemoryWithRawEmbedding(store, 'mem-good', blob);

    const results = await store.findNearest(vector, 5);

    expect(results.map(r => r.memory.id)).toContain('mem-good');
    expect(results.map(r => r.memory.id)).not.toContain('mem-empty');
  });
});
