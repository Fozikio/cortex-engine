/**
 * commands.ts — the command tree and alias table.
 *
 * Separated from bin/cli.ts so the tree is importable: the interactive shell,
 * help rendering and tests all need it, and bin/cli.ts is a script that runs
 * on import. Keeping it here also leaves the entry point a pure router.
 */

import { runAgent } from '../bin/agent-cmd.js';
import { runAnomalies } from '../bin/anomalies-cmd.js';
import { runConfig } from '../bin/config-cmd.js';
import { runDigest } from '../bin/digest-cmd.js';
import { runDoctor } from '../bin/doctor-cmd.js';
import { runHealth } from '../bin/health-cmd.js';
import { runInit } from '../bin/init.js';
import { runMaintain } from '../bin/maintain-cmd.js';
import { runMigrate } from '../bin/migrate-cmd.js';
import { runNliCmd } from '../bin/nli-cmd.js';
import { runReport } from '../bin/report-cmd.js';
import { runDown, runService, runStatus, runUp } from '../bin/service-cmd.js';
import { runServe } from '../bin/serve-cmd.js';
import { runToolsCmd } from '../bin/tools-cmd.js';
import { runUpdate } from '../bin/update-cmd.js';
import { runVitals } from '../bin/vitals-cmd.js';
import { runWander } from '../bin/wander-cmd.js';
import { renderRootHelp } from './help.js';
import type { AliasTable, CommandTree } from './router.js';

export function buildTree(version: string): CommandTree {
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
    dashboard: {
      summary: 'live service and memory view',
      run: async () => {
        const { runDashboard } = await import('./tui/dashboard.js');
        await runDashboard(version);
      },
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
  return tree;
}

/**
 * Pre-restructure verbs. Permanent, hidden, non-warning — cron jobs and
 * published docs invoke these directly.
 */
export const ALIASES: AliasTable = {
  health: ['memory', 'health'],
  vitals: ['memory', 'vitals'],
  report: ['memory', 'report'],
  anomalies: ['memory', 'anomalies'],
  wander: ['memory', 'wander'],
  maintain: ['memory', 'maintain'],
  digest: ['memory', 'digest'],
};
