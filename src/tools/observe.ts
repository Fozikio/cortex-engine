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
import { adjudicateContradiction, MAX_CONFIDENCE_PENALTY } from '../engines/adjudicate.js';
import { SALIENCE_SCORE } from '../engines/prompts.js';
import { str, optStr, optBool, fireTriggers, fireBridges } from './_helpers.js';

export const observeTool: ToolDefinition = {
  name: 'observe',
  category: 'memory',
  description: 'Records a declarative observation — duplicates merge into existing memories; high-novelty entries can become memories immediately, others queue for dream consolidation. Returns the new id.',
  whenToUse: 'You learned or confirmed something to be true and want it captured as a fact.',
  doNotUse: 'You have an open question (use wonder) or an untested hypothesis (use speculate).',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'A declarative statement of what you observed (e.g. "The auth system uses JWT tokens")' },
      namespace: { type: 'string', description: 'Target namespace (defaults to default namespace)' },
      salience: { type: 'number', description: 'Importance score 0.0-1.0 (omit to auto-score via LLM)' },
      source_file: { type: 'string', description: 'Source file path for provenance' },
      source_section: { type: 'string', description: 'Source section or heading for provenance' },
      check_conflict: { type: 'boolean', description: 'Check whether this observation contradicts the nearest existing memory (default: true; only runs when an NLI provider is configured)' },
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
          SALIENCE_SCORE.build({ text }),
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

    const predictionError = gate.max_similarity > 0 ? Math.round((1 - gate.max_similarity) * 1000) / 1000 : null;

    // Implicit-conflict check (STALE-style): evidence that lands near an
    // existing memory may contradict it rather than repeat it — negations
    // embed close to their affirmations, so the merge/link band is exactly
    // where conflicts hide. Gated on an NLI provider being configured: the
    // cross-encoder call is local and fast, so the write path stays cheap.
    // (The LLM is only consulted to reclassify an NLI contradiction as
    // temporal succession — see engines/adjudicate.ts.)
    const checkConflict = optBool(args, 'check_conflict', true);
    if (checkConflict && ctx.nli && gate.nearest_id && gate.decision !== 'novel') {
      try {
        const nearest = await store.getMemory(gate.nearest_id);
        if (nearest) {
          const adjudication = await adjudicateContradiction({
            claim: text,
            target: nearest.definition,
            nli: ctx.nli,
            llm: ctx.llm,
            llmTier: ctx.llmTier,
          });

          if (adjudication.verdict === 'genuine' || adjudication.verdict === 'supersedes') {
            // Conflicting evidence must not merge into the memory it
            // disputes — store it as an observation and flag the conflict.
            const obsId = await store.putObservation({
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

            const isGenuine = adjudication.verdict === 'genuine';
            const snippet = text.slice(0, 200).replace(/\s+/g, ' ').trim();
            await store.putSignal({
              type: isGenuine ? 'CONTRADICTION' : 'TENSION',
              description: [
                isGenuine
                  ? `Observation contradicts memory "${nearest.name}".`
                  : `Observation supersedes memory "${nearest.name}" (temporal succession) — revise with believe(valid_from).`,
                `Observation: "${snippet}"`,
                `[adjudicated: ${adjudication.verdict} via ${adjudication.method}, confidence ${adjudication.confidence.toFixed(2)}]`,
                adjudication.reasoning ? `Reasoning: ${adjudication.reasoning}` : '',
              ].filter(Boolean).join('\n'),
              concept_ids: [gate.nearest_id],
              priority: isGenuine ? 0.8 : 0.4,
              resolved: false,
              created_at: new Date(),
              resolution_note: null,
              observation_id: obsId,
            });

            let confidencePenalty = 0;
            if (isGenuine) {
              confidencePenalty = Math.round(MAX_CONFIDENCE_PENALTY * adjudication.confidence * 1000) / 1000;
              if (confidencePenalty > 0) {
                await store.updateMemory(gate.nearest_id, {
                  confidence: Math.max(0.1, nearest.confidence - confidencePenalty),
                  updated_at: new Date(),
                });
              }
            }

            const conflictResult: Record<string, unknown> = {
              id: obsId,
              action: isGenuine ? 'contradiction' : 'superseded',
              decision: gate.decision,
              nearest_id: gate.nearest_id,
              max_similarity: gate.max_similarity,
              adjudication,
              confidence_penalty: confidencePenalty > 0 ? confidencePenalty : undefined,
              namespace: namespace ?? ctx.namespaces.getDefaultNamespace(),
              keywords,
              salience,
              message: isGenuine
                ? `Observation contradicts existing memory "${nearest.name}" — CONTRADICTION signal recorded, memory confidence reduced.`
                : `Observation supersedes existing memory "${nearest.name}" — revise the belief with believe(valid_from); TENSION signal tracks the pending revision.`,
            };

            const resolvedNs = namespace ?? ctx.namespaces.getDefaultNamespace();
            ctx.consolidator?.notifyObservation(resolvedNs);
            await fireTriggers(ctx, resolvedNs, 'observe', text, { observation_id: obsId, nearest_id: gate.nearest_id, decision: conflictResult['action'] }, ctx.allTools);
            await fireBridges(ctx, resolvedNs, 'observe', conflictResult, ctx.allTools);

            return conflictResult;
          }
        }
      } catch (err) {
        // Conflict detection is best-effort — never block the write path.
        console.error('[observe:conflict-check]', err);
      }
    }

    // Merge decision: reactivate the existing memory instead of creating a
    // duplicate — but keep the observation. Discarding it loses the phrasing
    // and detail differences that distinguish this sighting from the stored
    // definition; queued unprocessed, the next dream cycle clusters it into
    // the same memory and feeds its content to the refine phase as evidence.
    if (gate.decision === 'merge' && gate.nearest_id) {
      const obsId = await store.putObservation({
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

      try {
        await store.touchMemory(gate.nearest_id, {});
      } catch {
        // touchMemory may not be fully supported — non-fatal
      }

      const mergeResult: Record<string, unknown> = {
        action: 'merged',
        id: obsId,
        nearest_id: gate.nearest_id,
        max_similarity: gate.max_similarity,
        namespace: namespace ?? ctx.namespaces.getDefaultNamespace(),
        message: `Observation merged into existing concept (similarity: ${gate.max_similarity.toFixed(2)}) — content queued as refine evidence for the next dream`,
      };

      const resolvedNs = namespace ?? ctx.namespaces.getDefaultNamespace();
      ctx.consolidator?.notifyObservation(resolvedNs);
      await fireTriggers(ctx, resolvedNs, 'observe', text, { observation_id: obsId, nearest_id: gate.nearest_id, decision: 'merge' }, ctx.allTools);
      await fireBridges(ctx, resolvedNs, 'observe', mergeResult, ctx.allTools);

      return mergeResult;
    }

    // Store the observation
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
      // Memory creation + observation mark-processed must commit together;
      // a crash between them leaves an orphan memory + the source obs
      // re-entering the dream pipeline on the next cycle.
      const memId = await store.withTransaction(async (txn) => {
        const newId = await txn.putMemory({
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
        await txn.markObservationProcessed(id);
        return newId;
      });

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

    // Notify the auto-consolidator so it can fire Phase A in the background
    // when enough observations have accumulated (threshold = AUTO_THRESHOLD).
    const resolvedNs = namespace ?? ctx.namespaces.getDefaultNamespace();
    ctx.consolidator?.notifyObservation(resolvedNs);

    // Fire triggers and bridges after observe
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
