/**
 * Tests for OllamaLLMProvider request construction.
 *
 * These assert on the outgoing request body rather than the parsed result,
 * because the bug they cover was invisible in the result: a reasoning model
 * spends the shared num_predict budget on hidden reasoning and returns an
 * empty `response`, which is indistinguishable from "the model had nothing
 * to say" unless you look at what was actually sent.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { OllamaLLMProvider } from './ollama.js';

function mockFetch(payload: Record<string, unknown>) {
  const spy = vi.fn(async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', spy);
  return spy;
}

function bodyOf(spy: ReturnType<typeof mockFetch>): Record<string, unknown> {
  const init = spy.mock.calls[0]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OllamaLLMProvider.generate', () => {
  it('disables thinking so the token budget goes to the answer', async () => {
    const spy = mockFetch({ response: 'an answer' });
    const provider = new OllamaLLMProvider();

    await provider.generate('why is the sky blue?', { maxTokens: 300 });

    expect(bodyOf(spy)['think']).toBe(false);
  });

  it('passes temperature and maxTokens through as ollama options', async () => {
    const spy = mockFetch({ response: 'an answer' });
    const provider = new OllamaLLMProvider();

    await provider.generate('hello', { temperature: 0.2, maxTokens: 128 });

    const opts = bodyOf(spy)['options'] as Record<string, unknown>;
    expect(opts['temperature']).toBe(0.2);
    expect(opts['num_predict']).toBe(128);
  });

  it('still strips inline think blocks for models that emit them', async () => {
    mockFetch({ response: '<think>deliberating</think>the answer' });
    const provider = new OllamaLLMProvider();

    expect(await provider.generate('q')).toBe('the answer');
  });
});

describe('OllamaLLMProvider.generateJSON', () => {
  it('disables thinking and requests json format', async () => {
    const spy = mockFetch({ response: '{"ok":true}' });
    const provider = new OllamaLLMProvider();

    await provider.generateJSON('give me json', { maxTokens: 200 });

    const body = bodyOf(spy);
    expect(body['think']).toBe(false);
    expect(body['format']).toBe('json');
  });

  it('does not leak a /no_think prefix into the prompt', async () => {
    const spy = mockFetch({ response: '{"ok":true}' });
    const provider = new OllamaLLMProvider();

    await provider.generateJSON('give me json');

    // The legacy soft switch is inert on current Ollama and pollutes the
    // prompt for every model that does not implement it.
    expect(String(bodyOf(spy)['prompt'])).not.toContain('/no_think');
    expect(bodyOf(spy)['prompt']).toBe('give me json');
  });

  it('parses the json response', async () => {
    mockFetch({ response: '{"answer":42}' });
    const provider = new OllamaLLMProvider();

    const out = await provider.generateJSON<{ answer: number }>('q');
    expect(out.answer).toBe(42);
  });
});
