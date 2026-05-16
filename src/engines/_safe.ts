/**
 * Safe-read helpers for cognitive engine phases.
 *
 * Replaces inline `.catch(() => fallback)` patterns that previously hid store
 * failures behind zero-result returns. These helpers log the underlying error
 * and increment a shared failure counter so callers can detect partial
 * pipeline failure via DreamResult.failures / DigestResult.failures.
 */

export interface PhaseStats {
  failures: number;
}

/**
 * Run a promise; if it rejects, log the error with a phase label, increment
 * the stats counter (if provided), and return the supplied fallback.
 */
export async function safeStoreRead<T>(
  promise: Promise<T>,
  fallback: T,
  label: string,
  stats?: PhaseStats,
): Promise<T> {
  try {
    return await promise;
  } catch (err) {
    console.error(`[safeStoreRead:${label}]`, err);
    if (stats) stats.failures++;
    return fallback;
  }
}
