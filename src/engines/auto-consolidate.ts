/**
 * SessionConsolidator — Hermes-inspired automatic memory extraction.
 *
 * Hermes Agent syncs conversation turns to memory after each response and
 * extracts memories on session end. This module replicates that loop for
 * cortex-engine:
 *
 *   - observe / wonder / speculate call notifyObservation() after every write.
 *   - notifyObservation asks the store how many unprocessed rows the
 *     namespace actually has; when that is >= AUTO_THRESHOLD, dreamPhaseA
 *     (NREM: cluster → refine → create) fires in the background without
 *     blocking the tool call that triggered it.
 *   - On process exit (SIGTERM / SIGINT), flush() runs dreamPhaseA across
 *     all namespaces that still have unprocessed rows.
 *
 * The trigger used to be an in-process call counter (#114): ten
 * notifyObservation() calls fired Phase A regardless of what the store held,
 * so ten observe calls whose rows a CLI had already promoted or processed by
 * hand still swept and reprocessed them. The store is the source of truth
 * for what is unprocessed — a namespace shared by more than one process (a
 * server plus a CLI) can have rows come and go between calls — so the count
 * read now happens against the store itself, on every notifyObservation, not
 * against a counter this process kept privately.
 *
 * dreamPhaseA is intentionally lightweight — no REM (edges, abstraction,
 * FSRS scoring). Those still belong in the scheduled full `dream` cycle.
 * The point is that raw observations do not sit unprocessed across session
 * boundaries; they become searchable memories within the same session.
 */

import type { CortexStore } from '../core/store.js';
import type { EmbedProvider } from '../core/embed.js';
import type { LLMProvider } from '../core/llm.js';
import type { NamespaceManager } from '../namespace/manager.js';
import { dreamPhaseA } from './cognition.js';

/** Number of unprocessed observations in the store that trigger an auto-consolidation. */
export const AUTO_THRESHOLD = 10;

export class SessionConsolidator {
  /** checking[namespace] = true while a threshold check is reading the store */
  private checking = new Set<string>();
  /** running[namespace] = true while a background Phase A is in flight */
  private running = new Set<string>();
  private shuttingDown = false;

  constructor(
    private readonly namespaces: NamespaceManager,
    private readonly embed: EmbedProvider,
    private readonly llm: LLMProvider,
  ) {}

  /**
   * Call this after every successful observation write. Schedules an async
   * check of the store's own unprocessed-row count for the namespace; when
   * it is >= AUTO_THRESHOLD, runs Phase A. Fire-and-forget (stays `void` so
   * observe/wonder/speculate never wait on it) — `checking` guards against
   * two of these checks racing for the same namespace, the way `running`
   * already guards two Phase A runs.
   */
  notifyObservation(namespace: string): void {
    if (this.checking.has(namespace) || this.running.has(namespace)) return;
    this.checking.add(namespace);
    void this.checkThreshold(namespace).finally(() => {
      this.checking.delete(namespace);
    });
  }

  private async checkThreshold(namespace: string): Promise<void> {
    const store = this.namespaces.getStore(namespace);
    let count: number;
    try {
      count = await this.countUnprocessed(store);
    } catch (err) {
      // Best-effort, same as a failed Phase A run — never crash the caller.
      if (process.env['CORTEX_DEBUG']) {
        process.stderr.write(`[auto-consolidate:${namespace}] count failed: ${String(err)}\n`);
      }
      return;
    }
    if (count >= AUTO_THRESHOLD && !this.shuttingDown && !this.running.has(namespace)) {
      this.runPhaseA(namespace);
    }
  }

  /** COUNT(*) where the store has it; falls back to fetching and counting rows. */
  private countUnprocessed(store: CortexStore): Promise<number> {
    const withCount = store as Partial<Pick<CortexStore, 'countUnprocessedObservations'>>;
    if (typeof withCount.countUnprocessedObservations === 'function') {
      return withCount.countUnprocessedObservations();
    }
    return store.getUnprocessedObservations(AUTO_THRESHOLD).then((rows) => rows.length);
  }

  /**
   * Flush all namespaces — called on process exit. Awaitable so the
   * exit handler can give it a chance to complete before the process dies.
   */
  async flush(): Promise<void> {
    this.shuttingDown = true;
    const namespaces = this.namespaces.getNamespaceNames();
    await Promise.allSettled(
      namespaces.map(async (ns) => {
        const store = this.namespaces.getStore(ns);
        const count = await this.countUnprocessed(store).catch(() => 0);
        if (count > 0) {
          await this.runPhaseA(ns, true);
        }
      }),
    );
  }

  private runPhaseA(namespace: string, wait = false): Promise<void> {
    this.running.add(namespace);

    const store: CortexStore = this.namespaces.getStore(namespace);
    const nsConfig = this.namespaces.getConfig(namespace);

    const work: Promise<void> = dreamPhaseA(store, this.embed, this.llm, {
      observation_limit: 50,
      similarity_merge: nsConfig.similarity_merge,
      similarity_link: nsConfig.similarity_link,
    }).then(() => {}).catch((err: unknown) => {
      // Auto-consolidation is best-effort — never crash the serving process.
      if (process.env['CORTEX_DEBUG']) {
        process.stderr.write(`[auto-consolidate:${namespace}] ${String(err)}\n`);
      }
    }).finally(() => {
      this.running.delete(namespace);
    });

    if (!wait) { void work; }
    return wait ? work : Promise.resolve();
  }
}
