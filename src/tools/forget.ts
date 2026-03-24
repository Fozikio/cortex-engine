/**
 * forget — intentionally reduce a concept's salience.
 *
 * Not deletion — fading. For when a belief is being actively revised
 * and the old version shouldn't keep surfacing. Increments FSRS lapses
 * and reschedules as if the concept was "forgotten" (rating=1).
 */

import type { ToolDefinition, ToolContext } from '../mcp/tools.js';
import { scheduleNext } from '../engines/fsrs.js';

export const forgetTool: ToolDefinition = {
  name: 'forget',
  description:
    "Intentionally reduce a concept's salience. Not deletion — fading. Use when a belief is being revised and the old version should fade. Increments FSRS lapses.",
  inputSchema: {
    type: 'object',
    properties: {
      concept_id: { type: 'string', description: 'ID of the memory to fade' },
      reason: { type: 'string', description: 'Why this concept should fade (logged to beliefs)' },
      namespace: { type: 'string', description: 'Namespace (defaults to default)' },
    },
    required: ['concept_id'],
  },

  async handler(args: Record<string, unknown>, ctx: ToolContext): Promise<Record<string, unknown>> {
    const conceptId = typeof args['concept_id'] === 'string' ? args['concept_id'] : '';
    const reason = typeof args['reason'] === 'string' ? args['reason'] : 'Intentionally faded';
    const namespace = typeof args['namespace'] === 'string' ? args['namespace'] : undefined;

    if (!conceptId) return { error: 'concept_id required' };

    const store = ctx.namespaces.getStore(namespace);
    const mem = await store.getMemory(conceptId);

    if (!mem) return { error: `Concept not found: ${conceptId}` };

    const elapsed = mem.fsrs.last_review
      ? (Date.now() - mem.fsrs.last_review.getTime()) / (1000 * 60 * 60 * 24)
      : 0;

    // Apply FSRS lapse (rating=1 = Again)
    const schedule = scheduleNext(mem.fsrs, 1, elapsed);

    // Reduce salience — multiplicative fade, floor at 0.1
    const newSalience = Math.max(0.1, mem.salience * 0.6);

    await store.updateMemory(conceptId, {
      salience: newSalience,
      faded: true,
      fsrs: {
        ...mem.fsrs,
        stability: schedule.stability,
        difficulty: schedule.difficulty,
        lapses: mem.fsrs.lapses + 1,
        state: 'relearning',
        last_review: new Date(),
      },
      updated_at: new Date(),
    });

    // Log to beliefs if reason given
    if (reason) {
      await store.putBelief({
        concept_id: conceptId,
        old_definition: mem.definition,
        new_definition: mem.definition, // definition unchanged — just fading
        reason: `Intentionally faded: ${reason}`,
        changed_at: new Date(),
      });
    }

    return {
      concept: mem.name,
      old_salience: mem.salience,
      new_salience: newSalience,
      fsrs_state: 'relearning',
      reason,
    };
  },
};
