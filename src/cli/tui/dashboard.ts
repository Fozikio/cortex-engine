/**
 * dashboard.ts — the live screen behind a bare `fozikio`.
 *
 * Render and data collection run on separate clocks: the frame repaints on a
 * 1s tick, while probes and store reads refresh on their own slower timers, so
 * network or SQLite latency can never stall the UI. Repaint is a full redraw —
 * at this size, diffing would be complexity without benefit.
 *
 * Vitals are deliberately absent: computing them scans a 30-day window of
 * sessions and observations, which is far too heavy for a render loop. The
 * dashboard points at `fozikio memory vitals` instead.
 */

import { c } from '../ui/color.js';
import { mark, sym, truncate } from '../ui/symbols.js';
import { Box, SINGLE } from '../ui/box.js';
import * as screen from '../ui/screen.js';
import { SERVICE_IDS, SERVICES, type ServiceDef } from '../../services/registry.js';
import { restart, start, status, stop, tailLog, type ServiceStatus } from '../../services/supervisor.js';

const RENDER_MS = 1000;
const PROBE_MS = 3000;
const STORE_MS = 15_000;
const MIN_WIDTH = 60;
const MAX_WIDTH = 78;

interface MemorySnapshot {
  memories?: number;
  unprocessed?: number;
  error?: string;
}

