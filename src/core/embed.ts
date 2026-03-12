/**
 * EmbedProvider — embedding abstraction for cortex-engine.
 *
 * Implementations: VertexEmbedProvider, OllamaEmbedProvider, OpenAIEmbedProvider.
 */

export interface EmbedProvider {
  /** Embed a single text string into a vector. */
  embed(text: string): Promise<number[]>;

  /** Embed multiple texts in a batch (default: sequential embed calls). */
  embedBatch?(texts: string[]): Promise<number[][]>;

  /** Dimensionality of the embedding vectors. */
  readonly dimensions: number;

  /** Provider name for provenance tracking. */
  readonly name: string;
}
