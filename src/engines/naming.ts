/**
 * Concept naming — derive a short, title-like `name` for a memory from its text.
 *
 * A memory's `name` is meant to be a usable concise label, not a prefix of its
 * `definition`. The three creation paths (goal_set, high-salience observe
 * promotion, dream create) previously each truncated the raw text with a
 * `slice(0, 60)`, so names rendered as broken mid-word fragments and the shapes
 * differed between paths. This module centralises naming:
 *
 *   - `deriveName(text, llm)` — the intended behaviour: ask the LLM for a genuine
 *     short concept label at mint time, falling back to the heuristic if the LLM
 *     is unavailable, errors, or returns nothing usable.
 *   - `deriveNameHeuristic(text)` — the deterministic fallback: prefer the first
 *     sentence when it already fits, otherwise truncate on a word boundary and
 *     append an ellipsis so a shortened label reads as deliberately short rather
 *     than cut off mid-word.
 */

import type { LLMProvider } from '../core/llm.js';
import { LABEL_CONCEPT } from './prompts.js';

/**
 * Strip trailing characters matching a single-character pattern. Linear in the
 * input length — unlike an unanchored `/[...]+$/` regex, which the engine
 * retries from every start position and so runs in O(n²) on a long run of
 * matching characters (a polynomial-ReDoS footgun on exported, caller-supplied
 * text). `re` must match exactly one character.
 */
function trimEndChars(s: string, re: RegExp): string {
  let end = s.length;
  while (end > 0 && re.test(s.charAt(end - 1))) end--;
  return s.slice(0, end);
}

/**
 * Maximum length of a derived memory name, ellipsis included. Kept at 60 to
 * match the `label-concept` prompt's instruction and the CLI's 60-char display
 * clipping — a name that never exceeds 60 means those display clips (a raw
 * `name.slice(0, 60)`) can never reintroduce a mid-word truncation.
 */
export const NAME_MAX_LEN = 60;

/**
 * Deterministic name derivation — no LLM. Prefer the first sentence when it is
 * already short enough to serve as a label; otherwise truncate on a word
 * boundary and mark the elision with an ellipsis.
 */
export function deriveNameHeuristic(text: string, maxLen: number = NAME_MAX_LEN): string {
  const trimmed = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!trimmed) return '';

  // A complete first sentence that already fits makes the cleanest label.
  const firstSentence = trimmed.match(/^[^.!?]+[.!?]/)?.[0]?.trim();
  if (firstSentence && firstSentence.length <= maxLen) {
    // Drop the trailing sentence punctuation — a label is a heading, not a sentence.
    return trimEndChars(firstSentence, /[.!?]/).trim();
  }

  // The whole text fits — nothing was cut, so no ellipsis.
  if (trimmed.length <= maxLen) return trimmed;

  // Accumulate whole words up to the budget, reserving one character for the
  // ellipsis so the returned label (ellipsis included) never exceeds maxLen.
  // Building from whole words keeps a word that ends exactly on the boundary —
  // even when the next character is punctuation — instead of dropping it, and
  // never leaves a partial word before the ellipsis.
  const budget = maxLen - 1;
  let clipped = '';
  for (const word of trimmed.split(' ')) {
    const next = clipped ? `${clipped} ${word}` : word;
    // Trailing punctuation on the boundary word doesn't count toward the
    // budget — it's stripped before the ellipsis anyway — so a whole word that
    // fits isn't dropped just because a comma pushed it one character over.
    if (trimEndChars(next, /[.,;:!?]/).length > budget) break;
    clipped = next;
  }
  const base = trimEndChars(clipped, /[\s.,;:!?]/);
  // A single leading token longer than the budget has no word boundary to
  // break on — hard-cut it.
  const result = base.length > 0 ? base : trimmed.slice(0, budget).trim();
  return `${result}…`;
}

/**
 * Strip an LLM label response down to a bare title: first line only, no wrapping
 * quotes/backticks, no leading "Title:"/"Label:" prefix, no trailing sentence
 * punctuation, whitespace collapsed. Returns '' when nothing usable remains.
 */
function sanitizeLabel(raw: string): string {
  let label = (raw ?? '').split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  label = label.replace(/^(?:title|label|name)\s*[:\-]\s*/i, '');
  // Strip wrapping quotes/backticks and any trailing sentence punctuation a
  // heading shouldn't carry (in either order — e.g. `"Label".`).
  label = trimEndChars(label.replace(/^[\s"'`]+/, ''), /[\s"'`.!?;:,]/);
  return label.replace(/\s+/g, ' ').trim();
}

/**
 * Derive a memory name — LLM-generated concept label at mint time, with the
 * deterministic heuristic as a fallback. Never throws: any LLM failure or empty
 * response degrades to `deriveNameHeuristic`.
 */
export async function deriveName(
  text: string,
  llm?: LLMProvider,
  opts?: { maxLen?: number },
): Promise<string> {
  const maxLen = opts?.maxLen ?? NAME_MAX_LEN;
  const source = (text ?? '').trim();
  const fallback = deriveNameHeuristic(source, maxLen);
  if (!source || !llm) return fallback;

  try {
    const raw = await llm.generate(LABEL_CONCEPT.build({ text: source }), {
      temperature: 0.2,
      maxTokens: 32,
    });
    const label = sanitizeLabel(raw);
    if (!label) return fallback;
    // If the model over-ran the budget, clip its title on a word boundary
    // rather than discard an otherwise-good label.
    return label.length <= maxLen ? label : deriveNameHeuristic(label, maxLen);
  } catch {
    return fallback;
  }
}
