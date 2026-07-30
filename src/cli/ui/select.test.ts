/**
 * Drives select() by emitting key sequences on stdin, with the TTY properties
 * stubbed. This is the trickiest UI code in the CLI — windowing arithmetic and
 * filter state — and it is not reachable through the command surface.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { select, type Choice } from './select.js';
import { setColorOverride, stripAnsi } from './color.js';
import { UsageError } from '../args.js';

const KEYS = {
  up: '\x1b[A',
  down: '\x1b[B',
  enter: '\r',
  esc: '\x1b',
  ctrlC: '\x03',
  backspace: '\x7f',
};

let written: string[] = [];
let restore: (() => void)[] = [];

function stubTty(rows = 24, cols = 100): void {
  const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: unknown };
  const stdout = process.stdout as NodeJS.WriteStream;

  const savedIn = stdin.isTTY;
  const savedRaw = stdin.setRawMode;
  const savedOut = stdout.isTTY;
  const savedRows = stdout.rows;
  const savedCols = stdout.columns;

  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdout.isTTY = true;
  stdout.rows = rows;
  stdout.columns = cols;

  const writeSpy = vi.spyOn(stdout, 'write').mockImplementation(((chunk: string) => {
    written.push(String(chunk));
    return true;
  }) as typeof stdout.write);

  restore.push(() => {
    stdin.isTTY = savedIn;
    stdin.setRawMode = savedRaw;
    stdout.isTTY = savedOut;
    stdout.rows = savedRows;
    stdout.columns = savedCols;
    writeSpy.mockRestore();
  });
}

/** Feed keys once select has attached its listener. */
async function send(...keys: string[]): Promise<void> {
  for (const key of keys) {
    await new Promise((r) => setImmediate(r));
    process.stdin.emit('data', Buffer.from(key, 'utf8'));
  }
}

/** Everything drawn so far, with styling removed. */
function screen(): string {
  return stripAnsi(written.join(''));
}

const choices: Choice<string>[] = [
  { label: 'up', value: 'up', hint: 'start every service' },
  { label: 'down', value: 'down', hint: 'stop every service' },
  { label: 'status', value: 'status', hint: 'show service status' },
  { label: 'doctor', value: 'doctor', hint: 'diagnose the install' },
  { label: 'memory health', value: 'memory health', hint: 'memory report' },
];

beforeEach(() => {
  written = [];
  restore = [];
  setColorOverride(false);
});

afterEach(() => {
  restore.forEach((fn) => fn());
  process.stdin.removeAllListeners('data');
  setColorOverride(null);
});

describe('select', () => {
  it('rejects without a terminal rather than hanging', async () => {
    await expect(select('pick', choices)).rejects.toBeInstanceOf(UsageError);
  });

  it('returns the first choice on enter', async () => {
    stubTty();
    const pending = select('pick', choices);
    await send(KEYS.enter);
    expect(await pending).toBe('up');
  });

  it('moves down with the arrow key', async () => {
    stubTty();
    const pending = select('pick', choices);
    await send(KEYS.down, KEYS.down, KEYS.enter);
    expect(await pending).toBe('status');
  });

  it('wraps around when moving up from the first entry', async () => {
    stubTty();
    const pending = select('pick', choices);
    await send(KEYS.up, KEYS.enter);
    expect(await pending).toBe('memory health');
  });

  it('resolves null on escape and on ctrl-c', async () => {
    stubTty();
    const escaped = select('pick', choices);
    await send(KEYS.esc);
    expect(await escaped).toBeNull();

    const cancelled = select('pick', choices);
    await send(KEYS.ctrlC);
    expect(await cancelled).toBeNull();
  });

  it('skips disabled entries', async () => {
    stubTty();
    const withDisabled: Choice<string>[] = [
      { label: 'a', value: 'a' },
      { label: 'b', value: 'b', disabled: true },
      { label: 'c', value: 'c' },
    ];
    const pending = select('pick', withDisabled);
    await send(KEYS.down, KEYS.enter);
    expect(await pending).toBe('c');
  });
});

describe('filtering', () => {
  it('narrows the list as characters are typed', async () => {
    stubTty();
    const pending = select('pick', choices);
    await send('d', 'o', 'c');
    const before = screen();
    await send(KEYS.enter);

    expect(await pending).toBe('doctor');
    // The counter reports the narrowed set against the whole.
    expect(before).toContain('1/5');
  });

  it('matches on the hint as well as the label', async () => {
    stubTty();
    const pending = select('pick', choices);
    await send('diagnose', KEYS.enter);
    expect(await pending).toBe('doctor');
  });

  it('backspace widens the list again', async () => {
    stubTty();
    const pending = select('pick', choices);
    await send('doctor');
    await send(KEYS.backspace, KEYS.backspace, KEYS.backspace,
      KEYS.backspace, KEYS.backspace, KEYS.backspace);
    await send(KEYS.enter);
    // Back to an unfiltered list, so the cursor sits on the first entry.
    expect(await pending).toBe('up');
  });

  it('reports no match and selects nothing', async () => {
    stubTty();
    const pending = select('pick', choices);
    await send('zzzz');
    expect(screen()).toContain('no match');
    await send(KEYS.enter);
    expect(await pending).toBeNull();
  });
});

describe('windowing', () => {
  const many: Choice<number>[] = Array.from({ length: 30 }, (_, i) => ({
    label: `cmd-${String(i).padStart(2, '0')}`,
    value: i,
  }));

  it('never draws more rows than the terminal has', async () => {
    // A 12-row terminal with 30 choices: the naive version drew all 30, which
    // scrolls the region out from under the cursor-up redraw and corrupts it.
    stubTty(12);
    const pending = select('pick', many);
    const firstFrame = stripAnsi(written.join(''));
    await send(KEYS.esc);
    await pending;

    const rendered = firstFrame.split('\n').filter((l) => l.includes('cmd-'));
    expect(rendered.length).toBeLessThanOrEqual(8);
  });

  it('scrolls the window to keep the cursor visible', async () => {
    stubTty(24);
    const pending = select('pick', many);
    await send(...Array(12).fill(KEYS.down));

    const lastFrame = stripAnsi(written[written.length - 1]);
    expect(lastFrame).toContain('cmd-12');
    expect(lastFrame).toContain('↑ more');

    await send(KEYS.enter);
    expect(await pending).toBe(12);
  });

  it('shows a down indicator while entries remain below', async () => {
    stubTty(24);
    const pending = select('pick', many);
    expect(stripAnsi(written[written.length - 1])).toContain('↓ more');
    await send(KEYS.esc);
    await pending;
  });
});
