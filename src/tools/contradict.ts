/**
 * contradict — report evidence that disputes a belief or memory, and have the
 * claim adjudicated before it becomes a signal.
 *
 * Previously this recorded a CONTRADICTION signal on the caller's say-so.
 * Now the (evidence, belief) pair is adjudicated first (NLI cross-encoder if
 * configured, LLM fallback otherwise — see engines/adjudicate.ts):
 *
 * - genuine       → CONTRADICTION signal (priority 0.8) + confidence penalty
 *                   on the disputed memory, scaled by adjudicator confidence
 * - supersedes    → TENSION signal (priority 0.4), no penalty — the world
 *                   changed; revise via believe() with valid_from instead of
 *                   distrusting the belief (bitemporal succession)
 * - tension       → TENSION signal (priority 0.5), no penalty
 * - complementary → no signal; the evidence supports the belief (use believe/link)
 * - unrelated     → no signal
 *
 * Pass force=true to skip adjudication and record the contradiction on the
 * caller's authority (the old behavior).
 */

import type { ToolDefinition } from '../mcp/tools.js';
import { adjudicateContradiction, MAX_CONFIDENCE_PENALTY } from '../engines/adjudicate.js';
import { optStr } from './_helpers.js';

const OBSERVATIONS_COLLECTION = 'observations';
const BELIEFS_COLLECTION = 'beliefs';

export const contradictTool: ToolDefinition = {
  name: 'contradict',
  category: 'beliefs',
  description: 'Adjudicates whether an observation genuinely contradicts a belief or memory (NLI/LLM), then records a CONTRADICTION or TENSION signal — genuine contradictions also reduce the memory\'s confidence. Returns the verdict and signal id.',
  whenToUse: 'You notice fresh evidence that disagrees with stored belief or memory and want it verified and surfaced for later resolution.',
  doNotUse: 'You want to update the belief itself (use believe) or close out a known contradiction (use resolve).',
  inputSchema: {
    type: 'object',
    properties: {
      observation_id: { type: 'string', description: 'Observation document ID' },
      belief_id: { type: 'string', description: 'Belief document ID (concept_id will be used)' },
      memory_id: { type: 'string', description: 'Memory document ID' },
      note: { type: 'string', description: 'Optional note about the contradiction' },
      force: { type: 'boolean', description: 'Skip adjudication and record the contradiction as-is (default: false)' },
      namespace: { type: 'string', description: 'Namespace (defaults to default)' },
    },
    required: ['observation_id'],
  },

  async handler(args, ctx) {
    const observationId = optStr(args, 'observation_id') ?? '';
    const beliefId = optStr(args, 'belief_id');
    const memoryId = optStr(args, 'memory_id');
    const note = optStr(args, 'note') ?? '';
    const force = args['force'] === true;
    const namespace = optStr(args, 'namespace');

    if (!observationId) {
      return { error: 'observation_id is required' };
    }

    const provided = [beliefId, memoryId].filter(Boolean);
    if (provided.length !== 1) {
      return { error: 'Provide exactly one of belief_id or memory_id.' };
    }

    const store = ctx.namespaces.getStore(namespace);

    const obsDoc = await store.get(OBSERVATIONS_COLLECTION, observationId);
    if (!obsDoc) {
      return { error: `Observation ${observationId} not found` };
    }
    const content = typeof obsDoc['content'] === 'string' ? obsDoc['content'] : '';
    const snippet = content.slice(0, 500);

    // Resolve the disputed concept and the text the evidence is claimed to contradict.
    let conceptId: string;
    let targetText: string;
    let targetMemoryConfidence: number | undefined;

    if (memoryId) {
      const memory = await store.getMemory(memoryId);
      if (!memory) {
        return { error: `Memory ${memoryId} not found` };
      }
      conceptId = memoryId;
      targetText = memory.definition;
      targetMemoryConfidence = memory.confidence;
    } else {
      const beliefDoc = await store.get(BELIEFS_COLLECTION, beliefId!);
      if (!beliefDoc) {
        return { error: `Belief ${beliefId} not found` };
      }
      const docConceptId = typeof beliefDoc['concept_id'] === 'string' ? beliefDoc['concept_id'] : '';
      if (!docConceptId) {
        return { error: 'Belief document has no concept_id' };
      }
      conceptId = docConceptId;
      targetText = typeof beliefDoc['new_definition'] === 'string' ? beliefDoc['new_definition'] : '';
      const conceptMemory = await store.getMemory(docConceptId);
      if (conceptMemory) {
        targetText = targetText || conceptMemory.definition;
        targetMemoryConfidence = conceptMemory.confidence;
      }
    }

    // Adjudicate unless the caller overrides. Never throws — degrades to an
    // unverified 'tension' when no provider can decide.
    const adjudication = force
      ? undefined
      : await adjudicateContradiction({
          claim: content,
          target: targetText,
          nli: ctx.nli,
          llm: ctx.llm,
          llmTier: ctx.llmTier,
        });

    const verdict = force ? 'genuine' : adjudication!.verdict;

    // Complementary / unrelated evidence is not worth a standing signal.
    if (verdict === 'complementary' || verdict === 'unrelated') {
      return {
        verdict,
        adjudication,
        signal_id: null,
        message: verdict === 'complementary'
          ? 'Evidence supports the belief rather than contradicting it — consider believe() to refine the definition, or link() to connect them.'
          : 'No meaningful logical relationship found — nothing recorded.',
      };
    }

    const verdictNote = force
      ? '[forced — adjudication skipped]'
      : `[adjudicated: ${adjudication!.verdict} via ${adjudication!.method}, confidence ${adjudication!.confidence.toFixed(2)}]`;
    const description = [
      verdict === 'supersedes'
        ? 'Temporal succession — the world changed; revise with believe(valid_from) rather than distrusting the belief.'
        : '',
      `Observation: "${snippet}"`,
      note ? `Note: ${note}` : '',
      verdictNote,
      adjudication?.reasoning ? `Reasoning: ${adjudication.reasoning}` : '',
    ].filter(Boolean).join('\n');

    const signalId = await store.putSignal({
      type: verdict === 'genuine' ? 'CONTRADICTION' : 'TENSION',
      description,
      concept_ids: [conceptId],
      priority: verdict === 'genuine' ? 0.8 : verdict === 'supersedes' ? 0.4 : 0.5,
      resolved: false,
      created_at: new Date(),
      resolution_note: null,
      observation_id: observationId,
    });

    // A verified genuine contradiction erodes trust in the memory now, rather
    // than waiting for someone to act on the signal. Scaled by adjudicator
    // confidence; forced contradictions apply the midpoint penalty.
    let confidencePenalty = 0;
    if (verdict === 'genuine' && targetMemoryConfidence !== undefined) {
      const scale = force ? 0.5 : adjudication!.confidence;
      confidencePenalty = Math.round(MAX_CONFIDENCE_PENALTY * scale * 1000) / 1000;
      if (confidencePenalty > 0) {
        await store.updateMemory(conceptId, {
          confidence: Math.max(0.1, targetMemoryConfidence - confidencePenalty),
          updated_at: new Date(),
        });
      }
    }

    return {
      verdict,
      adjudication,
      signal_id: signalId,
      confidence_penalty: confidencePenalty > 0 ? confidencePenalty : undefined,
      message: verdict === 'supersedes'
        ? 'Temporal succession — use believe() with valid_from to revise the belief; a TENSION signal tracks the pending revision.'
        : undefined,
    };
  },
};
