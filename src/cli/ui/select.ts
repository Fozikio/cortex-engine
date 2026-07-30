/**
 * select.ts — arrow-key menu.
 *
 * Uses raw mode directly rather than the shared screen module, because a menu
 * is an inline prompt: it must not take over the alternate buffer, and it has
 * to restore the terminal on its own before returning.
 */

import { c } from './color.js';
import { sym } from './symbols.js';
import { KEY } from './screen.js';
import { UsageError } from '../args.js';

export interface Choice<T> {
  label: string;
  value: T;
  hint?: string;
  disabled?: boolean;
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
    const firstEnabled = choices.findIndex((ch) => !ch.disabled);
    let cursor = firstEnabled === -1 ? 0 : firstEnabled;
    let drawnLines = 0;

    const draw = () => {
      // Move back over the previous render before repainting.
      if (drawnLines > 0) process.stdout.write(`\x1b[${drawnLines}A`);

      const lines = [`${c.bold(title)}`];
      for (let i = 0; i < choices.length; i++) {
        const ch = choices[i];
        const selected = i === cursor;
        const pointer = selected ? c.cyan(sym.arrow) : ' '.repeat(sym.arrow.length);
        let label = ch.disabled ? c.dim(ch.label) : ch.label;
        if (selected && !ch.disabled) label = c.cyan(label);
        const hint = ch.hint ? ` ${c.dim(ch.hint)}` : '';
        lines.push(`${pointer} ${label}${hint}`);
      }
      lines.push(c.dim('  ↑/↓ move · enter select · esc cancel'));

      drawnLines = lines.length;
      process.stdout.write(lines.map((l) => `\x1b[2K${l}`).join('\n') + '\n');
    };

    const move = (delta: number) => {
      // Skip disabled entries; give up after a full loop so an all-disabled
      // list cannot spin forever.
      let next = cursor;
      for (let i = 0; i < choices.length; i++) {
        next = (next + delta + choices.length) % choices.length;
        if (!choices[next].disabled) break;
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
        const chosen = choices[cursor];
        cleanup();
        resolve(chosen.disabled ? null : chosen.value);
        return;
      }
      if (key === KEY.UP || key === 'k') { move(-1); draw(); return; }
      if (key === KEY.DOWN || key === 'j') { move(1); draw(); return; }
    };

    process.stdout.write('\x1b[?25l');
    if (process.stdin.setRawMode) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
    draw();
  });
}
