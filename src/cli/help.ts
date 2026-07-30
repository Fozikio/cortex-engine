/**
 * help.ts — help rendered from the command tree.
 *
 * Generating help from the same structure the router walks means the two can
 * never drift, which is exactly what happened to the old hand-written help
 * block: it documented flags that had moved and omitted commands that existed.
 */

import { c } from './ui/color.js';
import { table } from './ui/table.js';
import type { CommandNode, CommandTree } from './router.js';

const USAGE = 'fozikio <command> [subcommand] [options]';

function groupRows(tree: CommandTree): string[][] {
  const rows: string[][] = [];
  for (const [name, node] of Object.entries(tree)) {
    if (node.hidden) continue;
    const label = node.children ? `${name} <sub>` : name;
    rows.push([c.cyan(label), node.summary]);
  }
  return rows;
}

/** Top-level help. */
export function renderRootHelp(tree: CommandTree, version: string): string {
  const out: string[] = [];
  out.push('');
  out.push(`  ${c.bold('fozikio')} ${c.dim(version)}  ${c.dim('— cortex-engine agent management')}`);
  out.push('');
  out.push(`  ${c.dim('Usage:')} ${USAGE}`);
  out.push('');
  out.push(`  ${c.bold('Commands')}`);
  out.push(table(groupRows(tree), { indent: 2, gap: 2 }));
  out.push('');
  out.push(`  ${c.bold('Global options')}`);
  out.push(table([
    [c.cyan('--json'), 'machine-readable output'],
    [c.cyan('--no-color'), 'disable styling (also honours NO_COLOR)'],
    [c.cyan('-y, --yes'), 'assume yes for confirmations'],
    [c.cyan('-h, --help'), 'show help for a command'],
    [c.cyan('--verbose'), 'include diagnostic detail'],
  ], { indent: 2, gap: 2 }));
  out.push('');
  out.push(`  ${c.dim('Run')} ${c.cyan('fozikio <command> --help')} ${c.dim('for command detail.')}`);
  out.push(`  ${c.dim('Run')} ${c.cyan('fozikio')} ${c.dim('with no arguments for the dashboard.')}`);
  out.push('');
  return out.join('\n');
}

/** Help for one node, group or leaf. */
export function renderCommandHelp(path: string[], node: CommandNode): string {
  const out: string[] = [];
  const name = path.join(' ');
  out.push('');
  out.push(`  ${c.bold(`fozikio ${name}`)}`);
  out.push(`  ${node.summary}`);
  out.push('');

  if (node.children) {
    out.push(`  ${c.bold('Subcommands')}`);
    out.push(table(groupRows(node.children), { indent: 2, gap: 2 }));
    out.push('');
  }

  if (node.detail) {
    out.push(node.detail.replace(/^/gm, '  '));
    out.push('');
  }
  return out.join('\n');
}
