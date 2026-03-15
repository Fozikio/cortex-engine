/**
 * anomalies-cmd.ts — fozikio anomalies command handler.
 *
 * Loads session data from ops entries + retrieval traces, builds session
 * feature vectors, and runs an Isolation Forest to detect anomalous sessions.
 *
 * Isolation Forest is implemented in pure TypeScript — no ML dependencies.
 *
 * Works with both SQLite and Firestore backends.
 *
 * Usage:
 *   fozikio anomalies
 *   fozikio anomalies --days 60
 *   fozikio anomalies --json
 */

import { loadConfig } from './config-loader.js';
import { SqliteCortexStore } from '../stores/sqlite.js';
import { FirestoreCortexStore } from '../stores/firestore.js';
import type { CortexStore } from '../core/store.js';
import type { CortexConfig } from '../core/config.js';
import type { OpsEntry, QueryFilter } from '../core/types.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_DAYS = 90;
const N_TREES = 100;
const SUBSAMPLE_SIZE = 256;
const ANOMALY_THRESHOLD = 0.6;
const WIDTH = 52;

// ─── Types ────────────────────────────────────────────────────────────────────

interface RetrievalTrace {
  session_id?: string;
  retry_within_60s?: boolean;
  timestamp?: Date | string | null;
  [key: string]: unknown;
}

interface SessionFeatures {
  session_ref: string;
  start_time: Date;
  duration_minutes: number;
  retrieval_count: number;
  retry_rate: number;
  ops_entry_count: number;
  has_commits: number; // 0 or 1
  observation_count: number;
}

// [duration_minutes, retrieval_count, retry_rate, ops_entry_count, has_commits, observation_count]
type FeatureVector = [number, number, number, number, number, number];

interface IsolationNode {
  feature_index?: number;
  split_value?: number;
  left?: IsolationNode;
  right?: IsolationNode;
  size: number;
  is_leaf: boolean;
}

interface AnomalyResult {
  session_ref: string;
  start_time: string;
  score: number;
  is_anomalous: boolean;
  features: SessionFeatures;
  explanation: string;
}

interface AnomaliesReport {
  generated_at: string;
  window_days: number;
  sessions_analyzed: number;
  anomalies_detected: number;
  threshold: number;
  results: AnomalyResult[];
  feature_summary: {
    avg_duration_minutes: number;
    avg_retrieval_count: number;
    avg_retry_rate: number;
    commit_rate_pct: number;
  } | null;
}

// ─── Arg Parsing ─────────────────────────────────────────────────────────────

interface ParsedArgs {
  json: boolean;
  days: number;
}

function parseArgs(args: string[]): ParsedArgs {
  let json = false;
  let days = DEFAULT_DAYS;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--days' && args[i + 1]) {
      const parsed = parseInt(args[++i], 10);
      if (!isNaN(parsed) && parsed > 0) days = parsed;
    }
  }

  return { json, days };
}

// ─── Store Factory ────────────────────────────────────────────────────────────

async function createStore(config: CortexConfig): Promise<CortexStore> {
  if (config.store === 'firestore') {
    const { getApps, initializeApp } = await import('firebase-admin/app');
    if (getApps().length === 0) {
      initializeApp({ projectId: config.store_options?.gcp_project_id });
    }
    const { getFirestore, FieldValue } = await import('firebase-admin/firestore');
    const db = config.store_options?.firestore_database_id
      ? getFirestore(config.store_options.firestore_database_id)
      : getFirestore();
    db.settings({ ignoreUndefinedProperties: true });
    return new FirestoreCortexStore(db, '', FieldValue);
  }

  return new SqliteCortexStore(
    config.store_options?.sqlite_path ?? './cortex.db',
  );
}

// ─── Date Helpers ─────────────────────────────────────────────────────────────

function toDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const t = v as { toDate?: () => Date };
  if (typeof t.toDate === 'function') return t.toDate();
  if (typeof v === 'string') return new Date(v);
  return null;
}

// ─── Box Drawing ─────────────────────────────────────────────────────────────

function row(label: string, value: string): string {
  const content = `  ${label.padEnd(28)}${value}`;
  return `\u2551${content.padEnd(WIDTH)}\u2551`;
}

function header(title: string): string {
  const padded = ` ${title} `;
  const totalPad = WIDTH - padded.length;
  const left = Math.floor(totalPad / 2);
  const right = totalPad - left;
  return `\u2551${' '.repeat(left)}${padded}${' '.repeat(right)}\u2551`;
}

