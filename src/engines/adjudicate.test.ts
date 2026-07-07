/**
 * Tests for contradiction adjudication — NLI-first, LLM-fallback, tier caps.
 */

import { describe, it, expect, vi } from 'vitest';
import { adjudicateContradiction } from './adjudicate.js';
import type { NLIProvider, NLIResult } from '../core/nli.js';
import type { LLMProvider } from '../core/llm.js';

function makeNLI(result: NLIResult): NLIProvider {
  return {
    name: 'fake-nli',
    classify: vi.fn().mockResolvedValue(result),
  };
}

function makeLLM(json: unknown): LLMProvider {
  return {
    name: 'fake-llm',
    modelId: 'fake-model',
    generate: vi.fn().mockResolvedValue(''),
    generateJSON: vi.fn().mockResolvedValue(json),
  };
}

const CLAIM = 'The user moved to Berlin last month.';
const TARGET = 'The user lives in Paris.';

describe('adjudicateContradiction — NLI path', () => {
  it('returns genuine on high-confidence NLI contradiction', async () => {
    const nli = makeNLI({
      label: 'contradiction',
      scores: { contradiction: 0.93, entailment: 0.02, neutral: 0.05 },
    });
    const result = await adjudicateContradiction({ claim: CLAIM, target: TARGET, nli });
    expect(result.method).toBe('nli');
    expect(result.verdict).toBe('genuine');
    expect(result.confidence).toBeCloseTo(0.93);
    // Both directions get classified (asymmetric cross-encoder).
    expect(nli.classify).toHaveBeenCalledTimes(2);
  });

  it('returns complementary on high-confidence entailment', async () => {
    const nli = makeNLI({
      label: 'entailment',
      scores: { contradiction: 0.05, entailment: 0.85, neutral: 0.10 },
    });
    const result = await adjudicateContradiction({ claim: CLAIM, target: TARGET, nli });
    expect(result.verdict).toBe('complementary');
  });

  it('prefers classifyBatch when available', async () => {
    const batchResult: NLIResult[] = [
      { label: 'neutral', scores: { contradiction: 0.2, entailment: 0.1, neutral: 0.7 } },
      { label: 'contradiction', scores: { contradiction: 0.9, entailment: 0.05, neutral: 0.05 } },
    ];
    const nli: NLIProvider = {
      name: 'fake-nli',
      classify: vi.fn(),
      classifyBatch: vi.fn().mockResolvedValue(batchResult),
    };
    const result = await adjudicateContradiction({ claim: CLAIM, target: TARGET, nli });
    // Takes the direction with the stronger contradiction score.
    expect(result.verdict).toBe('genuine');
    expect(nli.classify).not.toHaveBeenCalled();
  });

  it('falls back to LLM when NLI throws', async () => {
    const nli: NLIProvider = {
      name: 'fake-nli',
      classify: vi.fn().mockRejectedValue(new Error('service down')),
    };
    const llm = makeLLM({ verdict: 'genuine', confidence: 0.9, reasoning: 'direct conflict' });
    const result = await adjudicateContradiction({ claim: CLAIM, target: TARGET, nli, llm });
    expect(result.method).toBe('llm');
    expect(result.verdict).toBe('genuine');
  });

  it('lets the LLM reclassify an NLI contradiction as temporal succession', async () => {
    // NLI has no time axis — "moved to Berlin" vs "lives in Paris" scores as
    // contradiction. The one-shot LLM check turns it into supersedes.
    const nli = makeNLI({
      label: 'contradiction',
      scores: { contradiction: 0.9, entailment: 0.02, neutral: 0.08 },
    });
    const llm = makeLLM({ verdict: 'supersedes', confidence: 0.85, reasoning: 'state change' });
    const result = await adjudicateContradiction({ claim: CLAIM, target: TARGET, nli, llm });
    expect(result.verdict).toBe('supersedes');
    expect(result.method).toBe('llm');
  });

  it('keeps the NLI genuine verdict when the LLM agrees it is not succession', async () => {
    const nli = makeNLI({
      label: 'contradiction',
      scores: { contradiction: 0.9, entailment: 0.02, neutral: 0.08 },
    });
    const llm = makeLLM({ verdict: 'genuine', confidence: 0.8 });
    const result = await adjudicateContradiction({ claim: CLAIM, target: TARGET, nli, llm });
    expect(result.verdict).toBe('genuine');
    expect(result.method).toBe('nli');
  });

  it('keeps the NLI genuine verdict when the supersession check fails', async () => {
    const nli = makeNLI({
      label: 'contradiction',
      scores: { contradiction: 0.9, entailment: 0.02, neutral: 0.08 },
    });
    const llm: LLMProvider = {
      name: 'fake-llm',
      modelId: 'fake',
      generate: vi.fn(),
      generateJSON: vi.fn().mockRejectedValue(new Error('down')),
    };
    const result = await adjudicateContradiction({ claim: CLAIM, target: TARGET, nli, llm });
    expect(result.verdict).toBe('genuine');
    expect(result.method).toBe('nli');
  });
});

