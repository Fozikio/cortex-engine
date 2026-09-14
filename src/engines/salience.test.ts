/**
 * Salience scale normalisation.
 *
 * Digest and reflect wrote 1–10 into a 0–1 field, and the ranking factor
 * multiplied the result straight through. These pin the conversion rule at
 * the one place every writer and reader now goes through.
 */

import { describe, it, expect } from 'vitest';
import { normalizeSalience, isOutOfRangeSalience } from './salience.js';

describe('normalizeSalience', () => {
  it('leaves a value already on the 0–1 scale alone', () => {
    expect(normalizeSalience(0)).toBe(0);
    expect(normalizeSalience(0.35)).toBe(0.35);
    expect(normalizeSalience(1)).toBe(1);
  });

  it('treats anything above 1 as the legacy 1–10 scale and divides by 10', () => {
    expect(normalizeSalience(6)).toBeCloseTo(0.6);
    expect(normalizeSalience(7)).toBeCloseTo(0.7);
    expect(normalizeSalience(10)).toBe(1);
    expect(normalizeSalience(1.5)).toBeCloseTo(0.15);
  });

  it('clamps values that fit neither scale', () => {
    expect(normalizeSalience(-0.2)).toBe(0);
    expect(normalizeSalience(15)).toBe(1);
  });

  it('returns the fallback for non-numbers', () => {
    expect(normalizeSalience(undefined)).toBe(0.5);
    expect(normalizeSalience(Number.NaN)).toBe(0.5);
    expect(normalizeSalience('7', 0.3)).toBe(0.3);
  });
});

describe('isOutOfRangeSalience', () => {
  it('flags only finite numbers outside [0, 1]', () => {
    expect(isOutOfRangeSalience(7)).toBe(true);
    expect(isOutOfRangeSalience(-1)).toBe(true);
    expect(isOutOfRangeSalience(0.9)).toBe(false);
    expect(isOutOfRangeSalience(1)).toBe(false);
    expect(isOutOfRangeSalience(undefined)).toBe(false);
    expect(isOutOfRangeSalience(Number.NaN)).toBe(false);
  });
});
