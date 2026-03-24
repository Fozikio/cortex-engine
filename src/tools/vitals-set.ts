/**
 * vitals_set — update a single vital dimension.
 */

import type { ToolDefinition, ToolContext } from '../mcp/tools.js';

const COLLECTION = 'vitals';

type VitalDimension = 'curiosity' | 'connection' | 'confidence' | 'creative_energy' | 'frustration';

const VALID_DIMENSIONS: VitalDimension[] = [
  'curiosity', 'connection', 'confidence', 'creative_energy', 'frustration',
];

export const vitalsSetTool: ToolDefinition = {
  name: 'vitals_set',
  description: 'Update a single vital dimension value (0.0-1.0).',
  inputSchema: {
    type: 'object',
    properties: {
      dimension: {
        type: 'string',
        enum: VALID_DIMENSIONS as unknown as string[],
        description: 'Which vital to update',
      },
      value: { type: 'number', description: 'New value 0.0-1.0' },
      note: { type: 'string', description: 'Optional note explaining the change' },
      namespace: { type: 'string', description: 'Namespace (defaults to default)' },
    },
    required: ['dimension', 'value'],
  },

  async handler(args: Record<string, unknown>, ctx: ToolContext): Promise<Record<string, unknown>> {
    const dimension = typeof args['dimension'] === 'string' ? args['dimension'] : '';
    const rawValue = typeof args['value'] === 'number' ? args['value'] : NaN;
    const note = typeof args['note'] === 'string' ? args['note'] : '';
    const namespace = typeof args['namespace'] === 'string' ? args['namespace'] : undefined;

    if (!VALID_DIMENSIONS.includes(dimension as VitalDimension)) {
      return { error: `Invalid dimension: ${dimension}. Must be one of: ${VALID_DIMENSIONS.join(', ')}` };
    }

    if (isNaN(rawValue) || rawValue < 0 || rawValue > 1) {
      return { error: `Value must be between 0.0 and 1.0, got: ${rawValue}` };
    }

    const clamped = Math.min(1.0, Math.max(0.0, rawValue));
    const store = ctx.namespaces.getStore(namespace);
    const now = new Date().toISOString();

    const existing = await store.get(COLLECTION, dimension);

    const updated: Record<string, unknown> = {
      value: clamped,
      baseline: existing && typeof existing['baseline'] === 'number' ? existing['baseline'] : 0.5,
      decay_rate: existing && typeof existing['decay_rate'] === 'number' ? existing['decay_rate'] : 0.05,
      note,
      last_updated: now,
    };

    if (existing) {
      await store.update(COLLECTION, dimension, updated);
    } else {
      await store.put(COLLECTION, { ...updated, _id: dimension });
    }

    return {
      action: 'updated',
      dimension,
      value: Math.round(clamped * 100) / 100,
      note,
    };
  },
};
