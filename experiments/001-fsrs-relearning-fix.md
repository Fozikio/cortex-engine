---
experiment: 001
title: FSRS Relearning State Fix
date: 2026-03-15
status: in-progress
---

# Experiment 001: FSRS Relearning State Fix

## Hypothesis
Adding `relearning` to the scoreMemories filter will unfreeze 40 stuck memories and improve FSRS state distribution over subsequent dream cycles.

## Baseline (pre-fix, 2026-03-15T11:15Z)

| Metric | Value |
|--------|-------|
| Total memories | 152 |
| FSRS new | 17 |
| FSRS learning | 0 |
| FSRS review | 95 |
| FSRS relearning | 40 |
| Avg salience | 0.646 |
| Avg prediction error | 0.287 |
| Total observations | 368 |

## Change Applied
`cognition.ts:429` — add `relearning` to reviewable filter. Also add stricter 1-day access window for relearning memories (vs 3-day for review/learning).

## Measurement Protocol
1. Run 5 dream cycles after fix
2. After each cycle, record FSRS state distribution
3. Track: relearning count, new review entries, stability distribution shifts
4. Compare PE before/after over 30 dream cycles

## Results

### Post-fix measurements

| Cycle | Date | New | Learning | Review | Relearning | Notes |
|-------|------|-----|----------|--------|------------|-------|
| 0 (baseline) | 2026-03-15 | 17 | 0 | 95 | 40 | Pre-fix |
| 1 | 2026-03-15 | 20 | 0 | 135 | **0** | All 40 relearning graduated to review. 3 new memories created by dream. |
| 2 | | | | | | |
| 3 | | | | | | |
| 4 | | | | | | |
| 5 | | | | | | |

## Cycle 1 Analysis

**Immediate result:** 40/40 relearning memories (100%) graduated to review in a single dream cycle.

This confirms the root cause: these memories were never broken or low-quality. They were simply excluded from the scoring loop by the state filter bug. Once included, the standard FSRS rating logic (Good=3 for recently accessed, Hard=2 for not) moved them all to review state.

**New memories:** 3 new memories created (152 → 155 total, 20 in `new` state vs 17 baseline). Dream Phase 3 promoted 3 unclustered observations to new memories.

**State distribution shift:**
- Before: 62.5% review, 26.3% relearning, 11.2% new
- After: 87.1% review, 0% relearning, 12.9% new

87.1% of memories now in active FSRS review cycle. This is healthy.
