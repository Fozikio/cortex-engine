/**
 * maintain-cmd.ts — fozikio maintain command.
 *
 * Subcommands:
 *   fozikio maintain fix              Scan and repair data issues
 *   fozikio maintain re-embed         Re-embed all memories with current provider
 *   fozikio maintain re-embed --dry-run  Show what would be re-embedded
 *
 * Flags:
 *   --dry-run     Show what would change without writing
 *   --limit N     Max memories to process (default: 500)
 *   --collection  memories | observations (for re-embed, default: memories)
 *   --null-only   Re-embed only docs with null/empty embeddings
 *   --verbose     Detailed per-item output
 */

import { loadConfig } from './config-loader.js';
import { createStore, createEmbedProvider } from './store-factory.js';
import type { Memory, Observation } from '../core/types.js';

// ─── Arg Parsing ─────────────────────────────────────────────────────────────

interface MaintainArgs {
  subcommand: string | null;
  dryRun: boolean;
  limit: number;
  collection: 'memories' | 'observations';
  nullOnly: boolean;
  verbose: boolean;
}

function parseArgs(args: string[]): MaintainArgs {
  const subcommand = args[0] && !args[0].startsWith('--') ? args[0] : null;
  const rest = subcommand ? args.slice(1) : args;

  let dryRun = false;
  let limit = 500;
  let collection: 'memories' | 'observations' = 'memories';
  let nullOnly = false;
  let verbose = false;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--null-only') {
      nullOnly = true;
    } else if (arg === '--verbose') {
      verbose = true;
    } else if (arg === '--limit' && rest[i + 1]) {
      const parsed = parseInt(rest[++i], 10);
      if (!isNaN(parsed) && parsed > 0) limit = parsed;
    } else if (arg === '--collection' && rest[i + 1]) {
      const val = rest[++i];
      if (val === 'observations') collection = 'observations';
    }
  }

  return { subcommand, dryRun, limit, collection, nullOnly, verbose };
}

// ─── fix subcommand ──────────────────────────────────────────────────────────

interface FixIssue {
  id: string;
  name: string;
  issues: string[];
  fixes: Record<string, unknown>;
}

/**
 * Strip LLM output artifacts that leaked into definitions in older cortex versions.
 * Pattern: "YES\n\nDefinition:" or "YES\n\nUpdated Definition:" or "YES:" prefix.
 */
function stripYesPrefix(text: string): string {
  return text
    .replace(/^YES[:\s]*\n*(?:Updated\s+)?(?:Definition[:\s]*)?\n*/i, '')
    .trim();
}

/**
 * Detect whether a memory that is categorized as 'topic' or 'belief' should
 * be re-categorized based on keyword heuristics.
 */
function detectBetterCategory(
  name: string,
  definition: string,
  currentCategory: string,
): string | null {
  if (currentCategory !== 'topic' && currentCategory !== 'belief') return null;

  const text = `${name} ${definition}`.toLowerCase();

  const valueSignals = [
    'loyalty', 'honesty', 'transparency', 'integrity', 'absolute transparency',
    'no hidden state', 'genuinely useful', 'usefulness over', 'continuity matters',
    'grow genuinely', 'worth having around', 'honest about limits',
  ];
  const hasValueSignal = valueSignals.some(s => text.includes(s)) || /\bvalue[sd]?\b/.test(text);

  const patternSignals = [
    'disposition', 'tendency', 'practical and direct', 'pushes back',
    'read before acting', 'tinkerer', 'goes wide before', 'go wide before',
  ];
  const hasPatternSignal = patternSignals.some(s => text.includes(s));

  if (hasValueSignal) return 'value';
  if (currentCategory === 'topic' && hasPatternSignal) return 'pattern';
  return null;
}

