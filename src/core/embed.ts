/**
 * EmbedProvider — embedding abstraction for cortex-engine.
 *
 * Implementations: BuiltInEmbedProvider (default), OllamaEmbedProvider, VertexEmbedProvider.
 *
 * TODO: add an OpenAIEmbedProvider for text-embedding-3-small/large. The 'openai'
 * config value was removed from CortexConfig['embed'] when the union was
 * tightened to match what mcp/server.ts createEmbedProvider() actually handles.
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
