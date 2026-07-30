/**
 * Supervisor tests cover the parts that can be asserted without killing real
 * processes: PID record lifecycle, liveness, and the shape of the platform
 * stop command. The spawn/probe path is exercised end-to-end by hand against a
 * second NLI instance on a spare port.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearPidRecord, killCommand, pidAlive, readPidRecord } from './supervisor.js';
import { ensureDirs, pidFile, runDir } from './paths.js';

let home: string;
const savedHome = process.env.FOZIKIO_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'fozikio-test-'));
  process.env.FOZIKIO_HOME = home;
  ensureDirs();
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.FOZIKIO_HOME;
  else process.env.FOZIKIO_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

describe('paths', () => {
  it('honours FOZIKIO_HOME so state never lands in the real home directory', () => {
    expect(runDir().startsWith(home)).toBe(true);
  });
});

describe('PID records', () => {
  it('returns null when no record exists', () => {
    expect(readPidRecord('nli')).toBeNull();
  });

  it('round-trips a record', () => {
    const record = { pid: 4321, startedAt: new Date().toISOString(), cmd: 'python serve.py' };
    writeFileSync(pidFile('nli'), JSON.stringify(record));
    expect(readPidRecord('nli')).toEqual(record);
  });

  it('treats a corrupt record as absent rather than throwing', () => {
    // A half-written file must not crash `status`.
    writeFileSync(pidFile('nli'), '{ not json');
    expect(readPidRecord('nli')).toBeNull();
  });

  it('treats a record without a numeric pid as absent', () => {
    writeFileSync(pidFile('nli'), JSON.stringify({ startedAt: 'x', cmd: 'y' }));
    expect(readPidRecord('nli')).toBeNull();
  });

  it('clears a record', () => {
    writeFileSync(pidFile('nli'), JSON.stringify({ pid: 1, startedAt: 'x', cmd: 'y' }));
    clearPidRecord('nli');
    expect(readPidRecord('nli')).toBeNull();
  });

  it('clearing a missing record is not an error', () => {
    expect(() => clearPidRecord('ollama')).not.toThrow();
  });
});

describe('pidAlive', () => {
  it('reports this process as alive', () => {
    expect(pidAlive(process.pid)).toBe(true);
  });

  it('reports an unused pid as dead', () => {
    // PID 0 is not addressable as a normal process on either platform.
    expect(pidAlive(999_999_999)).toBe(false);
  });
});

describe('killCommand', () => {
  it('uses taskkill with a tree kill on Windows, and signals elsewhere', () => {
    const cmd = killCommand(1234);
    if (process.platform === 'win32') {
      // detached:true on Windows does not create a POSIX process group, so
      // process.kill(-pid) is not an option — /T is what reaches children.
      expect(cmd).toEqual({ cmd: 'taskkill', args: ['/pid', '1234', '/T', '/F'] });
    } else {
      expect(cmd).toBeNull();
    }
  });
});
