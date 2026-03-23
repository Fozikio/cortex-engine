/**
 * Tests for NamespaceManager.getQueryableNamespaces().
 */

import { describe, it, expect } from 'vitest';
import { NamespaceManager } from './manager.js';
import type { CortexConfig } from '../core/config.js';
import type { CortexStore } from '../core/store.js';

function makeConfig(
  namespaces: Record<string, { queryable?: boolean; default?: boolean }>,
): CortexConfig {
  const ns: CortexConfig['namespaces'] = {};
  for (const [name, opts] of Object.entries(namespaces)) {
    ns[name] = {
      description: name,
      cognitive_tools: ['query'],
      collections_prefix: name,
      queryable: opts.queryable,
      default: opts.default,
    };
  }
  return {
    store: 'sqlite',
    embed: 'built-in',
    llm: 'ollama',
    namespaces: ns,
  };
}

function stubStoreFactory(): CortexStore {
  return {} as unknown as CortexStore;
}

describe('NamespaceManager.getQueryableNamespaces', () => {
  it('returns empty when no namespace has queryable: true', () => {
    const config = makeConfig({ a: {}, b: {} });
    const mgr = new NamespaceManager(config, () => stubStoreFactory());
    expect(mgr.getQueryableNamespaces()).toEqual([]);
  });

  it('returns correct subset when some are queryable', () => {
    const config = makeConfig({
      a: { queryable: true },
      b: {},
      c: { queryable: true },
    });
    const mgr = new NamespaceManager(config, () => stubStoreFactory());
    const result = mgr.getQueryableNamespaces();
    expect(result).toContain('a');
    expect(result).toContain('c');
    expect(result).not.toContain('b');
    expect(result).toHaveLength(2);
  });

  it('returns all when all are queryable', () => {
    const config = makeConfig({
      a: { queryable: true },
      b: { queryable: true },
      c: { queryable: true },
    });
    const mgr = new NamespaceManager(config, () => stubStoreFactory());
    const result = mgr.getQueryableNamespaces();
    expect(result).toHaveLength(3);
    expect(result).toContain('a');
    expect(result).toContain('b');
    expect(result).toContain('c');
  });
});
