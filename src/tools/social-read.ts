/**
 * social_read — read current social cognition model.
 *
 * Returns the inferred interaction signal state built from sessions,
 * Discord, Reddit, and other interaction sources.
 */

import type { ToolDefinition, ToolContext } from '../mcp/tools.js';

const COLLECTION = 'social_signals';
const SIGNALS_DOC_ID = 'current';

export const socialReadTool: ToolDefinition = {
  name: 'social_read',
  category: 'social',
  description: 'Returns the current social cognition model — inferred interaction patterns aggregated from session/Discord/Reddit sources.',
  whenToUse: 'You want to inspect the agent\'s current model of its social dynamics.',
  doNotUse: 'You want to record a new social observation (use social_update) or score a specific signal (use social_score).',
  inputSchema: {
    type: 'object',
    properties: {
      namespace: { type: 'string', description: 'Namespace (defaults to default)' },
    },
  },

  async handler(args: Record<string, unknown>, ctx: ToolContext): Promise<Record<string, unknown>> {
    const namespace = typeof args['namespace'] === 'string' ? args['namespace'] : undefined;
    const store = ctx.namespaces.getStore(namespace);

    const doc = await store.get(COLLECTION, SIGNALS_DOC_ID);

    if (!doc) {
      return {
        session_energy: 0.5,
        engagement_depth: 0.5,
        topic_mode: 'unclear',
        last_session_type: 'unknown',
        last_updated: null,
        recent_observations: [],
        notes: '(no social signals recorded yet)',
      };
    }

    const rawObservations = Array.isArray(doc['raw_observations'])
      ? doc['raw_observations'] as Record<string, unknown>[]
      : [];

    return {
      session_energy: typeof doc['session_energy'] === 'number' ? doc['session_energy'] : 0.5,
      engagement_depth: typeof doc['engagement_depth'] === 'number' ? doc['engagement_depth'] : 0.5,
      topic_mode: typeof doc['topic_mode'] === 'string' ? doc['topic_mode'] : 'unclear',
      last_session_type: typeof doc['last_session_type'] === 'string' ? doc['last_session_type'] : 'unknown',
      last_updated: typeof doc['last_updated'] === 'string' ? doc['last_updated'] : null,
      recent_observations: rawObservations.slice(0, 10),
      notes: typeof doc['notes'] === 'string' ? doc['notes'] : '(no pattern notes yet)',
    };
  },
};
