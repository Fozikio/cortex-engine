/**
 * router.ts — noun-verb command resolution.
 *
 * The tree carries groups (`memory`, `service`, `agent`) and leaves. Legacy
 * top-level verbs are kept working through an alias table that rewrites the
 * argv path before resolution; they are hidden from help but are permanent,
 * not transitional — cron jobs and external docs invoke them directly, and a
 * deprecation warning would only pollute cron logs.
 */

import { UsageError } from './args.js';

export type Handler = (argv: string[]) => Promise<void> | void;

export interface CommandNode {
  /** One-line summary for help output. */
  summary: string;
  /** Leaf behaviour. Mutually exclusive with `children` in practice. */
  run?: Handler;
  /** Subcommands, for group nodes. */
  children?: Record<string, CommandNode>;
  /** Omit from help listings (aliases, easter eggs). */
  hidden?: boolean;
  /** Extra help text appended under the summary. */
  detail?: string;
}

export type CommandTree = Record<string, CommandNode>;

/** Legacy verb → canonical path. */
export type AliasTable = Record<string, string[]>;

export interface Resolution {
  /** Canonical path taken, e.g. ['memory', 'health']. */
  path: string[];
  node: CommandNode;
  /** Arguments remaining after the command path. */
  rest: string[];
}

/**
 * Resolve `argv` against the tree, expanding aliases first.
 *
 * Returns null when argv is empty, so the caller can choose between the
 * dashboard and help based on TTY-ness.
 */
export function resolve(
  argv: string[],
  tree: CommandTree,
  aliases: AliasTable = {},
): Resolution | null {
  if (argv.length === 0) return null;

  // Expand a legacy verb into its canonical path before walking.
  let args = argv;
  const alias = aliases[args[0]];
  if (alias) args = [...alias, ...args.slice(1)];

  const path: string[] = [];
  let level: CommandTree | undefined = tree;
  let node: CommandNode | undefined;

  for (const token of args) {
    // Stop at the first flag — everything from there is the command's own.
    if (token.startsWith('-')) break;
    const next: CommandNode | undefined = level?.[token];
    if (!next) break;
    node = next;
    path.push(token);
    level = next.children;
  }

  if (!node) {
    throw new UsageError(
      `unknown command: ${argv.join(' ')}`,
      'run `fozikio help` to see available commands',
    );
  }

  const rest = args.slice(path.length);

  // A group invoked with no runnable leaf: point at its subcommands.
  if (!node.run) {
    const sub = rest.find((t) => !t.startsWith('-'));
    if (sub) {
      throw new UsageError(
        `unknown subcommand: ${path.join(' ')} ${sub}`,
        `valid: ${Object.keys(node.children ?? {}).join(', ')}`,
      );
    }
    throw new UsageError(
      `${path.join(' ')} needs a subcommand`,
      `valid: ${Object.keys(node.children ?? {}).join(', ')}`,
    );
  }

  return { path, node, rest };
}

/** Walk the tree, yielding every visible leaf with its full path. */
export function* visibleLeaves(
  tree: CommandTree,
  prefix: string[] = [],
): Generator<{ path: string[]; node: CommandNode }> {
  for (const [name, node] of Object.entries(tree)) {
    if (node.hidden) continue;
    const path = [...prefix, name];
    if (node.run) yield { path, node };
    if (node.children) yield* visibleLeaves(node.children, path);
  }
}
