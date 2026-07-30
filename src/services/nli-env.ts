/**
 * nli-env.ts — virtualenv discovery for the bundled NLI service.
 *
 * Moved out of bin/nli-cmd.ts so the service registry, doctor and supervisor
 * can reason about NLI provisioning without importing a command module.
 * nli-cmd.ts re-exports these for its existing callers and tests.
 *
 * Path note: serviceDir() resolves relative to the compiled file's directory.
 * dist/services/ and dist/bin/ sit at the same depth under dist/, so '../../'
 * lands on the package root either way.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Directory holding serve.py and requirements.txt. */
export function serviceDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'nli-service');
}

/** Path to the python executable inside a venv, per platform. */
export function venvPython(venvDir: string): string {
  return process.platform === 'win32'
    ? join(venvDir, 'Scripts', 'python.exe')
    : join(venvDir, 'bin', 'python');
}

/** Default virtualenv location. */
export function defaultVenvDir(): string {
  return join(homedir(), '.fozikio', 'nli-venv');
}

/** Find a usable system Python 3 launcher. Returns null if none responds. */
export function findSystemPython(): string[] | null {
  const candidates: string[][] = process.platform === 'win32'
    ? [['py', '-3'], ['python'], ['python3']]
    : [['python3'], ['python']];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate[0], [...candidate.slice(1), '--version'], {
      stdio: 'pipe', shell: false,
    });
    if (probe.status === 0 && /Python 3/.test(String(probe.stdout) + String(probe.stderr))) {
      return candidate;
    }
  }
  return null;
}

/** Whether the virtualenv exists and holds a python executable. */
export function venvReady(venvDir = defaultVenvDir()): boolean {
  return existsSync(venvPython(venvDir));
}

/** Whether the npm package actually shipped the python service. */
export function serviceFilesPresent(): boolean {
  return existsSync(join(serviceDir(), 'serve.py'));
}
