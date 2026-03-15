#!/usr/bin/env node
/**
 * fozikio CLI — setup and management for cortex-engine agents.
 *
 * Commands:
 *   init <name>     Scaffold a new agent workspace
 *   serve            Start the MCP server
 *   config           View or edit configuration
 *   digest           Process documents through cortex
 *   health           Show cortex health report
 *   vitals           Show behavioral vitals and PE delta
 *   anomalies        Detect anomalous sessions with Isolation Forest
 *   report           Generate weekly quality report
 *   maintain         Data maintenance (fix, re-embed)
 *   help             Show help
 */

import { loadConfig } from './config-loader.js';
import { runInit } from './init.js';
import { runDigest } from './digest-cmd.js';
import { runConfig } from './config-cmd.js';
import { runAgent } from './agent-cmd.js';
import { runHealth } from './health-cmd.js';
import { runVitals } from './vitals-cmd.js';
import { runAnomalies } from './anomalies-cmd.js';
import { runReport } from './report-cmd.js';
import { runMaintain } from './maintain-cmd.js';
import { startServer } from '../mcp/server.js';

// ─── Help ──────────────────────────────────────────────────────────────────

function printHelp(): void {
  console.error(`fozikio — setup and management for cortex-engine agents

Usage:
  fozikio <command> [options]

Commands:
  init <name>   Scaffold a new agent workspace
  serve          Start the MCP server (stdio)
  config         View or edit configuration
  agent          Manage multi-agent registry
  digest         Process documents through cortex
  health         Show cortex health report
  vitals         Show behavioral vitals and PE delta
  anomalies      Detect anomalous sessions (Isolation Forest)
  report         Generate weekly quality report (memory, graph, ops, threads)
  maintain       Data maintenance (fix data issues, re-embed)
  help           Show this help message

Serve options:
  --agent <name>  Scope server to a named agent's namespace

Agent subcommands:
  agent add <name>      Register a new agent
  agent list            List registered agents
  agent generate-mcp    Write multi-agent .mcp.json

Init options:
  --store sqlite|firestore     Storage backend (default: sqlite)
  --embed ollama|vertex|openai   Embedding provider (default: ollama)
  --llm ollama|gemini|anthropic|openai   LLM provider (default: ollama)
  --namespace <name>           Default namespace name (default: default)
  --here                       Scaffold into current directory
  --obsidian                   Create .obsidian/ structure

Health options:
  --prune        Soft-delete prune candidates (fades memories meeting 3+ criteria)
  --json         Output as JSON instead of formatted table

Vitals options:
  --days N       Window size in days (default: 30)
  --json         Output as JSON instead of formatted table

Anomalies options:
  --days N       Window size in days (default: 90)
  --json         Output as JSON instead of formatted table

Report options:
  --days N       Report window in days (default: 7)
  --json         Output as JSON

Maintain subcommands:
  maintain fix           Scan and repair data issues in memories
  maintain re-embed      Re-embed memories with current embed provider

Maintain re-embed flags:
  --dry-run              Show what would be re-embedded without writing
  --null-only            Only re-embed docs with missing embeddings
  --limit N              Max docs to process (default: 500)
  --collection <name>    memories | observations (default: memories)

Examples:
  fozikio init my-agent
  fozikio init my-agent --store firestore --embed vertex --llm gemini
  fozikio init --here --obsidian
  fozikio serve
  fozikio config
  fozikio config --store sqlite --embed ollama
  fozikio digest path/to/file.md
  fozikio digest --pending
  fozikio health
  fozikio health --json
  fozikio health --prune
  fozikio vitals
  fozikio vitals --days 14 --json
  fozikio anomalies
  fozikio anomalies --days 60 --json
  fozikio report
  fozikio report --days 14 --json
  fozikio maintain fix
  fozikio maintain fix --dry-run
  fozikio maintain re-embed --null-only
  fozikio maintain re-embed --dry-run
`);
}

// ─── Dispatch ──────────────────────────────────────────────────────────────

const [,, command, ...rest] = process.argv;

switch (command) {
  case 'init':
    runInit(rest);
    break;

  case 'serve': {
    let agentName: string | undefined;
    const agentIdx = rest.indexOf('--agent');
    if (agentIdx !== -1 && rest[agentIdx + 1]) {
      agentName = rest[agentIdx + 1];
    }
    (async () => {
      const config = loadConfig(undefined, agentName);
      await startServer(config);
    })().catch(err => {
      console.error('[fozikio] Fatal error:', err);
      process.exit(1);
    });
    break;
  }

  case 'config':
    runConfig(rest).catch(err => {
      console.error('[fozikio] Config error:', err);
      process.exit(1);
    });
    break;

  case 'agent':
    runAgent(rest).catch(err => {
      console.error('[fozikio] Agent error:', err);
      process.exit(1);
    });
    break;

  case 'digest':
    runDigest(rest).catch(err => {
      console.error('[fozikio] Digest error:', err);
      process.exit(1);
    });
    break;

  case 'health':
    runHealth(rest).catch(err => {
      console.error('[fozikio] Health error:', err);
      process.exit(1);
    });
    break;

  case 'vitals':
    runVitals(rest).catch(err => {
      console.error('[fozikio] Vitals error:', err);
      process.exit(1);
    });
    break;

  case 'anomalies':
    runAnomalies(rest).catch(err => {
      console.error('[fozikio] Anomalies error:', err);
      process.exit(1);
    });
    break;

  case 'report':
    runReport(rest).catch(err => {
      console.error('[fozikio] Report error:', err);
      process.exit(1);
    });
    break;

  case 'maintain':
    runMaintain(rest).catch(err => {
      console.error('[fozikio] Maintain error:', err);
      process.exit(1);
    });
    break;

  case 'help':
  case '--help':
  case '-h':
    printHelp();
    break;

  case undefined:
    console.error('[fozikio] No command provided.\n');
    printHelp();
    process.exit(1);
    break;

  default:
    console.error(`[fozikio] Unknown command: ${command}\n`);
    printHelp();
    process.exit(1);
}
