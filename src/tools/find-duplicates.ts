/**
 * find_duplicates — detect near-duplicate memories using embeddings.
 *
 * Scans the N most-recently-updated memories (scan_limit), and for each
 * finds nearest neighbors above a similarity threshold. The candidate-fetch
 * width (`max_candidates`) determines how many siblings can be discovered
 * per scanned memory — must be at least the expected duplicate cluster size
 * or some pairs will be silently dropped.
 *
 * Optionally merges duplicates by keeping the higher-salience entry.
 */

import type { ToolDefinition, ToolContext } from '../mcp/tools.js';

const DUPLICATE_THRESHOLD = 0.85;
const DEFAULT_SCAN_LIMIT = 30;
const DEFAULT_MAX_CANDIDATES = 10;
const MAX_SCAN_LIMIT = 500;
const MAX_CANDIDATES_CAP = 50;

export const findDuplicatesTool: ToolDefinition = {
  name: 'find_duplicates',
  category: 'maintenance',
  description: 'Returns pairs of near-duplicate memories above a similarity threshold by scanning the N most-recently-updated memories. With merge=true, auto-merges pairs keeping the higher-salience entry. Defaults scan_limit=30, max_candidates=10 — increase both for full-graph audits or when concept clusters may have more than ~9 copies.',
  whenToUse: 'You suspect duplicate memories have piled up and want to audit or clean them. For a full-graph sweep, set scan_limit to the total memory count.',
  doNotUse: 'You want to fade one specific concept — use forget. You want to revise it — use believe.',
  inputSchema: {
    type: 'object',
    properties: {
      merge: {
        type: 'boolean',
        description: 'Auto-merge detected duplicates (default: false — report only)',
      },
      threshold: {
        type: 'number',
        description: 'Similarity threshold 0-1 (default: 0.85)',
      },
      scan_limit: {
        type: 'number',
        description: `How many of the most-recently-updated memories to scan (default: ${DEFAULT_SCAN_LIMIT}, max: ${MAX_SCAN_LIMIT}). Older memories not in the scan window won't appear as the "a" side of a pair, though they can appear as candidates.`,
      },
      max_candidates: {
        type: 'number',
        description: `How many nearest-neighbor candidates to fetch per scanned memory (default: ${DEFAULT_MAX_CANDIDATES}, max: ${MAX_CANDIDATES_CAP}). Must be at least the size of any expected duplicate cluster — if 5 copies of a concept exist, max_candidates < 5 will silently drop pairs.`,
      },
      namespace: { type: 'string', description: 'Namespace (defaults to default)' },
    },
  },

  async handler(args: Record<string, unknown>, ctx: ToolContext): Promise<Record<string, unknown>> {
    const merge = args['merge'] === true;
    const threshold =
      typeof args['threshold'] === 'number' ? args['threshold'] : DUPLICATE_THRESHOLD;
    const scanLimit = Math.min(
      typeof args['scan_limit'] === 'number' ? args['scan_limit'] : DEFAULT_SCAN_LIMIT,
      MAX_SCAN_LIMIT,
    );
    const maxCandidates = Math.min(
      typeof args['max_candidates'] === 'number' ? args['max_candidates'] : DEFAULT_MAX_CANDIDATES,
      MAX_CANDIDATES_CAP,
    );
    const namespace = typeof args['namespace'] === 'string' ? args['namespace'] : undefined;

    const store = ctx.namespaces.getStore(namespace);

    // Fetch all memories (sorted by updated_at desc happens naturally)
    const allMemories = await store.getAllMemories();
    if (allMemories.length === 0) {
      return { duplicates_found: 0, pairs: [], merged: 0, scanned: 0 };
    }

    // Sort by updated_at desc, take the first scanLimit for scanning
    const sorted = [...allMemories]
      .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime())
      .slice(0, scanLimit);

    const pairs: Array<{
      a: { id: string; name: string };
      b: { id: string; name: string };
      similarity: number;
    }> = [];
    const seenPairs = new Set<string>();
    let merged_count = 0;

    for (const mem of sorted) {
      if (!mem.embedding || mem.embedding.length === 0) continue;

      // Fetch maxCandidates + 1 because the first match is usually the mem itself
      const nearest = await store.findNearest(mem.embedding, maxCandidates + 1);
      for (const candidate of nearest) {
        if (candidate.memory.id === mem.id) continue;
        if (candidate.score < threshold) continue;

        const pairKey = [mem.id, candidate.memory.id].sort().join(':');
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);

        pairs.push({
          a: { id: mem.id, name: mem.name },
          b: { id: candidate.memory.id, name: candidate.memory.name },
          similarity: Math.round(candidate.score * 1000) / 1000,
        });

        if (merge) {
          await mergePair(store, mem.id, candidate.memory.id);
          merged_count++;
        }
      }
    }

    return {
      duplicates_found: pairs.length,
      pairs,
      merged: merged_count,
      scanned: sorted.length,
      total_memories: allMemories.length,
      note: merge
        ? `${merged_count} pairs merged`
        : sorted.length < allMemories.length
          ? `Scanned ${sorted.length}/${allMemories.length} most-recent memories. Increase scan_limit for full-graph audit. Run with merge=true to auto-merge.`
          : 'Run with merge=true to auto-merge',
    };
  },
};

async function mergePair(
  store: ReturnType<ToolContext['namespaces']['getStore']>,
  idA: string,
  idB: string,
): Promise<void> {
  const [memA, memB] = await Promise.all([store.getMemory(idA), store.getMemory(idB)]);

  if (!memA || !memB) return;

  // Keep the higher-salience memory, discard the other
  const [keep, discard] =
    memA.salience >= memB.salience
      ? [{ data: memA, id: idA }, { data: memB, id: idB }]
      : [{ data: memB, id: idB }, { data: memA, id: idA }];

  // Merge: combine source_files, take max access_count, take max salience
  await store.updateMemory(keep.id, {
    source_files: [...new Set([...keep.data.source_files, ...discard.data.source_files])],
    access_count: Math.max(keep.data.access_count, discard.data.access_count),
    salience: Math.max(keep.data.salience, discard.data.salience),
    updated_at: new Date(),
  });

  // Soft-delete the discarded memory by fading it
  await store.updateMemory(discard.id, {
    salience: 0,
    faded: true,
    updated_at: new Date(),
  });
}
