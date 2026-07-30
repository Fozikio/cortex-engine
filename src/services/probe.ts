/**
 * probe.ts — HTTP liveness checks.
 *
 * The probe is the authority on whether a service is up. This is the central
 * rule of the supervision design, and it comes from the failure that motivated
 * it: the ollama process stays alive while :11434 stops answering. A
 * PID-liveness check reports healthy straight through that fault, so a
 * responding endpoint — not a live process — is what "up" means here.
 */

export interface ProbeResult {
  ok: boolean;
  /** Round-trip in ms, when a response arrived. */
  latencyMs?: number;
  status?: number;
  error?: string;
}

/** GET `url`, treating any 2xx/3xx as alive. */
export async function probe(url: string, timeoutMs = 2000): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      // A probe must never be served from a cache.
      headers: { 'cache-control': 'no-cache' },
    });
    return {
      ok: res.status < 400,
      latencyMs: Date.now() - started,
      status: res.status,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Normalise the common cases so callers can present them plainly.
    const error =
      /abort|timeout/i.test(message) ? `timed out after ${timeoutMs}ms`
      : /ECONNREFUSED|fetch failed/i.test(message) ? 'connection refused'
      : message;
    return { ok: false, latencyMs: Date.now() - started, error };
  }
}

/**
 * Poll `url` until it answers or `timeoutMs` elapses.
 * Returns the successful result, or the last failure.
 */
export async function waitUntilReady(
  url: string,
  timeoutMs: number,
  intervalMs = 250,
  onTick?: (elapsedMs: number) => void,
): Promise<ProbeResult> {
  const deadline = Date.now() + timeoutMs;
  let last: ProbeResult = { ok: false, error: 'not started' };

  while (Date.now() < deadline) {
    last = await probe(url, Math.min(2000, timeoutMs));
    if (last.ok) return last;
    onTick?.(timeoutMs - (deadline - Date.now()));
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return last;
}
