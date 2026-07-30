/**
 * color.ts — terminal styling with zero dependencies.
 *
 * Emits SGR codes directly rather than delegating to `util.styleText`.
 * styleText performs its *own* TTY check against process.stdout and returns
 * the string unstyled when that check fails — which silently overrides an
 * explicit --color or FORCE_COLOR whenever output is piped. Detection has to
 * live in one place to be predictable, so it lives here.
 *
 * Owning the codes also sidesteps a version problem: styleText only exists
 * from Node 20.12, while package.json declares `engines: ">=20"`.
 *
 * Precedence, highest first:
 *   explicit override (--color/--no-color) > FORCE_COLOR > NO_COLOR >
 *   TERM=dumb > stream.isTTY
 */

export type Style =
  | 'reset' | 'bold' | 'dim' | 'italic' | 'underline' | 'inverse'
  | 'black' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white'
  | 'gray' | 'grey'
  | 'bgRed' | 'bgGreen' | 'bgYellow' | 'bgBlue';

/** SGR open/close pairs. */
const SGR: Record<Style, [number, number]> = {
  reset: [0, 0],
  bold: [1, 22],
  dim: [2, 22],
  italic: [3, 23],
  underline: [4, 24],
  inverse: [7, 27],
  black: [30, 39],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  blue: [34, 39],
  magenta: [35, 39],
  cyan: [36, 39],
  white: [37, 39],
  gray: [90, 39],
  grey: [90, 39],
  bgRed: [41, 49],
  bgGreen: [42, 49],
  bgYellow: [43, 49],
  bgBlue: [44, 49],
};

/** Set by --color / --no-color. null means "decide from the environment". */
let override: boolean | null = null;

/**
 * Force colour on or off for the rest of the process.
 * Pass null to fall back to environment detection.
 */
export function setColorOverride(value: boolean | null): void {
  override = value;
}

function envSaysNo(): boolean {
  // NO_COLOR is honoured when present and not empty (https://no-color.org).
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return true;
  if (process.env.TERM === 'dumb') return true;
  return false;
}

function envSaysYes(): boolean {
  const force = process.env.FORCE_COLOR;
  return force !== undefined && force !== '' && force !== '0' && force !== 'false';
}

/** Whether styling should be emitted for `stream`. */
export function colorEnabled(stream: NodeJS.WriteStream = process.stdout): boolean {
  if (override !== null) return override;
  if (envSaysYes()) return true;
  if (envSaysNo()) return false;
  return Boolean(stream.isTTY);
}

/**
 * Style `text`. Returns it unchanged when colour is disabled, so call sites
 * never branch on TTY-ness themselves.
 */
export function paint(
  text: string,
  styles: Style | Style[],
  stream: NodeJS.WriteStream = process.stdout,
): string {
  if (!colorEnabled(stream)) return text;
  const list = Array.isArray(styles) ? styles : [styles];
  if (list.length === 0) return text;

  let out = text;
  // Apply right-to-left so the outermost style opens first.
  for (let i = list.length - 1; i >= 0; i--) {
    const code = SGR[list[i]];
    if (!code) continue;
    out = `\x1b[${code[0]}m${out}\x1b[${code[1]}m`;
  }
  return out;
}

/** Shorthands for the styles used across the CLI. */
export const c = {
  bold: (t: string) => paint(t, 'bold'),
  dim: (t: string) => paint(t, 'dim'),
  red: (t: string) => paint(t, 'red'),
  green: (t: string) => paint(t, 'green'),
  yellow: (t: string) => paint(t, 'yellow'),
  blue: (t: string) => paint(t, 'blue'),
  cyan: (t: string) => paint(t, 'cyan'),
  magenta: (t: string) => paint(t, 'magenta'),
  gray: (t: string) => paint(t, 'gray'),
} as const;

/** Strip ANSI escapes — used for width maths and non-TTY output. */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/** Printable width of a string, ignoring styling. */
export function visibleWidth(text: string): number {
  return stripAnsi(text).length;
}