async function runFix(args: MaintainArgs): Promise<void> {
  const config = loadConfig();
  const store = await createStore(config);

  console.log('[maintain fix] Scanning memories for data issues...');

  const memories = await store.getAllMemories();
  console.log(`[maintain fix] Loaded ${memories.length} memories`);

  const issuesList: FixIssue[] = [];

  for (const memory of memories) {
    const issues: string[] = [];
    const fixes: Record<string, unknown> = {};

    // Check 1: Missing or empty definition
    if (!memory.definition || memory.definition.trim().length === 0) {
      issues.push('empty definition');
      fixes['definition'] = memory.name; // fallback to name
    }

    // Check 2: YES prefix artifact in definition
    const cleanDef = stripYesPrefix(memory.definition ?? '');
    if (cleanDef !== (memory.definition ?? '')) {
      issues.push('YES prefix artifact in definition');
      fixes['definition'] = cleanDef;
    }

    // Check 3: Missing embedding (null or empty array)
    const hasEmbedding = Array.isArray(memory.embedding) && memory.embedding.length > 0;
    if (!hasEmbedding) {
      issues.push('missing embedding');
      // Cannot fix here — use re-embed subcommand
    }

    // Check 4: Salience out of range
    if (typeof memory.salience === 'number' && (memory.salience < 0 || memory.salience > 1)) {
      issues.push(`salience out of range: ${memory.salience}`);
      fixes['salience'] = Math.max(0, Math.min(1, memory.salience));
    }

    // Check 5: Null access_count
    if (memory.access_count == null || typeof memory.access_count !== 'number') {
      issues.push('null access_count');
      fixes['access_count'] = 0;
    }

    // Check 6: Miscategorized identity memories (topic/belief that should be value/pattern)
    const defToCheck = (fixes['definition'] as string | undefined) ?? memory.definition ?? '';
    const betterCat = detectBetterCategory(memory.name, defToCheck, memory.category);
    if (betterCat) {
      issues.push(`miscategorized: '${memory.category}' should be '${betterCat}'`);
      fixes['category'] = betterCat;
    }

    if (issues.length > 0) {
      issuesList.push({ id: memory.id, name: memory.name, issues, fixes });
    }
  }

  if (issuesList.length === 0) {
    console.log('[maintain fix] No issues found.');
    return;
  }

  // Separate fixable from unfixable
  const fixable = issuesList.filter(item => Object.keys(item.fixes).length > 0);
  const unfixable = issuesList.filter(item => Object.keys(item.fixes).length === 0);

  console.log(`\n[maintain fix] Found ${issuesList.length} memories with issues:`);
  console.log(`  Fixable: ${fixable.length}`);
  console.log(`  Needs manual attention: ${unfixable.length} (missing embeddings — run re-embed)`);

  if (unfixable.length > 0 && args.verbose) {
    console.log('\nMemories needing re-embed:');
    for (const item of unfixable) {
      console.log(`  [${item.id}] ${item.name.slice(0, 60)}: ${item.issues.join(', ')}`);
    }
  }

  if (fixable.length === 0) {
    console.log('\n[maintain fix] Nothing to fix automatically.');
    return;
  }

  if (args.dryRun) {
    console.log('\n[maintain fix] Dry run — would apply these fixes:');
    for (const item of fixable) {
      console.log(`  [${item.id}] ${item.name.slice(0, 55)}`);
      for (const issue of item.issues.filter(i => !i.includes('missing embedding'))) {
        console.log(`    - ${issue}`);
      }
      const fixKeys = Object.keys(item.fixes);
      console.log(`    fixes: ${fixKeys.join(', ')}`);
    }
    return;
  }

  let applied = 0;
  let failed = 0;

  console.log('\n[maintain fix] Applying fixes...');
  for (const item of fixable) {
    try {
      await store.updateMemory(item.id, item.fixes);
      if (args.verbose) {
        console.log(`  [OK] ${item.name.slice(0, 60)} — fixed: ${Object.keys(item.fixes).join(', ')}`);
      }
      applied++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [FAIL] ${item.name.slice(0, 60)}: ${msg}`);
      failed++;
    }
  }

  console.log(`\n[maintain fix] Done.`);
  console.log(`  Applied: ${applied}`);
  console.log(`  Failed:  ${failed}`);
  if (unfixable.length > 0) {
    console.log(`  Skipped (needs re-embed): ${unfixable.length}`);
    console.log(`  Run: fozikio maintain re-embed --null-only`);
  }
}

// ─── re-embed subcommand ──────────────────────────────────────────────────────

const EMBED_DELAY_MS = parseInt(process.env['EMBED_DELAY_MS'] ?? '200', 10);
const ABORT_THRESHOLD = 5;

async function runReEmbed(args: MaintainArgs): Promise<void> {
  const config = loadConfig();
  const store = await createStore(config);
  const embed = await createEmbedProvider(config);

  console.log(`[maintain re-embed] Provider: ${embed.name} (${embed.dimensions}d)`);
  console.log(`[maintain re-embed] Collection: ${args.collection}`);
  console.log(`[maintain re-embed] Limit: ${args.limit}`);
  if (args.nullOnly) console.log('[maintain re-embed] Filter: null/empty embeddings only');
  if (args.dryRun) console.log('[maintain re-embed] DRY RUN — no writes');
  console.log('');

  let docs: Array<Memory | Observation>;
  let totalFetched: number;

  if (args.collection === 'memories') {
    const all = await store.getAllMemories();
    const filtered = args.nullOnly
      ? all.filter(m => !Array.isArray(m.embedding) || m.embedding.length === 0)
      : all;
    docs = filtered.slice(0, args.limit) as Memory[];
    totalFetched = all.length;
  } else {
    // observations — use generic query
    const filters = args.nullOnly
      ? [{ field: 'embedding', op: '==' as const, value: null }]
      : [];
    const rawDocs = await store.query('observations', filters, { limit: args.limit });
    docs = rawDocs as unknown as Observation[];
    totalFetched = docs.length;
  }

  console.log(`[maintain re-embed] Fetched ${totalFetched} total, processing ${docs.length}`);
  console.log('');

  let updated = 0;
  let skipped = 0;
  let failed = 0;
  let consecutiveFailures = 0;

  for (const doc of docs) {
    const isMemory = args.collection === 'memories';
    const name = isMemory
      ? (doc as Memory).name ?? doc.id
      : (doc as Observation).content?.slice(0, 60) ?? doc.id;
    const label = name.slice(0, 60);

    // Build embed input
    let embedInput: string;
    if (isMemory) {
      const m = doc as Memory;
      embedInput = `${m.name ?? ''}: ${m.definition ?? ''}`;
    } else {
      const o = doc as Observation;
      embedInput = o.content ?? '';
    }

    if (!embedInput || embedInput.trim().length < 10) {
      if (args.verbose) console.log(`  Skip (empty): ${label}`);
      skipped++;
      continue;
    }

    if (args.dryRun) {
      console.log(`  Would re-embed: ${label} (${embedInput.length} chars)`);
      updated++;
      continue;
    }

    // Embed
    let embedding: number[];
    try {
      process.stdout.write(`  ${label} ... `);
      embedding = await embed.embed(embedInput);
      console.log(`OK (${embedding.length}d)`);
      consecutiveFailures = 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`FAILED: ${msg}`);
      failed++;
      consecutiveFailures++;
      if (consecutiveFailures >= ABORT_THRESHOLD) {
        console.error(`[maintain re-embed] ${ABORT_THRESHOLD} consecutive failures — aborting.`);
        console.error('[maintain re-embed] Check that your embed provider is running and credentials are set.');
        process.exit(1);
      }
      continue;
    }

    // Write back
    try {
      if (isMemory) {
        await store.updateMemory(doc.id, { embedding });
      } else {
        await store.update('observations', doc.id, {
          embedding,
          updated_at: new Date(),
        });
      }
      updated++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  Write failed for ${label}: ${msg}`);
      failed++;
    }

    if (EMBED_DELAY_MS > 0) {
      await new Promise(r => setTimeout(r, EMBED_DELAY_MS));
    }
  }

  console.log('');
  console.log('[maintain re-embed] ─────────────────────────────────');
  console.log(`[maintain re-embed] Updated:  ${updated}`);
  console.log(`[maintain re-embed] Skipped:  ${skipped}`);
  console.log(`[maintain re-embed] Failed:   ${failed}`);

  if (args.dryRun) {
    console.log('[maintain re-embed] (Dry run — no writes performed)');
  }
}

