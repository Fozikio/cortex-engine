import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { colorEnabled, paint, setColorOverride, stripAnsi, visibleWidth } from './color.js';

const tty = { isTTY: true } as NodeJS.WriteStream;
const pipe = { isTTY: false } as NodeJS.WriteStream;

const saved = { ...process.env };

beforeEach(() => {
  setColorOverride(null);
  delete process.env.NO_COLOR;
  delete process.env.FORCE_COLOR;
  delete process.env.TERM;
});

afterEach(() => {
  setColorOverride(null);
  process.env = { ...saved };
});

describe('colorEnabled', () => {
  it('is on for a TTY and off for a pipe', () => {
    expect(colorEnabled(tty)).toBe(true);
    expect(colorEnabled(pipe)).toBe(false);
  });

  it('honours NO_COLOR over TTY detection', () => {
    process.env.NO_COLOR = '1';
    expect(colorEnabled(tty)).toBe(false);
  });

  it('ignores an empty NO_COLOR', () => {
    process.env.NO_COLOR = '';
    expect(colorEnabled(tty)).toBe(true);
  });

  it('honours FORCE_COLOR over NO_COLOR and over a pipe', () => {
    process.env.NO_COLOR = '1';
    process.env.FORCE_COLOR = '1';
    expect(colorEnabled(pipe)).toBe(true);
  });

  it('treats FORCE_COLOR=0 as unset', () => {
    process.env.FORCE_COLOR = '0';
    expect(colorEnabled(pipe)).toBe(false);
  });

  it('disables colour on a dumb terminal', () => {
    process.env.TERM = 'dumb';
    expect(colorEnabled(tty)).toBe(false);
  });

  it('lets an explicit override beat everything', () => {
    process.env.FORCE_COLOR = '1';
    setColorOverride(false);
    expect(colorEnabled(tty)).toBe(false);

    setColorOverride(true);
    process.env.NO_COLOR = '1';
    expect(colorEnabled(pipe)).toBe(true);
  });
});

describe('paint', () => {
  it('returns text untouched when colour is disabled', () => {
    setColorOverride(false);
    expect(paint('hello', 'red', tty)).toBe('hello');
  });

  it('wraps text in escapes when colour is enabled', () => {
    setColorOverride(true);
    const out = paint('hello', 'red', pipe);
    expect(out).not.toBe('hello');
    expect(stripAnsi(out)).toBe('hello');
  });

  it('applies multiple styles and still strips back to the original', () => {
    setColorOverride(true);
    const out = paint('hi', ['bold', 'green'], pipe);
    expect(stripAnsi(out)).toBe('hi');
  });

  it('is a no-op for an empty style list', () => {
    setColorOverride(true);
    expect(paint('hi', [], pipe)).toBe('hi');
  });
});

describe('visibleWidth', () => {
  it('measures printable characters, not escapes', () => {
    setColorOverride(true);
    // Column alignment depends on this: a styled cell must measure the same
    // as its plain equivalent, or every table drifts.
    expect(visibleWidth(paint('abcd', 'red', pipe))).toBe(4);
  });
});
