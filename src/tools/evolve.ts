/**
 * evolve — propose an identity evolution.
 */

import type { ToolDefinition, ToolContext } from '../mcp/tools.js';

const COLLECTION = 'evolutions';

const VALID_CONFIDENCE = ['high', 'medium', 'low'] as const;

export const evolveTool: ToolDefinition = {
  name: 'evolve',
  description:
    'Propose an identity evolution — a change in values, preferences, patterns, or beliefs. Creates a proposal that can be reviewed and applied.',
  inputSchema: {
    type: 'object',
    properties: {
      change: { type: 'string', description: 'What changed' },
      trigger: { type: 'string', description: 'What caused this' },
      from_value: { type: 'string', description: 'Previous state' },
      to_value: { type: 'string', description: 'New state' },
      confidence: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
        description: 'Confidence level. Default: medium',
      },
      dimension: {
        type: 'string',
        description: 'Part of identity (values, preferences, patterns, beliefs)',
      },
      session_ref: { type: 'string', description: 'Session date' },
      namespace: { type: 'string', description: 'Namespace (defaults to default)' },
    },
    required: ['change', 'trigger'],
  },

  async handler(args: Record<string, unknown>, ctx: ToolContext): Promise<Record<string, unknown>> {
    const change = typeof args['change'] === 'string' ? args['change'] : '';
    const trigger = typeof args['trigger'] === 'string' ? args['trigger'] : '';
    if (!change) return { error: 'change is required' };
    if (!trigger) return { error: 'trigger is required' };

    const confidence =
      typeof args['confidence'] === 'string' &&
      (VALID_CONFIDENCE as readonly string[]).includes(args['confidence'])
        ? args['confidence']
        : 'medium';

    const namespace = typeof args['namespace'] === 'string' ? args['namespace'] : undefined;
    const store = ctx.namespaces.getStore(namespace);
    const now = new Date().toISOString();

    const doc: Record<string, unknown> = {
      change,
      trigger,
      confidence,
      status: 'proposed',
      created_at: now,
    };

    if (typeof args['from_value'] === 'string') doc['from_value'] = args['from_value'];
    if (typeof args['to_value'] === 'string') doc['to_value'] = args['to_value'];
    if (typeof args['dimension'] === 'string') doc['dimension'] = args['dimension'];
    if (typeof args['session_ref'] === 'string') doc['session_ref'] = args['session_ref'];

    const id = await store.put(COLLECTION, doc);

    return { id, change, status: 'proposed', confidence };
  },
};
