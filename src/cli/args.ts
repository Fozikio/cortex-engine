/**
 * args.ts — one argument parser for the whole CLI.
 *
 * Replaces the per-command hand-rolled parsers with `util.parseArgs` (stable
 * since Node 20.0). Every command inherits the global flags below, and unknown
 * flags become a UsageError rather than being silently ignored.
 */

import { parseArgs, type ParseArgsConfig } from 'node:util';
import { setColorOverride } from './ui/color.js';

type OptionConfig = NonNullable<ParseArgsConfig['options']>;
type OptionValue = string | boolean | string[] | boolean[] | undefined;

/** Thrown for bad invocations. The CLI exits 2 on these. */
export class UsageError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Flags every command accepts. */
export const GLOBAL_OPTIONS: OptionConfig = {
  json: { type: 'boolean', default: false },
  color: { type: 'boolean', default: false },
  'no-color': { type: 'boolean', default: false },
  yes: { type: 'boolean', short: 'y', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  verbose: { type: 'boolean', default: false },
};

export interface GlobalFlags {
  json: boolean;
  yes: boolean;
  help: boolean;
  verbose: boolean;
}

export interface Parsed {
  /** Parsed flag values, command-specific plus global. */
  values: Record<string, OptionValue>;
  /** Non-flag arguments, in order. */
  positionals: string[];
  globals: GlobalFlags;
}

/**
 * Parse `argv` against `options` merged with the global flags.
 *
 * Applies the colour override as a side effect so `--no-color` takes hold
 * before any output is produced.
 */
export function parse(argv: string[], options: OptionConfig = {}): Parsed {
  const merged: OptionConfig = { ...GLOBAL_OPTIONS, ...options };

  let result: ReturnType<typeof parseArgs>;
  try {
    result = parseArgs({
      args: argv,
      options: merged,
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new UsageError(msg, 'run with --help to see valid options');
  }

  const values = result.values as Record<string, OptionValue>;

  // --no-color wins over --color; neither set means "detect from environment".
  if (values['no-color'] === true) setColorOverride(false);
  else if (values.color === true) setColorOverride(true);
  else setColorOverride(null);

  return {
    values,
    positionals: result.positionals as string[],
    globals: {
      json: values.json === true,
      yes: values.yes === true,
      help: values.help === true,
      verbose: values.verbose === true,
    },
  };
}

/** Read a string flag, or undefined when absent. */
export function str(parsed: Parsed, name: string): string | undefined {
  const v = parsed.values[name];
  return typeof v === 'string' ? v : undefined;
}

/** Read a boolean flag. */
export function bool(parsed: Parsed, name: string): boolean {
  return parsed.values[name] === true;
}

/**
 * Read a numeric flag. Throws UsageError when present but not a finite number,
 * rather than silently yielding NaN the way `parseInt` would.
 */
export function num(parsed: Parsed, name: string, fallback: number): number {
  const raw = str(parsed, name);
  if (raw === undefined) return fallback;
  const parsedNum = Number(raw);
  if (!Number.isFinite(parsedNum)) {
    throw new UsageError(`--${name} expects a number, got "${raw}"`);
  }
  return parsedNum;
}

/**
 * Legacy-compatible flag read for the pre-parseArgs command files.
 * Mirrors the `args.indexOf('--flag') + 1` idiom they each reimplemented.
 */
export function rawFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}
