/**
 * namespace-resolver.test.ts — tests for CLI namespace resolution.
 *
 * Covers the regression that motivated this module: fozikio health (and
 * siblings) silently ignored agent.yaml default_namespace and --namespace
 * flags, returning empty results when the MCP server correctly routed to a
 * non-default namespace.
 */

import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG } from '../core/config.js';
import type { CortexConfig } from '../core/config.js';
import { parseNamespaceArgs, resolveNamespace, namespaceLabel } from './namespace-resolver.js';

function configWithDefaultNamespace(name: string, collectionsPrefix?: string): CortexConfig {
  return {
    ...DEFAULT_CONFIG,
    namespaces: {
      default: {
        description: 'Default namespace',
        cognitive_tools: [],
        collections_prefix: '',
        default: name === 'default',
      },
      [name]: {
        description: `Namespace for ${name}`,
        cognitive_tools: [],
        collections_prefix: collectionsPrefix ?? `${name}_`,
        default: name !== 'default',
      },
    },
  };
}

describe('parseNamespaceArgs', () => {
  it('returns null for both fields when no flags present', () => {
    expect(parseNamespaceArgs(['--json', '--days', '30'])).toEqual({
      namespace: null,
      agentName: null,
    });
  });

  it('extracts --namespace value', () => {
    expect(parseNamespaceArgs(['--namespace', 'anthems'])).toEqual({
      namespace: 'anthems',
      agentName: null,
    });
  });

  it('extracts --agent value', () => {
    expect(parseNamespaceArgs(['--agent', 'anthems'])).toEqual({
      namespace: null,
      agentName: 'anthems',
    });
  });

  it('extracts both when both are present', () => {
    expect(parseNamespaceArgs(['--namespace', 'override', '--agent', 'anthems'])).toEqual({
      namespace: 'override',
      agentName: 'anthems',
    });
  });

  it('ignores a flag with no value following it', () => {
    expect(parseNamespaceArgs(['--namespace'])).toEqual({
      namespace: null,
      agentName: null,
    });
  });

  it('finds flags mixed among other args', () => {
    expect(parseNamespaceArgs(['health', '--days', '7', '--namespace', 'anthems', '--json'])).toEqual({
      namespace: 'anthems',
      agentName: null,
    });
  });
});

describe('resolveNamespace', () => {
  it('returns empty string when no flag and config has only the default namespace', () => {
    expect(resolveNamespace({ namespace: null, agentName: null }, DEFAULT_CONFIG)).toBe('');
  });

  it('returns the explicit --namespace value when provided', () => {
    expect(
      resolveNamespace({ namespace: 'anthems', agentName: null }, DEFAULT_CONFIG)
    ).toBe('anthems');
  });

  it('returns the namespace marked default in the config', () => {
    // Helper sets collections_prefix to `${name}_` by default, returned verbatim.
    const config = configWithDefaultNamespace('anthems');
    expect(resolveNamespace({ namespace: null, agentName: null }, config)).toBe('anthems_');
  });

  it('uses collections_prefix verbatim (no trailing-underscore strip)', () => {
    // Must match the literal value mcp/server.ts passes to SqliteCortexStore.
    // The store appends `_${collection}` regardless, so a prefix `songs_`
    // becomes table `songs__memories` for both CLI and MCP — symmetric.
    const config = configWithDefaultNamespace('anthems', 'songs_');
    expect(resolveNamespace({ namespace: null, agentName: null }, config)).toBe('songs_');
  });

  it('uses collections_prefix verbatim when it has no trailing underscore', () => {
    const config = configWithDefaultNamespace('anthems', 'special');
    expect(resolveNamespace({ namespace: null, agentName: null }, config)).toBe('special');
  });

  it('honours explicit --namespace flag over default in config', () => {
    const config = configWithDefaultNamespace('anthems');
    expect(
      resolveNamespace({ namespace: 'override', agentName: null }, config)
    ).toBe('override');
  });

  it('honours empty string --namespace as a deliberate request for the default namespace', () => {
    const config = configWithDefaultNamespace('anthems');
    expect(resolveNamespace({ namespace: '', agentName: null }, config)).toBe('');
  });

  it('maps the literal "default" namespace name to empty string', () => {
    expect(resolveNamespace({ namespace: null, agentName: null }, DEFAULT_CONFIG)).toBe('');
  });
});

describe('namespaceLabel', () => {
  it('renders empty namespace as (default) for visibility', () => {
    expect(namespaceLabel('')).toBe('(default)');
  });

  it('passes through non-empty names', () => {
    expect(namespaceLabel('anthems')).toBe('anthems');
  });
});
