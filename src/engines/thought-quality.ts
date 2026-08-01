/**
 * Thought quality — structural acceptance gate for model-generated cognition.
 *
 * Dream phases (refine, abstract) previously rejected LLM output via string
 * blocklists alone ("foreign thought markers"). Blocklists are brittle: they
 * encode one model's failure vocabulary and say nothing about whether the
 * thought is grounded in the evidence it claims to derive from.
 *
 * This module makes the quality decision structural:
 *
 * 1. Form checks — length bounds, sentence completeness, markdown leakage.
 * 2. Grounding — the fraction of the thought's content words that appear in
 *    the evidence it was generated from. Generic LLM filler ("holistic
 *    approach", "paradigm") shares almost no vocabulary with real evidence,
 *    so it scores near zero regardless of which model produced it.
 * 3. Generic-phrase markers — retained as a *weak* signal (they were derived
 *    empirically from real contamination incidents), but a single marker hit
 *    no longer vetoes a thought that is otherwise well-grounded.
 *
 * Pure and synchronous: no providers, no I/O — trivially unit-testable.
 */

import { extractKeywords } from './keywords.js';

/**
 * Phrases characteristic of ungrounded LLM filler. Derived empirically from
 * dream-contamination incidents (Gemini + Ollama 14B, 2026-04-02). Weak
 * evidence individually — used in combination with grounding, never alone.
 */
export const GENERIC_PHRASE_MARKERS: readonly string[] = [
  // Gemini-origin markers (identified 2026-04-02)
  'this concept', 'this memory concept', 'expanding digital landscape',
  'fundamentally unknowable', 'service gravity', 'critical challenge',
  'inevitable future', 'broader context', 'deeper understanding',
  'multifaceted', 'nuanced understanding', 'holistic approach',
  'inherent complexity', 'paradigm', 'interconnected', 'transformative',
  // Ollama 14B markers (identified 2026-04-02 from first local dream)
  'this pattern unifies', 'this pattern connects', 'this pattern bridges',
  'this memory concept integrates', 'adaptive knowledge',
  'structured coordination', 'transparent boundaries',
];

/**
 * Openers that make the ARTEFACT the grammatical subject instead of the thing
 * being described — "The memory concept involves...", "The concept refers
 * to...". A definition that opens this way says nothing about its subject, and
 * a name derived from it inherits the evasion.
 *
 * WHY THIS CANNOT BE LEFT TO `grounding`. This failure mode is a *paraphrase*
 * of the definition it replaces, so it retains that definition's vocabulary and
 * scores well. The 2026-07-31 regression scored 0.32 with zero generic-marker
 * hits and was accepted. Grounding measures whether a thought is derived from
 * its evidence; it cannot measure whether the thought is ABOUT anything. So
 * these veto regardless of grounding, exactly like the other form checks.
 *
 * ANCHORED AT THE START, DELIBERATELY. A legitimate memory may quote this
 * phrasing mid-sentence — a finding about corruption necessarily cites the
 * corrupt text. Matching anywhere would stop dream ever recording its own
 * failure modes, which is precisely the knowledge worth keeping.
 */
const SELF_REFERENTIAL_OPENERS: readonly RegExp[] = [
  /^(?:the|this)\s+(?:(?:memory|refined|unifying|underlying)\s+)?concept\b/i,
  /^(?:the|this)\s+memory\s+(?:phenomenon|entry|record)\b/i,
  /^(?:this|it)\s+refers\s+to\b/i,
  /^the\s+term\s+(?:refers|describes|is)\b/i,
  /^the\s+idea\s+(?:that|of)\b/i,
  /^the\s+phrase\b/i,
];

/**
 * Internal comparison scaffolding leaking into stored text. The refine and
 * connect prompts label their inputs "Concept A" / "Concept B"; when those
 * labels survive into the definition, the row describes the prompt rather than
 * the world. Seen verbatim on 2026-07-31: "Concept A emphasizes the capacity of
 * the memory concept to support diverse endeavors".
 *
 * A legitimate definition could in principle discuss an abstract "Concept A",
 * and this would reject it. That trade is deliberate: a rejected refinement
 * leaves the existing row untouched, which is the safe direction.
 */
const PLACEHOLDER_LEAK = /\bConcept\s+[A-Z]\b/;