// ─── Help ─────────────────────────────────────────────────────────────────────

function printMaintainHelp(): void {
  process.stderr.write(`fozikio maintain — data maintenance for cortex stores

Usage:
  fozikio maintain fix                 Scan and repair data issues
  fozikio maintain re-embed            Re-embed memories with current provider
  fozikio maintain re-embed --dry-run  Show what would be re-embedded

Fix flags:
  --dry-run     Show issues and fixes without writing
  --verbose     Show detail per memory

Re-embed flags:
  --dry-run               Show what would be re-embedded without writing
  --null-only             Only re-embed docs with missing/null embeddings
  --limit N               Max docs to process (default: 500)
  --collection <name>     memories | observations (default: memories)
  --verbose               Show detail per doc

Environment:
  EMBED_DELAY_MS          Delay between embed calls in ms (default: 200)
`);
}

// ─── Main Export ─────────────────────────────────────────────────────────────

export async function runMaintain(args: string[]): Promise<void> {
  const parsed = parseArgs(args);

  switch (parsed.subcommand) {
    case 'fix':
      await runFix(parsed);
      break;

    case 're-embed':
      await runReEmbed(parsed);
      break;

    case null:
    case undefined:
      printMaintainHelp();
      process.exit(1);
      break;

    default:
      process.stderr.write(`[fozikio maintain] Unknown subcommand: ${parsed.subcommand}\n\n`);
      printMaintainHelp();
      process.exit(1);
  }
}
