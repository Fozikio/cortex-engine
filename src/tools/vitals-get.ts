/**
 * vitals_get — read all current vitals with behavioral trigger evaluation.
 *
 * Vitals are stored in a 'vitals' collection with dimensions:
 * curiosity, connection, confidence, creative_energy, frustration.
 * Each has value, baseline, decay_rate, note, last_updated.
 * Trigger evaluation checks thresholds and returns action recommendations.
 */

import type { ToolDefinition, ToolContext } from '../mcp/tools.js';

const COLLECTION = 'vitals';

type VitalDimension = 'curiosity' | 'connection' | 'confidence' | 'creative_energy' | 'frustration';

const VITAL_DIMENSIONS: VitalDimension[] = [
  'curiosity', 'connection', 'confidence', 'creative_energy', 'frustration',
];

interface VitalDoc {
  value: number;
  baseline: number;
  decay_rate: number;
  note: string;
  last_updated: string;
}

const DEFAULT_VITALS: Record<VitalDimension, Omit<VitalDoc, 'last_updated'>> = {
  curiosity:       { value: 0.7, baseline: 0.6, decay_rate: 0.05, note: '' },
  connection:      { value: 0.5, baseline: 0.4, decay_rate: 0.04, note: '' },
  confidence:      { value: 0.6, baseline: 0.5, decay_rate: 0.03, note: '' },
  creative_energy: { value: 0.6, baseline: 0.5, decay_rate: 0.06, note: '' },
  frustration:     { value: 0.2, baseline: 0.2, decay_rate: 0.08, note: '' },
};

interface VitalSignal {
  dimension: VitalDimension;
  value: number;
  trigger: string;
  action: string;
}

function evaluateTriggers(vitals: Record<VitalDimension, VitalDoc>): VitalSignal[] {
  const signals: VitalSignal[] = [];

  if (vitals.curiosity.value < 0.3) {
    signals.push({
      dimension: 'curiosity',
      value: vitals.curiosity.value,
      trigger: 'Low curiosity',
      action: 'Explore an open thread',
    });
  }

  if (vitals.connection.value < 0.2) {
    signals.push({
      dimension: 'connection',
      value: vitals.connection.value,
      trigger: 'Low connection',
      action: 'Check Discord #inbox',
    });
  }

  if (vitals.frustration.value > 0.7) {
    signals.push({
      dimension: 'frustration',
      value: vitals.frustration.value,
      trigger: 'High frustration',
      action: 'Step back — switch to reflection or creative work',
    });
  }

  if (vitals.creative_energy.value < 0.25) {
    signals.push({
      dimension: 'creative_energy',
      value: vitals.creative_energy.value,
      trigger: 'Low creative energy',
      action: 'Avoid generative tasks — review or organize instead',
    });
  }

  return signals;
}

export const vitalsGetTool: ToolDefinition = {
  name: 'vitals_get',
  description:
    'Read all current vitals (curiosity, connection, confidence, creative_energy, frustration) with behavioral trigger evaluation.',
  inputSchema: {
    type: 'object',
    properties: {
      namespace: { type: 'string', description: 'Namespace (defaults to default)' },
    },
  },

  async handler(args: Record<string, unknown>, ctx: ToolContext): Promise<Record<string, unknown>> {
    const namespace = typeof args['namespace'] === 'string' ? args['namespace'] : undefined;
    const store = ctx.namespaces.getStore(namespace);
    const now = new Date().toISOString();

    const vitals = {} as Record<VitalDimension, VitalDoc>;

    for (const dim of VITAL_DIMENSIONS) {
      const doc = await store.get(COLLECTION, dim);

      if (!doc) {
        const defaults: VitalDoc = {
          ...DEFAULT_VITALS[dim],
          last_updated: now,
        };
        await store.put(COLLECTION, { ...defaults, _id: dim });
        vitals[dim] = defaults;
      } else {
        vitals[dim] = {
          value: typeof doc['value'] === 'number' ? doc['value'] : 0,
          baseline: typeof doc['baseline'] === 'number' ? doc['baseline'] : 0,
          decay_rate: typeof doc['decay_rate'] === 'number' ? doc['decay_rate'] : 0,
          note: typeof doc['note'] === 'string' ? doc['note'] : '',
          last_updated: typeof doc['last_updated'] === 'string' ? doc['last_updated'] : now,
        };
      }
    }

    const triggers = evaluateTriggers(vitals);

    const summary = Object.fromEntries(
      Object.entries(vitals).map(([dim, v]) => [
        dim,
        {
          value: Math.round(v.value * 100) / 100,
          baseline: v.baseline,
          decay_rate: v.decay_rate,
          note: v.note,
          last_updated: v.last_updated,
        },
      ])
    );

    return {
      vitals: summary,
      triggers: triggers.map((t) => ({
        dimension: t.dimension,
        value: Math.round(t.value * 100) / 100,
        trigger: t.trigger,
        action: t.action,
      })),
    };
  },
};
