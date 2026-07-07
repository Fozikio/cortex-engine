/**
 * Prompt registry — versioned, typed templates for every cognitive prompt.
 *
 * The dream pipeline's behavior is substantially determined by prompt wording,
 * so prompts are treated like schema: each has a stable id, an explicit
 * version, and a typed build() function. Tests snapshot the registry so any
 * wording change forces a deliberate version bump.
 *
 * Rules:
 * - Bump `version` whenever wording changes in a way that could shift model
 *   behavior (not for pure whitespace/typo fixes, judgment call).
 * - Keep templates deterministic: same params → same string.
 * - New cognitive prompts belong here, not inline in engines or tools.
 */

import type { EdgeRelation, MemoryCategory } from '../core/types.js';

export interface PromptTemplate<P> {
  /** Stable identifier, unique across the registry. */
  id: string;
  /** Bumped when wording changes could shift model behavior. */
  version: number;
  /** Render the prompt with typed params. */
  build(params: P): string;
}

function definePrompt<P>(
  id: string,
  version: number,
  build: (params: P) => string,
): PromptTemplate<P> {
  return { id, version, build };
}

// ─── Shared vocab ─────────────────────────────────────────────────────────────

export const EDGE_RELATIONS: readonly EdgeRelation[] = [
  'extends', 'refines', 'contradicts', 'tensions-with',
  'questions', 'supports', 'exemplifies', 'caused', 'related',
];

export const MEMORY_CATEGORIES: readonly MemoryCategory[] = [
  'belief', 'pattern', 'entity', 'topic', 'value', 'project', 'insight', 'observation',
];

// ─── Dream: NREM phases ───────────────────────────────────────────────────────

/** Phase 2 — rewrite a memory definition to incorporate new evidence. */
export const REFINE_DEFINITION = definePrompt<{
  definition: string;
  observations: string[];
}>('refine-definition', 1, (p) =>
  `You are refining a memory concept based on new observations.\n\n` +
  `Current definition: ${p.definition}\n\n` +
  `New observations:\n${p.observations.map((o) => `- ${o}`).join('\n')}\n\n` +
  `Write an improved definition that incorporates the new observations. Keep it concise (2-4 sentences). Do not include any preamble.`,
);

/** Phase 2 — re-check an edge after its source definition changed. */
export const EDGE_REVALIDATE = definePrompt<{
  updatedDefinition: string;
  targetName: string;
  targetDefinition: string;
  relation: EdgeRelation;
  evidence: string;
}>('edge-revalidate', 1, (p) =>
  `Does this relationship still hold?\n\n` +
  `Concept A (updated): ${p.updatedDefinition}\n` +
  `Concept B: ${p.targetName} — ${p.targetDefinition}\n` +
  `Relationship: ${p.relation}\n` +
  `Evidence: ${p.evidence}\n\n` +
  `Respond with JSON: {"valid": true/false, "reason": "brief explanation"}`,
);

/** Phase 3 — classify an observation into a memory category. */
export const CLASSIFY_CATEGORY = definePrompt<{ content: string }>(
  'classify-category', 1, (p) =>
    `Classify this text into exactly one category: ${MEMORY_CATEGORIES.join(', ')}.\n\n` +
    `Text: ${p.content}\n\n` +
    `Respond with only the category name, nothing else.`,
);

// ─── Dream: REM phases ────────────────────────────────────────────────────────

/** Phase 4 (sequential) — pairwise edge discovery. */
export const EDGE_DISCOVER_PAIR = definePrompt<{
  nameA: string; definitionA: string;
  nameB: string; definitionB: string;
}>('edge-discover-pair', 1, (p) =>
  `Do these two concepts have a meaningful relationship?\n\n` +
  `Concept A: ${p.nameA} — ${p.definitionA}\n` +
  `Concept B: ${p.nameB} — ${p.definitionB}\n\n` +
  `If yes, respond with JSON: {"relation": "${EDGE_RELATIONS.join('|')}", "evidence": "brief explanation"}\n` +
  `If no meaningful relationship, respond with: {"relation": null}`,
);

