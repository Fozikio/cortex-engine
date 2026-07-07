/**
 * ruminate — creative cognition tool.
 *
 * Pulls context from threads, recent observations, and open questions,
 * then produces a free-writing pass via LLM. The output is read back
 * and parsed for extractable beliefs, speculations, and identity insights.
 *
 * This is dream() for identity — compressive, generative processing
 * where the value isn't the text but what you learn from having written it.
 */

import type { ToolDefinition } from '../mcp/tools.js';
import type { CortexStore } from '../core/store.js';
import { extractKeywords } from '../engines/keywords.js';
import { RUMINATE_FREEWRITE, RUMINATE_EXTRACT } from '../engines/prompts.js';
import { optStr, optNum, optBool } from './_helpers.js';

export const ruminateTool: ToolDefinition = {
  name: 'ruminate',
  category: 'consolidation',
  description: 'Free-writes from accumulated context (threads, observations, evolutions, journals), then optionally extracts beliefs, speculations, and questions and stores them. dream() for identity.',
  whenToUse: 'You want to process accumulated experience and let new beliefs or questions emerge.',
  doNotUse: 'You want to consolidate observations (use dream) or reflect on one topic (use reflect).',
  inputSchema: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description: "Optional focus topic (e.g. \"what I've learned about my own voice\")",
      },
      context_depth: {
        type: 'number',
        description: 'How many recent observations to pull (default: 15)',
      },
      extract: {
        type: 'boolean',
        description: 'Extract beliefs/speculations from the output (default: true)',
      },
      namespace: { type: 'string', description: 'Namespace (defaults to default namespace)' },
    },
  },

  async handler(args, ctx) {
    const topic = optStr(args, 'topic');
    const depth = optNum(args, 'context_depth', 15);
    const shouldExtract = optBool(args, 'extract', true);
    const namespace = optStr(args, 'namespace');
    const store = ctx.namespaces.getStore(namespace);

    // Phase 1: Gather context
    const context = await gatherContext(store, depth);

    if (!context.trim()) {
      return {
        error: 'No context available to ruminate on. Try observing, creating threads, or writing journal entries first.',
      };
    }

    // Phase 2: Free-writing pass
    const topicInstruction = topic
      ? `Focus your reflection around: ${topic}`
      : 'Let your attention go wherever it naturally goes.';

    const prompt = RUMINATE_FREEWRITE.build({ context, topicInstruction });

    const rumination = await ctx.llm.generate(prompt, { temperature: 0.9 });

    // Store the rumination as a reflective observation
    const embedding = await ctx.embed.embed(rumination);
    const keywords = extractKeywords(rumination);

    const ruminationId = await store.putObservation({
      content: rumination,
      source_file: topic ? `ruminate:${topic}` : 'ruminate',
      source_section: 'ruminate',
      salience: 0.7,
      processed: false,
      prediction_error: null,
      created_at: new Date(),
      updated_at: new Date(),
      keywords,
      embedding,
      content_type: 'reflective',
    });

    const result: Record<string, unknown> = {
      rumination_id: ruminationId,
      text: rumination,
      context_items: context.split('\n').filter(l => l.startsWith('- ')).length,
      namespace: namespace ?? ctx.namespaces.getDefaultNamespace(),
    };

    // Phase 3: Extract and store insights
    if (shouldExtract) {
      try {
        const extractPrompt = RUMINATE_EXTRACT.build({ text: rumination });
        const extractionRaw = await ctx.llm.generate(extractPrompt, { temperature: 0.2 });

        // Parse JSON from the response
        const jsonMatch = extractionRaw.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          const extractions = JSON.parse(jsonMatch[0]) as Array<{
            type: string;
            text: string;
            salience: number;
          }>;

          const stored: Array<{ id: string; type: string; text: string }> = [];

          for (const item of extractions) {
            const itemEmbedding = await ctx.embed.embed(item.text);
            const itemKeywords = extractKeywords(item.text);

            const contentTypeMap: Record<string, string> = {
              BELIEF: 'speculative',
              SPECULATION: 'speculative',
              QUESTION: 'interrogative',
            };
            const sectionMap: Record<string, string> = {
              BELIEF: 'speculate',
              SPECULATION: 'speculate',
              QUESTION: 'wonder',
            };

            if (item.type === 'IDENTITY') {
              // Store as evolution proposal via generic put
              const refId = await store.put('evolutions', {
                change: item.text,
                trigger: `Emerged from rumination${topic ? ` on "${topic}"` : ''}`,
                confidence: item.salience >= 0.7 ? 'high' : 'medium',
                status: 'proposed',
                created_at: new Date().toISOString(),
              });
              stored.push({ id: refId, type: 'identity', text: item.text });
            } else if (contentTypeMap[item.type]) {
              const refId = await store.putObservation({
                content: item.text,
                source_file: 'ruminate:extract',
                source_section: sectionMap[item.type] ?? 'speculate',
                salience: item.salience,
                processed: false,
                prediction_error: null,
                created_at: new Date(),
                updated_at: new Date(),
                keywords: itemKeywords,
                embedding: itemEmbedding,
                content_type: contentTypeMap[item.type] as 'declarative' | 'interrogative' | 'speculative' | 'reflective',
              });
              stored.push({ id: refId, type: item.type.toLowerCase(), text: item.text });
            }
          }

          result['extractions'] = stored;
          result['extraction_count'] = stored.length;
        }
      } catch {
        result['extraction_error'] = 'Failed to parse extractions — rumination still stored.';
      }
    }

    return result;
  },
};

