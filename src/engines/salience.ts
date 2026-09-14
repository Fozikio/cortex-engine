/**
 * Salience is stored on a 0–1 scale everywhere: memories, observations, the
 * ranking factor in query and context, the FSRS-weighted L0 context tier.
 *
 * Two writers predated that and scored on 1–10: the digest document scorer
 * (`detectSalience` returned 5–7 and its chunk / reflect / predict steps
 * subtracted whole points from it) and the reflect tool (a literal 6). Their
 * values went into the store unchanged and, because the ranking factor is
 * `0.5 + salience * 0.5`, a memory minted from one of them outranked every
 * properly scored neighbour by up to 5x regardless of relevance. On one live
 * store 15 of 679 memories and 70 of 3,222 observations carried 3–9.
 *
 * A value above 1 can only be that legacy scale, so it is divided by 10.
 * Everything else is clamped to [0, 1]. Non-numbers take the fallback.
 */
export function normalizeSalience(value: unknown, fallback = 0.5): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const scaled = value > 1 ? value / 10 : value;
  return Math.max(0, Math.min(1, scaled));
}

/** True when a stored salience is on the legacy 1–10 scale or otherwise outside [0, 1]. */
export function isOutOfRangeSalience(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && (value < 0 || value > 1);
}
