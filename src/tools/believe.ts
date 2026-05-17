/**
 * believe — update what you believe about an existing memory.
 */

import type { ToolDefinition, ToolContext } from '../mcp/tools.js';
import { str, optStr, fireTriggers, fireBridges } from './_helpers.js';

export const believeTool: ToolDefinition = {
  name: 'believe',
  category: 'beliefs',
  description: 'Records a belief revision on an existing memory — logs the previous definition with a reason and updates the live memory. Returns the belief history entry id.',
  whenToUse: 'Your understanding of an existing concept has changed and you want the change tracked over time.',
  doNotUse: 'You are recording a brand-new fact (use observe) or just viewing past beliefs (use belief).',
  inputSchema: {
    type: 'object',
    properties: {
      concept_id: { type: 'string', description: 'ID of the memory/concept being revised' },
      new_definition: { type: 'string', description: 'The updated definition or belief' },
      reason: { type: 'string', description: 'Why this belief is changing' },
      namespace: { type: 'string', description: 'Namespace (defaults to default namespace)' },
    },
    required: ['concept_id', 'new_definition', 'reason'],
  },
  async handler(args: Record<string, unknown>, ctx: ToolContext) {
    const conceptId = str(args, 'concept_id');
    const newDefinition = str(args, 'new_definition');
    const reason = str(args, 'reason');
    const namespace = optStr(args, 'namespace');

    const store = ctx.namespaces.getStore(namespace);

    const memory = await store.getMemory(conceptId);
    if (!memory) {
      return { error: `Memory not found: ${conceptId}`, concept_id: conceptId };
    }

    const oldDefinition = memory.definition;

    // Embed BEFORE the transaction — LLM/network calls must never happen
    // inside withTransaction (they hold the writer mutex open). See
    // docs/concurrency.md.
    const newEmbedding = await ctx.embed.embed(newDefinition);

    // Atomic: belief log + memory update commit together so we never end up
    // with a belief entry that points at a memory that was never updated,
    // or a memory whose history is missing the revision row.
    const beliefId = await store.withTransaction(async (txn) => {
      const id = await txn.putBelief({
        concept_id: conceptId,
        old_definition: oldDefinition,
        new_definition: newDefinition,
        reason,
        changed_at: new Date(),
      });
      await txn.updateMemory(conceptId, {
        definition: newDefinition,
        embedding: newEmbedding,
        updated_at: new Date(),
      });
      return id;
    });

    const result = {
      belief_id: beliefId,
      concept_id: conceptId,
      concept_name: memory.name,
      old_definition: oldDefinition,
      new_definition: newDefinition,
      reason,
      namespace: namespace ?? ctx.namespaces.getDefaultNamespace(),
    };

    const resolvedNs = namespace ?? ctx.namespaces.getDefaultNamespace();
    await fireTriggers(ctx, resolvedNs, 'believe', reason, { concept_id: conceptId, belief_id: beliefId }, ctx.allTools);
    await fireBridges(ctx, resolvedNs, 'believe', result, ctx.allTools);

    return result;
  },
};
