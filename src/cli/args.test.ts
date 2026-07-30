import { describe, it, expect, afterEach } from 'vitest';
import { bool, num, parse, rawFlag, str, UsageError } from './args.js';
import { setColorOverride } from './ui/color.js';

afterEach(() => setColorOverride(null));

describe('parse', () => {
  it('exposes global flags on every command', () => {
    const parsed = parse(['--json', '--yes']);
    expect(parsed.globals.json).toBe(true);
    expect(parsed.globals.yes).toBe(true);
    expect(parsed.globals.help).toBe(false);
  });

  it('accepts short forms', () => {
    expect(parse(['-y']).globals.yes).toBe(true);
    expect(parse(['-h']).globals.help).toBe(true);
  });

  it('collects positionals separately from flags', () => {
    const parsed = parse(['start', 'ollama', '--json']);
    expect(parsed.positionals).toEqual(['start', 'ollama']);
    expect(parsed.globals.json).toBe(true);
  });

  it('merges command options with the globals', () => {
    const parsed = parse(['--days', '14', '--json'], { days: { type: 'string' } });
    expect(str(parsed, 'days')).toBe('14');
    expect(parsed.globals.json).toBe(true);
  });

  it('rejects unknown flags rather than ignoring them', () => {
    // The pre-parseArgs commands silently dropped anything they did not
    // recognise, so a typo looked like a working invocation.
    expect(() => parse(['--porcelain'])).toThrow(UsageError);
  });

  it('reports unknown flags as usage errors, with a hint', () => {
    try {
      parse(['--nope']);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      expect((err as UsageError).hint).toContain('--help');
    }
  });
});

describe('typed readers', () => {
  it('returns the fallback when a numeric flag is absent', () => {
    expect(num(parse([]), 'days', 30)).toBe(30);
  });

  it('parses a numeric flag', () => {
    expect(num(parse(['--days', '7'], { days: { type: 'string' } }), 'days', 30)).toBe(7);
  });

  it('rejects a non-numeric value instead of yielding NaN', () => {
    const parsed = parse(['--days', 'soon'], { days: { type: 'string' } });
    expect(() => num(parsed, 'days', 30)).toThrow(UsageError);
  });

  it('reads booleans', () => {
    const parsed = parse(['--dry-run'], { 'dry-run': { type: 'boolean' } });
    expect(bool(parsed, 'dry-run')).toBe(true);
    expect(bool(parsed, 'absent')).toBe(false);
  });
});

describe('rawFlag', () => {
  it('reads the value following a flag', () => {
    expect(rawFlag(['--port', '11435'], '--port')).toBe('11435');
  });

  it('returns undefined when the flag is last', () => {
    expect(rawFlag(['--port'], '--port')).toBeUndefined();
  });

  it('returns undefined when the flag is absent', () => {
    expect(rawFlag(['--host', 'x'], '--port')).toBeUndefined();
  });
});
