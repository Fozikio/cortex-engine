/**
 * Tests for the tool-discovery metadata contract.
 *
 * Every tool must have a valid category, a non-empty whenToUse, a unique
 * name, and a distinct whenToUse string (to catch copy-paste in PRs).
 * The composed MCP description format is snapshot-tested on a fixture.
 */

import { describe, expect, it } from 'vitest';
import {
  TOOL_CATEGORIES,
  composeMcpDescription,
  createTools,
  toToolMetadata,
} from './tools.js';
import type { ToolCategory, ToolDefinition } from './tools.js';

const tools = createTools();
const validCategories = new Set<ToolCategory>(TOOL_CATEGORIES);

describe('tool metadata contract', () => {
  it('every tool has a valid category', () => {
    for (const t of tools) {
      expect(t.category, `tool "${t.name}" has no category`).toBeTruthy();
      expect(
        validCategories.has(t.category),
        `tool "${t.name}" has invalid category: ${t.category}`,
      ).toBe(true);
    }
  });

  it('every tool has a non-empty whenToUse', () => {
    for (const t of tools) {
      expect(typeof t.whenToUse, `tool "${t.name}" whenToUse not a string`).toBe('string');
      expect(t.whenToUse.trim().length, `tool "${t.name}" whenToUse is empty`).toBeGreaterThan(0);
    }
  });

  it('tool names are unique', () => {
    const seen = new Map<string, number>();
    for (const t of tools) {
      seen.set(t.name, (seen.get(t.name) ?? 0) + 1);
    }
    for (const [name, count] of seen) {
      expect(count, `duplicate tool name: ${name}`).toBe(1);
    }
  });

  it('whenToUse strings are distinct across tools', () => {
    const seen = new Map<string, string>();
    for (const t of tools) {
      const key = t.whenToUse.trim().toLowerCase();
      const previous = seen.get(key);
      if (previous) {
        throw new Error(
          `tools "${previous}" and "${t.name}" share the same whenToUse — likely copy-paste`,
        );
      }
      seen.set(key, t.name);
    }
  });

  it('description budget — composed description under 600 chars', () => {
    // Soft budget — flagged for review if exceeded. Spec target: under 400 average,
    // but allow headroom for the longer-tail descriptions while still catching runaway prose.
    for (const t of tools) {
      const composed = composeMcpDescription(t);
      expect(composed.length, `tool "${t.name}" composed description is ${composed.length} chars`).toBeLessThanOrEqual(600);
    }
  });
});

describe('composeMcpDescription', () => {
  const fixture: ToolDefinition = {
    name: 'fixture',
    category: 'memory',
    description: 'Returns a fixture payload.',
    whenToUse: 'You are testing description composition.',
    doNotUse: 'You are running production code.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => ({}),
  };

  it('renders the expected shape with doNotUse', () => {
    expect(composeMcpDescription(fixture)).toMatchInlineSnapshot(`
      "[memory] Returns a fixture payload.

      Use when: You are testing description composition.
      Don't use when: You are running production code."
    `);
  });

  it('omits the Don\'t use line when doNotUse is absent', () => {
    const minimal = { ...fixture, doNotUse: undefined };
    const out = composeMcpDescription(minimal);
    expect(out).not.toContain("Don't use when");
    expect(out).toContain('Use when:');
    expect(out).toContain('[memory]');
  });
});

describe('toToolMetadata', () => {
  it('strips the handler', () => {
    const t = tools[0];
    const meta = toToolMetadata(t);
    expect('handler' in meta).toBe(false);
    expect(meta.name).toBe(t.name);
    expect(meta.category).toBe(t.category);
    expect(meta.whenToUse).toBe(t.whenToUse);
  });

  it('omits doNotUse when not set', () => {
    const fixture: ToolDefinition = {
      name: 'no-do-not',
      category: 'meta',
      description: 'desc',
      whenToUse: 'when',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({}),
    };
    const meta = toToolMetadata(fixture);
    expect('doNotUse' in meta).toBe(false);
  });
});