// ─── Context Gathering ───────────────────────────────────────────────────────

async function gatherContext(store: CortexStore, depth: number): Promise<string> {
  const parts: string[] = [];

  // 1. Open threads
  try {
    const threads = await store.query(
      'threads',
      [{ field: 'status', op: 'in', value: ['open', 'active'] }],
      { limit: 5, orderBy: 'priority', orderDir: 'desc' },
    );
    if (threads.length > 0) {
      parts.push('## Open Threads');
      for (const t of threads) {
        const body = typeof t['body'] === 'string' ? t['body'].slice(0, 200) : '';
        parts.push(`- **${t['title'] ?? 'Untitled'}**: ${body}`);
        if (t['next_step']) parts.push(`  Next: ${t['next_step']}`);
      }
    }
  } catch {
    // threads collection may not exist — non-fatal
  }

  // 2. Recent observations (including questions and speculations)
  try {
    const observations = await store.query(
      'observations',
      [],
      { limit: depth, orderBy: 'created_at', orderDir: 'desc' },
    );
    if (observations.length > 0) {
      parts.push('\n## Recent Observations');
      for (const o of observations) {
        const contentType = o['content_type'];
        const typeLabel = contentType === 'interrogative' ? '(question) '
          : contentType === 'speculative' ? '(hypothesis) '
          : '';
        const content = typeof o['content'] === 'string' ? o['content'].slice(0, 200) : '';
        parts.push(`- ${typeLabel}${content}`);
      }
    }
  } catch {
    // Non-fatal
  }

  // 3. Recent evolution proposals (identity changes in flight)
  try {
    const evolutions = await store.query(
      'evolutions',
      [{ field: 'status', op: '==', value: 'proposed' }],
      { limit: 5, orderBy: 'created_at', orderDir: 'desc' },
    );
    if (evolutions.length > 0) {
      parts.push('\n## Pending Identity Changes');
      for (const e of evolutions) {
        const change = typeof e['change'] === 'string' ? e['change'].slice(0, 200) : '';
        parts.push(`- ${change}`);
      }
    }
  } catch {
    // Non-fatal
  }

  // 4. Recent journal entries
  try {
    const journals = await store.query(
      'journals',
      [],
      { limit: 2, orderBy: 'created_at', orderDir: 'desc' },
    );
    if (journals.length > 0) {
      parts.push('\n## Recent Journal');
      for (const j of journals) {
        const content = typeof j['content'] === 'string' ? j['content'].slice(0, 300) : '';
        parts.push(`- ${content}`);
      }
    }
  } catch {
    // Non-fatal
  }

  return parts.join('\n');
}