/** Cheap counts only — anything requiring a full scan stays out of the loop. */
async function readMemory(): Promise<MemorySnapshot> {
  try {
    const [{ loadConfig }, { createStore }] = await Promise.all([
      import('../../bin/config-loader.js'),
      import('../../bin/store-factory.js'),
    ]);
    const config = loadConfig(process.cwd());
    const store = await createStore(config, '');
    const [memories, unprocessed] = await Promise.all([
      store.countDocuments('memories'),
      store.getUnprocessedObservations(10_000).then((o) => o.length),
    ]);
    return { memories, unprocessed };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function formatUptime(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `up ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `up ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `up ${h}h ${m % 60}m`;
  return `up ${Math.floor(h / 24)}d ${h % 24}h`;
}

function port(url: string): string {
  try {
    const p = new URL(url).port;
    return p ? `:${p}` : '';
  } catch {
    return '';
  }
}

export async function runDashboard(version: string): Promise<void> {
  if (!screen.isInteractive()) {
    throw new Error('the dashboard needs an interactive terminal');
  }

  const defs: ServiceDef[] = SERVICE_IDS.map((id) => SERVICES[id]);
  let statuses: ServiceStatus[] = [];
  let memory: MemorySnapshot = {};
  let cursor = 0;
  let message = '';
  let showLogs = false;
  let busy = false;
  let running = true;

  const refreshProbes = async () => {
    statuses = await Promise.all(defs.map((d) => status(d)));
  };
  const refreshStore = async () => {
    memory = await readMemory();
  };

  const width = () => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, screen.size().cols - 2));

  const frame = (): string => {
    const w = width();
    const box = new Box(w, SINGLE);
    box.top(`fozikio ${c.dim(version)}`);
    box.blank();

    box.raw(`  ${c.bold('SERVICES')}`);
    for (let i = 0; i < defs.length; i++) {
      const s = statuses[i];
      const selected = i === cursor;
      const pointer = selected ? c.cyan(sym.arrow) : ' '.repeat(sym.arrow.length);
      if (!s) {
        box.raw(`  ${pointer} ${defs[i].label} ${c.dim('checking…')}`);
        continue;
      }
      const label = selected ? c.cyan(s.label.padEnd(8)) : s.label.padEnd(8);
      const detail = s.state === 'up' ? formatUptime(s.uptimeMs) : s.detail;
      box.raw(
        `  ${pointer} ${mark.dot(s.state)} ${label} ${c.dim(port(s.url).padEnd(7))} ` +
        c.dim(truncate(detail, Math.max(10, w - 32))),
      );
    }

    // The stdio MCP server has no daemon lifecycle — shown for orientation only.
    box.raw(`    ${c.gray(sym.dotHollow)} ${c.dim('cortex mcp  stdio    spawned per session')}`);
    box.blank();

    box.raw(`  ${c.bold('MEMORY')}`);
    if (memory.error) {
      box.raw(`    ${c.dim(truncate(memory.error, w - 6))}`);
    } else if (memory.memories === undefined) {
      box.raw(`    ${c.dim('reading…')}`);
    } else {
      box.raw(`    ${String(memory.memories)} ${c.dim('memories')}`);
      const unprocessed = memory.unprocessed ?? 0;
      const text = `${unprocessed} unprocessed`;
      box.raw(`    ${unprocessed > 0 ? c.yellow(text) : c.dim(text)}`);
    }
    box.blank();

    if (showLogs) {
      const def = defs[cursor];
      box.raw(`  ${c.bold('LOG')} ${c.dim(def.label)}`);
      const lines = tailLog(def.id, 6);
      if (lines.length === 0) box.raw(`    ${c.dim('no output yet')}`);
      else for (const line of lines) box.raw(`    ${c.dim(truncate(line, w - 6))}`);
      box.blank();
    }

    if (message) {
      box.raw(`  ${message}`);
      box.blank();
    }

    box.raw(`  ${c.dim('[s] start/stop  [r] restart  [l] logs  [d] doctor  [q] quit')}`);
    box.bottom();
    return box.toString();
  };

  const repaint = () => { if (running) screen.paint(frame()); };

  /** Run an action without letting a second keypress start a concurrent one. */
  const act = async (label: string, fn: () => Promise<{ ok: boolean; message: string }>) => {
    if (busy) return;
    busy = true;
    message = `${c.cyan(sym.arrow)} ${label}${sym.ellipsis}`;
    repaint();
    try {
      const result = await fn();
      message = `${result.ok ? mark.ok() : mark.fail()} ${label} ${c.dim(result.message)}`;
    } catch (err) {
      message = `${mark.fail()} ${label} ${c.dim(err instanceof Error ? err.message : String(err))}`;
    } finally {
      busy = false;
      await refreshProbes();
      repaint();
    }
  };

  screen.enter();

  const timers = [
    setInterval(repaint, RENDER_MS),
    setInterval(() => { void refreshProbes().then(repaint); }, PROBE_MS),
    setInterval(() => { void refreshStore(); }, STORE_MS),
  ];
  const unsubscribeResize = screen.onResize(repaint);

  const shutdown = (): void => {
    running = false;
    timers.forEach(clearInterval);
    unsubscribeResize();
    screen.restore();
  };

  /** Resolves when the user quits, or leaves for another command. */
  await new Promise<void>((resolve) => {
    screen.onKey((key) => {
      if (key === screen.KEY.CTRL_C || key === 'q') {
        shutdown();
        resolve();
        return;
      }
      if (key === screen.KEY.UP || key === 'k') {
        cursor = (cursor - 1 + defs.length) % defs.length;
        repaint();
        return;
      }
      if (key === screen.KEY.DOWN || key === 'j') {
        cursor = (cursor + 1) % defs.length;
        repaint();
        return;
      }
      if (key === 'l') { showLogs = !showLogs; repaint(); return; }
      if (key === 's') {
        const def = defs[cursor];
        const current = statuses[cursor];
        void (current?.state === 'up'
          ? act(`stopping ${def.label}`, () => stop(def))
          : act(`starting ${def.label}`, () => start(def)));
        return;
      }
      if (key === 'r') {
        const def = defs[cursor];
        void act(`restarting ${def.label}`, () => restart(def));
        return;
      }
      if (key === 'd') {
        // doctor produces a full report — hand the terminal back rather than
        // trying to squeeze it into a panel.
        shutdown();
        resolve();
        void import('../../bin/doctor-cmd.js').then((m) => m.runDoctor([]));
        return;
      }
    });

    void Promise.all([refreshProbes(), refreshStore()]).then(repaint);
  });
}
