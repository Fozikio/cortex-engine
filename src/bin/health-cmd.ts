/**
 * health-cmd.ts — fozikio health command.
 *
 * Outputs a combined cortex health report covering:
 *   - Memory stats (total, salience, FSRS states, stale, low-salience)
 *   - Observation stats (total, unprocessed, avg prediction error)
 *   - Prune candidates (multi-criteria scoring, dry-run by default)
 *
 * Usage:
 *   fozikio health              Print formatted health report (dry-run)
 *   fozikio health --prune      Mark prune candidates as faded (soft-delete)
 *   fozikio health --json       Output as JSON
 */

import { loadConfig } from './config-loader.js';
import { createStore } from './store-factory.js';
import type { Memory, Observation, FSRSState } from '../core/types.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const STALE_DAYS = 90;
const LOW_SALIENCE_THRESHOLD = 0.1;
const PRUNE_SALIENCE_THRESHOLD = 0.15;
const PRUNE_ACCESS_THRESHOLD = 3;
const PRUNE_AGE_DAYS = 60;
const PRUNE_CRITERIA_REQUIRED = 3;
const WIDTH = 52; // inner width between ║ borders

// ─── ASCII Box Helpers ────────────────────────────────────────────────────────

function row(label: string, value: string): string {
  const content = `  ${label.padEnd(28)}${value}`;
  return `║${content.padEnd(WIDTH)}║`;
}

function subrow(label: string, value: string): string {
  const content = `    ${label.padEnd(26)}${value}`;
  return `║${content.padEnd(WIDTH)}║`;
}

function header(title: string): string {
  const padded = ` ${title} `;
  const totalPad = WIDTH - padded.length;
  const left = Math.floor(totalPad / 2);
  const right = totalPad - left;
  return `║${' '.repeat(left)}${padded}${' '.repeat(right)}║`;
}

function divider(): string {
  return `╠${'═'.repeat(WIDTH)}╣`;
}

function top(): string {
  return `╔${'═'.repeat(WIDTH)}╗`;
}

function bottom(): string {
  return `╚${'═'.repeat(WIDTH)}╝`;
}

function fmt(n: number, digits = 2): string {
  return n.toFixed(digits);
}

function fmtCount(n: number): string {
  return n.toLocaleString('en-US');
}

function pct(count: number, total: number): string {
  if (total === 0) return '0.0%';
  return `${((count / total) * 100).toFixed(1)}%`;
}

// ─── Arg Parsing ──────────────────────────────────────────────────────────────

interface ParsedArgs {
  prune: boolean;
  json: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  return {
    prune: args.includes('--prune'),
    json: args.includes('--json'),
  };
}

// ─── Prune Scoring ────────────────────────────────────────────────────────────

interface PruneCandidate {
  id: string;
  name: string;
  score: number;
  reasons: string[];
}

function scorePruneCandidate(
  memory: Memory,
  edgeIds: Set<string>,
  now: number,
): PruneCandidate | null {
  const reasons: string[] = [];
  let score = 0;

  // Criterion 1: low salience
  if (typeof memory.salience === 'number' && memory.salience < PRUNE_SALIENCE_THRESHOLD) {
    score++;
    reasons.push(`salience ${fmt(memory.salience, 3)} < ${PRUNE_SALIENCE_THRESHOLD}`);
  }

  // Criterion 2: low access count
  if (typeof memory.access_count === 'number' && memory.access_count < PRUNE_ACCESS_THRESHOLD) {
    score++;
    reasons.push(`access_count ${memory.access_count} < ${PRUNE_ACCESS_THRESHOLD}`);
  }

  // Criterion 3: FSRS in relearning
  if (memory.fsrs?.state === 'relearning') {
    score++;
    reasons.push('fsrs state: relearning');
  }

  // Criterion 4: no edges
  if (!edgeIds.has(memory.id)) {
    score++;
    reasons.push('no edges (orphan)');
  }

  // Criterion 5: high age
  const ageMs = now - (memory.created_at instanceof Date ? memory.created_at.getTime() : new Date(memory.created_at).getTime());
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays > PRUNE_AGE_DAYS) {
    score++;
    reasons.push(`age ${Math.floor(ageDays)}d > ${PRUNE_AGE_DAYS}d`);
  }

  if (score < PRUNE_CRITERIA_REQUIRED) return null;

  return {
    id: memory.id,
    name: (memory.name ?? memory.id).slice(0, 50),
    score,
    reasons,
  };
}

