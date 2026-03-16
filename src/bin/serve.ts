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

import { loadConfig } from './config-loader.js';
import { startServer } from '../mcp/server.js';

// Parse --agent flag from argv
let agentName: string | undefined;
const agentIdx = process.argv.indexOf('--agent');
if (agentIdx !== -1 && process.argv[agentIdx + 1]) {
  agentName = process.argv[agentIdx + 1];
}

let config;
try {
  config = loadConfig(undefined, agentName);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('ENOENT') || msg.includes('not found')) {
    console.error('');
    console.error('  \u2717 agent.yaml not found');
    console.error('    run `fozikio init` first, or use --workspace <path>');
    console.error('');
  } else {
    console.error(`[cortex-engine] ${msg}`);
  }
  process.exit(1);
}

startServer(config).catch(err => {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('EADDRINUSE') || msg.includes('locked')) {
    console.error('');
    console.error('  \u2717 memory store is locked');
    console.error('    another process may be running');
    console.error('');
  } else if (msg.includes('network') || msg.includes('fetch')) {
    console.error('');
    console.error('  \u2717 embedding model not available');
    console.error('    check your network connection and try again');
    console.error('');
  } else {
    console.error(`[cortex-engine] Fatal: ${msg}`);
  }
  process.exit(1);
});
