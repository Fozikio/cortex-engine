/**
 * evolution_resolve — transition an identity evolution out of `proposed`.
 *
 * Without this, `evolve` can only ever write `proposed` and nothing can write
 * the other three statuses `evolution_list` accepts — so `applied_at` is
 * structurally always null and the ledger grows without ever resolving.
 */

import type { ToolDefinition, ToolContext } from '../mcp/tools.js';

const COLLECTION = 'evolutions';

const VALID_STATUSES = ['applied', 'rejected', 'reverted'] as const;

export const evolutionResolveTool: ToolDefinition = {
  name: 'evolution_resolve',
  category: 'journal',
  description:
    'Transitions an identity evolution proposal to applied, rejected, or reverted, with an optional note. Stamps applied_at when applied. Returns the updated evolution.',
  whenToUse:
    'You have acted on a proposal from evolution_list — adopted the change, decided against it, or are undoing one you previously applied.',
  doNotUse:
    'You are recording a new identity change (use evolve) or reviewing what is pending (use evolution_list).',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Evolution proposal ID' },
      status: {
        type: 'string',
        enum: ['applied', 'rejected', 'reverted'],
        description:
          'applied = adopted into identity; rejected = declined; reverted = undoing a previously applied change',
      },
      note: {
        type: 'string',
        description: 'Why — what was adopted, or why it was declined/undone',
      },
      namespace: { type: 'string', description: 'Namespace (defaults to default)' },
    },
    required: ['id', 'status'],
  },

  async handler(args: Record<string, unknown>, ctx: ToolContext): Promise<Record<string, unknown>> {
    const id = typeof args['id'] === 'string' ? args['id'] : '';
    const status = typeof args['status'] === 'string' ? args['status'] : '';
    if (!id) return { error: 'id is required' };
    if (!status) return { error: 'status is required' };
    if (!(VALID_STATUSES as readonly string[]).includes(status)) {
      return { error: `status must be one of: ${VALID_STATUSES.join(', ')}` };
    }

    const namespace = typeof args['namespace'] === 'string' ? args['namespace'] : undefined;
    const store = ctx.namespaces.getStore(namespace);

    const existing = await store.get(COLLECTION, id);
    if (!existing) return { error: `Evolution not found: ${id}` };

    const previous = (existing['status'] as string | undefined) ?? 'proposed';

    if (previous === status) {
      return { error: `Evolution ${id} is already ${status}` };
    }

    // You cannot undo something that was never adopted. Without this guard the
    // ledger can record a revert with no corresponding apply, which reads as
    // history that never happened.
    if (status === 'reverted' && previous !== 'applied') {
      return {
        error: `Cannot revert an evolution that is ${previous} — only an applied evolution can be reverted`,
      };
    }

    const now = new Date().toISOString();

    const patch: Record<string, unknown> = {
      status,
      previous_status: previous,
      resolved_at: now,
      updated_at: now,
    };

    if (typeof args['note'] === 'string' && args['note']) patch['note'] = args['note'];

    // applied_at marks when the change entered identity, so it survives a later
    // revert as the historical record of when it had been in force.
    if (status === 'applied') patch['applied_at'] = now;

    await store.update(COLLECTION, id, patch);

    return {
      id,
      status,
      previous_status: previous,
      resolved_at: now,
      applied_at: status === 'applied' ? now : ((existing['applied_at'] as string | undefined) ?? null),
      note: (patch['note'] as string | undefined) ?? null,
    };
  },
};
