/**
 * screen.ts — alternate-screen and raw-mode control.
 *
 * The contract here is restoration. A CLI that exits leaving the terminal in
 * the alternate buffer, with the cursor hidden and stdin in raw mode, has
 * broken the user's shell — that is a defect, not a rough edge. So every
 * teardown path routes through one idempotent `restore()`: normal return,
 * SIGINT, SIGTERM, and uncaughtException.
 *
 * Raw mode suppresses SIGINT, so Ctrl-C (\x03) is detected by the key reader
 * in onKey() rather than by a signal handler.
 */

const ALT_ENTER = '\x1b[?1049h';
const ALT_EXIT = '\x1b[?1049l';
const CURSOR_HIDE = '\x1b[?25l';
const CURSOR_SHOW = '\x1b[?25h';
const CLEAR = '\x1b[2J\x1b[H';

let active = false;
let hooksInstalled = false;
let keyHandler: ((key: string) => void) | null = null;

function onStdinData(chunk: Buffer): void {
  if (keyHandler) keyHandler(chunk.toString('utf8'));
}

/** Idempotent teardown. Safe to call when nothing was ever set up. */
export function restore(): void {
  if (!active) return;
  active = false;

  process.stdin.off('data', onStdinData);
  keyHandler = null;

  if (process.stdin.isTTY && process.stdin.setRawMode) {
    try { process.stdin.setRawMode(false); } catch { /* stream already gone */ }
  }
  process.stdin.pause();

  try {
    process.stdout.write(CURSOR_SHOW + ALT_EXIT);
  } catch { /* stdout closed */ }
}

function installHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;

  process.on('exit', restore);
  process.on('SIGINT', () => { restore(); process.exit(130); });
  process.on('SIGTERM', () => { restore(); process.exit(143); });
  process.on('uncaughtException', (err) => {
    restore();
    console.error(err);
    process.exit(1);
  });
}

/** True when a full-screen UI can be drawn. */
export function isInteractive(): boolean {
  return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

/** Enter the alternate buffer, hide the cursor, and put stdin in raw mode. */
export function enter(): void {
  if (active) return;
  installHooks();
  active = true;

  process.stdout.write(ALT_ENTER + CURSOR_HIDE + CLEAR);

  if (process.stdin.isTTY && process.stdin.setRawMode) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.on('data', onStdinData);
}

/** Register the keypress callback. Ctrl-C arrives here as '\x03'. */
export function onKey(handler: (key: string) => void): void {
  keyHandler = handler;
}

/** Repaint: home the cursor, write, then clear anything below. */
export function paint(frame: string): void {
  process.stdout.write('\x1b[H' + frame + '\x1b[0J');
}

/** Current terminal size, with sane defaults when it cannot be read. */
export function size(): { cols: number; rows: number } {
  return {
    cols: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24,
  };
}

/** Subscribe to resize. Returns an unsubscribe function. */
export function onResize(handler: () => void): () => void {
  process.stdout.on('resize', handler);
  return () => { process.stdout.off('resize', handler); };
}

/** Common key names, normalised from raw escape sequences. */
export const KEY = {
  CTRL_C: '\x03',
  UP: '\x1b[A',
  DOWN: '\x1b[B',
  RIGHT: '\x1b[C',
  LEFT: '\x1b[D',
  ENTER: '\r',
  ENTER_LF: '\n',
  ESC: '\x1b',
  SPACE: ' ',
} as const;
