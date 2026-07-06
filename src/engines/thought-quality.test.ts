/**
 * Tests for the structural thought-quality gate.
 */

import { describe, it, expect } from 'vitest';
import { assessThought, groundingScore } from './thought-quality.js';

const EVIDENCE = [
  'The auth service issues JWT tokens with a 15 minute expiry.',
  'Refresh tokens rotate on every use and are stored hashed in SQLite.',
  'Token rotation failures are logged to the ops collection.',
];

describe('groundingScore', () => {
  it('scores evidence-derived text high', () => {
    const score = groundingScore(
      'The auth service rotates refresh tokens on every use and logs rotation failures.',
      EVIDENCE,
    );
    expect(score).toBeGreaterThan(0.7);
  });

  it('scores generic filler near zero', () => {
    const score = groundingScore(
      'This represents a holistic paradigm of interconnected complexity across the expanding digital landscape.',
      EVIDENCE,
    );
    expect(score).toBeLessThan(0.2);
  });
});

describe('assessThought', () => {
  it('accepts a grounded, complete refinement', () => {
    const result = assessThought(
      'The auth service issues short-lived JWT tokens and rotates refresh tokens on every use, logging failures to ops.',
      { evidence: EVIDENCE },
    );
    expect(result.ok).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('rejects generic LLM filler even without marker phrases', () => {
    const result = assessThought(
      'Systems evolve through emergent synergies that reveal latent organizational dynamics over time.',
      { evidence: EVIDENCE },
    );
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes('ungrounded'))).toBe(true);
  });

  it('rejects text with two or more generic markers regardless of evidence', () => {
    const result = assessThought(
      'This concept requires a holistic approach to token auth service management and rotation.',
      { evidence: EVIDENCE },
    );
    expect(result.ok).toBe(false);
    expect(result.generic_hits.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects truncated output', () => {
    const result = assessThought('The auth service issues JWT tokens and');
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes('truncation'))).toBe(true);
  });

  it('rejects markdown-formatted output', () => {
    const result = assessThought('**Pattern**: tokens rotate on use in the auth service.', {
      evidence: EVIDENCE,
    });
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes('markdown'))).toBe(true);
  });

  it('rejects too-short output', () => {
    const result = assessThought('Tokens rotate.');
    expect(result.ok).toBe(false);
  });

  it('retains blocklist behavior on a single marker when no evidence is available', () => {
    const result = assessThought(
      'A multifaceted view of token rotation policies in the authentication layer.',
    );
    expect(result.ok).toBe(false);
    expect(result.generic_hits).toContain('multifaceted');
  });

  it('tolerates a single marker when the thought is otherwise well-grounded', () => {
    const result = assessThought(
      'The auth service and SQLite store are interconnected: refresh tokens rotate on every use, are stored hashed, and rotation failures are logged to the ops collection.',
      { evidence: EVIDENCE },
    );
    expect(result.generic_hits).toContain('interconnected');
    expect(result.ok).toBe(true);
  });

  it('allows lower grounding floors for abstractive output', () => {
    const abstraction =
      'Rotation appears as a general defensive principle: tokens, like credentials anywhere, resist theft by being short-lived.';
    const strict = assessThought(abstraction, { evidence: EVIDENCE, minGrounding: 0.5 });
    const loose = assessThought(abstraction, { evidence: EVIDENCE, minGrounding: 0.1 });
    expect(strict.ok).toBe(false);
    expect(loose.ok).toBe(true);
  });
});
