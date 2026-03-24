/**
 * observe — record a factual observation with prediction error gating.
 *
 * Checks for duplicates via prediction error gate: similar observations merge
 * into existing memories. Novel high-salience observations become memories
 * immediately; others queue for dream() consolidation.
 */

import type { ToolDefinition } from '../mcp/tools.js';
import type { CortexStore } from '../core/store.js';
import { predictionErrorGate } from '../engines/memory.js';
import { extractKeywords } from '../engines/keywords.js';
import { str, optStr, fireTriggers, fireBridges } from './_helpers.js';

export const observeTool: ToolDefinition = {
  name: 'observe',
  description: 'Record a factual observation — something you learned, confirmed, or noticed to be true. Content should be declarative (statements of fact), not questions or speculation. For open questions use wonder(). For untested hypotheses use speculate(). Duplicate observations are automatically merged. Very novel, high-importance observations become new memories immediately; others queue for dream() consolidation.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'A declarative statement of what you observed (e.g. "The auth system uses JWT tokens")' },
      namespace: { type: 'string', description: 'Target namespace (defaults to default namespace)' },
      salience: { type: 'number', description: 'Importance score 0.0-1.0 (omit to auto-score via LLM)' },
      source_file: { type: 'string', description: 'Source file path for provenance' },
      source_section: { type: 'string', description: 'Source section or heading for provenance' },
    },
    required: ['text'],
  },
  async handler(args, ctx) {
    const text = str(args, 'text');
    const namespace = optStr(args, 'namespace');
    const sourceFile = optStr(args, 'source_file') ?? '';
    const sourceSection = optStr(args, 'source_section') ?? '';

    const store: CortexStore = ctx.namespaces.getStore(namespace);
    const provenance = ctx.session.getProvenance();

    // Embed the observation
    const embedding = await ctx.embed.embed(text);

    // Auto-score importance when salience not explicitly provided
    let salience: number;
    if (typeof args['salience'] === 'number') {
      salience = args['salience'];
    } else {
      try {
        const scoreResult = await ctx.llm.generateJSON<{ composite: number }>(
          `Rate the importance of this observation on a scale of 0.0 to 1.0. Consider novelty, emotional arousal, reward relevance, and attention-worthiness. Return {"composite": <number>}.\n\nObservation: ${text}`,
          { temperature: 0.1, schema: { type: 'object', properties: { composite: { type: 'number' } }, required: ['composite'] } },
        );
        salience = scoreResult.composite ?? 0.5;
      } catch {
        salience = 0.5;
      }
    }

    // Run prediction error gate with namespace-specific thresholds
    const nsConfig = ctx.namespaces.getConfig(namespace);
    const gate = await predictionErrorGate(store, embedding, {
      merge: nsConfig.similarity_merge,
      link: nsConfig.similarity_link,
    });

    // Extract keywords
    const keywords = extractKeywords(text);

    // If merge decision, update existing memory instead of creating duplicate
    if (gate.decision === 'merge' && gate.nearest_id) {
      await store.updateMemory(gate.nearest_id, {
        updated_at: new Date(),
      });
      try {
        await store.touchMemory(gate.nearest_id, {});
      } catch {
        // touchMemory may not be fully supported — non-fatal
      }

      const mergeResult: Record<string, unknown> = {
        action: 'merged',
        nearest_id: gate.nearest_id,
        max_similarity: gate.max_similarity,
        namespace: namespace ?? ctx.namespaces.getDefaultNamespace(),
        message: `Observation merged into existing concept (similarity: ${gate.max_similarity.toFixed(2)})`,
      };

      const resolvedNs = namespace ?? ctx.namespaces.getDefaultNamespace();
      await fireTriggers(ctx, resolvedNs, 'observe', text, { nearest_id: gate.nearest_id, decision: 'merge' }, ctx.allTools);
      await fireBridges(ctx, resolvedNs, 'observe', mergeResult, ctx.allTools);

      return mergeResult;
    }

    // Store the observation
    const predictionError = gate.max_similarity > 0 ? Math.round((1 - gate.max_similarity) * 1000) / 1000 : null;
    const id = await store.putObservation({
      content: text,
      source_file: sourceFile,
      source_section: sourceSection,
      salience,
      processed: false,
      prediction_error: predictionError,
      created_at: new Date(),
      updated_at: new Date(),
      embedding,
      keywords,
      provenance,
    });

    // High prediction error = surprise — create a signal
    if (predictionError !== null && predictionError >= 0.5) {
      try {
        const snippet = text.slice(0, 120).replace(/\s+/g, ' ').trim() + (text.length > 120 ? '...' : '');
        await store.putSignal({
          type: 'SURPRISE',
          description: `High prediction error (${(predictionError * 100).toFixed(0)}%): observation diverges from existing knowledge. "${snippet}"`,
          concept_ids: gate.nearest_id ? [gate.nearest_id] : [],
          priority: 0.5,
          resolved: false,
          created_at: new Date(),
          resolution_note: null,
        });
      } catch {
        // Signal write failure is non-fatal
      }
    }

    // High-salience novel observation — create memory immediately
    if (gate.decision === 'novel' && salience >= 0.7) {
      const firstSentence = text.match(/^[^.!?]+[.!?]/)?.[0]?.trim();
      const memName = firstSentence && firstSentence.length <= 80
        ? firstSentence
        : text.slice(0, 60).replace(/\s+\S*$/, '');

      const category = inferCategory(text);
      const memId = await store.putMemory({
        name: memName,
        definition: text,
        category,
        salience,
        confidence: 0.7,
        access_count: 1,
        created_at: new Date(),
        updated_at: new Date(),
        last_accessed: new Date(),
        source_files: [sourceFile],
        embedding,
        tags: keywords.slice(0, 5),
        fsrs: { stability: 1, difficulty: 0.3, reps: 0, lapses: 0, state: 'new', last_review: null },
        memory_origin: 'organic',
      });

      await store.markObservationProcessed(id);

      const createResult: Record<string, unknown> = {
        action: 'created',
        id,
        memory_id: memId,
        decision: gate.decision,
        nearest_id: gate.nearest_id,
        max_similarity: gate.max_similarity,
        namespace: namespace ?? ctx.namespaces.getDefaultNamespace(),
        keywords,
        salience,
        message: 'Novel high-salience observation -> new memory created immediately',
      };

      const resolvedNs = namespace ?? ctx.namespaces.getDefaultNamespace();
      await fireTriggers(ctx, resolvedNs, 'observe', text, { observation_id: id, memory_id: memId, decision: gate.decision }, ctx.allTools);
      await fireBridges(ctx, resolvedNs, 'observe', createResult, ctx.allTools);

      return createResult;
    }

    const result: Record<string, unknown> = {
      id,
      action: gate.decision === 'link' ? 'linked' : 'queued',
      decision: gate.decision,
      nearest_id: gate.nearest_id,
      max_similarity: gate.max_similarity,
      namespace: namespace ?? ctx.namespaces.getDefaultNamespace(),
      keywords,
      salience,
      message: `Observation stored (similarity: ${gate.max_similarity.toFixed(2)}) — will consolidate during next dream`,
    };

    // Fire triggers and bridges after observe
    const resolvedNs = namespace ?? ctx.namespaces.getDefaultNamespace();
    await fireTriggers(ctx, resolvedNs, 'observe', text, { observation_id: id, decision: gate.decision }, ctx.allTools);
    await fireBridges(ctx, resolvedNs, 'observe', result, ctx.allTools);

    return result;
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Simple heuristic category inference from text content. */
function inferCategory(text: string): 'belief' | 'pattern' | 'entity' | 'topic' | 'value' | 'project' | 'insight' | 'observation' | 'goal' {
  const lower = text.toLowerCase();
  if (/\bi (believe|think|feel|prefer)\b/.test(lower)) return 'belief';
  if (/\bpattern|tendency|always|usually|often\b/.test(lower)) return 'pattern';
  if (/\bgoal|want to|plan to|need to|should\b/.test(lower)) return 'goal';
  if (/\binsight|realized|discovered|learned\b/.test(lower)) return 'insight';
  if (/\bvalue|principle|important that\b/.test(lower)) return 'value';
  if (/\bproject|building|working on|developing\b/.test(lower)) return 'project';
  return 'observation';
}