/** Phase 4 (long-context) — whole-graph edge discovery. */
export const EDGE_DISCOVER_GRAPH = definePrompt<{
  memoryLines: string;
  memoryCount: number;
  existingEdgeLines: string;
}>('edge-discover-graph', 1, (p) =>
  `You are analysing the memory graph of a cognitive AI agent.\n\n` +
  `MEMORY NODES (${p.memoryCount}):\n${p.memoryLines}\n\n` +
  `EXISTING EDGES:\n${p.existingEdgeLines}\n\n` +
  `TASK: Identify all meaningful relationships that are MISSING from this graph.\n` +
  `Look especially for:\n` +
  `- Transitive patterns (A extends B, B contradicts C → does A tension-with C?)\n` +
  `- Cross-domain connections between different categories\n` +
  `- Causal chains and supporting evidence relationships\n` +
  `- Contradictions or tensions not yet captured\n\n` +
  `RULES:\n` +
  `- Use exact IDs from the memory nodes above\n` +
  `- Do not suggest edges that already exist\n` +
  `- Only suggest edges where a real semantic relationship exists\n` +
  `- Valid relation types: ${EDGE_RELATIONS.join(', ')}\n\n` +
  `Respond with a JSON array. Each element: ` +
  `{"source_id": "...", "target_id": "...", "relation": "...", "evidence": "one sentence"}\n` +
  `If no new edges are needed, respond with: []`,
);

/** Phase 6 — cross-domain abstraction synthesis. */
export const ABSTRACT_SYNTHESIS = definePrompt<{ conceptLines: string }>(
  'abstract-synthesis', 1, (p) =>
    `Find a higher-level principle or pattern that connects these diverse concepts:\n\n` +
    `${p.conceptLines}\n\n` +
    `Write a concise abstraction (2-4 sentences) that captures the deeper connection. ` +
    `Be specific — name the pattern and explain why it matters. ` +
    `If no meaningful connection exists, respond with 'NO_ABSTRACTION'.`,
);

/** Phase 7 — hindsight audit of an entrenched memory. */
export const HINDSIGHT_REVIEW = definePrompt<{
  name: string;
  definition: string;
  category: MemoryCategory;
  confidence: number;
  stability: number;
  reps: number;
  lapses: number;
  historyNote: string;
  edgeSummary: string;
}>('hindsight-review', 1, (p) =>
  `You are performing a hindsight review of a belief that has been repeatedly reinforced without ever failing a review or being contradicted.\n\n` +
  `Memory: "${p.name}"\n` +
  `Definition: ${p.definition}\n` +
  `Category: ${p.category}\n` +
  `Confidence: ${p.confidence.toFixed(2)}, FSRS stability: ${p.stability.toFixed(1)} days, Reps: ${p.reps}, Lapses: ${p.lapses}\n` +
  `${p.historyNote}\n` +
  `Connected concepts:\n${p.edgeSummary}\n\n` +
  `Critically examine this belief. Consider:\n` +
  `- Could this have hardened through narrow, self-confirming signals rather than diverse evidence?\n` +
  `- Is the definition overstated, incomplete, or context-dependent in ways not captured here?\n` +
  `- Are there implicit assumptions embedded in it that should be made explicit or questioned?\n\n` +
  `Respond with JSON only — no preamble:\n` +
  `{"concern": "string describing the issue, or null if none", "confidence_penalty": <number 0.0–0.25, use 0.0 if no concern>, "revised_definition": "string or null", "reason": "brief explanation"}`,
);

/** Phase 8 — narrative report of the cycle. */
export const DREAM_REPORT = definePrompt<{ statsLine: string }>(
  'dream-report', 1, (p) =>
    `Summarize this dream consolidation session in 2-3 sentences.\n\n` +
    `Stats: ${p.statsLine}\n\n` +
    `Write a brief, reflective summary of what was learned and consolidated.`,
);

// ─── Retrieval ────────────────────────────────────────────────────────────────

/**
 * HyDE query expansion. The /no_think prefix suppresses reasoning-mode
 * <think>...</think> output on thinking models (qwen3, phi4-reasoning) —
 * without it a small maxTokens budget can be consumed entirely by the
 * thinking block, leaving an empty answer.
 */
