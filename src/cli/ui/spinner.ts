/**
 * spinner.ts — progress indicator that disappears cleanly when not on a TTY.
 *
 * When stdout is piped or redirected, the spinner emits a single plain line
 * instead of animation frames, so logs and `--json` consumers never see
 * carriage returns or escape codes.
 */

import { c } from './color.js';
import { sym } from './symbols.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const FRAMES_ASCII = ['|', '/', '-', '\\'];
const INTERVAL_MS = 80;

export interface Spinner {
  /** Replace the label without restarting the animation. */
  update(text: string): void;
  succeed(text?: string): void;
  fail(text?: string): void;
  warn(text?: string): void;
  /** Stop and erase, leaving no trace. */
  stop(): void;
}

/** A spinner that writes nothing but a final status line. */
function staticSpinner(label: string, stream: NodeJS.WriteStream): Spinner {
  let current = label;
  const done = (glyph: string, text?: string) => {
    stream.write(`${glyph} ${text ?? current}\n`);
  };
  return {
    update(text) { current = text; },
    succeed(text) { done(sym.ok, text); },
    fail(text) { done(sym.fail, text); },
    warn(text) { done(sym.warn, text); },
    stop() { /* nothing was drawn */ },
  };
}

/**
 * Start a spinner. Always returns a Spinner — call sites never branch on
 * whether the terminal is interactive.
 */
export function spin(label: string, stream: NodeJS.WriteStream = process.stdout): Spinner {
  if (!stream.isTTY) return staticSpinner(label, stream);

  const frames = process.platform === 'win32' && !process.env.WT_SESSION
    ? FRAMES_ASCII
    : FRAMES;

  let text = label;
  let index = 0;
  let stopped = false;

  const clearLine = () => { stream.write('\r\x1b[2K'); };
  const render = () => {
    if (stopped) return;
    stream.write(`\r\x1b[2K${c.cyan(frames[index])} ${text}`);
    index = (index + 1) % frames.length;
  };

  stream.write('\x1b[?25l'); // hide cursor for the duration
  render();
  const timer = setInterval(render, INTERVAL_MS);
  // Do not hold the event loop open on the spinner alone.
  timer.unref?.();

  const finish = (glyph: string, final?: string) => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    clearLine();
    stream.write('\x1b[?25h');
    if (glyph) stream.write(`${glyph} ${final ?? text}\n`);
  };

  return {
    update(next) { text = next; },
    succeed(final) { finish(c.green(sym.ok), final); },
    fail(final) { finish(c.red(sym.fail), final); },
    warn(final) { finish(c.yellow(sym.warn), final); },
    stop() { finish(''); },
  };
}
