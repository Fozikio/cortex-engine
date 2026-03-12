/**
 * FSRS-6 — Free Spaced Repetition Scheduler.
 *
 * Pure math, zero dependencies. Extracted from idapixl-cortex/src/engines/memory.ts.
 *
 * FSRS-6 uses a power-law decay model to predict recall probability
 * and schedule optimal review intervals. Each memory has:
 * - stability: expected days until recall probability drops to 90%
 * - difficulty: 1-10 scale of how hard the memory is to retain
 * - state: new → learning → review → relearning lifecycle
 *
 * Rating scale: 1=Again, 2=Hard, 3=Good, 4=Easy
 */

import type { FSRSData, FSRSState, ScheduleResult } from '../core/types.js';

// ─── FSRS-6 Constants ─────────────────────────────────────────────────────────

/** Default FSRS-6 weights (w[0]..w[20]) from the open-source paper. */
export const FSRS_WEIGHTS: readonly number[] = [
  0.4072, 1.1829, 3.1262, 15.4722,
  7.2102, 0.5316, 1.0651, 0.0589,
  1.506, 0.14, 1.0036, 1.9395,
  0.11, 0.2918, 0.5, 1.0, 2.0, 0.0, 0.0, 0.0, 0.0,
];

export const DESIRED_RETENTION = 0.9;

const DECAY = -0.5;
const FACTOR = Math.pow(0.9, 1 / DECAY) - 1;

// ─── Core Functions ───────────────────────────────────────────────────────────

/**
 * Probability of recall after `elapsed_days` with given `stability`.
 * Decays from 1.0 toward 0 following a power curve.
 */
export function retrievability(stability: number, elapsed_days: number): number {
  return Math.pow(1 + FACTOR * elapsed_days / stability, DECAY);
}

/**
 * New difficulty after a review with a given rating.
 */
function updateDifficulty(d: number, rating: 1 | 2 | 3 | 4): number {
  const delta = -FSRS_WEIGHTS[6] * (rating - 3);
  const mean_reversion = FSRS_WEIGHTS[7] * (FSRS_WEIGHTS[4] - d);
  return Math.min(10, Math.max(1, d + delta + mean_reversion));
}

/**
 * Stability after a successful recall (short-term memory strengthening).
 */
function stabilityAfterRecall(
  d: number, s: number, r: number, rating: 1 | 2 | 3 | 4
): number {
  const hard_penalty = rating === 2 ? FSRS_WEIGHTS[15] : 1;
  const easy_bonus = rating === 4 ? FSRS_WEIGHTS[16] : 1;
  return s * (
    Math.exp(FSRS_WEIGHTS[8]) *
    (11 - d) *
    Math.pow(s, -FSRS_WEIGHTS[9]) *
    (Math.exp((1 - r) * FSRS_WEIGHTS[10]) - 1) *
    hard_penalty * easy_bonus
  ) + s;
}

/**
 * Stability after forgetting (relearning curve).
 */
function stabilityAfterForgetting(d: number, s: number, r: number): number {
  return FSRS_WEIGHTS[11] *
    Math.pow(d, -FSRS_WEIGHTS[12]) *
    (Math.pow(s + 1, FSRS_WEIGHTS[13]) - 1) *
    Math.exp((1 - r) * FSRS_WEIGHTS[14]);
}

/**
 * Initial stability for a new card rated 1-4 on first review.
 */
export function initialStability(rating: 1 | 2 | 3 | 4): number {
  return Math.max(FSRS_WEIGHTS[rating - 1], 0.1);
}

/**
 * Schedule the next review for a memory given a rating.
 * Returns updated FSRS fields and the next interval in days.
 *
 * @param fsrs - Current FSRS state of the memory
 * @param rating - Review quality: 1=Again, 2=Hard, 3=Good, 4=Easy
 * @param elapsed_days - Days since last review (0 for new memories)
 */
export function scheduleNext(
  fsrs: FSRSData,
  rating: 1 | 2 | 3 | 4,
  elapsed_days: number = 0
): ScheduleResult {
  let stability: number;
  let difficulty: number;
  let state: FSRSState;

  if (fsrs.state === 'new') {
    stability = initialStability(rating);
    difficulty = FSRS_WEIGHTS[4] - FSRS_WEIGHTS[5] * (rating - 3);
    state = rating === 1 ? 'relearning' : 'learning';
  } else {
    const r = retrievability(fsrs.stability, elapsed_days);
    difficulty = updateDifficulty(fsrs.difficulty, rating);

    if (rating === 1) {
      stability = stabilityAfterForgetting(difficulty, fsrs.stability, r);
      state = 'relearning';
    } else {
      stability = stabilityAfterRecall(difficulty, fsrs.stability, r, rating);
      state = 'review';
    }
  }

  const interval_days = Math.max(
    1,
    Math.round(stability * Math.log(DESIRED_RETENTION) / Math.log(0.9))
  );

  return { stability, difficulty, interval_days, state };
}

/**
 * Calculate elapsed days between a date and now.
 */
export function elapsedDaysSince(date: Date | null): number {
  if (!date) return 0;
  const ms = Date.now() - date.getTime();
  return ms / (1000 * 60 * 60 * 24);
}

/**
 * Create fresh FSRS state for a new memory.
 */
export function newFSRSState(): FSRSData {
  return {
    stability: FSRS_WEIGHTS[2],
    difficulty: FSRS_WEIGHTS[4],
    reps: 0,
    lapses: 0,
    state: 'new',
    last_review: null,
  };
}
