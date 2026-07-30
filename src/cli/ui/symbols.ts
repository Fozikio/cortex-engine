/**
 * symbols.ts — status glyphs with an ASCII fallback.
 *
 * Windows consoles below Windows Terminal, and CI logs, cannot always render
 * the Unicode set. Detection mirrors what the runtime can be trusted to draw:
 * anything non-Windows, or Windows Terminal / VS Code / a UTF-8 codepage.
 */

import { paint } from './color.js';

function supportsUnicode(): boolean {
  if (process.env.FOZIKIO_ASCII === '1') return false;
  if (process.platform !== 'win32') return process.env.TERM !== 'dumb';
  return Boolean(
    process.env.WT_SESSION ||               // Windows Terminal
    process.env.TERM_PROGRAM === 'vscode' ||
    process.env.ConEmuTask ||
    process.env.TERM,                       // Git Bash / MSYS
  );
}

const UNICODE = supportsUnicode();

const GLYPH = {
  ok: UNICODE ? '✓' : 'OK',
  fail: UNICODE ? '✗' : 'X',
  warn: UNICODE ? '⚠' : '!',
  info: UNICODE ? 'ℹ' : 'i',
  dotFilled: UNICODE ? '●' : '*',
  dotHollow: UNICODE ? '○' : 'o',
  arrow: UNICODE ? '→' : '->',
  bullet: UNICODE ? '·' : '-',
  ellipsis: UNICODE ? '…' : '...',
  barFull: UNICODE ? '▓' : '#',
  barEmpty: UNICODE ? '░' : '.',
} as const;

export const sym = GLYPH;

/** Uncoloured glyphs, for width maths and `--json`-adjacent plain output. */
export const plain = GLYPH;

/** Coloured status markers. */
export const mark = {
  ok: () => paint(GLYPH.ok, 'green'),
  fail: () => paint(GLYPH.fail, 'red'),
  warn: () => paint(GLYPH.warn, 'yellow'),
  info: () => paint(GLYPH.info, 'blue'),
  /** Filled dot in a state colour — the service-status indicator. */
  dot: (state: 'up' | 'down' | 'degraded' | 'unknown') => {
    switch (state) {
      case 'up': return paint(GLYPH.dotFilled, 'green');
      case 'down': return paint(GLYPH.dotFilled, 'red');
      case 'degraded': return paint(GLYPH.dotFilled, 'yellow');
      default: return paint(GLYPH.dotHollow, 'gray');
    }
  },
} as const;

/**
 * A proportional bar, e.g. ▓▓▓▓░░ for 0.66 at width 6.
 * `value` is clamped to 0..1.
 */
export function bar(value: number, width = 6): string {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const filled = Math.round(clamped * width);
  return GLYPH.barFull.repeat(filled) + GLYPH.barEmpty.repeat(width - filled);
}

/** Truncate to `width`, appending an ellipsis when it does not fit. */
export function truncate(text: string, width: number): string {
  if (text.length <= width) return text;
  if (width <= GLYPH.ellipsis.length) return text.slice(0, width);
  return text.slice(0, width - GLYPH.ellipsis.length) + GLYPH.ellipsis;
}
