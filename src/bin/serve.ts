#!/usr/bin/env node
/**
 * cortex-engine MCP server entry point.
 *
 * Searches for a config file in standard locations, merges with defaults,
 * then starts the stdio MCP server.
 *
 * Config search order:
 *   1. .fozikio/config.yaml   (agent workspace)
 *   2. cortex.config.yaml     (project root)
 *   3. config.yaml            (project root)
 *   4. defaults               (sqlite + ollama)
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { DEFAULT_CONFIG } from '../core/config.js';
import type { CortexConfig, AgentConfig } from '../core/config.js';
import { startServer } from '../mcp/server.js';

function loadConfig(): CortexConfig {
  const searchPaths = [
    resolve(process.cwd(), '.fozikio', 'config.yaml'),
    resolve(process.cwd(), 'cortex.config.yaml'),
    resolve(process.cwd(), 'config.yaml'),
  ];

  for (const configPath of searchPaths) {
    if (existsSync(configPath)) {
      try {
        const raw = readFileSync(configPath, 'utf-8');
        const parsed = parseYaml(raw) as AgentConfig | CortexConfig;

        if (parsed && typeof parsed === 'object' && 'cortex' in parsed && parsed.cortex) {
          // Wrapped AgentConfig format
          return { ...DEFAULT_CONFIG, ...parsed.cortex };
        }

        // Top-level CortexConfig format
        return { ...DEFAULT_CONFIG, ...(parsed as Partial<CortexConfig>) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[cortex-engine] Failed to parse config at ${configPath}: ${message}`);
      }
    }
  }

  // No config found — use defaults
  console.error('[cortex-engine] No config file found, using defaults (sqlite + ollama)');
  return DEFAULT_CONFIG;
}

const config = loadConfig();

startServer(config).catch(err => {
  console.error('[cortex-engine] Fatal error:', err);
  process.exit(1);
});
