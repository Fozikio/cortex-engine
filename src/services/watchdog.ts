/**
 * watchdog.ts — keep services answering.
 *
 * Restarts on probe failure with exponential backoff, and trips a circuit
 * breaker rather than looping forever. A watchdog that silently restarts a
 * daemon forty times is concealing a fault, so it escalates: after
 * NOTIFY_AFTER restarts inside the window it fires a notification.
 *
 * Notification is intentionally a generic hook rather than a hard dependency —
 * set FOZIKIO_NOTIFY_URL to receive a JSON POST, or FOZIKIO_NOTIFY_CMD to run
 * a command. Both are optional and best-effort; a failing notifier never
 * interferes with supervision.
 */

import { spawn } from 'node:child_process';
import { probe } from './probe.js';
import { restart } from './supervisor.js';
import type { ServiceDef } from './registry.js';

const PROBE_INTERVAL_MS = 10_000;
const BACKOFF_MS = [2000, 4000, 8000, 16_000, 30_000];
const MAX_CONSECUTIVE_FAILURES = 5;
const NOTIFY_AFTER = 3;

export interface WatchEvent {
  type: 'healthy' | 'failed' | 'restarting' | 'restarted' | 'giving-up';
  service: string;
  message: string;
}

export interface WatchOptions {
  onEvent?: (event: WatchEvent) => void;
  /** Stop the loop. */
  signal?: AbortSignal;
  intervalMs?: number;
}

/** Fire a best-effort notification. Never throws. */
export async function notify(title: string, message: string): Promise<void> {
  const url = process.env.FOZIKIO_NOTIFY_URL;
  if (url) {
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, message, source: 'fozikio-watchdog' }),
        signal: AbortSignal.timeout(5000),
      });
    } catch { /* notification must never break supervision */ }
  }

  const cmd = process.env.FOZIKIO_NOTIFY_CMD;
  if (cmd) {
    try {
      const child = spawn(cmd, [title, message], {
        stdio: 'ignore', detached: true, windowsHide: true, shell: true,
      });
      child.unref();
    } catch { /* same */ }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/**
 * Watch one service until aborted.
 *
 * Resolves when the signal aborts, or when the circuit breaker trips after
 * MAX_CONSECUTIVE_FAILURES failed restarts.
 */
export async function watch(def: ServiceDef, opts: WatchOptions = {}): Promise<void> {
  const interval = opts.intervalMs ?? PROBE_INTERVAL_MS;
  const emit = opts.onEvent ?? (() => {});
  let consecutiveFailures = 0;
  let restartsInWindow = 0;
  let healthy = true;

  while (!opts.signal?.aborted) {
    const result = await probe(def.probeUrl(), def.probeTimeoutMs);

    if (result.ok) {
      if (!healthy) emit({ type: 'healthy', service: def.id, message: 'recovered' });
      healthy = true;
      consecutiveFailures = 0;
      restartsInWindow = 0;
      await sleep(interval, opts.signal);
      continue;
    }

    healthy = false;
    emit({
      type: 'failed',
      service: def.id,
      message: result.error ?? 'probe failed',
    });

    const backoff = BACKOFF_MS[Math.min(consecutiveFailures, BACKOFF_MS.length - 1)];
    emit({
      type: 'restarting',
      service: def.id,
      message: `restart in ${Math.round(backoff / 1000)}s (attempt ${consecutiveFailures + 1})`,
    });
    await sleep(backoff, opts.signal);
    if (opts.signal?.aborted) return;

    const started = await restart(def);
    if (started.ok) {
      restartsInWindow += 1;
      consecutiveFailures = 0;
      healthy = true;
      emit({ type: 'restarted', service: def.id, message: started.message });

      if (restartsInWindow >= NOTIFY_AFTER) {
        await notify(
          `fozikio: ${def.label} keeps failing`,
          `${def.label} has been restarted ${restartsInWindow} times. ${def.impact}`,
        );
        restartsInWindow = 0;
      }
    } else {
      consecutiveFailures += 1;
      emit({ type: 'failed', service: def.id, message: started.message });

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        emit({
          type: 'giving-up',
          service: def.id,
          message: `${consecutiveFailures} consecutive failed restarts — not retrying`,
        });
        await notify(
          `fozikio: ${def.label} is down`,
          `Gave up after ${consecutiveFailures} failed restarts. ${started.message}`,
        );
        return;
      }
    }

    await sleep(interval, opts.signal);
  }
}

/** Watch several services concurrently. */
export async function watchAll(defs: ServiceDef[], opts: WatchOptions = {}): Promise<void> {
  await Promise.all(defs.map((def) => watch(def, opts)));
}
