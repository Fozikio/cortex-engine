/**
 * Shared-mechanism check for dream abstractions (#147).
 *
 * Asked for "the pattern that connects these concepts", a model nearly always
 * finds one by climbing to a level where anything connects: "systems develop
 * through friction and identity", "subtraction over addition", "agency and
 * constraint". One live run linked a failed MCP integration to a person's
 * family history that way. The words that carry such a synthesis are abstract
 * nouns that no member actually uses, or words every memory in the store uses.
 *
 * So the model has to name the mechanism and the members it spans, and the
 * mechanism has to hold a term that at least two of those members' own text
 * contains — not an abstract noun, and not a word common to a large share of
 * the store. A synthesis that can't point to a term the members share is
 * glue, however fluent.
 */

import { extractKeywords } from './keywords.js';

/** Nouns a synthesis reaches for when it has no concrete link. */
const ABSTRACT_NOUNS = new Set([
  'system', 'pattern', 'complexity', 'integrity', 'authenticity', 'clarity', 'efficiency', 'friction',
  'identity', 'constraint', 'agency', 'autonomy', 'alignment', 'balance', 'tension', 'interplay',
  'evolution', 'growth', 'adaptation', 'adaptability', 'coherence', 'consistency', 'reliability',
  'structure', 'structured', 'process', 'approach', 'dynamic', 'mechanism', 'framework', 'principle',
  'concept', 'context', 'nature', 'value', 'purpose', 'meaning', 'trust', 'boundary', 'boundarie',
  'change', 'flow', 'emergence', 'emergent', 'resilience', 'transformation', 'optimization',
  'optimisation', 'performance', 'simplicity', 'subtraction', 'addition', 'design', 'development',
  'relationship', 'connection', 'interaction', 'feedback', 'loop', 'learning', 'knowledge',
  'understanding', 'insight', 'deeper', 'underlying', 'fundamental', 'effective', 'meaningful',
  'complex', 'iterative', 'intentional', 'organizational', 'organisational', 'technical', 'personal',
  'cognitive', 'creative', 'shift', 'role', 'need', 'importance', 'impact', 'focus', 'state', 'level',
]);

/** Share of the pool above which a term is too common to count as shared. */
export const MAX_TERM_SHARE = 0.25;
/** Pool size below which the share rule is not applied. */
export const MIN_POOL_FOR_SHARE = 20;
/**
 * Term-set Jaccard at or above which two members restate one fact and count
 * as one. On one store, edge-linked pairs sat at p95 0.094 / p99 0.294; two
 * memories retelling Muzak's "Stimulus Progression" scored 0.308, and their
 * "abstraction" was a third copy of the same fact.
 */
export const RESTATE_JACCARD = 0.25;

function jaccard(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

/** Light normalisation so "hooks"/"hook" and "edges"/"edge" meet; "stimulus", "analysis", "class" stay whole. */
export function normaliseTerm(word: string): string {
  return word.length > 4 && word.endsWith('s') && !/(?:ss|us|is)$/.test(word) ? word.slice(0, -1) : word;
}

export function termSet(text: string): Set<string> {
  return new Set(extractKeywords(text, 500).map(normaliseTerm));
}

/** Document frequency of each term over a pool of texts. */
export function documentFrequency(texts: string[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const t of texts) for (const term of termSet(t)) df.set(term, (df.get(term) ?? 0) + 1);
  return df;
}

export interface MechanismMember {
  name: string;
  text: string;
}

export interface MechanismCheckInput {
  /** The mechanism as the model stated it. */
  mechanism: unknown;
  /** Names of the members the model says the mechanism spans. */
  cited: unknown;
  /** The members the model was shown. */
  members: MechanismMember[];
  /** Document frequency over the pool, and the pool's size. */
  df: Map<string, number>;
  poolSize: number;
}

export interface MechanismCheckResult {
  ok: boolean;
  reasons: string[];
  /** Members the model cited that match a shown member, in shown order. */
  citedMembers: MechanismMember[];
  /** Mechanism terms found in at least two cited members. */
  sharedTerms: string[];
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function checkMechanism(input: MechanismCheckInput): MechanismCheckResult {
  const reasons: string[] = [];
  const mechanism = typeof input.mechanism === 'string' ? input.mechanism.trim() : '';
  const cited = Array.isArray(input.cited) ? input.cited.filter((c): c is string => typeof c === 'string') : [];

  // A cited name matches a shown member when either contains the other
  // (models shorten long names, or add the category tag).
  const citedMembers = input.members.filter((m) => {
    const n = norm(m.name);
    return cited.some((c) => {
      const cn = norm(c);
      return cn.length > 0 && (cn.includes(n) || n.includes(cn));
    });
  });

  if (!mechanism) reasons.push('no mechanism stated');
  if (citedMembers.length < 2) reasons.push(`mechanism spans ${citedMembers.length} of the shown members (need 2)`);

  // Members that restate one fact count once: a "synthesis" of two retellings
  // is a third retelling, not an abstraction.
  const memberTerms: Array<Set<string>> = [];
  for (const m of citedMembers) {
    const terms = termSet(`${m.name} ${m.text}`);
    if (!memberTerms.some((t) => jaccard(t, terms) >= RESTATE_JACCARD)) memberTerms.push(terms);
  }
  if (citedMembers.length >= 2 && memberTerms.length < 2) {
    reasons.push(`cited members restate one another (term overlap >= ${RESTATE_JACCARD})`);
  }
  // "Too common" means something only in a pool big enough to have a
  // background; in a handful of memories any shared term is a large share.
  const limit = input.poolSize < MIN_POOL_FOR_SHARE ? Infinity : Math.floor(input.poolSize * MAX_TERM_SHARE);
  const sharedTerms = [...termSet(mechanism)].filter((term) =>
    !ABSTRACT_NOUNS.has(term)
    && memberTerms.filter((s) => s.has(term)).length >= 2
    && (input.df.get(term) ?? 0) <= limit,
  );
  if (mechanism && memberTerms.length >= 2 && sharedTerms.length === 0) {
    reasons.push('mechanism names no concrete term the cited members share');
  }

  return { ok: reasons.length === 0, reasons, citedMembers, sharedTerms };
}
