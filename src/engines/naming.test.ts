/**
 * Naming tests — the deterministic heuristic and the LLM-with-fallback path.
 *
 * The heuristic is the contract every creation path (goal_set, observe,
 * dream create) falls back to when no LLM label is available, so its shape —
 * word-boundary truncation with an ellipsis, first-sentence preference — is
 * pinned here.
 */

import { describe, it, expect } from 'vitest';
import { deriveName, deriveNameHeuristic, NAME_MAX_LEN } from './naming.js';
import type { LLMProvider } from '../core/llm.js';

function stubLLM(reply: string | (() => Promise<string>)): LLMProvider {
  return {
    name: 'stub',
    modelId: 'stub-1',
    async generate() {
      return typeof reply === 'string' ? reply : reply();
    },
    async generateJSON<T>() {
      return {} as T;
    },
  };
}

describe('deriveNameHeuristic', () => {
  it('returns short text verbatim', () => {
    expect(deriveNameHeuristic('Beat the benchmark')).toBe('Beat the benchmark');
  });

  it('truncates on a word boundary and appends an ellipsis (never mid-word)', () => {
    const goal = 'Beat the frozen all-cash benchmark and build a verifiable track record of doing it.';
    const name = deriveNameHeuristic(goal);
    expect(name.endsWith('…')).toBe(true);
    expect(name.replace(/…$/, '').length).toBeLessThanOrEqual(NAME_MAX_LEN);
    // The old raw slice cut mid-word at "...verifiable tr"; the heuristic must
    // end on a whole word instead.
    expect(name).not.toContain('verifiable tr…');
    expect(name).toBe('Beat the frozen all-cash benchmark and build a verifiable track…');
  });

  it('prefers a complete first sentence when it already fits, dropping end punctuation', () => {
    const text = 'The auth system uses JWT tokens. It stores them in an httpOnly cookie.';
    expect(deriveNameHeuristic(text)).toBe('The auth system uses JWT tokens');
  });

  it('falls back to a hard cut for a single over-long token', () => {
    const token = 'x'.repeat(100);
    const name = deriveNameHeuristic(token, 10);
    expect(name).toBe(`${'x'.repeat(10)}…`);
  });

  it('collapses whitespace and handles empty input', () => {
    expect(deriveNameHeuristic('   ')).toBe('');
    expect(deriveNameHeuristic('a\n\n  b   c')).toBe('a b c');
  });
});

describe('deriveName', () => {
  it('uses a sanitized LLM label when available', async () => {
    const name = await deriveName('Beat the frozen all-cash benchmark.', stubLLM('"Beating the Cash Benchmark".'));
    expect(name).toBe('Beating the Cash Benchmark');
  });

  it('strips a leading Title: prefix and wrapping quotes', async () => {
    const name = await deriveName('some concept', stubLLM('Title: `Concept Label`'));
    expect(name).toBe('Concept Label');
  });

  it('falls back to the heuristic when the LLM throws', async () => {
    const goal = 'Beat the frozen all-cash benchmark and build a verifiable track record of doing it.';
    const name = await deriveName(goal, stubLLM(async () => { throw new Error('llm down'); }));
    expect(name).toBe(deriveNameHeuristic(goal));
  });

  it('falls back to the heuristic when the LLM returns nothing usable', async () => {
    const name = await deriveName('Short concept', stubLLM('   '));
    expect(name).toBe('Short concept');
  });

  it('clips an over-long LLM label on a word boundary', async () => {
    const long = 'This is a needlessly long title that the model produced despite the instruction to be brief and concise';
    const name = await deriveName('concept', stubLLM(long));
    expect(name.endsWith('…')).toBe(true);
    expect(name.replace(/…$/, '').length).toBeLessThanOrEqual(NAME_MAX_LEN);
  });

  it('uses the heuristic when no LLM is provided', async () => {
    expect(await deriveName('Short concept')).toBe('Short concept');
  });
});
