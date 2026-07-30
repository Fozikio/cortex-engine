/**
 * prompt.ts — confirmations and free-text input.
 *
 * Non-interactive callers (cron, pipes, CI) must never hang waiting on stdin.
 * When there is no TTY, a prompt either takes the `assumeYes` answer or throws
 * — it does not block.
 */

import * as readline from 'node:readline/promises';
import { c } from './color.js';
import { UsageError } from '../args.js';

export interface ConfirmOptions {
  /** Answer used when the user just presses enter. */
  default?: boolean;
  /** Set by --yes: skip the question and answer true. */
  assumeYes?: boolean;
}

function interactive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** Ask a yes/no question. */
export async function confirm(question: string, opts: ConfirmOptions = {}): Promise<boolean> {
  const fallback = opts.default ?? false;

  if (opts.assumeYes) return true;

  if (!interactive()) {
    throw new UsageError(
      `"${question}" needs an answer but stdin is not a terminal`,
      're-run with --yes to accept automatically',
    );
  }

  const hint = fallback ? 'Y/n' : 'y/N';
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} ${c.dim(`(${hint})`)} `)).trim().toLowerCase();
    if (answer === '') return fallback;
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

/** Ask for a line of text. */
export async function input(question: string, fallback?: string): Promise<string> {
  if (!interactive()) {
    if (fallback !== undefined) return fallback;
    throw new UsageError(
      `"${question}" needs input but stdin is not a terminal`,
      'pass the value as a flag instead',
    );
  }

  const suffix = fallback ? c.dim(` (${fallback})`) : '';
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question}${suffix} `)).trim();
    return answer === '' && fallback !== undefined ? fallback : answer;
  } finally {
    rl.close();
  }
}