function divider(): string { return `\u2560${'\u2550'.repeat(WIDTH)}\u2563`; }
function top(): string     { return `\u2554${'\u2550'.repeat(WIDTH)}\u2557`; }
function bottom(): string  { return `\u255a${'\u2550'.repeat(WIDTH)}\u255d`; }
function fmt(n: number, digits = 3): string { return n.toFixed(digits); }

// ─── Session Feature Extraction ───────────────────────────────────────────────

const COMMIT_KEYWORDS = ['commit', 'push', 'merge'];

function hasCommitKeyword(content: string): boolean {
  const lower = content.toLowerCase();
  return COMMIT_KEYWORDS.some(kw => lower.includes(kw));
}

function buildSessionFeatures(
  entries: OpsEntry[],
  traces: RetrievalTrace[],
  sessionRef: string,
): SessionFeatures | null {
  const dates = entries
    .map(e => (e.created_at instanceof Date ? e.created_at : toDate(e.created_at)))
    .filter((d): d is Date => d !== null)
    .sort((a, b) => a.getTime() - b.getTime());

  if (dates.length === 0) return null;

  const startTime = dates[0];
  const endTime = dates[dates.length - 1];
  const durationMinutes = (endTime.getTime() - startTime.getTime()) / (1000 * 60);

  // Sessions under half a minute with fewer than 3 entries are likely incomplete data
  if (durationMinutes < 0.5 && entries.length < 3) return null;

  const sessionTraces = traces.filter(t => t.session_id === sessionRef);
  const retrieval_count = sessionTraces.length;
  const retried = sessionTraces.filter(t => t.retry_within_60s === true).length;
  const retry_rate = retrieval_count > 0 ? retried / retrieval_count : 0;
  const has_commits = entries.some(e => hasCommitKeyword(e.content)) ? 1 : 0;

  return {
    session_ref: sessionRef,
    start_time: startTime,
    duration_minutes: durationMinutes,
    retrieval_count,
    retry_rate,
    ops_entry_count: entries.length,
    has_commits,
    observation_count: 0, // filled in after building all features
  };
}

function featureToVector(f: SessionFeatures): FeatureVector {
  return [
    f.duration_minutes,
    f.retrieval_count,
    f.retry_rate,
    f.ops_entry_count,
    f.has_commits,
    f.observation_count,
  ];
}

// ─── Isolation Forest ─────────────────────────────────────────────────────────

/**
 * Average path length for a dataset of size n (theoretical expectation).
 * Used as the normalization constant c(n) in the anomaly score formula.
 */
function avgPathLength(n: number): number {
  if (n <= 1) return 0;
  if (n === 2) return 1;
  // H(n-1) harmonic number approximation (Euler-Mascheroni constant = 0.5772156649)
  const h = Math.log(n - 1) + 0.5772156649;
  return 2 * h - (2 * (n - 1)) / n;
}

function buildTree(
  data: FeatureVector[],
  indices: number[],
  currentDepth: number,
  maxDepth: number,
): IsolationNode {
  const size = indices.length;

  if (size <= 1 || currentDepth >= maxDepth) {
    return { size, is_leaf: true };
  }

  const numFeatures = data[0].length;
  const featureIdx = Math.floor(Math.random() * numFeatures);

  let minVal = Infinity;
  let maxVal = -Infinity;
  for (const i of indices) {
    const v = data[i][featureIdx];
    if (v < minVal) minVal = v;
    if (v > maxVal) maxVal = v;
  }

  if (minVal === maxVal) {
    return { size, is_leaf: true };
  }

  const splitVal = minVal + Math.random() * (maxVal - minVal);

  const leftIdx: number[] = [];
  const rightIdx: number[] = [];
  for (const i of indices) {
    if (data[i][featureIdx] < splitVal) {
      leftIdx.push(i);
    } else {
      rightIdx.push(i);
    }
  }

  return {
    feature_index: featureIdx,
    split_value: splitVal,
    left: buildTree(data, leftIdx, currentDepth + 1, maxDepth),
    right: buildTree(data, rightIdx, currentDepth + 1, maxDepth),
    size,
    is_leaf: false,
  };
}

function pathLength(node: IsolationNode, x: FeatureVector, depth: number): number {
  if (node.is_leaf || node.feature_index === undefined) {
    return depth + avgPathLength(node.size);
  }

  if (x[node.feature_index] < node.split_value!) {
    return pathLength(node.left!, x, depth + 1);
  } else {
    return pathLength(node.right!, x, depth + 1);
  }
}

