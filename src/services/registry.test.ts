import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isServiceId, resolveTargets, SERVICES, SERVICE_IDS } from './registry.js';

const saved = { ...process.env };

beforeEach(() => {
  delete process.env.OLLAMA_URL;
  delete process.env.CORTEX_NLI_URL;
  delete process.env.FOZIKIO_OLLAMA_BIN;
});

afterEach(() => { process.env = { ...saved }; });

describe('target resolution', () => {
  it('defaults to every service', () => {
    expect(resolveTargets().map((d) => d.id)).toEqual(SERVICE_IDS);
    expect(resolveTargets('all').map((d) => d.id)).toEqual(SERVICE_IDS);
  });

  it('resolves a single service', () => {
    expect(resolveTargets('nli').map((d) => d.id)).toEqual(['nli']);
  });

  it('rejects an unknown service and names the valid ones', () => {
    expect(() => resolveTargets('postgres')).toThrow(/valid: ollama, nli, all/);
  });

  it('narrows unknown strings', () => {
    expect(isServiceId('ollama')).toBe(true);
    expect(isServiceId('postgres')).toBe(false);
  });
});

describe('probe urls', () => {
  it('probes an endpoint that proves the API works, not just the port', () => {
    expect(SERVICES.ollama.probeUrl()).toBe('http://localhost:11434/api/tags');
    expect(SERVICES.nli.probeUrl()).toBe('http://127.0.0.1:11435/health');
  });

  it('follows OLLAMA_URL, without doubling the slash', () => {
    process.env.OLLAMA_URL = 'http://localhost:9999/';
    expect(SERVICES.ollama.probeUrl()).toBe('http://localhost:9999/api/tags');
  });

  it('follows CORTEX_NLI_URL', () => {
    process.env.CORTEX_NLI_URL = 'http://127.0.0.1:11439';
    expect(SERVICES.nli.probeUrl()).toBe('http://127.0.0.1:11439/health');
  });
});

describe('ollama supervision', () => {
  it('prefers FOZIKIO_OLLAMA_BIN over a PATH lookup', () => {
    process.env.FOZIKIO_OLLAMA_BIN = '/custom/ollama';
    expect(SERVICES.ollama.launch()).toEqual({ cmd: '/custom/ollama', args: ['serve'] });
  });

  it('refuses to supervise a remote instance', async () => {
    // A remote ollama belongs to whoever runs it; we can probe but not manage.
    process.env.OLLAMA_URL = 'http://gpu-box.local:11434';
    process.env.FOZIKIO_OLLAMA_BIN = '/custom/ollama';
    expect(SERVICES.ollama.launch()).toBeNull();

    const diagnostics = await SERVICES.ollama.preflight();
    expect(diagnostics[0].level).toBe('warn');
    expect(diagnostics[0].message).toContain('remote');
  });

  it('treats loopback hosts as local', () => {
    process.env.FOZIKIO_OLLAMA_BIN = '/custom/ollama';
    for (const host of ['localhost', '127.0.0.1']) {
      process.env.OLLAMA_URL = `http://${host}:11434`;
      expect(SERVICES.ollama.launch()).not.toBeNull();
    }
  });
});

describe('nli supervision', () => {
  it('refuses to supervise a remote instance', async () => {
    process.env.CORTEX_NLI_URL = 'http://nli-box.local:11435';
    expect(SERVICES.nli.launch()).toBeNull();

    const diagnostics = await SERVICES.nli.preflight();
    expect(diagnostics[0].level).toBe('warn');
  });

  it('passes host and port to the python service via the environment', () => {
    process.env.CORTEX_NLI_URL = 'http://127.0.0.1:11439';
    const spec = SERVICES.nli.launch();
    // Null when the venv is not provisioned — only assert the spec when it is.
    if (spec) {
      expect(spec.env?.NLI_HOST).toBe('127.0.0.1');
      expect(spec.env?.NLI_PORT).toBe('11439');
    }
  });
});

describe('readiness budgets', () => {
  it('gives nli far longer than ollama, because it loads a model', () => {
    expect(SERVICES.nli.readyTimeoutMs).toBeGreaterThan(SERVICES.ollama.readyTimeoutMs * 5);
  });
});
