/**
 * service-cmd.ts — `fozikio service|up|down|status`.
 *
 * All four share one status renderer so the dashboard, the one-shot table and
 * the JSON payload can never disagree about what "up" means.
 *
 * Exit codes: 0 when everything probed healthy, 1 when anything is degraded or
 * down. Cron can branch on that directly.
 */

import { parse, UsageError, type Parsed } from '../cli/args.js';
import { c } from '../cli/ui/color.js';
import { mark, sym } from '../cli/ui/symbols.js';
import { table } from '../cli/ui/table.js';
import { spin } from '../cli/ui/spinner.js';
import { resolveTargets, SERVICE_IDS, type ServiceDef } from '../services/registry.js';
import {
  restart, start, status, stop, tailLog, type ServiceStatus,
} from '../services/supervisor.js';
import { watchAll } from '../services/watchdog.js';

// ─── Formatting ──────────────────────────────────────────────────────────────

function formatUptime(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function portOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.port ? `:${parsed.port}` : '';
  } catch {
    return '';
  }
}

/** One status line, shared by `status`, `up`, `down` and `service status`. */
export function statusRow(s: ServiceStatus): string[] {
  const state = s.state === 'up' ? c.green('up')
    : s.state === 'degraded' ? c.yellow('degraded')
    : c.red('down');
  return [
    mark.dot(s.state),
    s.label,
    c.dim(portOf(s.url)),
    state,
    c.dim(formatUptime(s.uptimeMs)),
    c.dim(s.detail),
  ];
}

export function printStatusTable(statuses: ServiceStatus[]): void {
  console.log('');
  console.log(table(statuses.map(statusRow), { indent: 2, gap: 2 }));
  console.log('');
}

/** True when every service probed healthy. */
function allHealthy(statuses: ServiceStatus[]): boolean {
  return statuses.every((s) => s.state === 'up');
}

async function collect(defs: ServiceDef[]): Promise<ServiceStatus[]> {
  return Promise.all(defs.map((d) => status(d)));
}

function emitJson(statuses: ServiceStatus[]): void {
  console.log(JSON.stringify({
    healthy: allHealthy(statuses),
    services: statuses.map((s) => ({
      id: s.id,
      state: s.state,
      url: s.url,
      managed: s.managed,
      supervisable: s.supervisable,
      pid: s.pid,
      uptimeMs: s.uptimeMs,
      latencyMs: s.probe.latencyMs,
      detail: s.detail,
    })),
  }, null, 2));
}

// ─── status ──────────────────────────────────────────────────────────────────

export async function runStatus(argv: string[]): Promise<void> {
  const parsed = parse(argv);
  const target = parsed.positionals[0];
  const statuses = await collect(resolveTargets(target));

  if (parsed.globals.json) emitJson(statuses);
  else printStatusTable(statuses);

  if (!allHealthy(statuses)) process.exitCode = 1;
}

// ─── up ──────────────────────────────────────────────────────────────────────

export async function runUp(argv: string[]): Promise<void> {
  const parsed = parse(argv, { watch: { type: 'boolean', default: false } });
  const defs = resolveTargets(parsed.positionals[0]);
  const useJson = parsed.globals.json;

  for (const def of defs) {
    const spinner = useJson ? null : spin(`starting ${def.label}`);
    const result = await start(def, {
      onProgress: (msg) => spinner?.update(`${def.label} ${sym.bullet} ${msg}`),
    });

    if (result.ok) {
      spinner?.succeed(`${def.label} ${c.dim(result.message)}`);
    } else {
      spinner?.fail(`${def.label} ${c.dim(result.message)}`);
      if (result.logTail?.length && !useJson) {
        console.log('');
        for (const line of result.logTail) console.log(c.dim(`    ${line}`));
        console.log('');
      }
    }
  }

  const statuses = await collect(defs);
  if (useJson) emitJson(statuses);
  else printStatusTable(statuses);

  if (!allHealthy(statuses)) {
    process.exitCode = 1;
    return;
  }

  if (parsed.values.watch === true) {
    await runWatchLoop(defs);
  }
}

// ─── down ────────────────────────────────────────────────────────────────────

