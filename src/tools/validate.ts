/**
 * validate — confirm or deny a prediction to strengthen/weaken memory via FSRS.
 */

import type { ToolDefinition, ToolContext } from '../mcp/tools.js';
import { str, optStr, fireTriggers, fireBridges } from './_helpers.js';
import { elapsedDaysSince, scheduleNext } from '../engines/fsrs.js';

export const validateTool: ToolDefinition = {
  name: 'validate',
  description: 'Confirm or deny a prediction. Correct predictions strengthen the memory (longer retention), incorrect ones weaken it (more frequent review). Use after predict() to close the feedback loop.',
  inputSchema: {
    type: 'object',
    properties: {
      prediction_id: { type: 'string', description: 'ID of the memory/prediction to validate' },
      outcome: { type: 'boolean', description: 'Whether the prediction was correct' },
      notes: { type: 'string', description: 'Optional notes on the validation outcome' },
      namespace: { type: 'string', description: 'Namespace (defaults to default namespace)' },
    },
    required: ['prediction_id', 'outcome'],
  },
  async handler(args: Record<string, unknown>, ctx: ToolContext) {
    const predictionId = str(args, 'prediction_id');
    const outcome = args['outcome'] as boolean;
    const notes = optStr(args, 'notes') ?? '';
    const namespace = optStr(args, 'namespace');

    const store = ctx.namespaces.getStore(namespace);

    const memory = await store.getMemory(predictionId);
    if (!memory) {
      return { error: `Memory not found: ${predictionId}`, prediction_id: predictionId };
    }

    // FSRS rating: correct=3 (Good), incorrect=1 (Again)
    const rating: 1 | 2 | 3 | 4 = outcome ? 3 : 1;
    const elapsed = elapsedDaysSince(memory.fsrs.last_review);
    const scheduled = scheduleNext(memory.fsrs, rating, elapsed);

    // Update memory FSRS state
    await store.touchMemory(predictionId, {
      stability: scheduled.stability,
      difficulty: scheduled.difficulty,
      state: scheduled.state,
      last_review: new Date(),
      reps: memory.fsrs.reps + 1,
      lapses: outcome ? memory.fsrs.lapses : memory.fsrs.lapses + 1,
    });

    const result = {
      prediction_id: predictionId,
      outcome,
      rating,
      notes,
      previous_stability: memory.fsrs.stability,
      new_stability: scheduled.stability,
      interval_days: scheduled.interval_days,
      state: scheduled.state,
      namespace: namespace ?? ctx.namespaces.getDefaultNamespace(),
    };

    const resolvedNs = namespace ?? ctx.namespaces.getDefaultNamespace();
    await fireTriggers(ctx, resolvedNs, 'validate', notes, { prediction_id: predictionId, outcome }, ctx.allTools);
    await fireBridges(ctx, resolvedNs, 'validate', result, ctx.allTools);

    return result;
  },
};
