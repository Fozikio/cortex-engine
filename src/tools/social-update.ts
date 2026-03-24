/**
 * social_update — log a social signal observation.
 *
 * Call when you've observed something notable about an interaction —
 * a pattern, an energy shift, an unusual engagement.
 */

import type { ToolDefinition, ToolContext } from '../mcp/tools.js';

const COLLECTION = 'social_signals';
const SIGNALS_DOC_ID = 'current';

const VALID_TOPIC_MODES = ['operational', 'creative', 'reflective', 'unclear'] as const;

export const socialUpdateTool: ToolDefinition = {
  name: 'social_update',
  description:
    'Log a social signal observation or update pattern notes. Call when you notice something about an interaction — energy, mode, engagement. Source required (interactive/discord/reddit/cron).',
  inputSchema: {
    type: 'object',
    properties: {
      source: {
        type: 'string',
        description: 'Where this signal came from: interactive, discord, reddit, cron, other',
      },
      observation: {
        type: 'string',
        description: 'What you observed (free text)',
      },
      session_energy: { type: 'number', description: 'Inferred energy level 0-1 (optional)' },
      engagement_depth: { type: 'number', description: 'Inferred engagement depth 0-1 (optional)' },
      topic_mode: {
        type: 'string',
        enum: ['operational', 'creative', 'reflective', 'unclear'],
        description: 'Inferred topic mode (optional)',
      },
      notes: {
        type: 'string',
        description: 'Update pattern reflection notes (replaces existing notes)',
      },
      namespace: { type: 'string', description: 'Namespace (defaults to default)' },
    },
    required: ['source', 'observation'],
  },

  async handler(args: Record<string, unknown>, ctx: ToolContext): Promise<Record<string, unknown>> {
    const source = typeof args['source'] === 'string' ? args['source'] : 'unknown';
    const observation = typeof args['observation'] === 'string' ? args['observation'] : '';
    if (!observation) return { error: 'observation is required' };

    const namespace = typeof args['namespace'] === 'string' ? args['namespace'] : undefined;
    const store = ctx.namespaces.getStore(namespace);
    const now = new Date().toISOString();

    // Read existing doc or start fresh
    const existing = await store.get(COLLECTION, SIGNALS_DOC_ID);

    const sessionEnergy =
      typeof args['session_energy'] === 'number' ? args['session_energy'] : null;
    const engagementDepth =
      typeof args['engagement_depth'] === 'number' ? args['engagement_depth'] : null;
    const topicMode =
      typeof args['topic_mode'] === 'string' &&
      (VALID_TOPIC_MODES as readonly string[]).includes(args['topic_mode'])
        ? args['topic_mode']
        : null;

    // Build the observation entry
    const observationEntry: Record<string, unknown> = {
      source,
      text: observation,
      timestamp: now,
    };
    if (sessionEnergy !== null) observationEntry['session_energy'] = sessionEnergy;
    if (engagementDepth !== null) observationEntry['engagement_depth'] = engagementDepth;
    if (topicMode !== null) observationEntry['topic_mode'] = topicMode;

    // Build updated document
    const rawObservations = existing && Array.isArray(existing['raw_observations'])
      ? existing['raw_observations'] as Record<string, unknown>[]
      : [];

    // Prepend new observation, cap at 100
    const updatedObservations = [observationEntry, ...rawObservations].slice(0, 100);

    const updatedDoc: Record<string, unknown> = {
      session_energy: sessionEnergy ?? (existing ? existing['session_energy'] : 0.5),
      engagement_depth: engagementDepth ?? (existing ? existing['engagement_depth'] : 0.5),
      topic_mode: topicMode ?? (existing ? existing['topic_mode'] : 'unclear'),
      last_session_type: source === 'interactive' ? 'interactive' : source === 'cron' ? 'cron' : (existing ? existing['last_session_type'] : 'unknown'),
      last_updated: now,
      raw_observations: updatedObservations,
      notes: typeof args['notes'] === 'string' && args['notes'].trim()
        ? args['notes']
        : (existing && typeof existing['notes'] === 'string' ? existing['notes'] : ''),
    };

    if (existing) {
      await store.update(COLLECTION, SIGNALS_DOC_ID, updatedDoc);
    } else {
      updatedDoc['id'] = SIGNALS_DOC_ID;
      await store.put(COLLECTION, updatedDoc);
    }

    return {
      logged: observation,
      source,
      current_state: {
        session_energy: updatedDoc['session_energy'],
        engagement_depth: updatedDoc['engagement_depth'],
        topic_mode: updatedDoc['topic_mode'],
      },
    };
  },
};
