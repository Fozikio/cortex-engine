/**
 * contradict — record a contradiction between an observation and a belief or memory.
 * Creates a CONTRADICTION signal linking the observation to the concept.
 */

import type { ToolDefinition } from '../mcp/tools.js';
import { optStr } from './_helpers.js';

const OBSERVATIONS_COLLECTION = 'observations';
const BELIEFS_COLLECTION = 'beliefs';
const MEMORIES_COLLECTION = 'memories';
const SIGNALS_COLLECTION = 'signals';

export const contradictTool: ToolDefinition = {
  name: 'contradict',
  description:
    'Record a contradiction between an observation and a belief or memory. Creates a CONTRADICTION signal. Provide observation_id and exactly one of belief_id or memory_id.',
  inputSchema: {
    type: 'object',
    properties: {
      observation_id: { type: 'string', description: 'Observation document ID' },
      belief_id: { type: 'string', description: 'Belief document ID (concept_id will be used)' },
      memory_id: { type: 'string', description: 'Memory document ID' },
      note: { type: 'string', description: 'Optional note about the contradiction' },
      namespace: { type: 'string', description: 'Namespace (defaults to default)' },
    },
    required: ['observation_id'],
  },

  async handler(args, ctx) {
    const observationId = typeof args['observation_id'] === 'string' ? args['observation_id'] : '';
    const beliefId = optStr(args, 'belief_id');
    const memoryId = optStr(args, 'memory_id');
    const note = optStr(args, 'note') ?? '';
    const namespace = optStr(args, 'namespace');

    if (!observationId) {
      return { error: 'observation_id is required' };
    }

    const provided = [beliefId, memoryId].filter(Boolean);
    if (provided.length !== 1) {
      return { error: 'Provide exactly one of belief_id or memory_id.' };
    }

    const store = ctx.namespaces.getStore(namespace);

    const obsDoc = await store.get(OBSERVATIONS_COLLECTION, observationId);
    if (!obsDoc) {
      return { error: `Observation ${observationId} not found` };
    }
    const content = typeof obsDoc['content'] === 'string' ? obsDoc['content'] : '';
    const snippet = content.slice(0, 500);

    let conceptId: string;

    if (memoryId) {
      const memDoc = await store.get(MEMORIES_COLLECTION, memoryId);
      if (!memDoc) {
        return { error: `Memory ${memoryId} not found` };
      }
      conceptId = memoryId;
    } else {
      const beliefDoc = await store.get(BELIEFS_COLLECTION, beliefId!);
      if (!beliefDoc) {
        return { error: `Belief ${beliefId} not found` };
      }
      const docConceptId = typeof beliefDoc['concept_id'] === 'string' ? beliefDoc['concept_id'] : '';
      if (!docConceptId) {
        return { error: 'Belief document has no concept_id' };
      }
      conceptId = docConceptId;
    }

    const description = note
      ? `Observation: "${snippet}"\nNote: ${note}`
      : `Observation: "${snippet}"`;

    const now = new Date().toISOString();

    const signalId = await store.put(SIGNALS_COLLECTION, {
      type: 'CONTRADICTION',
      description,
      concept_ids: [conceptId],
      priority: 0.8,
      resolved: false,
      created_at: now,
      resolution_note: null,
      observation_id: observationId,
    });

    return { signal_id: signalId };
  },
};
