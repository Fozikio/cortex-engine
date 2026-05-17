/**
 * `fozikio tools` — list and search cortex tools by category.
 *
 * Flags:
 *   --category <cat>   only show tools in this category
 *   --json             emit structured JSON instead of formatted text
 *   --search <q>       case-insensitive substring match on name/description/whenToUse
 */

import { createTools, TOOL_CATEGORIES, toToolMetadata } from '../mcp/tools.js';
import type { ToolCategory, ToolMetadata } from '../mcp/tools.js';

interface ToolsCmdOptions {
  category?: ToolCategory;
  search?: string;
  json: boolean;
}

function parseArgs(argv: string[]): ToolsCmdOptions {
  const opts: ToolsCmdOptions = { json: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--category' && argv[i + 1]) {
      const next = argv[++i];
      if (!(TOOL_CATEGORIES as readonly string[]).includes(next)) {
        throw new Error(`Unknown category: ${next}. Valid: ${TOOL_CATEGORIES.join(', ')}`);
      }
      opts.category = next as ToolCategory;
    } else if (arg === '--search' && argv[i + 1]) {
      opts.search = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return opts;
}

function printHelp(): void {
  console.log(`fozikio tools — list cortex tools by category

Usage:
  fozikio tools [options]

Options:
  --category <cat>   filter to one category (${TOOL_CATEGORIES.join(', ')})
  --json             emit JSON
  --search <q>       case-insensitive substring match on name/description/whenToUse
  -h, --help         show this help
`);
}

function filterTools(
  metas: ToolMetadata[],
  opts: ToolsCmdOptions,
): ToolMetadata[] {
  let out = metas;
  if (opts.category) {
    out = out.filter(t => t.category === opts.category);
  }
  if (opts.search) {
    const needle = opts.search.toLowerCase();
    out = out.filter(t =>
      t.name.toLowerCase().includes(needle) ||
      t.description.toLowerCase().includes(needle) ||
      t.whenToUse.toLowerCase().includes(needle) ||
      (t.doNotUse?.toLowerCase().includes(needle) ?? false),
    );
  }
  return out;
}

function formatText(metas: ToolMetadata[]): string {
  // Group by category in the canonical order.
  const grouped = new Map<ToolCategory, ToolMetadata[]>();
  for (const cat of TOOL_CATEGORIES) grouped.set(cat, []);
  for (const t of metas) grouped.get(t.category)!.push(t);

  const lines: string[] = [];
  for (const cat of TOOL_CATEGORIES) {
    const tools = grouped.get(cat) ?? [];
    if (tools.length === 0) continue;
    lines.push('');
    lines.push(`== ${cat} (${tools.length}) ==`);
    for (const t of tools.sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push('');
      lines.push(`  ${t.name}`);
      lines.push(`    ${t.description}`);
      lines.push(`    use when: ${t.whenToUse}`);
      if (t.doNotUse) lines.push(`    avoid when: ${t.doNotUse}`);
    }
  }
  lines.push('');
  lines.push(`Total: ${metas.length} tools`);
  return lines.join('\n');
}

export function runToolsCmd(argv: string[]): void {
  let opts: ToolsCmdOptions;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`[fozikio tools] ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const metas = createTools().map(toToolMetadata);
  const filtered = filterTools(metas, opts);

  if (opts.json) {
    console.log(JSON.stringify({ tools: filtered, total: filtered.length }, null, 2));
    return;
  }

  if (filtered.length === 0) {
    console.log('No tools matched.');
    return;
  }
  console.log(formatText(filtered));
}
