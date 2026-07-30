/**
 * doctor-cmd.ts — `fozikio doctor`.
 *
 * Answers "why isn't my install working?" and, for every failure, says what to
 * run next. A check that reports a problem without a remedy is only half a
 * diagnosis, so every non-ok result carries a `fix`.
 *
 * Exits 1 when any check fails, so it works as a cron gate.
 */

import { existsSync } from 'node:fs';
import { parse } from '../cli/args.js';
import { c } from '../cli/ui/color.js';
import { mark, sym } from '../cli/ui/symbols.js';
import { loadConfig } from './config-loader.js';
import { SERVICE_IDS, SERVICES, type Diagnostic } from '../services/registry.js';
import { status } from '../services/supervisor.js';

interface Check {
  group: string;
  label: string;
  level: 'ok' | 'warn' | 'error';
  detail?: string;
  fix?: string;
}

// ─── Runtime ─────────────────────────────────────────────────────────────────

function checkNode(): Check {
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 20) {
    return { group: 'runtime', label: 'node', level: 'ok', detail: `v${process.versions.node}` };
  }
  return {
    group: 'runtime',
    label: 'node',
    level: 'error',
    detail: `v${process.versions.node} is below the supported floor`,
    fix: 'upgrade to Node 20 or newer',
  };
}

// ─── Config + store ──────────────────────────────────────────────────────────

function checkConfig(): Check[] {
  const out: Check[] = [];
  try {
    const config = loadConfig();
    out.push({
      group: 'config',
      label: 'config.yaml',
      level: 'ok',
      detail: `store=${config.store} embed=${config.embed} llm=${config.llm}`,
    });

    if (config.store === 'sqlite') {
      const sqlitePath = config.store_options?.sqlite_path ?? './cortex.db';
      out.push(existsSync(sqlitePath)
        ? { group: 'config', label: 'store', level: 'ok', detail: sqlitePath }
        : {
          group: 'config',
          label: 'store',
          level: 'warn',
          detail: `${sqlitePath} does not exist yet`,
          fix: 'it is created on first write — run `fozikio memory health` to initialise',
        });
    }

    // Adjudication silently degrades to the LLM when the service is running
    // but nothing is configured to reach it, which is invisible at runtime.
    const nliUrl = process.env.CORTEX_NLI_URL ?? config.nli?.url;
    if (config.nli?.enabled && !nliUrl) {
      out.push({
        group: 'config',
        label: 'nli',
        level: 'warn',
        detail: 'enabled but no url configured — adjudication falls back to the LLM',
        fix: 'set nli.url in config.yaml, or CORTEX_NLI_URL in the environment',
      });
    } else if (config.nli?.enabled) {
      out.push({ group: 'config', label: 'nli', level: 'ok', detail: `adjudicating via ${nliUrl}` });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    out.push({
      group: 'config',
      label: 'config.yaml',
      level: 'error',
      detail: msg.includes('ENOENT') || msg.includes('not found') ? 'not found' : msg,
      fix: 'run `fozikio init` to scaffold a workspace',
    });
  }
  return out;
}

// ─── Services ────────────────────────────────────────────────────────────────

function fromDiagnostic(group: string, label: string, d: Diagnostic): Check {
  return { group, label, level: d.level, detail: d.message, fix: d.fix };
}

async function checkServices(): Promise<Check[]> {
  const out: Check[] = [];

  for (const id of SERVICE_IDS) {
    const def = SERVICES[id];

    for (const diagnostic of await def.preflight()) {
      out.push(fromDiagnostic('services', def.label, diagnostic));
    }

    const s = await status(def);
    if (s.state === 'up') {
      out.push({
        group: 'services',
        label: def.label,
        level: 'ok',
        detail: `responding on ${s.url} in ${s.probe.latencyMs}ms`,
      });
    } else if (s.state === 'degraded') {
      out.push({
        group: 'services',
        label: def.label,
        level: 'error',
        detail: s.detail,
        fix: `run \`fozikio service restart ${def.id}\``,
      });
    } else {
      out.push({
        group: 'services',
        label: def.label,
        level: 'error',
        detail: `not responding on ${s.url} ${sym.bullet} ${def.impact}`,
        fix: s.supervisable
          ? `run \`fozikio service start ${def.id}\``
          : 'cannot be started from here — see the warnings above',
      });
    }
  }
  return out;
}

// ─── Render ──────────────────────────────────────────────────────────────────

function glyphFor(level: Check['level']): string {
  return level === 'ok' ? mark.ok() : level === 'warn' ? mark.warn() : mark.fail();
}

function render(checks: Check[]): void {
  let currentGroup = '';
  console.log('');
  for (const check of checks) {
    if (check.group !== currentGroup) {
      currentGroup = check.group;
      console.log(`  ${c.bold(currentGroup.toUpperCase())}`);
    }
    const detail = check.detail ? ` ${c.dim(check.detail)}` : '';
    console.log(`   ${glyphFor(check.level)} ${check.label}${detail}`);
    if (check.fix && check.level !== 'ok') {
      console.log(`     ${c.dim(sym.arrow)} ${c.cyan(check.fix)}`);
    }
  }
  console.log('');

  const failed = checks.filter((ch) => ch.level === 'error').length;
  const warned = checks.filter((ch) => ch.level === 'warn').length;

  if (failed === 0 && warned === 0) {
    console.log(`  ${mark.ok()} ${c.green('everything checks out')}`);
  } else {
    const parts: string[] = [];
    if (failed) parts.push(c.red(`${failed} problem${failed === 1 ? '' : 's'}`));
    if (warned) parts.push(c.yellow(`${warned} warning${warned === 1 ? '' : 's'}`));
    console.log(`  ${parts.join(c.dim(' · '))}`);
  }
  console.log('');
}

export async function runDoctor(argv: string[]): Promise<void> {
  const parsed = parse(argv);

  const checks: Check[] = [
    checkNode(),
    ...checkConfig(),
    ...(await checkServices()),
  ];

  if (parsed.globals.json) {
    console.log(JSON.stringify({
      ok: !checks.some((ch) => ch.level === 'error'),
      checks,
    }, null, 2));
  } else {
    render(checks);
  }

  if (checks.some((ch) => ch.level === 'error')) process.exitCode = 1;
}
