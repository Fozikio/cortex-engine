/**
 * supervisor.ts — start, stop and inspect the local daemons.
 *
 * Two rules drive the implementation:
 *
 *   1. The probe decides. A process that is alive but not answering is
 *      `degraded`, not `up` — that is precisely the fault this exists to catch.
 *   2. PID records are untrusted until corroborated. PIDs are reused, so a
 *      record only counts when the process is alive *and* the endpoint answers.
 *
 * Windows note: `detached: true` does not create a POSIX process group, so
 * `process.kill(-pid)` is not portable. Stop is platform-split accordingly.
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { ensureDirs, logFile, pidFile } from './paths.js';
import { probe, waitUntilReady, type ProbeResult } from './probe.js';
import type { ServiceDef } from './registry.js';

const LOG_MAX_BYTES = 8 * 1024 * 1024;
const STOP_GRACE_MS = 5000;

export interface PidRecord {
  pid: number;
  startedAt: string;
  cmd: string;
}

export type ServiceState = 'up' | 'degraded' | 'down';

export interface ServiceStatus {
  id: string;
  label: string;
  state: ServiceState;
  /** True when a fozikio-owned PID record backs this process. */
  managed: boolean;
  /** False when the service cannot be started here (remote, or missing binary). */
  supervisable: boolean;
  pid?: number;
  uptimeMs?: number;
  probe: ProbeResult;
  url: string;
  /** Human-readable explanation, especially for non-`up` states. */
  detail: string;
}

// ─── PID records ─────────────────────────────────────────────────────────────

export function readPidRecord(id: string): PidRecord | null {
  const file = pidFile(id);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as PidRecord;
    return typeof parsed?.pid === 'number' ? parsed : null;
  } catch {
    return null; // corrupt record — treated as absent
  }
}

function writePidRecord(id: string, record: PidRecord): void {
  ensureDirs();
  writeFileSync(pidFile(id), JSON.stringify(record, null, 2));
}

export function clearPidRecord(id: string): void {
  rmSync(pidFile(id), { force: true });
}

/** Whether a PID currently exists. Signal 0 tests without delivering. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// ─── Status ──────────────────────────────────────────────────────────────────

export async function status(def: ServiceDef): Promise<ServiceStatus> {
  const url = def.probeUrl();
  const result = await probe(url, def.probeTimeoutMs);
  const record = readPidRecord(def.id);
  const alive = record ? pidAlive(record.pid) : false;
  const supervisable = def.launch() !== null;

  // A record whose process is gone is noise — drop it so status stays truthful.
  if (record && !alive) clearPidRecord(def.id);

  const base = {
    id: def.id,
    label: def.label,
    managed: alive,
    supervisable,
    pid: alive ? record?.pid : undefined,
    uptimeMs: alive && record ? Date.now() - Date.parse(record.startedAt) : undefined,
    probe: result,
    url,
  };

  if (result.ok) {
    return {
      ...base,
      state: 'up',
      detail: alive
        ? `responding in ${result.latencyMs}ms`
        : `responding in ${result.latencyMs}ms (started outside fozikio)`,
    };
  }

  if (alive) {
    // The silent-death case: process up, endpoint dead.
    return {
      ...base,
      state: 'degraded',
      detail: `process ${record?.pid} is alive but ${url} ${result.error ?? 'is not responding'}`,
    };
  }

  return {
    ...base,
    state: 'down',
    detail: result.error ?? 'not running',
  };
}

// ─── Logs ────────────────────────────────────────────────────────────────────

function rotateIfLarge(id: string): void {
  const file = logFile(id);
  try {
    if (existsSync(file) && statSync(file).size > LOG_MAX_BYTES) {
      renameSync(file, `${file}.1`);
    }
  } catch { /* rotation is best-effort */ }
}

/** Last `lines` lines of a service log, newest last. */
export function tailLog(id: string, lines = 20): string[] {
  const file = logFile(id);
  if (!existsSync(file)) return [];
  try {
    const content = readFileSync(file, 'utf8');
    return content.split(/\r?\n/).filter((l) => l !== '').slice(-lines);
  } catch {
    return [];
  }
}

// ─── Start ───────────────────────────────────────────────────────────────────

export interface StartResult {
  ok: boolean;
  alreadyRunning: boolean;
  pid?: number;
  message: string;
  /** Log tail, included when the start failed. */
  logTail?: string[];
}

export interface StartOptions {
  /** Report progress while waiting for readiness. */
  onProgress?: (message: string) => void;
}

