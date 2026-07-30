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
import { join } from 'node:path';
import { defaultVenvDir, findSystemPython, serviceDir, venvPython } from '../services/nli-env.js';
import { rawFlag as parseFlag } from '../cli/args.js';

// Provisioning helpers moved to services/nli-env.ts so the registry, doctor and
// supervisor can use them without importing a command module. Re-exported here
// for existing callers and tests.
export { serviceDir, venvPython, findSystemPython };

export async function runNliCmd(args: string[]): Promise<void> {
  const service = serviceDir();
  const servePy = join(service, 'serve.py');
  if (!existsSync(servePy)) {
    console.error(`[fozikio nli] Bundled service not found at ${servePy}.`);
    console.error('[fozikio nli] Reinstall @fozikio/cortex-engine (>= the version that ships scripts/nli-service).');
    process.exit(1);
  }

  const venvDir = parseFlag(args, '--venv') ?? defaultVenvDir();
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
