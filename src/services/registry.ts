/**
 * registry.ts — declarative service definitions.
 *
 * One registry backs `doctor`, `status`, `up`, `service` and the dashboard.
 * Adding a service means adding an entry here, not touching four code paths.
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  defaultVenvDir, findSystemPython, serviceDir, serviceFilesPresent, venvPython, venvReady,
} from './nli-env.js';

export type ServiceId = 'ollama' | 'nli';

export interface Diagnostic {
  level: 'ok' | 'warn' | 'error';
  message: string;
  /** Concrete command or action that resolves this. */
  fix?: string;
}

export interface LaunchSpec {
  cmd: string;
  args: string[];
  env?: Record<string, string>;
}

export interface ServiceDef {
  id: ServiceId;
  label: string;
  /** What breaks when this is down. Shown by doctor. */
  impact: string;
  /** Endpoint proving the service answers. */
  probeUrl(): string;
  probeTimeoutMs: number;
  /** How long to wait after spawn before declaring failure. */
  readyTimeoutMs: number;
  /**
   * Resolve the launch command, or null when this service cannot be
   * supervised locally (e.g. pointed at a remote host).
   */
  launch(): LaunchSpec | null;
  /** Environment checks run before a spawn is attempted. */
  preflight(): Promise<Diagnostic[]>;
}

// ─── Binary resolution ───────────────────────────────────────────────────────

/** Locate an executable on PATH without shelling out to a shell. */
function which(bin: string): string | null {
  const probe = process.platform === 'win32'
    ? spawnSync('where', [bin], { stdio: 'pipe', shell: false })
    : spawnSync('which', [bin], { stdio: 'pipe', shell: false });
  if (probe.status !== 0) return null;
  const first = String(probe.stdout).split(/\r?\n/).find((l) => l.trim() !== '');
  return first ? first.trim() : null;
}

function ollamaUrl(): string {
  return process.env.OLLAMA_URL ?? 'http://localhost:11434';
}

/** A URL we can supervise: loopback only. Remote hosts are probe-only. */
function isLocal(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

function ollamaBinary(): string | null {
  return process.env.FOZIKIO_OLLAMA_BIN ?? which('ollama');
}

// ─── ollama ──────────────────────────────────────────────────────────────────

const ollama: ServiceDef = {
  id: 'ollama',
  label: 'ollama',
  impact: 'embeddings and LLM calls — query, observe, wonder and dream all fail without it',
  probeUrl: () => `${ollamaUrl().replace(/\/$/, '')}/api/tags`,
  probeTimeoutMs: 2000,
  readyTimeoutMs: 15_000,

  launch() {
    if (!isLocal(ollamaUrl())) return null; // remote instance — not ours to run
    const bin = ollamaBinary();
    if (!bin) return null;
    return { cmd: bin, args: ['serve'] };
  },

  async preflight() {
    const out: Diagnostic[] = [];
    const url = ollamaUrl();

    if (!isLocal(url)) {
      out.push({
        level: 'warn',
        message: `OLLAMA_URL points at ${url} — remote, so it cannot be started locally`,
        fix: 'unset OLLAMA_URL to supervise a local instance',
      });
      return out;
    }

    const bin = ollamaBinary();
    if (!bin) {
      out.push({
        level: 'error',
        message: 'ollama executable not found on PATH',
        fix: 'install from https://ollama.com/download, or set FOZIKIO_OLLAMA_BIN to its full path',
      });
      return out;
    }
    out.push({ level: 'ok', message: `ollama binary at ${bin}` });
    return out;
  },
};

// ─── nli ─────────────────────────────────────────────────────────────────────

function nliUrl(): string {
  return process.env.CORTEX_NLI_URL ?? 'http://127.0.0.1:11435';
}

const nli: ServiceDef = {
  id: 'nli',
  label: 'nli',
  impact: 'contradiction adjudication — without it, cortex silently falls back to the LLM',
  probeUrl: () => `${nliUrl().replace(/\/$/, '')}/health`,
  probeTimeoutMs: 2000,
  // First start loads a cross-encoder from disk, and the very first ever run
  // downloads it. 3 minutes, not the 15s ollama gets.
  readyTimeoutMs: 180_000,

  launch() {
    if (!isLocal(nliUrl())) return null;
    if (!venvReady() || !serviceFilesPresent()) return null;

    const url = new URL(nliUrl());
    const env: Record<string, string> = {
      NLI_HOST: url.hostname,
      NLI_PORT: url.port || '11435',
    };
    if (process.env.NLI_MODEL) env.NLI_MODEL = process.env.NLI_MODEL;

    return {
      cmd: venvPython(defaultVenvDir()),
      args: [join(serviceDir(), 'serve.py')],
      env,
    };
  },

  async preflight() {
    const out: Diagnostic[] = [];
    const url = nliUrl();

    if (!isLocal(url)) {
      out.push({
        level: 'warn',
        message: `CORTEX_NLI_URL points at ${url} — remote, so it cannot be started locally`,
      });
      return out;
    }

    if (!serviceFilesPresent()) {
      out.push({
        level: 'error',
        message: 'bundled NLI service files are missing from the package',
        fix: 'reinstall @fozikio/cortex-engine',
      });
      return out;
    }

    if (!venvReady()) {
      const python = findSystemPython();
      if (!python) {
        out.push({
          level: 'error',
          message: 'Python 3 not found, and the NLI virtualenv does not exist yet',
          fix: 'install Python 3 from https://www.python.org/downloads/, then run `fozikio service start nli`',
        });
      } else {
        out.push({
          level: 'warn',
          message: 'NLI virtualenv not provisioned yet',
          fix: 'run `fozikio nli` once — it installs torch, which takes a few minutes',
        });
      }
      return out;
    }

    out.push({ level: 'ok', message: `NLI virtualenv at ${defaultVenvDir()}` });
    return out;
  },
};

// ─── Registry ────────────────────────────────────────────────────────────────

export const SERVICES: Record<ServiceId, ServiceDef> = { ollama, nli };

export const SERVICE_IDS: ServiceId[] = ['ollama', 'nli'];

export function isServiceId(value: string): value is ServiceId {
  return (SERVICE_IDS as string[]).includes(value);
}

/** Resolve a CLI target ("all", or a service id) to definitions. */
export function resolveTargets(target?: string): ServiceDef[] {
  if (!target || target === 'all') return SERVICE_IDS.map((id) => SERVICES[id]);
  if (!isServiceId(target)) {
    throw new Error(`unknown service "${target}" — valid: ${SERVICE_IDS.join(', ')}, all`);
  }
  return [SERVICES[target]];
}
