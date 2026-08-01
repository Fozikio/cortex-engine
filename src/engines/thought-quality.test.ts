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

/**
 * Regression corpus from the 2026-07-31 incident, verbatim.
 *
 * dream refined these two rows from specific, grounded definitions into
 * meta-text describing "the memory concept" instead of the subject. Both were
 * accepted by the gate as it stood. This is the same failure signature that
 * corrupted 301 of 639 definitions before engine 1.4.0, so the texts are kept
 * exactly as they were written rather than paraphrased into something tidier.
 */
const REAL_BEFORE_1 =
  "Embedding observations now occurs in seconds due to migration from SQLite-backed semantic indexes derived from markdown, with structured reflection loops and entity-aware retrieval, as demonstrated by systems like OpenClaw's workspace memory v2 and cortex-engine's production implementation.";
const REAL_AFTER_1 =
  'The memory concept involves rapid embedding of observations through optimized processing, leveraging structured reflection and entity-aware retrieval, as seen in systems like OpenClaw and cortex-engine, with performance improvements achieved through migration from SQLite-backed indexes.';

const REAL_AFTER_2 =
  'The memory concept encompasses two distinct yet interconnected intellectual pursuits: a science series and a humor-focused glossary. Concept A emphasizes the capacity of the memory concept to support diverse endeavors, while Concept B explores the nature of inquiry.';

describe('assessThought — self-referential meta-text (2026-07-31 regression)', () => {
  it('rejects a refinement that defines the memory instead of the subject', () => {
    // Grounding cannot save us here: this text is a PARAPHRASE of the very
    // definition it replaces, so it keeps the vocabulary and scored 0.32 with
    // zero generic-marker hits. It was accepted. That is the hole.
    const result = assessThought(REAL_AFTER_1, { evidence: [REAL_BEFORE_1] });
    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/describes the memory|meta/i);
  });

  it('rejects internal placeholder scaffolding leaking into stored text', () => {
    const result = assessThought(REAL_AFTER_2, { evidence: [REAL_AFTER_2] });
    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/placeholder|Concept A/i);
  });

  it('still accepts a legitimate memory ABOUT memory corruption', () => {
    // The discriminator is POSITION. This row quotes the boilerplate as
    // evidence mid-sentence; it does not open with it. A naive substring check
    // would reject it, and rejecting it would stop dream ever recording
    // findings about its own failures.
    const legit =
      'HALF THE MEMORY GRAPH IS CORRUPTED - measured, not estimated. Direct SQLite audit: 629 memories, 301 damaged. 53 were BOILERPLATE, where the definition was replaced with generic meta-text, for example "This memory phenomenon consistently occurs during the consolidation phase, reflecting its reliability and importance".';
    const result = assessThought(legit, { evidence: [legit] });
    expect(result.ok).toBe(true);
  });

  it('accepts a definition that merely mentions memory as its subject', () => {
    const evidence = ['Cortex stores memories in SQLite with 1024-d embeddings.'];
    const result = assessThought(
      'Cortex stores memories in SQLite alongside 1024-dimensional embeddings, so retrieval needs no external vector database.',
      { evidence },
    );
    expect(result.ok).toBe(true);
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
