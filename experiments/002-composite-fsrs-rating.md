---
experiment: 002
title: Composite FSRS Rating Signal
date: 2026-03-15
status: in-progress
---

# Experiment 002: Composite FSRS Rating Signal

## Hypothesis
Replacing the binary FSRS rating (Good=3 / Hard=2) with a composite rating that incorporates retrieval score, hop count, and contradiction edges will reduce average prediction error from 0.287 toward 0.15.

## Baseline (post-experiment-001, 2026-03-15)

| Metric | Value |
|--------|-------|
| Total memories | 155 |
| FSRS review | 135 |
| FSRS relearning | 0 |
| Avg prediction error | 0.287 |
| Avg salience | 0.646 |

## Current Rating Logic (binary)
```
rating = recentlyAccessed (3 days) ? Good(3) : Hard(2)
```
No Easy(4), no Again(1). Ignores retrieval quality entirely.

## Proposed Composite Rating
```
base = recentlyAccessed ? 3 : 2
+1 if retrieval_score > 0.92 AND hop_count == 0  (direct confident match → Easy)
-1 if retrieval_score < 0.75 OR hop_count > 0     (weak/indirect → Hard)
-1 if has_contradiction_edge                       (contradicted → harder)
clamp to [1, 4]
```

## Changes Required
1. Add `last_retrieval_score` and `last_hop_count` fields to Memory type
2. Update `touchMemory` in query tool handler to pass retrieval metadata
3. Update `scoreMemories` in cognition.ts to use composite rating
4. Track contradiction edges per memory for the rating

## Measurement Protocol
1. Snapshot current PE distribution before change
2. Apply composite rating
3. Run 10 dream cycles
4. After each cycle, record: avg PE, stability median, rating distribution (1/2/3/4)
5. Compare PE trend against baseline

## Results

### Post-fix measurements

| Cycle | Date | Avg PE | Stability p50 | Rating 1 | Rating 2 | Rating 3 | Rating 4 |
|-------|------|--------|---------------|----------|----------|----------|----------|
| 0 (baseline) | 2026-03-15 | 0.287 | — | 0 | — | — | 0 |
