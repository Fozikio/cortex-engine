/**
 * Contradiction adjudication — decide whether a claimed contradiction is real.
 *
 * The contradict tool previously recorded a CONTRADICTION signal on the
 * agent's say-so without ever checking whether the observation actually
 * conflicts with the stored belief. This module closes that loop:
 *
 * 1. NLI first — if a cross-encoder NLI provider is configured, classify the
 *    (belief, evidence) pair in both directions and map the result onto the
 *    cortex verdict vocabulary. Cheap, local, calibrated for exactly this task.
 * 2. LLM fallback — structured-JSON adjudication via a versioned prompt.
 *    Verdicts from low-tier models (per config.model_provenance.confidence_tiers)
 *    are capped: a 'genuine' verdict below 0.8 confidence is downgraded to
 *    'tension' so a weak local model cannot silently erode belief confidence.
 * 3. No provider / all failed — 'tension' with method 'none': the claim is
 *    recorded as unverified rather than trusted or dropped.
 *
 * Verdict vocabulary (superset of nliToCortexVerdict):
 * - genuine: both cannot be true of the same time — evidence negates the belief
 * - supersedes: temporal succession — the belief was true and the world has
 *   since changed; revise the belief (believe with valid_from) rather than
 *   distrust it. Only the LLM path can produce this — NLI has no time axis,
 *   and typically labels succession as contradiction.
 * - tension: partial/scope conflict, or unverifiable claim worth tracking
 * - complementary: evidence supports or refines the belief
 * - unrelated: no meaningful logical relationship
 */

import type { NLIProvider } from '../core/nli.js';
import type { LLMProvider } from '../core/llm.js';
import type { ConfidenceTier } from '../core/types.js';
import { nliToCortexVerdict } from '../providers/nli-http.js';
import { ADJUDICATE_CONTRADICTION } from './prompts.js';

export type ContradictionVerdict = 'genuine' | 'supersedes' | 'tension' | 'complementary' | 'unrelated';

const VALID_VERDICTS: readonly ContradictionVerdict[] = [
  'genuine', 'supersedes', 'tension', 'complementary', 'unrelated',
];

/** Below this confidence, a low-tier model's 'genuine' verdict is downgraded to 'tension'. */
const LOW_TIER_GENUINE_FLOOR = 0.8;

/**
 * Max confidence penalty applied to a memory on a fully-confident genuine
 * verdict. Shared by the contradict tool and observe-time conflict detection.
 */
export const MAX_CONFIDENCE_PENALTY = 0.15;

export interface AdjudicationResult {
  verdict: ContradictionVerdict;
  /** Adjudicator confidence in the verdict, 0-1. 0 when method is 'none'. */
  confidence: number;
  /** Which mechanism produced the verdict. */
  method: 'nli' | 'llm' | 'none';
  /** Brief explanation (LLM path) or score summary (NLI path). */
  reasoning?: string;
  /** Set when a low-tier LLM's 'genuine' verdict was downgraded to 'tension'. */
  tier_capped?: boolean;
}

export interface AdjudicateOptions {
  /** The new evidence (observation content). */
  claim: string;
  /** The stored belief or memory definition being disputed. */
  target: string;
  /** NLI cross-encoder provider — preferred when available. */
  nli?: NLIProvider;
  /** LLM fallback adjudicator. */
  llm?: LLMProvider;
  /** Capability tier of the LLM adjudicator (default 'medium'). */
  llmTier?: ConfidenceTier;
}

/**
 * Classify with NLI in both directions and keep the direction with the
 * stronger contradiction score. Cross-encoders are asymmetric — "moved to
 * Berlin" vs "lives in Paris" can score differently depending on which is
 * premise — so taking the max-contradiction direction is the standard
 * conservative reading for conflict detection.
 */
