/**
 * config-loader.test.ts — env-var overrides for provider selection.
 *
 * Motivation: a container (Railway, Fly, Cloud Run) rarely ships a config
 * file, so `loadConfig` fell through to DEFAULT_CONFIG and a server with no
 * Ollama got `llm: ollama` — every LLM-backed tool then failed at first use,
 * long after the health check had reported green. CORTEX_STORE / CORTEX_EMBED
 * / CORTEX_LLM / CORTEX_SQLITE_PATH let a deploy panel choose providers
 * without a file.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../core/config.js';
import { applyEnvOverrides, loadConfig } from './config-loader.js';

describe('applyEnvOverrides', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the config unchanged when no override is set', () => {
    const out = applyEnvOverrides(DEFAULT_CONFIG, {});
    expect(out).toEqual(DEFAULT_CONFIG);
  });

  it('applies valid store / embed / llm values', () => {
    const out = applyEnvOverrides(DEFAULT_CONFIG, {
      CORTEX_STORE: 'sqlite',
      CORTEX_EMBED: 'built-in',
      CORTEX_LLM: 'openai',
    });
    expect(out.store).toBe('sqlite');
    expect(out.embed).toBe('built-in');
    expect(out.llm).toBe('openai');
  });

  it('env wins over the file config', () => {
    const fromFile = { ...DEFAULT_CONFIG, llm: 'gemini' as const };
    const out = applyEnvOverrides(fromFile, { CORTEX_LLM: 'anthropic' });
    expect(out.llm).toBe('anthropic');
  });

  it('ignores unknown values with a warning instead of throwing', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = applyEnvOverrides(DEFAULT_CONFIG, { CORTEX_LLM: 'gpt5', CORTEX_EMBED: ' ' });
    expect(out.llm).toBe(DEFAULT_CONFIG.llm);
    expect(out.embed).toBe(DEFAULT_CONFIG.embed);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('CORTEX_LLM="gpt5"');
  });

  it('sets the sqlite path without dropping other store options', () => {
    const fromFile = {
      ...DEFAULT_CONFIG,
      store_options: { gcp_project_id: 'keep-me' },
    };
    const out = applyEnvOverrides(fromFile, { CORTEX_SQLITE_PATH: '/data/cortex.db' });
    expect(out.store_options).toEqual({ gcp_project_id: 'keep-me', sqlite_path: '/data/cortex.db' });
  });

  it('does not mutate its input', () => {
    const input = { ...DEFAULT_CONFIG };
    applyEnvOverrides(input, { CORTEX_LLM: 'kimi', CORTEX_SQLITE_PATH: '/x.db' });
    expect(input.llm).toBe(DEFAULT_CONFIG.llm);
    expect(input.store_options).toBe(DEFAULT_CONFIG.store_options);
  });
});

describe('loadConfig with no config file', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    vi.restoreAllMocks();
  });

  it('reports the effective providers after env overrides', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cortex-cfg-'));
    try {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      process.env.CORTEX_LLM = 'openai';
      process.env.CORTEX_SQLITE_PATH = join(dir, 'brain.db');

      const config = loadConfig(dir);

      expect(config.llm).toBe('openai');
      expect(config.store_options?.sqlite_path).toBe(join(dir, 'brain.db'));
      const printed = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls
        .map((c) => String(c[0]))
        .join('\n');
      expect(printed).toContain('llm=openai');
      expect(printed).not.toContain('sqlite + ollama');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('loadConfig over a named cortex map (agent.yaml)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lifts the primary entry's plugins and nli onto the config", () => {
    const dir = mkdtempSync(join(tmpdir(), 'cortex-cfg-'));
    try {
      mkdirSync(join(dir, '.fozikio'));
      writeFileSync(
        join(dir, '.fozikio', 'agent.yaml'),
        [
          'agent:',
          '  name: ledger',
          'agents:',
          '  ledger:',
          '    namespace: ledger',
          'cortex:',
          '  ledger:',
          '    store: sqlite',
          '    embed: ollama',
          '    llm: ollama',
          '    primary: true',
          '    collections_prefix: ledger_',
          '    cognitive_tools: [query, observe]',
          '    plugins:',
          '      - ./.fozikio/plugins/codebase-mind/dist/index.js',
          '    nli:',
          '      enabled: true',
          '      url: http://127.0.0.1:11435',
          '',
        ].join('\n'),
      );
      const config = loadConfig(dir, 'ledger');
      expect(config.plugins).toEqual(['./.fozikio/plugins/codebase-mind/dist/index.js']);
      expect(config.nli).toEqual({ enabled: true, url: 'http://127.0.0.1:11435' });
      expect(config.namespaces.ledger?.collections_prefix).toBe('ledger_');
      expect(config.namespaces.ledger?.cognitive_tools).toEqual(['query', 'observe']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
