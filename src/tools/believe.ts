/**
 * believe — update what you believe about an existing memory.
 */

import type { ToolDefinition, ToolContext } from '../mcp/tools.js';
import { str, optStr, fireTriggers, fireBridges } from './_helpers.js';

export const believeTool: ToolDefinition = {
  name: 'believe',
  description: 'Update what you believe about an existing memory. Logs the previous definition, records why the belief changed, and updates the memory. Use when your understanding of a concept has changed — not for new observations.',
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

    // Log belief change
    const beliefId = await store.putBelief({
      concept_id: conceptId,
      old_definition: oldDefinition,
      new_definition: newDefinition,
      reason,
      changed_at: new Date(),
    });

    // Re-embed with new definition
    const newEmbedding = await ctx.embed.embed(newDefinition);

    // Update the memory
    await store.updateMemory(conceptId, {
      definition: newDefinition,
      embedding: newEmbedding,
      updated_at: new Date(),
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
