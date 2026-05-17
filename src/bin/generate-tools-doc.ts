/**
 * Generator for docs/tools-reference.md.
 *
 * Walks the canonical tool list, groups by category, and emits a markdown
 * reference with one subsection per tool (name, description, whenToUse,
 * doNotUse, input schema summary). Run via `npm run docs:tools`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTools, TOOL_CATEGORIES, toToolMetadata } from '../mcp/tools.js';
import type { ToolCategory, ToolMetadata } from '../mcp/tools.js';

const CATEGORY_HEADINGS: Record<ToolCategory, string> = {
  memory: 'Memory',
  consolidation: 'Consolidation',
  beliefs: 'Beliefs',
  ops: 'Ops Log',
  threads: 'Threads',
  journal: 'Journal & Identity',
  social: 'Social',
  content: 'Content',
  graph: 'Graph',
  vitals: 'Vitals',
  agents: 'Agents & Goals',
  maintenance: 'Maintenance',
  meta: 'Meta & Signals',
};

function formatSchemaSummary(meta: ToolMetadata): string[] {
  const props = meta.inputSchema.properties ?? {};
  const required = new Set(meta.inputSchema.required ?? []);
  const names = Object.keys(props);
  if (names.length === 0) {
    return ['  - (no arguments)'];
  }
  const lines: string[] = [];
  for (const name of names) {
    const prop = props[name] as { type?: string; description?: string };
    const tag = required.has(name) ? ' *(required)*' : '';
    const typeStr = prop?.type ? ` \`${prop.type}\`` : '';
    const desc = prop?.description ? ` — ${prop.description}` : '';
    lines.push(`  - \`${name}\`${typeStr}${tag}${desc}`);
  }
  return lines;
}

function renderTool(meta: ToolMetadata): string[] {
  const lines: string[] = [];
  lines.push(`### \`${meta.name}\``);
  lines.push('');
  lines.push(meta.description);
  lines.push('');
  lines.push(`**Use when:** ${meta.whenToUse}`);
  lines.push('');
  if (meta.doNotUse) {
    lines.push(`**Don't use when:** ${meta.doNotUse}`);
    lines.push('');
  }
  lines.push('**Arguments:**');
  lines.push('');
  lines.push(...formatSchemaSummary(meta));
  lines.push('');
  return lines;
}

function render(metas: ToolMetadata[]): string {
  const grouped = new Map<ToolCategory, ToolMetadata[]>();
  for (const cat of TOOL_CATEGORIES) grouped.set(cat, []);
  for (const m of metas) grouped.get(m.category)!.push(m);

  const lines: string[] = [];
  lines.push('# Cortex tools reference');
  lines.push('');
  lines.push('Auto-generated from `src/mcp/tools.ts`. Do not edit by hand — run `npm run docs:tools`.');
  lines.push('');
  lines.push(`Total tools: ${metas.length}. Categories: ${TOOL_CATEGORIES.length}.`);
  lines.push('');
  lines.push('## Index');
  lines.push('');
  for (const cat of TOOL_CATEGORIES) {
    const tools = (grouped.get(cat) ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
    if (tools.length === 0) continue;
    const heading = CATEGORY_HEADINGS[cat];
    const slug = heading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    lines.push(`- [${heading}](#${slug}) (${tools.length})`);
  }
  lines.push('');

  for (const cat of TOOL_CATEGORIES) {
    const tools = (grouped.get(cat) ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
    if (tools.length === 0) continue;
    lines.push(`## ${CATEGORY_HEADINGS[cat]}`);
    lines.push('');
    for (const t of tools) {
      lines.push(...renderTool(t));
    }
  }

  return lines.join('\n');
}

function main(): void {
  const metas = createTools().map(toToolMetadata);
  const content = render(metas);

  // Resolve project root from this module's location: dist/bin/ → ../../docs/
  // or src/bin/ in dev — either way, walk up two from the dirname.
  const here = dirname(fileURLToPath(import.meta.url));
  const projectRoot = resolve(here, '..', '..');
  const outDir = join(projectRoot, 'docs');
  const outPath = join(outDir, 'tools-reference.md');

  mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, content, 'utf-8');
  console.log(`Wrote ${outPath} (${metas.length} tools, ${content.length} chars)`);
}

main();
