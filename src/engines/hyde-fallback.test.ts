/**
 * Regression test for the HyDE empty-LLM-output bug.
 *
 * Bug: when an LLM (e.g. qwen3 in thinking mode) consumes its entire
 * maxTokens budget on the thinking block and returns no answer,
 * stripThinking() leaves an empty string. The embed provider then
 * returned undefined, crashing downstream consumers with the cryptic
 * "Cannot read properties of undefined (reading 'length')".
 *
 * Fix: hydeExpand falls back to embedding the raw query when the LLM
 * produces empty output.
 */

import { describe, it, expect, vi } from 'vitest';
import { hydeExpand } from './memory.js';
import type { EmbedProvider } from '../core/embed.js';
import type { LLMProvider } from '../core/llm.js';

function makeMockLLM(output: string): LLMProvider {
  return {
    generate: vi.fn(async () => output),
    generateJSON: vi.fn(),
    name: 'mock',
    modelId: 'mock',
  } as unknown as LLMProvider;
}

function makeMockEmbed(): { provider: EmbedProvider; lastInput: { value: string | null } } {
  const lastInput = { value: null as string | null };
  const provider: EmbedProvider = {
    name: 'mock',
    dimensions: 4,
    embed: vi.fn(async (text: string) => {
      lastInput.value = text;
      return [1, 2, 3, 4];
    }),
    embedBatch: vi.fn(),
  } as unknown as EmbedProvider;
  return { provider, lastInput };
}

describe('hydeExpand fallback on empty LLM output', () => {
  it('falls back to embedding the raw query when LLM returns empty string', async () => {
    const llm = makeMockLLM('');
    const { provider, lastInput } = makeMockEmbed();

    const result = await hydeExpand('Glitterrot voice', llm, provider);

    expect(result).toEqual([1, 2, 3, 4]);
    expect(lastInput.value).toBe('Glitterrot voice');
  });

  it('falls back when LLM returns whitespace-only string', async () => {
    const llm = makeMockLLM('   \n\t  ');
    const { provider, lastInput } = makeMockEmbed();

    await hydeExpand('test query', llm, provider);

    expect(lastInput.value).toBe('test query');
  });

  it('uses the hypothetical when LLM returns substantive text', async () => {
    const llm = makeMockLLM('A hypothetical passage about the query topic.');
    const { provider, lastInput } = makeMockEmbed();

    await hydeExpand('test query', llm, provider);

    expect(lastInput.value).toBe('A hypothetical passage about the query topic.');
  });
});
