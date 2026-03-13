/**
 * VertexLLMProvider — Vertex AI Gemini via @google-cloud/vertexai.
 *
 * Generalized provider with no idapixl-specific dependencies.
 * Cost tracking is opt-in via an optional callback.
 */

import type { LLMProvider, GenerateOptions, GenerateJSONOptions } from '../core/llm.js';

export interface VertexLLMOptions {
  /** GCP project ID. Falls back to GOOGLE_CLOUD_PROJECT env var. */
  projectId?: string;
  /** GCP region (default: us-central1). */
  location?: string;
  /** Gemini model ID (default: gemini-2.5-flash). */
  model?: string;
}

export class VertexLLMProvider implements LLMProvider {
  readonly name = 'vertex-gemini';
  readonly modelId: string;

  private readonly projectId: string;
  private vertexAI: import('@google-cloud/vertexai').VertexAI;

  constructor(
    options: VertexLLMOptions,
    vertexAI: import('@google-cloud/vertexai').VertexAI,
  ) {
    this.projectId = options.projectId ?? process.env['GOOGLE_CLOUD_PROJECT'] ?? '';
    this.modelId = options.model ?? 'gemini-2.5-flash';

    if (!this.projectId) {
      throw new Error('VertexLLMProvider: projectId is required (config or GOOGLE_CLOUD_PROJECT env)');
    }

    this.vertexAI = vertexAI;
  }

  async generate(prompt: string, options?: GenerateOptions): Promise<string> {
    const model = this.vertexAI.preview.getGenerativeModel({
      model: this.modelId,
      generationConfig: {
        temperature: options?.temperature ?? 0.2,
        maxOutputTokens: options?.maxTokens ?? 1024,
      },
    });

    const result = await model.generateContent(prompt);
    const text = result.response.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('VertexLLMProvider: empty response');

    return text.trim();
  }

  async generateJSON<T>(prompt: string, options?: GenerateJSONOptions): Promise<T> {
    const model = this.vertexAI.preview.getGenerativeModel({
      model: this.modelId,
      generationConfig: {
        temperature: options?.temperature ?? 0.2,
        maxOutputTokens: options?.maxTokens ?? 2048,
        responseMimeType: 'application/json',
      },
    });

    const result = await model.generateContent(prompt);
    const text = result.response.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('VertexLLMProvider: empty response');

    return JSON.parse(text.trim()) as T;
  }
}