export async function start(def: ServiceDef, opts: StartOptions = {}): Promise<StartResult> {
  const current = await status(def);
  if (current.state === 'up') {
    return { ok: true, alreadyRunning: true, pid: current.pid, message: 'already running' };
  }

  // A degraded process will not recover on its own; clear it before respawning
  // so we do not end up with two instances fighting over the port.
  if (current.state === 'degraded') {
    opts.onProgress?.('stopping unresponsive process');
    await stop(def);
  }

  const diagnostics = await def.preflight();
  const blocker = diagnostics.find((d) => d.level === 'error');
  if (blocker) {
    return {
      ok: false,
      alreadyRunning: false,
      message: blocker.fix ? `${blocker.message} — ${blocker.fix}` : blocker.message,
    };
  }

  const spec = def.launch();
  if (!spec) {
    const warn = diagnostics.find((d) => d.level === 'warn');
    return {
      ok: false,
      alreadyRunning: false,
      message: warn?.message ?? 'cannot be started from here',
    };
  }

  ensureDirs();
  rotateIfLarge(def.id);

  const fd = openSync(logFile(def.id), 'a');
  let child;
  try {
    child = spawn(spec.cmd, spec.args, {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
      env: { ...process.env, ...spec.env },
    });
  } finally {
    // The child holds its own duplicate; the parent must not keep this open.
    closeSync(fd);
  }

  if (!child.pid) {
    return { ok: false, alreadyRunning: false, message: `failed to spawn ${spec.cmd}` };
  }

  // Detach so this process can exit without taking the service down.
  child.unref();

  writePidRecord(def.id, {
    pid: child.pid,
    startedAt: new Date().toISOString(),
    cmd: [spec.cmd, ...spec.args].join(' '),
  });

  opts.onProgress?.(`waiting for ${def.probeUrl()}`);
  const ready = await waitUntilReady(def.probeUrl(), def.readyTimeoutMs, 250);

  if (!ready.ok) {
    return {
      ok: false,
      alreadyRunning: false,
      pid: child.pid,
      message: `did not become ready within ${Math.round(def.readyTimeoutMs / 1000)}s — ${ready.error ?? 'no response'}`,
      logTail: tailLog(def.id, 20),
    };
  }

  return {
    ok: true,
    alreadyRunning: false,
    pid: child.pid,
    message: `ready in ${ready.latencyMs}ms`,
  };
}

// ─── Stop ────────────────────────────────────────────────────────────────────

export interface StopResult {
  ok: boolean;
  message: string;
}

/**
 * The kill command for a detached child on this platform.
 * Exported so tests can assert its shape without killing real processes.
 */
export function killCommand(pid: number): { cmd: string; args: string[] } | null {
  if (process.platform === 'win32') {
    // /T includes the process tree, /F forces. detached:true on Windows does
    // not give a POSIX process group, so signals to -pid are not an option.
    return { cmd: 'taskkill', args: ['/pid', String(pid), '/T', '/F'] };
  }
  return null; // POSIX uses process.kill on the group directly
}

export async function stop(def: ServiceDef): Promise<StopResult> {
  const record = readPidRecord(def.id);

  if (!record || !pidAlive(record.pid)) {
    clearPidRecord(def.id);
    const result = await probe(def.probeUrl(), def.probeTimeoutMs);
    if (result.ok) {
      return {
        ok: false,
        message: 'running but not started by fozikio — stop it where it was started',
      };
    }
    return { ok: true, message: 'not running' };
  }

  const win = killCommand(record.pid);
  if (win) {
    spawnSync(win.cmd, win.args, { stdio: 'ignore', windowsHide: true });
  } else {
    try {
      process.kill(-record.pid, 'SIGTERM');
    } catch {
      try { process.kill(record.pid, 'SIGTERM'); } catch { /* already gone */ }
    }
  }

  // Give it a grace period, then insist.
  const deadline = Date.now() + STOP_GRACE_MS;
  while (Date.now() < deadline && pidAlive(record.pid)) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (pidAlive(record.pid) && !win) {
    try { process.kill(-record.pid, 'SIGKILL'); } catch { /* already gone */ }
  }

  clearPidRecord(def.id);
  return { ok: true, message: `stopped (pid ${record.pid})` };
}

export async function restart(def: ServiceDef, opts: StartOptions = {}): Promise<StartResult> {
  await stop(def);
  return start(def, opts);
}
