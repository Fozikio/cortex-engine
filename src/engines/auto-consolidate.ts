/**
 * SessionConsolidator — Hermes-inspired automatic memory extraction.
 *
 * Hermes Agent syncs conversation turns to memory after each response and
 * extracts memories on session end. This module replicates that loop for
 * cortex-engine:
 *
 *   - observe / wonder / speculate call notifyObservation() after every write.
 *   - When pending count hits AUTO_THRESHOLD per namespace, dreamPhaseA
 *     (NREM: cluster → refine → create) fires in the background without
 *     blocking the tool call that triggered it.
 *   - On process exit (SIGTERM / SIGINT), flush() runs dreamPhaseA across
 *     all namespaces with unprocessed observations.
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

/** Number of new observations per namespace that trigger an auto-consolidation. */
export const AUTO_THRESHOLD = 10;

export class SessionConsolidator {
  /** pending[namespace] = count of new observations since last auto-run */
  private pending = new Map<string, number>();
  /** running[namespace] = true while a background Phase A is in flight */
  private running = new Set<string>();
  private shuttingDown = false;

  constructor(
    private readonly namespaces: NamespaceManager,
    private readonly embed: EmbedProvider,
    private readonly llm: LLMProvider,
  ) {}

  /**
   * Call this after every successful observation write. When the pending
   * count crosses AUTO_THRESHOLD, schedules a background Phase A run.
   */
  notifyObservation(namespace: string): void {
    const count = (this.pending.get(namespace) ?? 0) + 1;
    this.pending.set(namespace, count);
    if (count >= AUTO_THRESHOLD && !this.running.has(namespace)) {
      this.runPhaseA(namespace);
    }
  }

  /**
   * Flush all namespaces — called on process exit. Awaitable so the
   * exit handler can give it a chance to complete before the process dies.
   */
  async flush(): Promise<void> {
    this.shuttingDown = true;
    const namespaces = this.namespaces.getNamespaceNames();
    await Promise.allSettled(
      namespaces
        .filter((ns) => (this.pending.get(ns) ?? 0) > 0)
        .map((ns) => this.runPhaseA(ns, true)),
    );
  }

  private runPhaseA(namespace: string, wait = false): Promise<void> {
    this.running.add(namespace);
    this.pending.set(namespace, 0);

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
      // If more observations arrived while we were running, re-trigger.
      if (!this.shuttingDown && (this.pending.get(namespace) ?? 0) >= AUTO_THRESHOLD) {
        void this.runPhaseA(namespace);
      }
    });

    if (!wait) { void work; }
    return wait ? work : Promise.resolve();
  }
}
