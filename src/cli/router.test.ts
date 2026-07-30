import { describe, it, expect } from 'vitest';
import { resolve, visibleLeaves, type AliasTable, type CommandTree } from './router.js';
import { UsageError } from './args.js';

const noop = () => {};

const tree: CommandTree = {
  up: { summary: 'start', run: noop },
  status: { summary: 'status', run: noop },
  service: {
    summary: 'services',
    children: {
      start: { summary: 'start one', run: noop },
      logs: { summary: 'tail', run: noop },
    },
  },
  memory: {
    summary: 'memory',
    children: {
      health: { summary: 'health', run: noop },
      vitals: { summary: 'vitals', run: noop },
    },
  },
  idapixl: { summary: '', hidden: true, run: noop },
};

const aliases: AliasTable = {
  health: ['memory', 'health'],
  vitals: ['memory', 'vitals'],
};

describe('resolve', () => {
  it('returns null for empty argv so the caller can pick a default', () => {
    expect(resolve([], tree, aliases)).toBeNull();
  });

  it('resolves a top-level leaf', () => {
    const r = resolve(['status'], tree, aliases)!;
    expect(r.path).toEqual(['status']);
    expect(r.rest).toEqual([]);
  });

  it('resolves a nested subcommand', () => {
    const r = resolve(['service', 'start', 'ollama'], tree, aliases)!;
    expect(r.path).toEqual(['service', 'start']);
    expect(r.rest).toEqual(['ollama']);
  });

  it('stops walking at the first flag', () => {
    const r = resolve(['status', '--json'], tree, aliases)!;
    expect(r.path).toEqual(['status']);
    expect(r.rest).toEqual(['--json']);
  });

  it('passes flags through to a nested command', () => {
    const r = resolve(['service', 'logs', 'nli', '--lines', '5'], tree, aliases)!;
    expect(r.path).toEqual(['service', 'logs']);
    expect(r.rest).toEqual(['nli', '--lines', '5']);
  });

  it('rejects an unknown command', () => {
    expect(() => resolve(['frobnicate'], tree, aliases)).toThrow(UsageError);
  });

  it('rejects an unknown subcommand and lists the valid ones', () => {
    try {
      resolve(['service', 'frobnicate'], tree, aliases);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as UsageError).hint).toContain('start');
    }
  });

  it('asks for a subcommand when a group is invoked bare', () => {
    expect(() => resolve(['service'], tree, aliases)).toThrow(/needs a subcommand/);
  });
});

describe('aliases', () => {
  // Cron jobs and published docs invoke the pre-restructure verbs directly.
  // If any of these stop routing, those callers break silently.
  it.each(Object.entries(aliases))('routes legacy `%s` to its new path', (legacy, path) => {
    const r = resolve([legacy], tree, aliases)!;
    expect(r.path).toEqual(path);
    expect(r.node.run).toBeDefined();
  });

  it('forwards arguments through an alias', () => {
    const r = resolve(['health', '--json', '--prune'], tree, aliases)!;
    expect(r.path).toEqual(['memory', 'health']);
    expect(r.rest).toEqual(['--json', '--prune']);
  });

  it('leaves non-aliased commands alone', () => {
    expect(resolve(['up'], tree, aliases)!.path).toEqual(['up']);
  });
});

describe('visibleLeaves', () => {
  it('walks nested groups and skips hidden nodes', () => {
    const paths = [...visibleLeaves(tree)].map((l) => l.path.join(' '));
    expect(paths).toContain('service start');
    expect(paths).toContain('memory vitals');
    expect(paths).not.toContain('idapixl');
  });
});
