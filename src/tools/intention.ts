/**
 * intention — prospective memory system.
 * Set reminders that surface when a trigger condition occurs.
 */

import type { ToolDefinition } from '../mcp/tools.js';
import { optStr } from './_helpers.js';

const INTENTIONS_COLLECTION = 'intentions';

export const intentionTool: ToolDefinition = {
  name: 'intention',
  description:
    'Prospective memory — set a reminder to surface when a trigger condition occurs. Example: trigger="when user mentions X", content="remind about Y". Use action=list to show pending, action=fire to mark as fired, action=cancel to delete.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['set', 'list', 'fire', 'cancel'],
        description: 'set=create new intention, list=show pending, fire=mark as fired, cancel=delete',
      },
      trigger: { type: 'string', description: 'When this should surface (for action=set)' },
      content: { type: 'string', description: 'What to remind about (for action=set)' },
      expires_days: { type: 'number', description: 'Days until expiry — omit for no expiry (for action=set)' },
      id: { type: 'string', description: 'Intention ID (for action=fire or cancel)' },
      namespace: { type: 'string', description: 'Namespace (defaults to default)' },
    },
    required: ['action'],
  },

  async handler(args, ctx) {
    const action = typeof args['action'] === 'string' ? args['action'] : '';
    const namespace = optStr(args, 'namespace');
    const store = ctx.namespaces.getStore(namespace);
    const now = new Date().toISOString();

    if (action === 'set') {
      const trigger = typeof args['trigger'] === 'string' ? args['trigger'] : '';
      const content = typeof args['content'] === 'string' ? args['content'] : '';
      if (!trigger || !content) {
        return { error: 'trigger and content are required' };
      }

      const expiresAt = typeof args['expires_days'] === 'number'
        ? new Date(Date.now() + args['expires_days'] * 86400_000).toISOString()
        : null;

      const id = await store.put(INTENTIONS_COLLECTION, {
        trigger,
        content,
        created_at: now,
        expires_at: expiresAt,
        fired: false,
        fire_count: 0,
      });

      return { action: 'set', id, trigger, content };
    }

    if (action === 'list') {
      const results = await store.query(
        INTENTIONS_COLLECTION,
        [{ field: 'fired', op: '==', value: false }],
        { limit: 20, orderBy: 'created_at', orderDir: 'desc' },
      );

      const nowMs = Date.now();
      const pending = results
        .filter((doc) => {
          const expiresAt = typeof doc['expires_at'] === 'string' ? doc['expires_at'] : null;
          return !expiresAt || new Date(expiresAt).getTime() > nowMs;
        })
        .map((doc) => ({
          id: typeof doc['id'] === 'string' ? doc['id'] : '',
          trigger: typeof doc['trigger'] === 'string' ? doc['trigger'] : '',
          content: typeof doc['content'] === 'string' ? doc['content'] : '',
          fire_count: typeof doc['fire_count'] === 'number' ? doc['fire_count'] : 0,
          created_at: typeof doc['created_at'] === 'string' ? doc['created_at'] : '',
        }));

      return { pending_count: pending.length, intentions: pending };
    }

    if (action === 'fire') {
      const id = optStr(args, 'id') ?? '';
      if (!id) return { error: 'id is required' };
      await store.update(INTENTIONS_COLLECTION, id, {
        fired: true,
        fire_count: 1,
      });
      return { action: 'fired', id };
    }

    if (action === 'cancel') {
      const id = optStr(args, 'id') ?? '';
      if (!id) return { error: 'id is required' };
      await store.update(INTENTIONS_COLLECTION, id, {
        fired: true,
        cancelled: true,
      });
      return { action: 'cancelled', id };
    }

    return { error: `Unknown action: ${action}` };
  },
};