/** Fisher-Yates shuffle (unbiased). */
function fisherYatesShuffle(arr: number[]): number[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Build Isolation Forest and return anomaly scores (0–1, higher = more anomalous).
 * Score formula: 2^(-avgPath / c), where c = avgPathLength(subsampleSize).
 */
function isolationForest(data: FeatureVector[]): number[] {
  const n = data.length;
  if (n === 0) return [];
  if (n === 1) return [0];

  const subsampleSize = Math.min(SUBSAMPLE_SIZE, n);
  const maxDepth = Math.ceil(Math.log2(subsampleSize));

  const trees: IsolationNode[] = [];
  for (let t = 0; t < N_TREES; t++) {
    const shuffled = fisherYatesShuffle([...Array(n).keys()]);
    const subset = shuffled.slice(0, subsampleSize);
    trees.push(buildTree(data, subset, 0, maxDepth));
  }

  const c = avgPathLength(subsampleSize);
  const scores: number[] = [];

  for (let i = 0; i < n; i++) {
    const x = data[i];
    let totalPath = 0;
    for (const tree of trees) {
      totalPath += pathLength(tree, x, 0);
    }
    const avgPath = totalPath / N_TREES;
    scores.push(Math.pow(2, -avgPath / c));
  }

  return scores;
}

// ─── Anomaly Explanation ──────────────────────────────────────────────────────

function explainAnomaly(features: SessionFeatures): string {
  const reasons: string[] = [];

  if (features.duration_minutes > 60 && features.has_commits === 0) {
    reasons.push('Long session with no commits — possible stuck session');
  }

  if (features.retry_rate > 0.3 && features.retrieval_count > 10) {
    reasons.push('High retry rate with many tool calls — fighting the system');
  }

  if (features.observation_count > 5 && features.ops_entry_count < 3) {
    reasons.push('Many observations but few ops entries — thinking without acting');
  }

  if (
    features.duration_minutes < 2 &&
    features.has_commits === 0 &&
    features.retrieval_count === 0
  ) {
    reasons.push('Very short session with no retrieval or commits — incomplete/crashed');
  }

  if (features.duration_minutes > 180) {
    reasons.push('Unusually long session duration — possible runaway or stall');
  }

  if (features.retry_rate > 0.5 && features.retrieval_count > 5) {
    reasons.push('Very high retry rate — repeated retrieval failures');
  }

  if (reasons.length === 0) {
    reasons.push('Statistical outlier — unusual combination of features');
  }

  return reasons.join('; ');
}

// ─── Report Rendering ─────────────────────────────────────────────────────────

function renderReport(report: AnomaliesReport): void {
  const now = new Date(report.generated_at);
  const anomalies = report.results.filter(r => r.is_anomalous);
  const pct = report.sessions_analyzed > 0
    ? ((anomalies.length / report.sessions_analyzed) * 100).toFixed(1)
    : '0.0';

  const lines: string[] = [];
  lines.push(top());
  lines.push(header('ANOMALY DETECTION REPORT'));
  lines.push(header(now.toISOString().slice(0, 10)));
  lines.push(divider());
  lines.push(row('Sessions analyzed:', String(report.sessions_analyzed)));
  lines.push(row('Anomalies detected:', `${anomalies.length} (${pct}%)`));
  lines.push(row('Threshold:', String(report.threshold)));
  lines.push(row('Trees:', String(N_TREES)));
  lines.push(row('Window:', `last ${report.window_days} days`));

  if (anomalies.length > 0) {
    lines.push(divider());
    lines.push(header('Flagged Sessions'));
    lines.push(divider());
    for (const a of anomalies.slice(0, 10)) {
      const ts = a.start_time.slice(0, 16).replace('T', ' ');
      const scoreStr = fmt(a.score);
      const tag = a.explanation.split(';')[0].trim().slice(0, 20);
      lines.push(row(`  ${ts}`, `score=${scoreStr} ${tag}`));
    }
    if (anomalies.length > 10) {
      lines.push(row('  ...and more', `(${anomalies.length - 10} not shown)`));
    }
  }

  if (report.feature_summary) {
    const fs = report.feature_summary;
    lines.push(divider());
    lines.push(header('Feature Ranges'));
    lines.push(divider());
    lines.push(row('Avg duration (min):', fmt(fs.avg_duration_minutes, 1)));
    lines.push(row('Avg retrieval count:', fmt(fs.avg_retrieval_count, 1)));
    lines.push(row('Avg retry rate:', fmt(fs.avg_retry_rate)));
    lines.push(row('Sessions with commits:', `${fs.commit_rate_pct.toFixed(1)}%`));
  }

  lines.push(bottom());

  console.log('');
  for (const line of lines) console.log(line);
  console.log('');
}

// ─── Main Export ─────────────────────────────────────────────────────────────

export async function runAnomalies(args: string[]): Promise<void> {
  const { json, days } = parseArgs(args);

  const config = loadConfig();
  const store = await createStore(config);

  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - days);

  process.stderr.write(`[fozikio anomalies] Loading session data (last ${days} days)...\n`);

  const cutoffFilter: QueryFilter = { field: 'created_at', op: '>=', value: cutoff };
  const traceCutoffFilter: QueryFilter = { field: 'timestamp', op: '>=', value: cutoff };
  const obsCutoffFilter: QueryFilter = { field: 'created_at', op: '>=', value: cutoff };

  const [opsEntries, rawTraces, rawObs] = await Promise.all([
    store.queryOps({ days }),
    store.query('retrieval_traces', [traceCutoffFilter], { limit: 5000, orderBy: 'timestamp', orderDir: 'asc' }),
    store.query('observations', [obsCutoffFilter], { limit: 2000 }),
  ]);

  // Silence unused variable warning — cutoffFilter used above
  void cutoffFilter;

  const traces = rawTraces as RetrievalTrace[];

  // Group ops entries by session_ref
  const opsByRef = new Map<string, OpsEntry[]>();
  for (const e of opsEntries) {
    const ref = e.session_ref ?? 'unknown';
    if (ref === 'unknown') continue;
    if (!opsByRef.has(ref)) opsByRef.set(ref, []);
    opsByRef.get(ref)!.push(e);
  }

  // Build session features
  const allFeatures: SessionFeatures[] = [];
  for (const [ref, entries] of opsByRef) {
    const f = buildSessionFeatures(entries, traces, ref);
    if (f) allFeatures.push(f);
  }

  if (allFeatures.length === 0) {
    process.stderr.write('[fozikio anomalies] No sessions found with sufficient data.\n');
    const emptyReport: AnomaliesReport = {
      generated_at: now.toISOString(),
      window_days: days,
      sessions_analyzed: 0,
      anomalies_detected: 0,
      threshold: ANOMALY_THRESHOLD,
      results: [],
      feature_summary: null,
    };
    if (json) {
      console.log(JSON.stringify(emptyReport, null, 2));
    } else {
      console.log('[fozikio anomalies] No sessions found with sufficient data.');
    }
    return;
  }

  // Assign observation counts using session time windows
  for (const f of allFeatures) {
    const windowStart = new Date(f.start_time.getTime() - 2 * 60 * 60 * 1000);
    const windowEnd = new Date(f.start_time.getTime() + 4 * 60 * 60 * 1000);
    let count = 0;
    for (const obs of rawObs) {
      const created = obs.created_at as unknown;
      const d = toDate(created);
      if (d && d >= windowStart && d <= windowEnd) count++;
    }
    f.observation_count = count;
  }

  process.stderr.write(
    `[fozikio anomalies] Analyzing ${allFeatures.length} sessions with ${N_TREES} trees...\n`,
  );

  const featureVectors: FeatureVector[] = allFeatures.map(featureToVector);
  const scores = isolationForest(featureVectors);

  const results: AnomalyResult[] = allFeatures.map((f, i) => ({
    session_ref: f.session_ref,
    start_time: f.start_time.toISOString(),
    score: scores[i],
    is_anomalous: scores[i] >= ANOMALY_THRESHOLD,
    features: f,
    explanation: scores[i] >= ANOMALY_THRESHOLD ? explainAnomaly(f) : '',
  }));

  results.sort((a, b) => b.score - a.score);

  const anomalies = results.filter(r => r.is_anomalous);

  const avgDur = allFeatures.reduce((s, f) => s + f.duration_minutes, 0) / allFeatures.length;
  const avgRetrieval = allFeatures.reduce((s, f) => s + f.retrieval_count, 0) / allFeatures.length;
  const avgRetry = allFeatures.reduce((s, f) => s + f.retry_rate, 0) / allFeatures.length;
  const commitRate = allFeatures.filter(f => f.has_commits).length / allFeatures.length;

  const report: AnomaliesReport = {
    generated_at: now.toISOString(),
    window_days: days,
    sessions_analyzed: allFeatures.length,
    anomalies_detected: anomalies.length,
    threshold: ANOMALY_THRESHOLD,
    results,
    feature_summary: {
      avg_duration_minutes: avgDur,
      avg_retrieval_count: avgRetrieval,
      avg_retry_rate: avgRetry,
      commit_rate_pct: commitRate * 100,
    },
  };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    renderReport(report);
  }
}
