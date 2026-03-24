/**
 * find_duplicates — detect near-duplicate memories using embeddings.
 *
 * Scans recent memories, embeds each, and finds nearest neighbors above
 * a similarity threshold. Optionally merges duplicates by keeping the
 * higher-salience entry.
 */

import type { ToolDefinition, ToolContext } from '../mcp/tools.js';

const DUPLICATE_THRESHOLD = 0.85;
const BATCH_SIZE = 30;

export const findDuplicatesTool: ToolDefinition = {
  name: 'find_duplicates',
  description:
    'Detect near-duplicate memories and optionally merge them. Returns pairs with similarity above threshold. Set merge=true to auto-merge (keeps higher-salience entry).',
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
      namespace: { type: 'string', description: 'Namespace (defaults to default)' },
    },
  },

  async handler(args: Record<string, unknown>, ctx: ToolContext): Promise<Record<string, unknown>> {
    const merge = args['merge'] === true;
    const threshold =
      typeof args['threshold'] === 'number' ? args['threshold'] : DUPLICATE_THRESHOLD;
    const namespace = typeof args['namespace'] === 'string' ? args['namespace'] : undefined;

    const store = ctx.namespaces.getStore(namespace);

    // Fetch all memories (sorted by updated_at desc happens naturally)
    const allMemories = await store.getAllMemories();
    if (allMemories.length === 0) return { duplicates_found: 0, pairs: [], merged: 0 };

    // Sort by updated_at desc, take the first BATCH_SIZE for scanning
    const sorted = [...allMemories]
      .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime())
      .slice(0, BATCH_SIZE);

    const pairs: Array<{
      a: { id: string; name: string };
      b: { id: string; name: string };
      similarity: number;
    }> = [];
    const seenPairs = new Set<string>();
    let merged_count = 0;

    for (const mem of sorted) {
      if (!mem.embedding || mem.embedding.length === 0) continue;

      // Find 3 nearest — first will often be itself, second is potential duplicate
      const nearest = await store.findNearest(mem.embedding, 3);
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
      note: merge ? `${merged_count} pairs merged` : 'Run with merge=true to auto-merge',
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
