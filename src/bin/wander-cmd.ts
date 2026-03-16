/**
 * wander-cmd.ts — walk through an agent's memory graph from the CLI.
 *
 * Takes a random walk through stored memories, following semantic
 * connections. Shows how the engine links concepts during consolidation.
 *
 * Usage:
 *   fozikio wander
 *   fozikio wander --steps 8
 *   fozikio wander --from "authentication"
 */

import { loadConfig } from './config-loader.js';
import { SqliteCortexStore } from '../stores/sqlite.js';
import { BuiltInEmbedProvider } from '../providers/builtin-embed.js';
import { OllamaEmbedProvider } from '../providers/ollama.js';
import type { EmbedProvider } from '../core/embed.js';
import type { Memory } from '../core/types.js';

export async function runWander(args: string[]): Promise<void> {
  const log = (s: string) => console.log(s);

  // Parse args
  let steps = 5;
  let fromText: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--steps' && args[i + 1]) {
      steps = parseInt(args[i + 1], 10) || 5;
      i++;
    } else if (args[i] === '--from' && args[i + 1]) {
      fromText = args[i + 1];
      i++;
    }
  }

  // Load config
  let config;
  try {
    config = loadConfig();
  } catch {
    log('');
    log('  \u2717 no agent workspace found');
    log('    run `fozikio init` first');
    log('');
    process.exit(1);
    return;
  }

  if (config.store !== 'sqlite') {
    log('');
    log('  wander currently works with sqlite stores only');
    log('');
    process.exit(1);
  }

  // Connect to store
  const nsName = Object.keys(config.namespaces ?? {})[0] ?? 'default';
  const store = new SqliteCortexStore(
    config.store_options?.sqlite_path ?? './cortex.db',
    nsName,
  );

  // Get all memories
  const memories: Memory[] = await store.getAllMemories();

  if (memories.length === 0) {
    log('');
    log(`  ${nsName} has no memories yet`);
    log('  observe something first, then come back');
    log('');
    return;
  }

  // Create embed provider for seeded walks
  let embed: EmbedProvider | null = null;
  if (fromText) {
    if (config.embed === 'built-in') {
      embed = new BuiltInEmbedProvider();
    } else if (config.embed === 'ollama') {
      embed = new OllamaEmbedProvider({
        model: config.embed_options?.ollama_model,
        baseUrl: config.embed_options?.ollama_url,
      });
    }
  }

  log('');
  log(`  walking ${nsName}'s memory \u00B7\u00B7\u00B7`);
  log('');

  // Start walk: pick random or embed from text
  let currentIdx: number;

  if (fromText && embed) {
    const queryVec = await embed.embed(fromText);
    let bestIdx = 0;
    let bestSim = -1;
    for (let i = 0; i < memories.length; i++) {
      if (memories[i].embedding?.length) {
        const sim = cosineSimilarity(queryVec, memories[i].embedding);
        if (sim > bestSim) {
          bestSim = sim;
          bestIdx = i;
        }
      }
    }
    currentIdx = bestIdx;
  } else {
    currentIdx = Math.floor(Math.random() * memories.length);
  }

  const visited = new Set<number>();

  for (let step = 0; step < steps; step++) {
    visited.add(currentIdx);
    const mem = memories[currentIdx];
    const name = mem.name || mem.definition?.slice(0, 60) || '(unnamed)';

    // Display this step
    const truncated = name.length > 70 ? name.slice(0, 67) + '...' : name;
    log(`  "${truncated}"`);

    // Find next hop via embedding similarity
    if (mem.embedding?.length && step < steps - 1) {
      let bestIdx = -1;
      let bestSim = -1;
      for (let i = 0; i < memories.length; i++) {
        if (visited.has(i)) continue;
        if (!memories[i].embedding?.length) continue;
        const sim = cosineSimilarity(mem.embedding, memories[i].embedding);
        // Small random noise prevents deterministic paths
        const noisySim = sim + (Math.random() * 0.05);
        if (noisySim > bestSim) {
          bestSim = noisySim;
          bestIdx = i;
        }
      }
      if (bestIdx >= 0) {
        const sim = cosineSimilarity(mem.embedding, memories[bestIdx].embedding);
        const strength = sim > 0.7 ? 'strong link' : sim > 0.4 ? 'linked' : 'weak link';
        log(`    \u21B3 ${strength} (${sim.toFixed(2)})`);
        currentIdx = bestIdx;
      } else {
        break;
      }
    }
  }

  log('');
  log(`  ${visited.size} hops \u00B7 ${memories.length} total memories`);
  log('');
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
