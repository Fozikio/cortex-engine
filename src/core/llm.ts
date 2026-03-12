/**
 * LLMProvider — language model abstraction for cortex-engine.
 *
 * Used for cognitive tools that need LLM reasoning:
 * - HyDE query expansion (generate hypothetical passages)
 * - Importance scoring (4-channel: novelty, arousal, reward, attention)
 * - Dream consolidation (memory definition refinement, edge discovery)
 * - Reflective passage generation
 *
 * Implementations: GeminiLLMProvider, OllamaLLMProvider, AnthropicLLMProvider, OpenAILLMProvider.
 */

export interface LLMProvider {
  /** Generate text from a prompt. */
  generate(prompt: string, options?: GenerateOptions): Promise<string>;

  /** Generate structured JSON output from a prompt. */
  generateJSON<T>(prompt: string, options?: GenerateJSONOptions): Promise<T>;

  /** Provider name for provenance tracking. */
  readonly name: string;

  /** Model ID being used. */
  readonly modelId: string;
}

export interface GenerateOptions {
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

export interface GenerateJSONOptions extends GenerateOptions {
  /** JSON Schema describing the expected output shape. */
  schema?: Record<string, unknown>;
}
