/**
 * link — manually create a typed edge between two concepts.
 *
 * Dream consolidation builds edges automatically from co-occurring observations.
 * This tool lets you make explicit connections you've reasoned to directly —
 * "this exemplifies that", "these are in tension", etc.
 */

import type { ToolDefinition, ToolContext } from '../mcp/tools.js';
import type { EdgeRelation } from '../core/types.js';

const EDGES_COLLECTION = 'edges';

const VALID_RELATIONS: EdgeRelation[] = [
  'extends', 'refines', 'contradicts', 'tensions-with',
  'questions', 'supports', 'exemplifies', 'caused', 'related',
];

export const linkTool: ToolDefinition = {
  name: 'link',
  description:
    "Manually create a typed relationship edge between two concepts. Use for connections you've reasoned to explicitly rather than waiting for dream consolidation.",
  inputSchema: {
    type: 'object',
    properties: {
      source_id: { type: 'string', description: 'ID of the source concept' },
      target_id: { type: 'string', description: 'ID of the target concept' },
      relation: {
        type: 'string',
        enum: VALID_RELATIONS as unknown as string[],
        description:
          'Relationship type: extends, refines, contradicts, tensions-with, questions, supports, exemplifies, caused, related',
      },
      evidence: { type: 'string', description: 'Why you believe this relationship exists' },
      weight: { type: 'number', description: 'Edge strength 0.1-1.0 (default: 0.7)' },
      namespace: { type: 'string', description: 'Namespace (defaults to default)' },
    },
    required: ['source_id', 'target_id', 'relation'],
  },

  async handler(args: Record<string, unknown>, ctx: ToolContext): Promise<Record<string, unknown>> {
    const sourceId = typeof args['source_id'] === 'string' ? args['source_id'] : '';
    const targetId = typeof args['target_id'] === 'string' ? args['target_id'] : '';
    const relation = typeof args['relation'] === 'string' ? args['relation'] : 'related';
    const evidence = typeof args['evidence'] === 'string' ? args['evidence'] : 'Manually linked';
    const weight = typeof args['weight'] === 'number' ? Math.min(1, Math.max(0.1, args['weight'])) : 0.7;
    const namespace = typeof args['namespace'] === 'string' ? args['namespace'] : undefined;

    if (!sourceId || !targetId) return { error: 'source_id and target_id required' };
    if (!VALID_RELATIONS.includes(relation as EdgeRelation)) {
      return { error: `Invalid relation. Use one of: ${VALID_RELATIONS.join(', ')}` };
    }

    const store = ctx.namespaces.getStore(namespace);

    // Verify both concepts exist
    const [source, target] = await Promise.all([
      store.getMemory(sourceId),
      store.getMemory(targetId),
    ]);

    if (!source) return { error: `Source concept not found: ${sourceId}` };
    if (!target) return { error: `Target concept not found: ${targetId}` };

    // Check for duplicate edge
    const existing = await store.query(EDGES_COLLECTION, [
      { field: 'source_id', op: '==', value: sourceId },
      { field: 'target_id', op: '==', value: targetId },
      { field: 'relation', op: '==', value: relation },
    ], { limit: 1 });

    if (existing.length > 0) {
      return {
        already_exists: true,
        edge_id: typeof existing[0]['id'] === 'string' ? existing[0]['id'] : null,
        source: source.name,
        target: target.name,
        relation,
      };
    }

    const now = new Date().toISOString();
    const edgeId = await store.putEdge({
      source_id: sourceId,
      target_id: targetId,
      relation: relation as EdgeRelation,
      weight,
      evidence,
      created_at: new Date(now),
    });

    return {
      edge_id: edgeId,
      source: source.name,
      target: target.name,
      relation,
      weight,
      evidence,
    };
  },
};