async function adjudicateWithNLI(
  nli: NLIProvider,
  claim: string,
  target: string,
): Promise<AdjudicationResult> {
  const [forward, reverse] = nli.classifyBatch
    ? await nli.classifyBatch([
        { premise: target, hypothesis: claim },
        { premise: claim, hypothesis: target },
      ])
    : await Promise.all([
        nli.classify(target, claim),
        nli.classify(claim, target),
      ]);

  const stronger = forward.scores.contradiction >= reverse.scores.contradiction
    ? forward
    : reverse;

  const verdict = nliToCortexVerdict(stronger.label, stronger.scores);
  return {
    verdict,
    confidence: stronger.scores[stronger.label],
    method: 'nli',
    reasoning:
      `NLI (${nli.name}): ${stronger.label} ` +
      `[c=${stronger.scores.contradiction.toFixed(2)}, ` +
      `e=${stronger.scores.entailment.toFixed(2)}, ` +
      `n=${stronger.scores.neutral.toFixed(2)}]`,
  };
}

async function adjudicateWithLLM(
  llm: LLMProvider,
  claim: string,
  target: string,
  tier: ConfidenceTier,
): Promise<AdjudicationResult> {
  const result = await llm.generateJSON<{
    verdict: string;
    confidence: number;
    reasoning?: string;
  }>(ADJUDICATE_CONTRADICTION.build({ claim, target }), {
    temperature: 0.1,
    schema: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: [...VALID_VERDICTS] },
        confidence: { type: 'number' },
        reasoning: { type: 'string' },
      },
      required: ['verdict', 'confidence'],
    },
  });

  const verdict = VALID_VERDICTS.includes(result.verdict as ContradictionVerdict)
    ? (result.verdict as ContradictionVerdict)
    : 'tension';
  const confidence = Math.min(1, Math.max(0, result.confidence ?? 0.5));

  // Tier cap: a low-tier adjudicator may not unilaterally declare a genuine
  // contradiction unless it is highly confident. This is the consumer for
  // config.model_provenance.confidence_tiers — verdict authority scales with
  // the capability of the model issuing it.
  if (tier === 'low' && verdict === 'genuine' && confidence < LOW_TIER_GENUINE_FLOOR) {
    return {
      verdict: 'tension',
      confidence,
      method: 'llm',
      reasoning: result.reasoning,
      tier_capped: true,
    };
  }

  return { verdict, confidence, method: 'llm', reasoning: result.reasoning };
}

/**
 * Adjudicate a claimed contradiction between new evidence and a stored belief.
 * Never throws — provider failures degrade to the unverified 'none' result.
 */
export async function adjudicateContradiction(
  options: AdjudicateOptions,
): Promise<AdjudicationResult> {
  const { claim, target, nli, llm, llmTier = 'medium' } = options;

  if (nli) {
    try {
      const nliResult = await adjudicateWithNLI(nli, claim, target);

      // NLI has no time axis, so it labels temporal succession ("moved to
      // Berlin" vs "lives in Paris") as contradiction. Before a genuine
      // verdict stands, one LLM call gets the chance to reclassify it as
      // succession — the only case where the expensive check runs.
      if (nliResult.verdict === 'genuine' && llm) {
        try {
          const llmResult = await adjudicateWithLLM(llm, claim, target, llmTier);
          if (llmResult.verdict === 'supersedes') {
            return {
              ...llmResult,
              reasoning: `${llmResult.reasoning ?? 'Temporal succession.'} (NLI flagged conflict; reclassified as succession)`,
            };
          }
        } catch (err) {
          console.error('[adjudicate:supersede-check]', err);
        }
      }

      return nliResult;
    } catch (err) {
      console.error('[adjudicate:nli]', err);
      // Fall through to LLM.
    }
  }

  if (llm) {
    try {
      return await adjudicateWithLLM(llm, claim, target, llmTier);
    } catch (err) {
      console.error('[adjudicate:llm]', err);
    }
  }

  return {
    verdict: 'tension',
    confidence: 0,
    method: 'none',
    reasoning: 'No adjudication provider available — recorded as unverified tension.',
  };
}
