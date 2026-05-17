/**
 * Tests for parseStoreUrl / createStoreFromUrl.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseStoreUrl, createStoreFromUrl } from './store-url.js';
import { JsonCortexStore } from '../stores/json.js';
import { SqliteCortexStore } from '../stores/sqlite.js';

// ─── parseStoreUrl ────────────────────────────────────────────────────────────

describe('parseStoreUrl', () => {
  it('parses sqlite with relative path', () => {
    expect(parseStoreUrl('sqlite:./cortex.db')).toEqual({
      kind: 'sqlite',
      options: { path: './cortex.db', namespace: undefined },
    });
  });

  it('parses sqlite with absolute POSIX path', () => {
    expect(parseStoreUrl('sqlite:/var/data/cortex.db')).toEqual({
      kind: 'sqlite',
      options: { path: '/var/data/cortex.db', namespace: undefined },
    });
  });

  it('parses sqlite with namespace query', () => {
    expect(parseStoreUrl('sqlite:./db.sqlite?namespace=alpha')).toEqual({
      kind: 'sqlite',
      options: { path: './db.sqlite', namespace: 'alpha' },
    });
  });

  it('parses firestore with project only', () => {
    expect(parseStoreUrl('firestore:my-project')).toEqual({
      kind: 'firestore',
      options: { projectId: 'my-project', databaseId: undefined, namespace: undefined },
    });
  });

  it('parses firestore with database and namespace', () => {
    expect(parseStoreUrl('firestore:proj?database=second&namespace=tools')).toEqual({
      kind: 'firestore',
      options: { projectId: 'proj', databaseId: 'second', namespace: 'tools' },
    });
  });

  it('parses json with relative path', () => {
    expect(parseStoreUrl('json:./backup.json')).toEqual({
      kind: 'json',
      options: { path: './backup.json', namespace: undefined },
    });
  });

  it('parses json with namespace', () => {
    expect(parseStoreUrl('json:./b.json?namespace=alpha')).toEqual({
      kind: 'json',
      options: { path: './b.json', namespace: 'alpha' },
    });
  });

  it('throws on missing scheme', () => {
    expect(() => parseStoreUrl('./cortex.db')).toThrow(/expected one of/);
  });

  it('throws on empty string', () => {
    expect(() => parseStoreUrl('')).toThrow(/non-empty/);
  });

  it('throws on missing target', () => {
    expect(() => parseStoreUrl('sqlite:')).toThrow(/missing target/);
  });

  it('throws on unknown scheme', () => {
    expect(() => parseStoreUrl('postgres://host')).toThrow(/expected one of/);
  });

  it('decodes URL-encoded namespace values', () => {
    expect(parseStoreUrl('json:./b.json?namespace=alpha_one')).toEqual({
      kind: 'json',
      options: { path: './b.json', namespace: 'alpha_one' },
    });
  });
});

// ─── createStoreFromUrl ───────────────────────────────────────────────────────

describe('createStoreFromUrl', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    tmpDirs.length = 0;
  });

  function mkTmp(): string {
    const d = mkdtempSync(join(tmpdir(), 'cortex-storeurl-'));
    tmpDirs.push(d);
    return d;
  }

  it('creates a JsonCortexStore from a json url', async () => {
    const dir = mkTmp();
    const path = join(dir, 'data.json');
    const store = await createStoreFromUrl(`json:${path}`);
    expect(store).toBeInstanceOf(JsonCortexStore);
    const caps = await store.getCapabilities();
    expect(caps.backend).toBe('json');
    expect(caps.namespace).toBe('');
  });

  it('creates a JsonCortexStore with namespace', async () => {
    const dir = mkTmp();
    const path = join(dir, 'data.json');
    const store = await createStoreFromUrl(`json:${path}?namespace=alpha`);
    const caps = await store.getCapabilities();
    expect(caps.namespace).toBe('alpha');
  });

  it('creates a SqliteCortexStore from a sqlite url', async () => {
    const dir = mkTmp();
    const path = join(dir, 'test.db');
    const store = await createStoreFromUrl(`sqlite:${path}`);
    expect(store).toBeInstanceOf(SqliteCortexStore);
    const caps = await store.getCapabilities();
    expect(caps.backend).toBe('sqlite');
  });

  it('creates a SqliteCortexStore with namespace', async () => {
    const dir = mkTmp();
    const path = join(dir, 'test.db');
    const store = await createStoreFromUrl(`sqlite:${path}?namespace=tools`);
    const caps = await store.getCapabilities();
    expect(caps.namespace).toBe('tools');
  });
});
