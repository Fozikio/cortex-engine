/**
 * Verification script for the HyDE crash fix.
 *
 * Loads the live cortex.db from the anthems hub (read-only), runs the
 * exact code path that was crashing (hydeExpand -> findNearest ->
 * spreadActivation), and prints the results. If the fix works, this
 * succeeds where the running MCP server (still on old code) still fails.
 *
 * Usage:
 *   node scripts/verify-hyde-fix.mjs
 */

import {
  SqliteCortexStore,
  OllamaEmbedProvider,
  OllamaLLMProvider,
  hydeExpand,
  spreadActivation,
} from '../dist/index.js';

const DB_PATH = 'D:\\My_Docs\\Obsidian Vaults\\_AGENT\\cortex.db';
const QUERY = 'Glitterrot voice';
const NAMESPACE = 'anthems';

const store = new SqliteCortexStore(DB_PATH, NAMESPACE);
const embed = new OllamaEmbedProvider();
const llm = new OllamaLLMProvider({ model: 'qwen3:14b' });

console.log(`Query: "${QUERY}"   namespace: "${NAMESPACE}"   hyde: true`);
console.log('Running hydeExpand...');
const embedding = await hydeExpand(QUERY, llm, embed);
console.log(`  embedding dim: ${embedding.length}`);

console.log('Running findNearest(15)...');
const nearest = await store.findNearest(embedding, 15);
console.log(`  found: ${nearest.length} candidates`);

console.log('Running spreadActivation (the path that was crashing)...');
const activated = await spreadActivation(store, nearest, embedding);
console.log(`  activated: ${activated.length} memories`);

console.log('\nTop 5 results:');
const top5 = activated
  .sort((a, b) => b.score - a.score)
  .slice(0, 5)
  .map((r) => ({
    id: r.memory.id,
    name: r.memory.name,
    score: Number(r.score.toFixed(4)),
    hop_count: r.hop_count,
  }));
console.log(JSON.stringify(top5, null, 2));

process.exit(0);
