/**
 * OllamaEmbedProvider and OllamaLLMProvider — Ollama REST API implementations.
 *
 * Talks to a local Ollama instance (default: http://localhost:11434).
 * Uses Node.js built-in fetch — no extra HTTP dependencies.
 *
 * Defaults:
 *   embed model  — qwen3-embedding:0.6b (1024 dimensions, MRL to 32)
 *   LLM model    — qwen3:14b
 *
 * Thinking is disabled on every call via the native `think: false` parameter.
 * The default model is a reasoning model, and reasoning tokens are drawn from
 * the same `num_predict` budget as the answer — so a bounded call spends its
 * whole budget thinking and returns an empty `response`. See generate().
 */

import type { EmbedProvider } from '../core/embed.js';
import type { LLMProvider, GenerateOptions, GenerateJSONOptions } from '../core/llm.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Strip inline <think>...</think> blocks from model output.
 *
 * Retained only for models that still inline their reasoning into `response`.
 * It is NOT the defence against reasoning models on current Ollama, which
 * returns reasoning in a separate `thinking` field that never matches this
 * pattern — relying on it there strips nothing while the answer is already
 * gone. `think: false` on the request is the actual defence.
 */
function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
}

async function ollamaPost<T>(
  baseUrl: string,
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw new Error(
      `Ollama not reachable at ${baseUrl}. Is Ollama running?`,
      { cause },
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '(no body)');
    throw new Error(
      `Ollama request to ${path} failed: HTTP ${response.status} — ${text}`,
    );
  }

  return response.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// OllamaEmbedProvider
// ---------------------------------------------------------------------------

interface OllamaEmbedResponse {
  embeddings: number[][];
}

export class OllamaEmbedProvider implements EmbedProvider {
  readonly name = 'ollama';
  readonly dimensions: number;

  private readonly model: string;
  private readonly baseUrl: string;

  constructor(options?: {
    model?: string;
    baseUrl?: string;
    dimensions?: number;
  }) {
    this.model = options?.model ?? 'qwen3-embedding:0.6b';
    this.baseUrl = options?.baseUrl ?? 'http://localhost:11434';
    this.dimensions = options?.dimensions ?? 1024;
  }

  async embed(text: string): Promise<number[]> {
    if (!text || !text.trim()) {
      throw new Error('OllamaEmbedProvider.embed: refusing to embed empty text — caller likely has an upstream bug.');
    }
    const data = await ollamaPost<OllamaEmbedResponse>(
      this.baseUrl,
      '/api/embed',
      { model: this.model, input: text },
    );
    const first = data.embeddings?.[0];
    if (!first || first.length === 0) {
      throw new Error(`OllamaEmbedProvider.embed: Ollama returned no embedding for model "${this.model}". Is the model pulled?`);
    }
    return first;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const data = await ollamaPost<OllamaEmbedResponse>(
      this.baseUrl,
      '/api/embed',
      { model: this.model, input: texts },
    );
    return data.embeddings;
  }
}

// ---------------------------------------------------------------------------
// OllamaLLMProvider
// ---------------------------------------------------------------------------

interface OllamaGenerateResponse {
  response: string;
}

export class OllamaLLMProvider implements LLMProvider {
  readonly name = 'ollama';
  readonly modelId: string;

  private readonly baseUrl: string;

  constructor(options?: {
    model?: string;
    baseUrl?: string;
  }) {
    this.modelId = options?.model ?? 'qwen3:14b';
    this.baseUrl = options?.baseUrl ?? 'http://localhost:11434';
  }

  async generate(prompt: string, options?: GenerateOptions): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.modelId,
      prompt,
      stream: false,
      // Reasoning tokens come out of the same num_predict budget as the answer.
      // Measured on qwen3:14b at num_predict=300: thinking consumed all 300
      // tokens, `response` came back empty with done_reason=length, in 17.3s.
      // The same call with think:false answered completely in 50 tokens / 3.1s.
      // Every engine call site is bounded, so leaving this on silently empties
      // or truncates them all.
      think: false,
      options: {
        ...(options?.temperature !== undefined && { temperature: options.temperature }),
        ...(options?.maxTokens !== undefined && { num_predict: options.maxTokens }),
      },
    };

    if (options?.systemPrompt) {
      body['system'] = options.systemPrompt;
    }

    const data = await ollamaPost<OllamaGenerateResponse>(
      this.baseUrl,
      '/api/generate',
      body,
    );

    return stripThinking(data.response);
  }

  async generateJSON<T>(prompt: string, options?: GenerateJSONOptions): Promise<T> {
    let systemPrompt = options?.systemPrompt ?? '';

    if (options?.schema) {
      const schemaInstruction = `Respond with JSON matching this schema: ${JSON.stringify(options.schema)}`;
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${schemaInstruction}` : schemaInstruction;
    }

    const body: Record<string, unknown> = {
      model: this.modelId,
      prompt,
      stream: false,
      format: 'json',
      // Previously a `/no_think` prompt prefix. That is the legacy qwen3 soft
      // switch and is inert on current Ollama — measured identical to sending
      // nothing (300 tokens into `thinking`, empty `response`) — so JSON calls
      // were failing to parse an empty string while the comment claimed they
      // were protected. It also leaked a literal "/no_think" line into the
      // prompt for every model that does not implement it.
      think: false,
      options: {
        ...(options?.temperature !== undefined && { temperature: options.temperature }),
        ...(options?.maxTokens !== undefined && { num_predict: options.maxTokens }),
      },
    };

    if (systemPrompt) {
      body['system'] = systemPrompt;
    }

    const data = await ollamaPost<OllamaGenerateResponse>(
      this.baseUrl,
      '/api/generate',
      body,
    );

    try {
      return JSON.parse(stripThinking(data.response)) as T;
    } catch (cause) {
      throw new Error(
        `OllamaLLMProvider.generateJSON: failed to parse JSON response.\nRaw response: ${data.response}`,
        { cause },
      );
    }
  }
}
