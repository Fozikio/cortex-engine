/**
 * Shared lexical-search fallback for stores without native full-text search
 * (JsonCortexStore, FirestoreCortexStore). SqliteCortexStore uses FTS5/BM25
 * instead. Scoring is simple weighted token overlap — good enough to surface
 * exact-keyword matches that embedding search misses.
 */

import type { Memory, MemorySummary, SearchResult } from '../core/types.js';

function toSummary(m: Memory): MemorySummary {
  return {
    id: m.id,
    name: m.name,
    definition: m.definition,
    category: m.category,
    salience: m.salience,
    confidence: m.confidence,
    access_count: m.access_count,
    updated_at: m.updated_at,
    tags: m.tags,
    fsrs: m.fsrs,
    provenance: m.provenance,
  };
}

/** Lowercase alphanumeric tokens, 2+ chars. */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []);
}

/**
 * Score one memory against query tokens. Name hits weigh 2.0, tag hits 1.5,
 * definition hits 1.0. Normalized by token count so the score stays in 0-1
 * (a token matching name+tag+definition still counts once, at max weight).
 */
function scoreMemory(memory: Memory, tokens: string[]): number {
  const name = memory.name.toLowerCase();
  const definition = memory.definition.toLowerCase();
  const tags = memory.tags.map((t) => t.toLowerCase());

  let total = 0;
  for (const token of tokens) {
    if (name.includes(token)) total += 2.0;
    else if (tags.some((t) => t.includes(token))) total += 1.5;
    else if (definition.includes(token)) total += 1.0;
  }
  return total / (tokens.length * 2.0);
}

/**
 * Rank `memories` by lexical overlap with `text`. Skips faded memories and
 * zero-score candidates. Returns at most `limit` results, best first.
 */
export function lexicalSearch(memories: Memory[], text: string, limit: number): SearchResult[] {
  const tokens = tokenize(text);
  if (tokens.length === 0) return [];

  return memories
    .filter((m) => !m.faded)
    .map((m) => ({ memory: m, score: scoreMemory(m, tokens) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ memory, score }) => ({
      memory: toSummary(memory),
      score,
      distance: 1 - score,
    }));
}
