/**
 * feedback — close the retrieval loop with asymmetric trust scoring.
 *
 * Pattern borrowed from Hermes Agent's holographic memory provider: helpful
 * retrievals nudge trust up gently (+0.05), unhelpful ones cut it harder
 * (-0.10). Asymmetry matters — one bad retrieval should cost more than one
 * good retrieval earns, so polluted memories decay out of top ranks quickly.
 *
 * Confidence is the trust signal here: it already feeds composite ranking
 * and consolidation decisions. Every event is also logged to feedback_log
 * so retrieval_audit can correlate feedback with retrieval traces.
 */

import type { ToolDefinition } from '../mcp/tools.js';
import { str, optStr } from './_helpers.js';

const HELPFUL_DELTA = 0.05;
const UNHELPFUL_DELTA = -0.10;
const CONFIDENCE_FLOOR = 0.05;
const CONFIDENCE_CEIL = 1.0;

export const feedbackTool: ToolDefinition = {
  name: 'feedback',
  category: 'memory',
  description: 'Records whether a retrieved memory was actually helpful, adjusting its confidence asymmetrically (+0.05 helpful / -0.10 unhelpful) and logging the event for retrieval audits.',
  whenToUse: 'You just acted on a retrieved memory and know whether it was accurate and useful — close the loop so future ranking improves.',
  doNotUse: 'You want to correct a memory definition (use believe) or remove it entirely (use forget).',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Memory id the feedback applies to' },
      helpful: { type: 'boolean', description: 'true if the memory was accurate and useful, false if wrong, stale, or misleading' },
      note: { type: 'string', description: 'Optional context — what made it helpful or unhelpful' },
      namespace: { type: 'string', description: 'Memory namespace (defaults to default)' },
    },
    required: ['id', 'helpful'],
  },
  async handler(args, ctx) {
    const id = str(args, 'id');
    const helpful = args['helpful'];
    if (typeof helpful !== 'boolean') {
      throw new Error('Missing required boolean argument: helpful');
    }
    const note = optStr(args, 'note');
    const namespace = optStr(args, 'namespace');

    const store = ctx.namespaces.getStore(namespace);

    const memory = await store.getMemory(id);
    if (!memory) {
      return { error: `Memory not found: ${id}` };
    }

    const delta = helpful ? HELPFUL_DELTA : UNHELPFUL_DELTA;
    const confidenceAfter = Math.max(
      CONFIDENCE_FLOOR,
      Math.min(CONFIDENCE_CEIL, memory.confidence + delta),
    );
    const now = new Date();

    await store.withTransaction(async (txn) => {
      await txn.updateMemory(id, { confidence: confidenceAfter, updated_at: now });
      // Helpful feedback is a successful retrieval — reinforce access stats.
      // Unhelpful feedback deliberately does NOT touch: a failed retrieval
      // should not look like recent use to the consolidation pipeline.
      if (helpful) {
        await txn.touchMemory(id, {});
      }
      await txn.put('feedback_log', {
        memory_id: id,
        memory_name: memory.name,
        helpful,
        note: note ?? null,
        confidence_before: memory.confidence,
        confidence_after: confidenceAfter,
        timestamp: now.toISOString(),
      });
    });

    return {
      memory_id: id,
      name: memory.name,
      helpful,
      confidence_before: memory.confidence,
      confidence_after: confidenceAfter,
    };
  },
};