export async function runDown(argv: string[]): Promise<void> {
  const parsed = parse(argv);
  const defs = resolveTargets(parsed.positionals[0]);
  const results: { id: string; ok: boolean; message: string }[] = [];

  for (const def of defs) {
    const result = await stop(def);
    results.push({ id: def.id, ...result });
    if (!parsed.globals.json) {
      const glyph = result.ok ? mark.ok() : mark.warn();
      console.log(`  ${glyph} ${def.label} ${c.dim(result.message)}`);
    }
  }

  if (parsed.globals.json) console.log(JSON.stringify({ stopped: results }, null, 2));
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

// ─── watch ───────────────────────────────────────────────────────────────────

async function runWatchLoop(defs: ServiceDef[]): Promise<void> {
  const controller = new AbortController();
  const onSigint = () => {
    console.log(`\n  ${c.dim('watch stopped')}`);
    controller.abort();
  };
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigint);

  console.log(`  ${c.dim(`watching ${defs.map((d) => d.label).join(', ')} — ctrl-c to stop`)}`);
  console.log('');

  await watchAll(defs, {
    signal: controller.signal,
    onEvent: (event) => {
      const glyph = event.type === 'healthy' || event.type === 'restarted' ? mark.ok()
        : event.type === 'giving-up' ? mark.fail()
        : mark.warn();
      const time = new Date().toISOString().slice(11, 19);
      console.log(`  ${c.dim(time)} ${glyph} ${event.service} ${c.dim(event.message)}`);
    },
  });
}

// ─── service <verb> ──────────────────────────────────────────────────────────

async function runLogs(parsed: Parsed): Promise<void> {
  const defs = resolveTargets(parsed.positionals[1]);
  const count = Number(parsed.values.lines ?? 40);

  for (const def of defs) {
    const lines = tailLog(def.id, Number.isFinite(count) ? count : 40);
    console.log('');
    console.log(`  ${c.bold(def.label)}`);
    if (lines.length === 0) {
      console.log(`  ${c.dim('no log output yet')}`);
      continue;
    }
    for (const line of lines) console.log(`  ${c.dim(line)}`);
  }
  console.log('');
}

export async function runService(argv: string[]): Promise<void> {
  const parsed = parse(argv, {
    lines: { type: 'string' },
    watch: { type: 'boolean', default: false },
  });
  const verb = parsed.positionals[0];

  if (!verb) {
    throw new UsageError(
      'service needs a verb',
      'valid: start, stop, restart, status, logs',
    );
  }

  const targetArg = parsed.positionals[1];
  const defs = resolveTargets(targetArg);

  // Re-emit only what the delegate understands, rather than replaying raw argv
  // (a service name and a verb can collide when sliced positionally).
  const delegated = [
    ...(targetArg ? [targetArg] : []),
    ...(parsed.globals.json ? ['--json'] : []),
  ];

  switch (verb) {
    case 'status':
      return runStatus(delegated);

    case 'start': {
      for (const def of defs) {
        const spinner = spin(`starting ${def.label}`);
        const result = await start(def, {
          onProgress: (msg) => spinner.update(`${def.label} ${sym.bullet} ${msg}`),
        });
        if (result.ok) spinner.succeed(`${def.label} ${c.dim(result.message)}`);
        else {
          spinner.fail(`${def.label} ${c.dim(result.message)}`);
          process.exitCode = 1;
        }
      }
      if (parsed.values.watch === true) await runWatchLoop(defs);
      return;
    }

    case 'stop':
      return runDown(delegated);

    case 'restart': {
      for (const def of defs) {
        const spinner = spin(`restarting ${def.label}`);
        const result = await restart(def, {
          onProgress: (msg) => spinner.update(`${def.label} ${sym.bullet} ${msg}`),
        });
        if (result.ok) spinner.succeed(`${def.label} ${c.dim(result.message)}`);
        else {
          spinner.fail(`${def.label} ${c.dim(result.message)}`);
          process.exitCode = 1;
        }
      }
      return;
    }

    case 'logs':
      return runLogs(parsed);

    default:
      throw new UsageError(
        `unknown service verb: ${verb}`,
        `valid: start, stop, restart, status, logs ${sym.bullet} services: ${SERVICE_IDS.join(', ')}, all`,
      );
  }
}
