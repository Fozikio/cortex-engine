/**
 * Shared helpers for LLM providers.
 *
 * Both VertexLLMProvider and OpenAICompatibleLLMProvider need the same
 * pre-/post-processing logic around `generateJSON`. Keeping the helpers
 * here means a fix (e.g. handling a new fence dialect) lands in one place.
 */

/**
 * Strip common code-fence wrappers from LLM JSON output.
 *
 * Models often return ```json\n{...}\n``` or plain ```\n{...}\n```; the
 * fences must be stripped before JSON.parse. Returns the trimmed inner
 * payload, or the original (trimmed) text if no fences are present.
 */
export function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

/**
 * Build a system prompt that appends a JSON-schema instruction.
 *
 * If both `base` and `schema` are provided, the schema instruction is
 * appended with a blank line separator. If only `schema` is provided,
 * the schema instruction alone is returned. If neither is provided,
 * returns an empty string.
 */
export function buildJsonSystemPrompt(base: string | undefined, schema: unknown): string {
  const baseTrimmed = base ?? '';
  if (schema === undefined) return baseTrimmed;
  const schemaInstruction = `Respond with JSON matching this schema: ${JSON.stringify(schema)}`;
  return baseTrimmed ? `${baseTrimmed}\n\n${schemaInstruction}` : schemaInstruction;
}
