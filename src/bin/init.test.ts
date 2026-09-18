/**
 * init.test.ts — the generated .mcp.json names a package npm can resolve (#107), and
 * `init --here` keeps a project's own CLAUDE.md, AGENTS.md and .mcp.json (#108).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMcpJson, buildMcpServerEntry, writeMcpJson, runInit } from './init.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'fozikio-init-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('buildMcpJson', () => {
  it('pins the scoped package, not the pre-rename stub', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const json = JSON.parse(buildMcpJson('1.7.1', platform)) as { mcpServers: { cortex: { args: string[] } } };
      expect(json.mcpServers.cortex.args).toContain('@fozikio/cortex-engine@1.7.1');
      expect(json.mcpServers.cortex.args.some((a) => /^cortex-engine@/.test(a))).toBe(false);
    }
  });

  it('wraps npx in cmd /c on Windows only', () => {
    expect(buildMcpServerEntry('1.7.1', 'win32')).toEqual({ command: 'cmd', args: ['/c', 'npx', '-y', '@fozikio/cortex-engine@1.7.1'] });
    expect(buildMcpServerEntry('1.7.1', 'linux')).toEqual({ command: 'npx', args: ['-y', '@fozikio/cortex-engine@1.7.1'] });
  });
});

describe('writeMcpJson', () => {
  it('writes a fresh file when there is none', () => {
    const d = tmp();
    expect(writeMcpJson(d, '1.7.1', 'linux')).toBe('written');
    expect(JSON.parse(readFileSync(join(d, '.mcp.json'), 'utf-8'))).toEqual({
      mcpServers: { cortex: { command: 'npx', args: ['-y', '@fozikio/cortex-engine@1.7.1'] } },
    });
  });

  it('adds cortex beside the servers already there', () => {
    const d = tmp();
    writeFileSync(join(d, '.mcp.json'), JSON.stringify({ mcpServers: { github: { command: 'gh-mcp' } } }));
    expect(writeMcpJson(d, '1.7.1', 'linux')).toBe('merged');
    const json = JSON.parse(readFileSync(join(d, '.mcp.json'), 'utf-8')) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(json.mcpServers)).toEqual(['github', 'cortex']);
    expect(json.mcpServers.github).toEqual({ command: 'gh-mcp' });
  });

  it('leaves a file that already has a cortex server untouched', () => {
    const d = tmp();
    const theirs = JSON.stringify({ mcpServers: { cortex: { command: 'npx', args: ['fozikio', 'serve', '--agent', 'anthems'] } } });
    writeFileSync(join(d, '.mcp.json'), theirs);
    expect(writeMcpJson(d, '1.7.1', 'linux')).toBe('kept');
    expect(readFileSync(join(d, '.mcp.json'), 'utf-8')).toBe(theirs);
  });

  it('leaves a file it cannot parse untouched', () => {
    const d = tmp();
    writeFileSync(join(d, '.mcp.json'), '{ not json');
    expect(writeMcpJson(d, '1.7.1', 'linux')).toBe('unreadable');
    expect(readFileSync(join(d, '.mcp.json'), 'utf-8')).toBe('{ not json');
  });
});

describe('runInit --here', () => {
  it('keeps the project\'s CLAUDE.md and AGENTS.md and merges its .mcp.json', () => {
    const d = tmp();
    const claude = '# My project\n\nSeven thousand words of design record.\n';
    const agents = '# Roster\n';
    writeFileSync(join(d, 'CLAUDE.md'), claude);
    writeFileSync(join(d, 'AGENTS.md'), agents);
    writeFileSync(join(d, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    runInit(['--here'], d);

    expect(readFileSync(join(d, 'CLAUDE.md'), 'utf-8')).toBe(claude);
    expect(readFileSync(join(d, 'AGENTS.md'), 'utf-8')).toBe(agents);
    const mcp = JSON.parse(readFileSync(join(d, '.mcp.json'), 'utf-8')) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(mcp.mcpServers)).toEqual(['other', 'cortex']);
    expect(existsSync(join(d, '.fozikio', 'agent.yaml'))).toBe(true);
    expect(readFileSync(join(d, '.fozikio', 'CLAUDE.md'), 'utf-8')).toContain('cortex-engine');
    expect(existsSync(join(d, '.fozikio', 'AGENTS.md'))).toBe(true);
    const summary = (console.error as unknown as { mock: { calls: string[][] } }).mock.calls.map((c) => c[0]).join('\n');
    expect(summary).toContain('CLAUDE.md');
    expect(summary).toContain('kept');
  });

  it('writes the pointers into an empty directory as before', () => {
    const d = tmp();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    runInit(['--here'], d);
    expect(existsSync(join(d, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(d, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(d, '.fozikio', 'CLAUDE.md'))).toBe(false);
    const mcp = JSON.parse(readFileSync(join(d, '.mcp.json'), 'utf-8')) as { mcpServers: { cortex: { args: string[] } } };
    expect(mcp.mcpServers.cortex.args.some((a) => a.startsWith('@fozikio/cortex-engine@'))).toBe(true);
  });
});
