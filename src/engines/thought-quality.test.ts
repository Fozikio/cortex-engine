/**
 * Tests for the structural thought-quality gate.
 */

import { describe, it, expect } from 'vitest';
import {
  assessThought,
  groundingScore,
  hasConceptPlaceholder,
  stripMarkdownFormatting,
  substituteConceptPlaceholders,
} from './thought-quality.js';

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


/**
 * Regression corpus for the mid-text markdown leak (issue #54), verbatim from
 * the dream run that accepted all five rows below. The gate as it stood was
 * `/^(#{1,6}\s|\*\*)/` — anchored to position 0, so bold anywhere after the
 * first character passed. It fired elsewhere in the same run, which is exactly
 * what made it look like a working check.
 */
const REAL_ABSTRACT_1 =
  'The unifying pattern is **"Persistence through Structure"** — a principle where organized, hierarchical frameworks outlast the material they organize.';
const REAL_ABSTRACT_2 =
  'The deeper connection is **"Boundary Translation Principle"** — a pattern that emphasizes the necessity of explicit contracts at every interface.';

describe('assessThought — mid-text markdown leak (issue #54)', () => {
  it('rejects bold that appears after the first character', () => {
    for (const text of [REAL_ABSTRACT_1, REAL_ABSTRACT_2]) {
      const result = assessThought(text, { evidence: [text], minGrounding: 0.1 });
      expect(result.ok).toBe(false);
      expect(result.reasons.some((r) => r.includes('markdown'))).toBe(true);
    }
  });

  it('rejects underscore emphasis mid-text', () => {
    const result = assessThought(
      'Refresh tokens rotate on every use, which the ops log records as __rotation events__ for audit.',
      { evidence: EVIDENCE },
    );
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes('markdown'))).toBe(true);
  });

  it('rejects a heading on any line, not just the first', () => {
    const result = assessThought(
      'Tokens rotate on every use in the auth service.\n\n## Rotation failures\n\nFailures are logged to ops.',
      { evidence: EVIDENCE },
    );
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes('markdown'))).toBe(true);
  });

  it('does not fire on a lone asterisk or a hash used as an issue reference', () => {
    // Widening the check from position 0 to anywhere buys precision problems if
    // it treats ordinary punctuation as formatting. Only PAIRED emphasis counts.
    const result = assessThought(
      'Token rotation was fixed in issue #52; the 3 * 5 retry matrix in the auth service still logs every failure to ops.',
      { evidence: EVIDENCE },
    );
    expect(result.reasons.some((r) => r.includes('markdown'))).toBe(false);
  });
});

describe('stripMarkdownFormatting', () => {
  it('keeps the wrapped text and drops the markers', () => {
    expect(stripMarkdownFormatting(REAL_ABSTRACT_1)).toBe(
      'The unifying pattern is "Persistence through Structure" — a principle where organized, hierarchical frameworks outlast the material they organize.',
    );
  });

  it('produces text the gate then accepts', () => {
    // This is the whole point for `abstract`: a rejected abstraction leaves
    // nothing in its place, so formatting alone must not cost the synthesis.
    const stripped = stripMarkdownFormatting(REAL_ABSTRACT_1);
    const result = assessThought(stripped, { evidence: [REAL_ABSTRACT_1], minGrounding: 0.1 });
    expect(result.ok).toBe(true);
  });

  it('strips heading markers without eating the heading text', () => {
    expect(stripMarkdownFormatting('## Rotation failures\n\nFailures are logged.')).toBe(
      'Rotation failures\n\nFailures are logged.',
    );
  });

  it('leaves unformatted text byte-identical', () => {
    const clean = 'Refresh tokens rotate on every use and are stored hashed in SQLite.';
    expect(stripMarkdownFormatting(clean)).toBe(clean);
  });
});

describe('substituteConceptPlaceholders (issue #53)', () => {
  it('rewrites the prompt labels into the names they stood for', () => {
    expect(
      substituteConceptPlaceholders(
        'Concept A provides the storage layer that Concept B queries for retrieval.',
        { A: 'SQLite store', B: 'spread activation' },
      ),
    ).toBe('SQLite store provides the storage layer that spread activation queries for retrieval.');
  });

  it('leaves a slot alone when no name is supplied', () => {
    // A partial map must not invent a subject; the survivor is still caught by
    // the placeholder gate downstream rather than being silently stored.
    const out = substituteConceptPlaceholders(
      'Concept A extends Concept B.',
      { A: 'FSRS scheduling' },
    );
    expect(out).toBe('FSRS scheduling extends Concept B.');
    expect(hasConceptPlaceholder(out)).toBe(true);
  });

  it('repairs evidence that would otherwise poison a refinement', () => {
    // The live-store shape: 82% of edge evidence carried these labels, refine
    // read them back as source material, and the model echoed them into the
    // definition — where the gate threw the whole refinement away.
    const evidence = 'Concept A emphasizes retention capacity, while Concept B explores inquiry.';
    expect(hasConceptPlaceholder(evidence)).toBe(true);
    const repaired = substituteConceptPlaceholders(evidence, {
      A: 'semantic memory',
      B: 'diachronic analysis',
    });
    expect(hasConceptPlaceholder(repaired)).toBe(false);
    expect(repaired).toContain('semantic memory');
    expect(repaired).toContain('diachronic analysis');
  });

  it('does not touch a capitalised word that merely follows "Concept"', () => {
    const text = 'Concept Analysis is a documented technique in the retrieval literature.';
    expect(substituteConceptPlaceholders(text, { A: 'nope' })).toBe(text);
  });

  it('withholds a replacement name that is itself contaminated', () => {
    // Contamination propagates: a leaked definition yields a leaked name, and
    // feeding that name back as ground truth re-contaminates the repair. One
    // live row was named `Concept A describes the agent's capacity to retain...`.
    // Substituting it would swap one placeholder for a longer one.
    const out = substituteConceptPlaceholders('Concept A extends Concept B.', {
      A: "Concept A describes the agent's capacity to retain observations",
      B: 'FSRS scheduling',
    });
    expect(out).toBe('Concept A extends FSRS scheduling.');
    expect(hasConceptPlaceholder(out)).toBe(true);
  });

  it('leaves text with no scaffolding untouched', () => {
    const clean = 'The SQLite store backs retrieval with 1024-dimensional embeddings.';
    expect(substituteConceptPlaceholders(clean, { A: 'x', B: 'y' })).toBe(clean);
  });
});