export interface ThoughtQualityOptions {
  /**
   * Texts the thought is supposed to be derived from (current definition,
   * observations, source concepts). When provided, grounding is enforced.
   */
  evidence?: string[];
  /**
   * Minimum fraction of the thought's content keywords that must appear in
   * the evidence (default 0.25). Lower this for deliberately abstractive
   * output (cross-domain synthesis legitimately introduces new vocabulary).
   */
  minGrounding?: number;
  /** Require terminal sentence punctuation (default true) — rejects truncation. */
  requireSentenceEnd?: boolean;
  /** Minimum character length (default 20). */
  minLength?: number;
  /** Maximum character length (default 2000). */
  maxLength?: number;
}

export interface ThoughtQualityResult {
  /** True when the thought passes all structural checks. */
  ok: boolean;
  /**
   * Fraction of the thought's content keywords found in the evidence,
   * or null when no evidence was provided.
   */
  grounding: number | null;
  /** Generic-phrase markers found in the thought (lowercased). */
  generic_hits: string[];
  /** Human-readable reasons for rejection (empty when ok). */
  reasons: string[];
}

/**
 * Keyword-overlap grounding: what fraction of the thought's content words
 * appear anywhere in the evidence? Returns 1 for an empty keyword set
 * (nothing to contradict grounding).
 */
export function groundingScore(text: string, evidence: string[]): number {
  const thoughtKeywords = extractKeywords(text, 50);
  if (thoughtKeywords.length === 0) return 1;

  const evidenceKeywords = new Set(extractKeywords(evidence.join(' '), 500));
  const hits = thoughtKeywords.filter((k) => evidenceKeywords.has(k)).length;
  return hits / thoughtKeywords.length;
}

/**
 * Assess whether model-generated text is acceptable as a stored thought.
 *
 * Decision rule:
 * - Form failures (empty, truncated, markdown-formatted, out of bounds,
 *   self-referential meta-text, placeholder leakage) reject. These are
 *   unconditional: grounding cannot arbitrate a thought that is well-derived
 *   from its evidence and still about nothing.
 * - Two or more generic-phrase markers reject.
 * - With evidence: grounding below `minGrounding` rejects, and a single
 *   generic marker rejects when grounding is only marginal
 *   (< minGrounding + 0.15).
 * - Without evidence: a single generic marker rejects (blocklist behavior is
 *   retained where grounding cannot arbitrate).
 */
export function assessThought(
  text: string,
  options: ThoughtQualityOptions = {},
): ThoughtQualityResult {
  const {
    evidence,
    minGrounding = 0.25,
    requireSentenceEnd = true,
    minLength = 20,
    maxLength = 2000,
  } = options;

  const trimmed = text.trim();
  const reasons: string[] = [];

  if (trimmed.length < minLength) reasons.push(`too short (<${minLength} chars)`);
  if (trimmed.length > maxLength) reasons.push(`too long (>${maxLength} chars)`);
  if (requireSentenceEnd && trimmed.length > 0 && !/[.!?]["')\]]?$/.test(trimmed)) {
    reasons.push('does not end with sentence punctuation (possible truncation)');
  }
  if (/^(#{1,6}\s|\*\*)/.test(trimmed)) {
    reasons.push('markdown formatting leaked into thought');
  }
  if (SELF_REFERENTIAL_OPENERS.some((re) => re.test(trimmed))) {
    reasons.push('describes the memory rather than its subject (meta-text opener)');
  }
  if (PLACEHOLDER_LEAK.test(trimmed)) {
    reasons.push('internal placeholder scaffolding leaked into thought (Concept A/B)');
  }

  const lower = trimmed.toLowerCase();
  const genericHits = GENERIC_PHRASE_MARKERS.filter((m) => lower.includes(m));
  if (genericHits.length >= 2) {
    reasons.push(`generic phrasing (${genericHits.length} marker hits)`);
  }

  let grounding: number | null = null;
  if (evidence && evidence.length > 0) {
    grounding = groundingScore(trimmed, evidence);
    if (grounding < minGrounding) {
      reasons.push(`ungrounded (${grounding.toFixed(2)} < ${minGrounding} keyword overlap with evidence)`);
    } else if (genericHits.length === 1 && grounding < minGrounding + 0.15) {
      reasons.push(`generic phrasing with marginal grounding (${grounding.toFixed(2)})`);
    }
  } else if (genericHits.length === 1) {
    reasons.push('generic phrasing (marker hit, no evidence available to check grounding)');
  }

  return {
    ok: reasons.length === 0,
    grounding,
    generic_hits: genericHits,
    reasons,
  };
}
