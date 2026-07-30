/**
 * shell.ts — the interactive session behind a bare `fozikio`.
 *
 * A REPL, not a monitor: a persistent prompt that runs any command in-process,
 * keeps history, completes on tab, and offers a browsable palette. The live
 * dashboard is one command inside it rather than the landing experience,
 * because a fixed panel of service lights answers one question and a prompt
 * answers all of them.
 *
 * Commands run in this process, so three things matter:
 *   - process.exitCode is reset between runs, or the first failure would
 *     poison the shell's own exit status.
 *   - Errors are caught and printed; one bad command must not end the session.
 *   - Commands that block forever (serve, nli) are refused with a pointer to
 *     the supervised equivalent, rather than hanging the prompt.
 */

import * as readline from 'node:readline/promises';
import { UsageError } from '../args.js';
import { c } from '../ui/color.js';
import { mark, sym, truncate } from '../ui/symbols.js';
import { select, type Choice } from '../ui/select.js';
import { renderCommandHelp, renderRootHelp } from '../help.js';
import { resolve, visibleLeaves, type AliasTable, type CommandTree } from '../router.js';
import { SERVICE_IDS, SERVICES } from '../../services/registry.js';
import { status } from '../../services/supervisor.js';

/** Commands that never terminate — they would hang the prompt. */
const BLOCKING: Record<string, string> = {
  serve: 'runs an MCP server over stdio and never returns — run it in its own terminal',
  nli: 'runs in the foreground — use `service start nli` for a supervised instance',
};

const PROMPT = `${c.cyan('fozikio')} ${c.dim('›')} `;

interface ShellOptions {
  tree: CommandTree;
  aliases: AliasTable;
  version: string;
}

/** Every runnable command path, for completion and the palette. */
function commandPaths(tree: CommandTree): { path: string; summary: string }[] {
  return [...visibleLeaves(tree)].map((leaf) => ({
    path: leaf.path.join(' '),
    summary: leaf.node.summary,
  }));
}

async function serviceLine(): Promise<string> {
  const statuses = await Promise.all(SERVICE_IDS.map((id) => status(SERVICES[id])));
  return statuses.map((s) => `${mark.dot(s.state)} ${s.label}`).join('  ');
}

function banner(version: string, services: string): string {
  return [
    '',
    `  ${c.bold('fozikio')} ${c.dim(version)}`,
    `  ${services}`,
    '',
    `  ${c.dim('enter a command · empty enter to browse · ')}${c.cyan('?')}${c.dim(' help · ')}${c.cyan('exit')}${c.dim(' quit')}`,
    '',
  ].join('\n');
}

/** Browsable command palette, shown on an empty prompt. */
async function palette(tree: CommandTree): Promise<string | null> {
  const choices: Choice<string>[] = commandPaths(tree).map((cmd) => ({
    label: cmd.path,
    value: cmd.path,
    hint: truncate(cmd.summary, 46),
  }));
  return select('run which command?', choices);
}

export async function runShell(opts: ShellOptions): Promise<void> {
  const { tree, aliases, version } = opts;
  const paths = commandPaths(tree).map((cmd) => cmd.path);
  const builtins = ['help', 'exit', 'quit', 'clear'];

  /** Tab completion over command paths and shell builtins. */
  const completer = (line: string): [string[], string] => {
    const candidates = [...paths, ...builtins];
    const hits = candidates.filter((cmd) => cmd.startsWith(line));
    return [hits.length ? hits : candidates, line];
  };

  console.log(banner(version, await serviceLine()));

  // History is tracked here and seeded back through readline's `history`
  // option — newest first, the order readline expects. A copy is passed in
  // because readline mutates the array it is handed.
  const history: string[] = [];
  const remember = (entry: string) => {
    if (entry === '' || history[0] === entry) return;
    history.unshift(entry);
    if (history.length > 200) history.length = 200;
  };

  let running = true;

  // The interface is consumed as an async iterator rather than a question per
  // line. Recreating it around every line discards whatever the input stream
  // has already buffered, which silently swallows pasted multi-line input.
  // Iterating holds one interface open and delivers lines in order; while a
  // command runs, further input simply waits.
  //
  // It is still rebuilt for the palette, which needs raw mode to itself — but
  // that only happens on an interactive terminal, where the tty holds unread
  // input rather than the stream buffering it.
  while (running) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      completer,
      history: [...history],
      historySize: 200,
      terminal: true,
    });

    // Ctrl-C abandons the current line rather than the session; the session
    // ends on Ctrl-D, `exit`, or `quit`.
    rl.on('SIGINT', () => {
      rl.write(null, { ctrl: true, name: 'u' });
      console.log(`  ${c.dim('(type exit to quit)')}`);
      rl.prompt();
    });

    let wantPalette = false;
    rl.setPrompt(PROMPT);
    rl.prompt();

    for await (const line of rl) {
      const input = line.trim();
      remember(input);

      if (input === 'exit' || input === 'quit') { running = false; break; }

      if (input === '') {
        wantPalette = true;
        break;
      } else if (input === 'clear') {
        console.clear();
      } else if (input === '?' || input === 'help') {
        console.log(renderRootHelp(tree, version));
      } else {
        await runOne(input);
      }

      rl.prompt();
    }

    rl.close();

    if (wantPalette) {
      const chosen = await palette(tree);
      if (chosen) await runOne(chosen);
      continue;
    }

    // The iterator ended without an explicit exit — stdin closed (Ctrl-D).
    break;
  }

  console.log(`  ${c.dim('bye')}`);

  /** Resolve and execute one line, keeping the session alive on failure. */
  async function runOne(input: string): Promise<void> {
    const argv = input.split(/\s+/).filter(Boolean);

    const blocked = BLOCKING[argv[0]];
    if (blocked) {
      console.log('');
      console.log(`  ${mark.warn()} ${c.bold(argv[0])} ${c.dim(blocked)}`);
      console.log('');
      return;
    }

    // A previous command's failure must not leak into this one, nor into the
    // exit status of the shell itself.
    process.exitCode = 0;

    try {
      const resolved = resolve(argv, tree, aliases);
      if (!resolved) return;

      if (resolved.rest.includes('--help') || resolved.rest.includes('-h')) {
        console.log(renderCommandHelp(resolved.path, resolved.node));
        return;
      }

      if (resolved.path[0] === 'dashboard') {
        // The dashboard owns the alternate screen; it restores on exit and we
        // land back at the prompt.
        const { runDashboard } = await import('./dashboard.js');
        await runDashboard(version);
        return;
      }

      await resolved.node.run!(resolved.rest);
    } catch (err) {
      if (err instanceof UsageError) {
        console.log('');
        console.log(`  ${mark.fail()} ${err.message}`);
        if (err.hint) console.log(`    ${c.dim(sym.arrow)} ${c.dim(err.hint)}`);
        console.log('');
      } else {
        const message = err instanceof Error ? err.message : String(err);
        console.log('');
        console.log(`  ${mark.fail()} ${message}`);
        console.log('');
      }
    } finally {
      process.exitCode = 0;
    }
  }
}
