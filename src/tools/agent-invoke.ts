/**
 * agent_invoke — dispatch a task to a cortex-backed agent.
 *
 * Runs a focused task loop using the configured LLM provider:
 * 1. Queries cortex for existing knowledge about the topic
 * 2. Builds a context-aware prompt with what cortex already knows
 * 3. Runs the LLM to complete the task
 * 4. Stores findings back into cortex as observations
 * 5. Returns the result
 *
 * This replaces expensive host-agent subagents with cheap, cortex-aware
 * agents that compound knowledge across sessions.
 */

import type { ToolDefinition, ToolContext } from '../mcp/tools.js';
import type { Memory, SearchResult } from '../core/types.js';
import { extractKeywords } from '../engines/keywords.js';

// ─── Tool Schema ─────────────────────────────────────────────────────────────

export const agentInvokeTool: ToolDefinition = {
  name: 'agent_invoke',
  description:
    'Dispatch a task to a cortex-backed agent using the configured LLM. ' +
    'The agent queries cortex for existing knowledge, completes the task, ' +
    'and stores findings back. Much cheaper than spawning a full subagent — ' +
    'uses the configured LLM (Ollama, Gemini Flash, DeepSeek, etc.) instead ' +
    'of the host model. Use for research, analysis, summarization, and ' +
    'any task that benefits from accumulated cortex knowledge.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      task: {
        type: 'string',
        description: 'The task to complete. Be specific about what you need.',
      },
      context: {
        type: 'string',
        description: 'Additional context to include in the agent prompt (optional).',
      },
      store_results: {
        type: 'boolean',
        description: 'Whether to store findings back into cortex as observations (default: true).',
      },
      namespace: {
        type: 'string',
        description: 'Namespace to query/write to (default: default namespace).',
      },
      temperature: {
        type: 'number',
        description: 'LLM temperature (default: 0.3).',
      },
      max_tokens: {
        type: 'number',
        description: 'Max output tokens (default: 2048).',
      },
    },
    required: ['task'],
  },

  async handler(args: Record<string, unknown>, ctx: ToolContext) {
    const task = String(args.task);
    const extraContext = typeof args.context === 'string' ? args.context : '';
    const storeResults = args.store_results !== false; // default true
    const temperature = typeof args.temperature === 'number' ? args.temperature : 0.3;
    const maxTokens = typeof args.max_tokens === 'number' ? args.max_tokens : 2048;

    // Resolve namespace
    const nsName = typeof args.namespace === 'string' ? args.namespace : undefined;
    const store = ctx.namespaces.getStore(nsName);
    const ns = nsName ?? ctx.namespaces.getDefaultNamespace();

    // ── Phase 1: Gather existing cortex knowledge ──────────────────────

    // Extract keywords from the task for targeted retrieval
    const keywords = extractKeywords(task);
    const queryText = task.length > 200 ? task.slice(0, 200) : task;

    // Embed the task and query cortex for similar memories
    const embedding = await ctx.embed.embed(queryText);
    const searchResults = await store.findNearest(embedding, 8);

    // Also check for keyword matches across all memories
    const allMemories = await store.getAllMemories();
    const keywordMatches: Memory[] = allMemories
      .filter((m: Memory) =>
        keywords.some((kw: string) =>
          m.name.toLowerCase().includes(kw) ||
          (m.definition ?? '').toLowerCase().includes(kw)
        )
      )
      .slice(0, 5);

    // Deduplicate — searchResults are { score, memory: { id, name, ... } }
    const seenIds = new Set(searchResults.map((r: SearchResult) => r.memory.id));
    const uniqueKeywordMatches = keywordMatches.filter((m: Memory) => !seenIds.has(m.id));

    // Combine into a flat list of { name, definition } for the prompt
    const relevantMemories = [
      ...searchResults.map((r: SearchResult) => ({ name: r.memory.name, definition: r.memory.definition })),
      ...uniqueKeywordMatches.map((m: Memory) => ({ name: m.name, definition: m.definition })),
    ];

    // ── Phase 2: Build context-aware prompt ────────────────────────────

    let cortexContext = '';
    if (relevantMemories.length > 0) {
      cortexContext = '\n\n## What I Already Know\n\n' +
        relevantMemories
          .map(m => `- **${m.name}**: ${m.definition ?? '(no definition)'}`)
          .join('\n');
    }

    const systemPrompt =
      'You are a focused research and analysis agent with access to a knowledge graph. ' +
      'You have been given existing knowledge from the graph below. ' +
      'Build on what is already known — don\'t repeat it. ' +
      'Focus on gaps, new insights, and actionable findings. ' +
      'Be concise and specific. Structure your response clearly.';

    const userPrompt =
      `## Task\n\n${task}` +
      (extraContext ? `\n\n## Additional Context\n\n${extraContext}` : '') +
      cortexContext +
      '\n\n## Instructions\n\n' +
      'Complete the task above. Build on existing knowledge where relevant. ' +
      'Structure your response with clear sections. ' +
      'End with a "Key Findings" section summarizing the most important points.';

    // ── Phase 3: Run the LLM ───────────────────────────────────────────

    const result = await ctx.llm.generate(userPrompt, {
      temperature,
      maxTokens,
      systemPrompt,
    });

    // ── Phase 4: Store findings back into cortex ───────────────────────

    let storedCount = 0;

    if (storeResults && result.length > 50) {
      // Extract key findings and store as observations
      const extractPrompt =
        `Extract 1-5 key factual findings from this text. ` +
        `Return a JSON array of objects with "name" (short title, max 80 chars) ` +
        `and "finding" (1-2 sentence summary) fields. ` +
        `Only include genuinely new or important information.\n\n${result}`;

      try {
        const findings = await ctx.llm.generateJSON<Array<{ name: string; finding: string }>>(
          extractPrompt,
          { temperature: 0.1, maxTokens: 1024 },
        );

        if (Array.isArray(findings)) {
          for (const f of findings.slice(0, 5)) {
            if (!f.name || !f.finding) continue;

            const content = `${f.name}: ${f.finding}`;
            const findingEmbed = await ctx.embed.embed(content);
            const findingKeywords = extractKeywords(content);

            await store.putObservation({
              content,
              source_file: `agent_invoke: ${task.slice(0, 100)}`,
              source_section: 'agent-finding',
              salience: 0.6,
              processed: false,
              prediction_error: null,
              created_at: new Date(),
              updated_at: new Date(),
              embedding: findingEmbed,
              keywords: findingKeywords,
              content_type: 'declarative',
              provenance: {
                model_id: ctx.llm.modelId,
                model_family: ctx.llm.name,
                client: 'agent_invoke',
                agent: ctx.session.getProvenance().model_id,
              },
            });

            storedCount++;
          }
        }
      } catch {
        // Extraction failed — the result is still returned, just not stored
      }
    }

    return {
      task,
      namespace: ns,
      model: `${ctx.llm.name}/${ctx.llm.modelId}`,
      existing_knowledge: relevantMemories.length,
      result,
      stored_findings: storedCount,
    };
  },
};
