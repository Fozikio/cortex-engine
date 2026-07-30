/**
 * select.ts — filterable arrow-key menu.
 *
 * Uses raw mode directly rather than the shared screen module, because a menu
 * is an inline prompt: it must not take over the alternate buffer, and it has
 * to restore the terminal on its own before returning.
 *
 * Two behaviours the first version got wrong once the command list grew past a
 * screenful:
 *   - The list is windowed. Redraw works by moving the cursor up over the
 *     previous render, so a list taller than the terminal scrolls the region
 *     out from under that cursor arithmetic and corrupts the display.
 *   - Printable keys filter rather than navigate, so a long list stays
 *     reachable by typing. That rules out j/k as movement keys — arrows only.
 */

import { c } from './color.js';
import { sym, truncate } from './symbols.js';
import { KEY } from './screen.js';
import { UsageError } from '../args.js';

const MAX_VISIBLE = 10;

export interface Choice<T> {
  label: string;
  value: T;
  hint?: string;
  disabled?: boolean;
}

/**
 * Printable text from a key chunk, or null.
 *
 * A chunk is not always one character: fast typing and pastes arrive as a
 * single data event, so matching on length 1 silently dropped them.
 */
function printableText(chunk: string): string | null {
  if (chunk.length === 0) return null;
  for (const ch of chunk) {
    if (ch < ' ' || ch > '~') return null;
  }
  return chunk;
}

/**
 * Present `choices` and resolve with the selected value.
 * Rejects with UsageError when stdin is not a TTY.
 * Resolves to null when the user cancels (Esc or Ctrl-C).
 */
export function select<T>(title: string, choices: Choice<T>[]): Promise<T | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return Promise.reject(new UsageError(
      'a menu needs a terminal',
      'pass the choice as an argument instead',
    ));
  }
  if (choices.length === 0) {
    return Promise.reject(new UsageError('nothing to choose from'));
  }

  return new Promise((resolve) => {
    let query = '';
    let cursor = 0;
    let offset = 0;
    let drawnLines = 0;

    const filtered = (): Choice<T>[] => {
      if (query === '') return choices;
      const needle = query.toLowerCase();
      return choices.filter((ch) =>
        ch.label.toLowerCase().includes(needle) ||
        (ch.hint?.toLowerCase().includes(needle) ?? false));
    };

    const visibleCount = (listLength: number): number => {
      const rows = (process.stdout.rows ?? 24) - 4; // title, footer, breathing room
      return Math.max(3, Math.min(MAX_VISIBLE, rows, Math.max(1, listLength)));
    };

    /** Keep the cursor inside the window after movement or a filter change. */
    const clampWindow = (list: Choice<T>[], size: number) => {
      if (cursor >= list.length) cursor = Math.max(0, list.length - 1);
      if (cursor < offset) offset = cursor;
      if (cursor >= offset + size) offset = cursor - size + 1;
      const maxOffset = Math.max(0, list.length - size);
      if (offset > maxOffset) offset = maxOffset;
      if (offset < 0) offset = 0;
    };

    const draw = () => {
      if (drawnLines > 0) process.stdout.write(`\x1b[${drawnLines}A`);

      const list = filtered();
      const size = visibleCount(list.length);
      clampWindow(list, size);

      const width = Math.max(40, (process.stdout.columns ?? 80) - 4);
      const lines: string[] = [];

      const typed = query === '' ? c.dim('type to filter') : c.cyan(query);
      lines.push(`${c.bold(title)} ${typed}`);

      if (list.length === 0) {
        lines.push(`  ${c.dim('no match')}`);
      } else {
        const window = list.slice(offset, offset + size);
        for (let i = 0; i < window.length; i++) {
          const ch = window[i];
          const selected = offset + i === cursor;
          const pointer = selected ? c.cyan(sym.arrow) : ' '.repeat(sym.arrow.length);
          let label = ch.disabled ? c.dim(ch.label) : ch.label;
          if (selected && !ch.disabled) label = c.cyan(label);
          const room = width - ch.label.length - 6;
          const hint = ch.hint && room > 8 ? ` ${c.dim(truncate(ch.hint, room))}` : '';
          lines.push(`${pointer} ${label}${hint}`);
        }
      }

      const more: string[] = [];
      if (offset > 0) more.push('↑ more');
      if (offset + size < list.length) more.push('↓ more');
      const counter = list.length === choices.length
        ? `${list.length}`
        : `${list.length}/${choices.length}`;
      lines.push(c.dim(
        `  ↑/↓ move · enter select · esc cancel · ${counter}` +
        (more.length ? ` · ${more.join(' ')}` : ''),
      ));

      drawnLines = lines.length;
      // \x1b[2K clears each line as it is written; \x1b[0J drops whatever a
      // previous, taller render left below.
      process.stdout.write(lines.map((l) => `\x1b[2K${l}`).join('\n') + '\n\x1b[0J');
    };

    const move = (delta: number) => {
      const list = filtered();
      if (list.length === 0) return;
      let next = cursor;
      for (let i = 0; i < list.length; i++) {
        next = (next + delta + list.length) % list.length;
        if (!list[next].disabled) break;
      }
      cursor = next;
    };

    const cleanup = () => {
      process.stdin.off('data', onData);
      if (process.stdin.setRawMode) process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\x1b[?25h');
    };

    const onData = (chunk: Buffer) => {
      const key = chunk.toString('utf8');

      if (key === KEY.CTRL_C || key === KEY.ESC) {
        cleanup();
        resolve(null);
        return;
      }
      if (key === KEY.ENTER || key === KEY.ENTER_LF) {
        const chosen = filtered()[cursor];
        cleanup();
        resolve(!chosen || chosen.disabled ? null : chosen.value);
        return;
      }
      if (key === KEY.UP) { move(-1); draw(); return; }
      if (key === KEY.DOWN) { move(1); draw(); return; }

      // Backspace arrives as DEL on most terminals, BS on some.
      if (key === '\x7f' || key === '\b') {
        if (query !== '') { query = query.slice(0, -1); cursor = 0; offset = 0; draw(); }
        return;
      }
      const text = printableText(key);
      if (text !== null) {
        query += text;
        cursor = 0;
        offset = 0;
        draw();
      }
    };

    process.stdout.write('\x1b[?25l');
    if (process.stdin.setRawMode) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
    draw();
  });
}
