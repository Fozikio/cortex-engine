/**
 * The circuit breaker is the part of the watchdog most likely to be wrong and
 * least likely to be noticed: without it, a permanently broken service is
 * restarted forever. These tests drive the loop with fake timers so the
 * backoff schedule does not make them slow.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const probe = vi.hoisted(() => vi.fn());
const restart = vi.hoisted(() => vi.fn());

vi.mock('./probe.js', () => ({ probe, waitUntilReady: vi.fn() }));
vi.mock('./supervisor.js', () => ({ restart }));

const { watch } = await import('./watchdog.js');
const { SERVICES } = await import('./registry.js');

const def = SERVICES.nli;

/** Drive fake timers until `promise` settles, or the budget is exhausted. */
async function drain(promise: Promise<unknown>, maxTicks = 500): Promise<void> {
  let settled = false;
  void promise.then(() => { settled = true; });
  for (let i = 0; i < maxTicks && !settled; i++) {
    await vi.advanceTimersByTimeAsync(1000);
  }
  await promise;
}

beforeEach(() => {
  vi.useFakeTimers();
  probe.mockReset();
  restart.mockReset();
  delete process.env.FOZIKIO_NOTIFY_URL;
  delete process.env.FOZIKIO_NOTIFY_CMD;
});

afterEach(() => { vi.useRealTimers(); });

describe('watch', () => {
  it('gives up after five consecutive failed restarts', async () => {
    probe.mockResolvedValue({ ok: false, error: 'connection refused' });
    restart.mockResolvedValue({ ok: false, alreadyRunning: false, message: 'still broken' });

    const events: string[] = [];
    await drain(watch(def, { intervalMs: 1000, onEvent: (e) => events.push(e.type) }));

    expect(events).toContain('giving-up');
    // Five attempts and no more — the breaker must stop the loop, not slow it.
    expect(restart).toHaveBeenCalledTimes(5);
  });

  it('stops probing once aborted', async () => {
    probe.mockResolvedValue({ ok: true });
    const controller = new AbortController();

    const running = watch(def, { intervalMs: 1000, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(3000);
    const callsBeforeAbort = probe.mock.calls.length;

    controller.abort();
    await drain(running);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(probe.mock.calls.length).toBeLessThanOrEqual(callsBeforeAbort + 1);
  });

  it('reports recovery after a restart succeeds', async () => {
    // Fail once, then stay healthy.
    probe
      .mockResolvedValueOnce({ ok: false, error: 'connection refused' })
      .mockResolvedValue({ ok: true });
    restart.mockResolvedValue({ ok: true, alreadyRunning: false, message: 'ready in 20ms' });

    const events: string[] = [];
    const controller = new AbortController();
    const running = watch(def, {
      intervalMs: 1000,
      signal: controller.signal,
      onEvent: (e) => events.push(e.type),
    });

    await vi.advanceTimersByTimeAsync(20_000);
    controller.abort();
    await drain(running);

    expect(events).toContain('restarted');
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('notifies after repeated restarts rather than hiding them', async () => {
    const notified: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      notified.push(String(init?.body ?? ''));
      return new Response('ok');
    });
    vi.stubGlobal('fetch', fetchMock);
    process.env.FOZIKIO_NOTIFY_URL = 'http://localhost:9999/notify';

    // Every probe fails but every restart "succeeds" — the service flaps.
    probe.mockResolvedValue({ ok: false, error: 'connection refused' });
    restart.mockResolvedValue({ ok: true, alreadyRunning: false, message: 'ready' });

    const controller = new AbortController();
    const running = watch(def, { intervalMs: 1000, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(120_000);
    controller.abort();
    await drain(running);

    expect(notified.length).toBeGreaterThan(0);
    expect(notified[0]).toContain('keeps failing');
    vi.unstubAllGlobals();
  });
});
