#!/usr/bin/env node
/**
 * fozikio CLI — entry point.
 *
 * A router and nothing else. Commands live in *-cmd.ts, the tree and alias
 * table in cli/commands.ts, and help is generated from the same tree the
 * router walks so the two cannot drift.
 */

import { createRequire } from 'node:module';
import { parse, UsageError } from '../cli/args.js';
import { ALIASES, buildTree } from '../cli/commands.js';
import { renderCommandHelp, renderRootHelp } from '../cli/help.js';
import { resolve } from '../cli/router.js';
import { c } from '../cli/ui/color.js';
import { mark, sym } from '../cli/ui/symbols.js';
import { isInteractive } from '../cli/ui/screen.js';

const require = createRequire(import.meta.url);
const { version } = require('../../package.json') as { version: string };

const tree = buildTree(version);

function fail(err: unknown): never {
  if (err instanceof UsageError) {
    console.error('');
    console.error(`  ${mark.fail()} ${err.message}`);
    if (err.hint) console.error(`    ${c.dim(sym.arrow)} ${c.dim(err.hint)}`);
    console.error('');
    process.exit(2);
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error('');
  console.error(`  ${mark.fail()} ${message}`);
  console.error('');
  process.exit(1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // Bare invocation: interactive shell on a terminal, help when piped.
  if (argv.length === 0) {
    if (!isInteractive()) {
      console.log(renderRootHelp(tree, version));
      return;
    }
    const { runShell } = await import('../cli/tui/shell.js');
    await runShell({ tree, aliases: ALIASES, version });
    return;
  }

  if (argv[0] === '--version' || argv[0] === '-v') {
    console.log(version);
    return;
  }
  if (argv[0] === '--help' || argv[0] === '-h') {
    console.log(renderRootHelp(tree, version));
    return;
  }

  const resolved = resolve(argv, tree, ALIASES);
  if (!resolved) {
    console.log(renderRootHelp(tree, version));
    return;
  }

  // --help anywhere in a command's own arguments prints that command's help.
  // Handled here rather than in each command so every one behaves the same.
  const wantsHelp = parse(
    resolved.rest.filter((a) => a === '--help' || a === '-h'),
  ).globals.help;
  if (wantsHelp) {
    console.log(renderCommandHelp(resolved.path, resolved.node));
    return;
  }

  await resolved.node.run!(resolved.rest);
}

main().catch(fail);