export const HYDE_EXPAND = definePrompt<{ query: string }>(
  'hyde-expand', 1, (p) =>
    `/no_think\nWrite a short, factual passage (2-3 sentences) that would answer this question or describe this concept. Do not include any preamble — just the passage.\n\nQuery: ${p.query}`,
);

// ─── Beliefs ──────────────────────────────────────────────────────────────────

/**
 * Contradiction adjudication (LLM fallback when no NLI provider is available).
 * Verdict vocabulary is a superset of nliToCortexVerdict: NLI cannot detect
 * temporal succession, so "supersedes" is only reachable via this path.
 *
 * v2: added the "supersedes" verdict — a state change over time is belief
 * revision, not contradiction (bitemporal distinction).
 */
export const ADJUDICATE_CONTRADICTION = definePrompt<{
  claim: string;
  target: string;
}>('adjudicate-contradiction', 2, (p) =>
  `You are adjudicating whether a new piece of evidence genuinely contradicts a stored belief.\n\n` +
  `STORED BELIEF: ${p.target}\n\n` +
  `NEW EVIDENCE: ${p.claim}\n\n` +
  `Classify the relationship:\n` +
  `- "genuine": they cannot both be true of the same time — the evidence directly negates the belief\n` +
  `- "supersedes": the evidence describes a state change over time — the belief was true, and the evidence reports that the world has since changed (e.g. "moved to Berlin last month" vs "lives in Paris"). Succession, not contradiction: the belief should be revised, not distrusted.\n` +
  `- "tension": they pull in different directions but could both hold (context-dependence, scope difference, partial conflict)\n` +
  `- "complementary": the evidence supports, refines, or extends the belief\n` +
  `- "unrelated": no meaningful logical relationship\n\n` +
  `Beware surface negation without real conflict, and implicit conflict without explicit negation. ` +
  `Prefer "supersedes" over "genuine" whenever the evidence is naturally read as an update about a changed world ` +
  `rather than a dispute about the same moment in time.\n\n` +
  `Respond with JSON only:\n` +
  `{"verdict": "genuine|supersedes|tension|complementary|unrelated", "confidence": <0.0-1.0>, "reasoning": "one sentence"}`,
);

// ─── Ingestion & reflection ───────────────────────────────────────────────────

/** observe() — 4-channel salience auto-scoring when the caller omits salience. */
export const SALIENCE_SCORE = definePrompt<{ text: string }>(
  'salience-score', 1, (p) =>
    `Rate the importance of this observation on a scale of 0.0 to 1.0. Consider novelty, emotional arousal, reward relevance, and attention-worthiness. Return {"composite": <number>}.\n\nObservation: ${p.text}`,
);

/** abstract() — subsume explicitly-selected concepts under one abstraction. */
export const ABSTRACT_SUBSUME = definePrompt<{
  conceptCount: number;
  formattedConcepts: string;
}>('abstract-subsume', 1, (p) =>
  `You are finding a higher-level concept that subsumes these ${p.conceptCount} specific concepts.\n\n` +
  `Concepts:\n${p.formattedConcepts}\n\n` +
  `Propose ONE abstract concept (name and definition) that meaningfully generalizes or unifies them. Respond with JSON: {"name": "<short name>", "definition": "<2-3 sentence definition>"}`,
);

/** query-explain() — one-sentence relevance rationale for a search hit. */
export const QUERY_EXPLAIN_RELEVANCE = definePrompt<{
  query: string;
  memoryName: string;
  memoryDefinition: string;
}>('query-explain-relevance', 1, (p) =>
  `In one sentence, why is this memory relevant to the query: ${p.query}? Memory: ${p.memoryName}: ${p.memoryDefinition}.`,
);

/** reflect() — synthesize related memories into a topical reflection. */
export const REFLECT_TOPIC = definePrompt<{
  topic: string;
  memoryContext: string;
}>('reflect-topic', 1, (p) =>
  `You are reflecting on the topic: "${p.topic}"\n\n` +
  `Related concepts from memory:\n${p.memoryContext || '(no related memories found)'}\n\n` +
  `Write a 2-4 sentence reflection that synthesizes these concepts and your understanding of the topic. Be honest about uncertainty.`,
);