// ─── Health Report Types ──────────────────────────────────────────────────────

interface HealthReport {
  generatedAt: string;
  memory: {
    total: number;
    avgSalience: number;
    lowSalienceCount: number;
    staleCount: number;
    fsrs: Record<FSRSState, number>;
  };
  observations: {
    total: number;
    unprocessed: number;
    avgPredictionError: number;
  };
  pruneCandidates: PruneCandidate[];
  pruned?: number;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function runHealth(args: string[]): Promise<void> {
  const { prune, json } = parseArgs(args);

  if (!json) {
    console.error('[fozikio health] Loading config...');
  }

  const config = loadConfig();
  const store = await createStore(config);

  if (!json) {
    console.error(`[fozikio health] Backend: ${config.store}. Fetching data...`);
  }

  const now = new Date();
  const staleCutoff = new Date(now);
  staleCutoff.setDate(staleCutoff.getDate() - STALE_DAYS);

  // ── Parallel fetches ──────────────────────────────────────────────────────
  const [memories, unprocessedObs] = await Promise.all([
    store.getAllMemories(),
    store.getUnprocessedObservations(10_000),
  ]);

  // Fetch all observations for PE stats — unprocessed are a subset, but we
  // also want total count. Use getUnprocessedObservations with a high limit
  // and then separately query for total via ops query pattern.
  // Note: CortexStore has no getAllObservations(), so we use the generic
  // query() method which returns raw records.
  const allObsRaw = await store.query('observations', [], { limit: 100_000 });
  const allObs = allObsRaw as unknown as Observation[];

  // Get edges to identify orphan memories
  const allMemoryIds = memories.map(m => m.id);
  const edges = allMemoryIds.length > 0
    ? await store.getEdgesForMemories(allMemoryIds)
    : [];

  const memoryIdsWithEdges = new Set<string>();
  for (const edge of edges) {
    memoryIdsWithEdges.add(edge.source_id);
    memoryIdsWithEdges.add(edge.target_id);
  }

  // ── Memory stats ──────────────────────────────────────────────────────────
  const totalMemories = memories.length;
  const lowSalienceCount = memories.filter(m => (m.salience ?? 0) < LOW_SALIENCE_THRESHOLD).length;
  const staleCount = memories.filter(m => {
    const la = m.last_accessed instanceof Date
      ? m.last_accessed
      : m.last_accessed ? new Date(m.last_accessed as unknown as string) : null;
    return la && la < staleCutoff;
  }).length;
  const avgSalience = totalMemories > 0
    ? memories.reduce((s, m) => s + (m.salience ?? 0), 0) / totalMemories
    : 0;

  const fsrsCounts: Record<FSRSState, number> = { new: 0, learning: 0, review: 0, relearning: 0 };
  for (const m of memories) {
    const state = m.fsrs?.state;
    if (state && state in fsrsCounts) {
      fsrsCounts[state]++;
    }
  }

  // ── Observation stats ─────────────────────────────────────────────────────
  const totalObs = allObs.length;
  const unprocessedCount = unprocessedObs.length;
  const obsWithPE = allObs.filter(o => o.prediction_error != null);
  const avgPE = obsWithPE.length > 0
    ? obsWithPE.reduce((s, o) => s + (o.prediction_error ?? 0), 0) / obsWithPE.length
    : 0;

  // ── Prune candidates ──────────────────────────────────────────────────────
  const nowMs = now.getTime();
  const pruneCandidates: PruneCandidate[] = [];
  for (const memory of memories) {
    const candidate = scorePruneCandidate(memory, memoryIdsWithEdges, nowMs);
    if (candidate) pruneCandidates.push(candidate);
  }

  // Sort by score descending, then by name
  pruneCandidates.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  // ── Prune action ──────────────────────────────────────────────────────────
  let pruned = 0;
  if (prune && pruneCandidates.length > 0) {
    if (!json) {
      console.error(`[fozikio health] Pruning ${pruneCandidates.length} candidates (soft-delete via faded=true)...`);
    }
    for (const candidate of pruneCandidates) {
      await store.updateMemory(candidate.id, { faded: true });
      pruned++;
    }
    if (!json) {
      console.error(`[fozikio health] Pruned ${pruned} memories.`);
    }
  }

  // ── Build report ──────────────────────────────────────────────────────────
  const report: HealthReport = {
    generatedAt: now.toISOString(),
    memory: {
      total: totalMemories,
      avgSalience,
      lowSalienceCount,
      staleCount,
      fsrs: fsrsCounts,
    },
    observations: {
      total: totalObs,
      unprocessed: unprocessedCount,
      avgPredictionError: avgPE,
    },
    pruneCandidates,
    ...(prune ? { pruned } : {}),
  };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  // ── Formatted ASCII output ────────────────────────────────────────────────
  const lines: string[] = [];
  const dateStr = now.toISOString().slice(0, 10);

  lines.push(top());
  lines.push(header('CORTEX HEALTH REPORT'));
  lines.push(header(dateStr));

  // Memory Health
  lines.push(divider());
  lines.push(header('Memory Health'));
  lines.push(divider());
  lines.push(row('Total memories:', fmtCount(totalMemories)));
  lines.push(row('Avg salience:', fmt(avgSalience, 3)));
  lines.push(row(`Low salience (<${LOW_SALIENCE_THRESHOLD}):`, fmtCount(lowSalienceCount)));
  lines.push(row(`Stale (>${STALE_DAYS}d no access):`, fmtCount(staleCount)));
  lines.push(row('FSRS states:', ''));
  lines.push(subrow('new:', `${fmtCount(fsrsCounts.new)} (${pct(fsrsCounts.new, totalMemories)})`));
  lines.push(subrow('learning:', `${fmtCount(fsrsCounts.learning)} (${pct(fsrsCounts.learning, totalMemories)})`));
  lines.push(subrow('review:', `${fmtCount(fsrsCounts.review)} (${pct(fsrsCounts.review, totalMemories)})`));
  lines.push(subrow('relearning:', `${fmtCount(fsrsCounts.relearning)} (${pct(fsrsCounts.relearning, totalMemories)})`));

  // Observation Stats
  lines.push(divider());
  lines.push(header('Observation Stats'));
  lines.push(divider());
  lines.push(row('Total observations:', fmtCount(totalObs)));
  lines.push(row('Unprocessed:', fmtCount(unprocessedCount)));
  lines.push(row('Avg prediction error:', fmt(avgPE, 3)));

  // Prune Candidates
  lines.push(divider());
  const pruneHeaderSuffix = prune ? ` — ${pruned} pruned` : ' (dry run)';
  lines.push(header(`Prune Candidates${pruneHeaderSuffix}`));
  lines.push(divider());
  lines.push(row('Criteria required:', `${PRUNE_CRITERIA_REQUIRED} of 5`));
  lines.push(row('Candidates found:', fmtCount(pruneCandidates.length)));
  if (!prune && pruneCandidates.length > 0) {
    lines.push(row('', 'Run with --prune to soft-delete'));
  }

  if (pruneCandidates.length > 0) {
    lines.push(divider());
    lines.push(header('Top Prune Candidates'));
    lines.push(divider());
    const shown = pruneCandidates.slice(0, 10);
    for (const c of shown) {
      const scoreLabel = `[${c.score}/5]`;
      const nameDisplay = c.name.length > 32 ? c.name.slice(0, 32) + '...' : c.name.padEnd(35);
      lines.push(row(`${scoreLabel} ${nameDisplay}`, ''));
      for (const reason of c.reasons) {
        lines.push(subrow('- ' + reason, ''));
      }
    }
    if (pruneCandidates.length > 10) {
      lines.push(row('', `… and ${pruneCandidates.length - 10} more`));
    }
  }

  lines.push(bottom());

  console.log('');
  for (const line of lines) {
    console.log(line);
  }
  console.log('');
}
