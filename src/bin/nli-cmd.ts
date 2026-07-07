/**
 * fozikio nli — run the bundled NLI cross-encoder service from an installed
 * package, no repo clone required.
 *
 * The Python service ships in the npm package under scripts/nli-service/.
 * On first run this creates a virtualenv at ~/.fozikio/nli-venv, installs
 * the service's requirements into it, and starts the server; later runs
 * reuse the venv. The venv lives outside node_modules so package
 * reinstalls/upgrades don't wipe the (large) torch install.
 *
 * Flags:
 *   --port <n>       Listen port (default 11435 — matches LocalNLIProvider)
 *   --host <addr>    Bind address (default 127.0.0.1; keep loopback — no auth)
 *   --model <id>     HF cross-encoder id (default cross-encoder/nli-roberta-base)
 *   --venv <dir>     Virtualenv location (default ~/.fozikio/nli-venv)
 *   --reinstall      Recreate the virtualenv from scratch
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Directory holding serve.py/requirements.txt, resolved relative to dist/bin/. */
export function serviceDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'nli-service');
}

/** Path to the python executable inside a venv, per platform. */
export function venvPython(venvDir: string): string {
  return process.platform === 'win32'
    ? join(venvDir, 'Scripts', 'python.exe')
    : join(venvDir, 'bin', 'python');
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

function parseFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

export async function runNliCmd(args: string[]): Promise<void> {
  const service = serviceDir();
  const servePy = join(service, 'serve.py');
  if (!existsSync(servePy)) {
    console.error(`[fozikio nli] Bundled service not found at ${servePy}.`);
    console.error('[fozikio nli] Reinstall @fozikio/cortex-engine (>= the version that ships scripts/nli-service).');
    process.exit(1);
  }

  const venvDir = parseFlag(args, '--venv') ?? join(homedir(), '.fozikio', 'nli-venv');
  const port = parseFlag(args, '--port') ?? '11435';
  const host = parseFlag(args, '--host') ?? '127.0.0.1';
  const model = parseFlag(args, '--model');
  const reinstall = args.includes('--reinstall');

  if (reinstall && existsSync(venvDir)) {
    console.error(`[fozikio nli] Removing ${venvDir} for reinstall...`);
    rmSync(venvDir, { recursive: true, force: true });
  }

  const python = venvPython(venvDir);

  if (!existsSync(python)) {
    const system = findSystemPython();
    if (!system) {
      console.error('[fozikio nli] Python 3 not found. Install it (https://www.python.org/downloads/) and re-run.');
      process.exit(1);
    }

    console.error(`[fozikio nli] First run — creating virtualenv at ${venvDir}...`);
    const venv = spawnSync(system[0], [...system.slice(1), '-m', 'venv', venvDir], { stdio: 'inherit' });
    if (venv.status !== 0) {
      console.error('[fozikio nli] Failed to create virtualenv.');
      process.exit(1);
    }

    console.error('[fozikio nli] Installing requirements (torch is large — this can take a few minutes)...');
    const pip = spawnSync(
      python,
      ['-m', 'pip', 'install', '-r', join(service, 'requirements.txt')],
      { stdio: 'inherit' },
    );
    if (pip.status !== 0) {
      // Leave no half-provisioned venv behind — the next run would trust it.
      rmSync(venvDir, { recursive: true, force: true });
      console.error('[fozikio nli] pip install failed; virtualenv removed. Re-run to retry.');
      process.exit(1);
    }
  }

  console.error(`[fozikio nli] Starting NLI service on ${host}:${port} (first start downloads the model)...`);
  console.error(`[fozikio nli] Point cortex-engine at it: CORTEX_NLI_URL=http://${host}:${port} or nli.enabled in config.`);

  const child = spawn(python, [servePy], {
    stdio: 'inherit',
    env: {
      ...process.env,
      NLI_HOST: host,
      NLI_PORT: port,
      ...(model ? { NLI_MODEL: model } : {}),
    },
  });

  child.on('exit', (code) => process.exit(code ?? 0));
}
