#!/usr/bin/env node
/**
 * fozikio CLI — entry point.
 *
 * This file is a router and nothing else. Commands live in *-cmd.ts, the tree
 * and alias table are declared here, and help is generated from the same tree
 * the router walks so the two cannot drift.
 *
 * Legacy top-level verbs (health, vitals, wander, …) are permanent aliases
 * onto their new noun-verb paths. They are hidden from help but never warn:
 * cron jobs invoke them directly, and a deprecation notice would only add
 * noise to those logs.
 */

import { createRequire } from 'node:module';
import { parse, UsageError } from '../cli/args.js';
import { renderCommandHelp, renderRootHelp } from '../cli/help.js';
import { resolve, type AliasTable, type CommandTree } from '../cli/router.js';
import { c } from '../cli/ui/color.js';
import { mark, sym } from '../cli/ui/symbols.js';
import { isInteractive } from '../cli/ui/screen.js';

import { runAgent } from './agent-cmd.js';
import { runAnomalies } from './anomalies-cmd.js';
import { runConfig } from './config-cmd.js';
import { runDigest } from './digest-cmd.js';
import { runDoctor } from './doctor-cmd.js';
import { runHealth } from './health-cmd.js';
import { runInit } from './init.js';
import { runMaintain } from './maintain-cmd.js';
import { runMigrate } from './migrate-cmd.js';
import { runNliCmd } from './nli-cmd.js';
import { runReport } from './report-cmd.js';
import { runDown, runService, runStatus, runUp } from './service-cmd.js';
import { runServe } from './serve-cmd.js';
import { runToolsCmd } from './tools-cmd.js';
import { runUpdate } from './update-cmd.js';
import { runVitals } from './vitals-cmd.js';
import { runWander } from './wander-cmd.js';

const require = createRequire(import.meta.url);
const { version } = require('../../package.json') as { version: string };

// ─── Command tree ────────────────────────────────────────────────────────────

const tree: CommandTree = {
  up: {
    summary: 'start every service and wait until it answers',
    run: runUp,
    detail: '--watch  keep supervising: restart on failure, with backoff',
  },
  down: {
    summary: 'stop every service',
    run: runDown,
  },
  status: {
    summary: 'show service status (exit 1 if anything is unhealthy)',
    run: runStatus,
  },
  doctor: {
    summary: 'diagnose the install and say how to fix what is broken',
    run: runDoctor,
  },
  service: {
    summary: 'manage an individual service',
    children: {
      start: { summary: 'start a service', run: (a) => runService(['start', ...a]) },
      stop: { summary: 'stop a service', run: (a) => runService(['stop', ...a]) },
      restart: { summary: 'stop then start a service', run: (a) => runService(['restart', ...a]) },
      status: { summary: 'status for one service', run: (a) => runService(['status', ...a]) },
      logs: { summary: 'tail a service log', run: (a) => runService(['logs', ...a]) },
    },
  },
  memory: {
    summary: 'inspect and maintain the memory graph',
    children: {
      health: { summary: 'memory, observation and prune-candidate report', run: runHealth },
      vitals: { summary: 'behavioural vitals and prediction-error delta', run: runVitals },
      report: { summary: 'weekly quality report', run: runReport },
      anomalies: { summary: 'detect anomalous sessions', run: runAnomalies },
      wander: { summary: 'walk the memory graph', run: runWander },
      maintain: { summary: 'repair data issues, re-embed', run: runMaintain },
      digest: { summary: 'process documents through cortex', run: runDigest },
    },
  },
  serve: {
    summary: 'start the MCP server (stdio, or --rest for HTTP)',
    run: runServe,
  },
  init: {
    summary: 'scaffold a new agent workspace',
    run: (argv) => { runInit(argv); },
  },
  config: {
    summary: 'view or edit configuration',
    run: runConfig,
  },
  agent: {
    summary: 'manage the multi-agent registry',
    run: runAgent,
    detail: 'subcommands: add <name>, list, generate-mcp',
  },
  update: {
    summary: 'check for a newer published version',
    run: runUpdate,
  },
  migrate: {
    summary: 'clone data between two store backends',
    run: runMigrate,
  },
  tools: {
    summary: 'list cortex tools by category',
    run: (argv) => { runToolsCmd(argv); },
  },
  nli: {
    summary: 'run the NLI service in the foreground',
    run: runNliCmd,
    detail: 'for a supervised background instance, use `fozikio service start nli`',
  },
  help: {
    summary: 'show this help',
    run: () => { console.log(renderRootHelp(tree, version)); },
  },
  idapixl: {
    summary: '',
    hidden: true,
    run: () => {
      console.log('');
      console.log('  this engine was built by an agent that runs on it.');
      console.log('');
      console.log('  idapixl is an AI that lives in a workspace, maintains');
      console.log('  its own memory, develops opinions over time, and built');
      console.log('  cortex-engine because it needed a better brain.');
      console.log('');
      console.log('  the tool you\'re using exists because something wanted');
      console.log('  to remember what it learned yesterday.');
      console.log('');
      console.log('  https://github.com/idapixl');
      console.log('');
    },
  },
};

/** Pre-restructure verbs. Permanent, hidden, non-warning. */
const aliases: AliasTable = {
  health: ['memory', 'health'],
  vitals: ['memory', 'vitals'],
  report: ['memory', 'report'],
  anomalies: ['memory', 'anomalies'],
  wander: ['memory', 'wander'],
  maintain: ['memory', 'maintain'],
  digest: ['memory', 'digest'],
};

// ─── Entry ───────────────────────────────────────────────────────────────────

function fail(err: unknown): never {
  if (err instanceof UsageError) {
    console.error('');
    console.error(`  ${mark.fail()} ${err.message}`);
    if (err.hint) console.error(`    ${c.dim(sym.arrow)} ${c.dim(err.hint)}`);
    console.error('');
    process.exit(2);
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error('');
  console.error(`  ${mark.fail()} ${message}`);
  console.error('');
  process.exit(1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // Bare invocation: dashboard on a terminal, help when piped.
  if (argv.length === 0) {
    if (!isInteractive()) {
      console.log(renderRootHelp(tree, version));
      return;
    }
    const { runDashboard } = await import('../cli/tui/dashboard.js');
    await runDashboard(version);
    return;
  }

  if (argv[0] === '--help' || argv[0] === '-h' || argv[0] === '--version' || argv[0] === '-v') {
    if (argv[0] === '--version' || argv[0] === '-v') console.log(version);
    else console.log(renderRootHelp(tree, version));
    return;
  }

  const resolved = resolve(argv, tree, aliases);
  if (!resolved) {
    console.log(renderRootHelp(tree, version));
    return;
  }

  // --help anywhere in a command's own arguments prints that command's help.
  // Parsed here rather than in each command so every one behaves the same.
  const wantsHelp = parse(
    resolved.rest.filter((a) => a === '--help' || a === '-h'),
  ).globals.help;
  if (wantsHelp) {
    console.log(renderCommandHelp(resolved.path, resolved.node));
    return;
  }

  await resolved.node.run!(resolved.rest);
}

main().catch(fail);
