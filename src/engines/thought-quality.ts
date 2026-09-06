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

/** True when text still carries `Concept A`-style prompt scaffolding. */
export function hasConceptPlaceholder(text: string): boolean {
  return PLACEHOLDER_LEAK.test(text);
}

/** Global twin of PLACEHOLDER_LEAK, capturing the slot letter for substitution. */
const PLACEHOLDER_LEAK_GLOBAL = /\bConcept\s+([A-Z])\b/g;

/**
 * Rewrite leaked `Concept A` / `Concept B` scaffolding into the names of the
 * concepts those slots actually stood for.
 *
 * The `connect` phase builds its prompt with positional labels and stores the
 * model's answer verbatim, so the labels end up in edge evidence — 82% of rows
 * in one live store. `refine` then reads that evidence as source material and
 * echoes the labels into definitions, where PLACEHOLDER_LEAK rejects them. The
 * gate holds, but every rejection is a refinement thrown away, so consolidation
 * does progressively less work while reporting success.
 *
 * Substituting at the boundary fixes both directions with one rule: `connect`
 * calls it before writing evidence, and `refine` calls it on evidence written
 * before that change, so the 2,665 already-stored rows need no migration.
 *
 * A slot with no name supplied is left exactly as it was — a partial map must
 * not invent a subject. Those survivors still meet PLACEHOLDER_LEAK downstream.
 *
 * A NAME THAT IS ITSELF CONTAMINATED IS TREATED AS NO NAME AT ALL. Contamination
 * propagates: a leaked definition yields a leaked name, and feeding that name
 * back as ground truth re-contaminates the repair, leaving the row permanently
 * unrepairable until the name is withheld. One such row was observed named
 * `Concept A describes the agent's capacity to retain…` — a memory whose label
 * is a prompt placeholder. Substituting it would swap one placeholder for a
 * longer one. Withholding leaves the slot for the gate to catch instead.
 */
export function substituteConceptPlaceholders(
  text: string,
  names: Readonly<Record<string, string | undefined>>,
): string {
  return text.replace(PLACEHOLDER_LEAK_GLOBAL, (match, letter: string) => {
    const name = names[letter]?.trim();
    if (!name || PLACEHOLDER_LEAK.test(name)) return match;
    return name;
  });
}

/**
 * Markdown that leaked out of the model and into text meant to be stored raw.
 *
 * NOT ANCHORED TO THE START, unlike the meta-text openers above. The previous
 * check was `/^(#{1,6}\s|\*\*)/`, which caught a thought opening with `**` and
 * missed one where the bold lands anywhere later — the shape `abstract`
 * reliably produces:
 *
 *   The unifying pattern is **"Persistence through Structure"** — a principle...
 *
 * Five such rows were accepted in a single run, and because names are derived
 * from definitions the asterisks propagated into the labels too. The check fired
 * elsewhere in the same run, which is what made it look like it worked.
 *
 * The start-anchoring argument that governs SELF_REFERENTIAL_OPENERS does not
 * transfer here. That one protects a memory that legitimately *quotes* meta-text
 * while reporting a finding. A quoted `**bold**` carries no such meaning: its
 * content survives stripping intact, so `stripMarkdownFormatting` salvages the
 * thought rather than the gate discarding it.
 *
 * Paired emphasis only — a lone `*` is ordinary punctuation in prose and a lone
 * `#` is an issue reference. Headings match at any line start, not just the
 * first, so a multi-paragraph answer that turns into a document is caught.
 */
const MARKDOWN_LEAK: readonly RegExp[] = [
  /(?:^|\n)#{1,6}\s/,
  /(?:^|\s)(\*\*|__)\S(?:[\s\S]*?\S)?\1/,
];

/**
 * Remove markdown emphasis and heading markers, keeping the text they wrapped.
 *
 * For callers that can afford to salvage rather than reject. Rejection is right
 * for `refine`, where the previous definition survives and nothing is lost; it
 * is expensive for `abstract`, where nothing takes the rejected row's place and
 * a real cross-domain synthesis is discarded over its punctuation.
 */
export function stripMarkdownFormatting(text: string): string {
  return text
    .replace(/(^|\n)#{1,6}\s+/g, '$1')
    .replace(/(^|\s)(\*\*|__)(\S(?:[\s\S]*?\S)?)\2/g, '$1$3')
    .trim();
}

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
  if (MARKDOWN_LEAK.some((re) => re.test(trimmed))) {
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