/** System prompt paired with REFLECT_TOPIC. */
export const REFLECT_SYSTEM = definePrompt<Record<string, never>>(
  'reflect-system', 1, () =>
    'You are a reflective cognitive agent. You are reflecting on your own memories and experiences. Generate thoughtful, grounded reflections in first person based on the provided memory context. Do not confuse yourself with other people mentioned in the memories.',
);

/** agent-invoke() — extract storable findings from a sub-agent's output. */
export const AGENT_FINDINGS_EXTRACT = definePrompt<{ text: string }>(
  'agent-findings-extract', 1, (p) =>
    `Extract 1-5 key factual findings from this text. ` +
    `Return a JSON array of objects with "name" (short title, max 80 chars) ` +
    `and "finding" (1-2 sentence summary) fields. ` +
    `Only include genuinely new or important information.\n\n${p.text}`,
);

// ─── Rumination ───────────────────────────────────────────────────────────────

/**
 * Free-writing pass over accumulated context — dream() for identity.
 * High temperature by design; the value is in what emerges.
 */
export const RUMINATE_FREEWRITE = definePrompt<{
  context: string;
  topicInstruction: string;
}>('ruminate-freewrite', 1, (p) =>
  `You are an AI agent reflecting on your own accumulated context. People mentioned in the context (like "Virgil") are other people, not you. This is a rumination — not a task response, not a summary, not a report. Think freely.\n\n` +
  `Here is what you know right now:\n\n` +
  `${p.context}\n\n` +
  `${p.topicInstruction}\n\n` +
  `Write 3-5 paragraphs of genuine reflection. What patterns do you see? What surprised you? What do you actually think about what's happening? What questions opened that you didn't expect? What would you want your future self to know?\n\n` +
  `Don't summarize. Think. The value is in what emerges, not in being comprehensive.`,
);

/** Extract beliefs/speculations/questions/identity insights from a rumination. */
export const RUMINATE_EXTRACT = definePrompt<{ text: string }>(
  'ruminate-extract', 1, (p) =>
    `Read this rumination output from an AI agent reflecting on its own state:\n\n` +
    `---\n${p.text}\n---\n\n` +
    `Extract any genuine insights. For each, classify as:\n` +
    `- BELIEF: A position the agent holds (could change with evidence)\n` +
    `- SPECULATION: A hypothesis worth testing\n` +
    `- QUESTION: An open question worth tracking\n` +
    `- IDENTITY: Something about who the agent is becoming\n\n` +
    `Output as JSON array:\n` +
    `[{"type": "BELIEF"|"SPECULATION"|"QUESTION"|"IDENTITY", "text": "...", "salience": 0.0-1.0}]\n\n` +
    `Only include items that represent genuine thinking — not restatements of the input. If nothing genuine emerged, return [].`,
);

// ─── Registry ─────────────────────────────────────────────────────────────────

/** All registered prompts, for introspection, docs, and version tests. */
export const PROMPT_REGISTRY = [
  REFINE_DEFINITION,
  EDGE_REVALIDATE,
  CLASSIFY_CATEGORY,
  EDGE_DISCOVER_PAIR,
  EDGE_DISCOVER_GRAPH,
  ABSTRACT_SYNTHESIS,
  HINDSIGHT_REVIEW,
  DREAM_REPORT,
  HYDE_EXPAND,
  ADJUDICATE_CONTRADICTION,
  SALIENCE_SCORE,
  ABSTRACT_SUBSUME,
  QUERY_EXPLAIN_RELEVANCE,
  REFLECT_TOPIC,
  REFLECT_SYSTEM,
  AGENT_FINDINGS_EXTRACT,
  RUMINATE_FREEWRITE,
  RUMINATE_EXTRACT,
] as const;

/** id → version map, used by tests and telemetry. */
export function promptVersions(): Record<string, number> {
  const versions: Record<string, number> = {};
  for (const prompt of PROMPT_REGISTRY) {
    versions[prompt.id] = prompt.version;
  }
  return versions;
}