describe('adjudicateContradiction — LLM path', () => {
  it('passes through a valid verdict', async () => {
    const llm = makeLLM({ verdict: 'unrelated', confidence: 0.7 });
    const result = await adjudicateContradiction({ claim: CLAIM, target: TARGET, llm });
    expect(result).toMatchObject({ verdict: 'unrelated', method: 'llm', confidence: 0.7 });
  });

  it('passes through a supersedes verdict', async () => {
    const llm = makeLLM({ verdict: 'supersedes', confidence: 0.8 });
    const result = await adjudicateContradiction({ claim: CLAIM, target: TARGET, llm });
    expect(result.verdict).toBe('supersedes');
  });

  it('coerces an invalid verdict to tension', async () => {
    const llm = makeLLM({ verdict: 'kinda-sorta', confidence: 0.9 });
    const result = await adjudicateContradiction({ claim: CLAIM, target: TARGET, llm });
    expect(result.verdict).toBe('tension');
  });

  it('caps a low-tier genuine verdict below the confidence floor', async () => {
    const llm = makeLLM({ verdict: 'genuine', confidence: 0.6 });
    const result = await adjudicateContradiction({
      claim: CLAIM, target: TARGET, llm, llmTier: 'low',
    });
    expect(result.verdict).toBe('tension');
    expect(result.tier_capped).toBe(true);
  });

  it('lets a highly-confident low-tier genuine verdict stand', async () => {
    const llm = makeLLM({ verdict: 'genuine', confidence: 0.9 });
    const result = await adjudicateContradiction({
      claim: CLAIM, target: TARGET, llm, llmTier: 'low',
    });
    expect(result.verdict).toBe('genuine');
    expect(result.tier_capped).toBeUndefined();
  });

  it('does not cap medium/high tier verdicts', async () => {
    const llm = makeLLM({ verdict: 'genuine', confidence: 0.6 });
    const result = await adjudicateContradiction({
      claim: CLAIM, target: TARGET, llm, llmTier: 'high',
    });
    expect(result.verdict).toBe('genuine');
  });
});

describe('adjudicateContradiction — degradation', () => {
  it('returns unverified tension when no provider is available', async () => {
    const result = await adjudicateContradiction({ claim: CLAIM, target: TARGET });
    expect(result).toMatchObject({ verdict: 'tension', confidence: 0, method: 'none' });
  });

  it('returns unverified tension when all providers fail', async () => {
    const nli: NLIProvider = {
      name: 'fake-nli',
      classify: vi.fn().mockRejectedValue(new Error('down')),
    };
    const llm: LLMProvider = {
      name: 'fake-llm',
      modelId: 'fake',
      generate: vi.fn(),
      generateJSON: vi.fn().mockRejectedValue(new Error('down too')),
    };
    const result = await adjudicateContradiction({ claim: CLAIM, target: TARGET, nli, llm });
    expect(result.method).toBe('none');
    expect(result.verdict).toBe('tension');
  });
});
