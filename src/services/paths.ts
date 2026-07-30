/**
 * paths.ts — on-disk locations for supervision state.
 *
 * Everything lives under ~/.fozikio/ alongside the NLI virtualenv, which
 * already uses that root. Deliberately outside node_modules so package
 * upgrades never discard running-service state or logs.
 */

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Root for all fozikio runtime state. Override for tests. */
export function root(): string {
  return process.env.FOZIKIO_HOME ?? join(homedir(), '.fozikio');
}

/** PID records: <id>.json */
export function runDir(): string {
  return join(root(), 'run');
}

/** Service stdout/stderr: <id>.log (+ <id>.log.1 after rotation) */
export function logDir(): string {
  return join(root(), 'logs');
}

export function pidFile(id: string): string {
  return join(runDir(), `${id}.json`);
}

export function logFile(id: string): string {
  return join(logDir(), `${id}.log`);
}

/** Create the state directories if absent. Safe to call repeatedly. */
export function ensureDirs(): void {
  mkdirSync(runDir(), { recursive: true });
  mkdirSync(logDir(), { recursive: true });
}
