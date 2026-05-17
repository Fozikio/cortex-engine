/**
 * speculate — record a hypothesis or untested idea for future validation.
 */

import type { ToolDefinition } from '../mcp/tools.js';
import { extractKeywords } from '../engines/keywords.js';
import { str, optStr, optNum, fireTriggers, fireBridges } from './_helpers.js';

export const speculateTool: ToolDefinition = {
  name: 'speculate',
  category: 'memory',
  description: 'Records a hypothesis as a speculative observation, flagged so it is excluded from default query results until validated. Returns the new observation id.',
  whenToUse: 'You want to capture a "what if" idea or untested claim that should not yet be treated as fact.',
  doNotUse: 'You have a confirmed fact (use observe) or an open question (use wonder).',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The hypothesis (e.g. "Switching to sessions might reduce token overhead")' },
      namespace: { type: 'string', description: 'Target namespace (defaults to default)' },
      salience: { type: 'number', description: 'Importance score 0.0-1.0 (default: 0.5)' },
      basis: { type: 'string', description: 'What evidence or reasoning supports this hypothesis' },
    },
    required: ['text'],
  },
  async handler(args, ctx) {
    const text = str(args, 'text');
    const namespace = optStr(args, 'namespace');
    const salience = optNum(args, 'salience', 0.5);
    const basis = optStr(args, 'basis') ?? '';

    const store = ctx.namespaces.getStore(namespace);
    const provenance = ctx.session.getProvenance();
    const embedding = await ctx.embed.embed(text);
    const keywords = extractKeywords(text);

    const id = await store.putObservation({
      content: text,
      source_file: basis,
      source_section: 'speculate',
      salience,
      processed: false,
      prediction_error: null,
      created_at: new Date(),
      updated_at: new Date(),
      embedding,
      keywords,
      provenance,
      content_type: 'speculative',
    });

    const resolvedNs = namespace ?? ctx.namespaces.getDefaultNamespace();
    await fireTriggers(ctx, resolvedNs, 'speculate', text, { observation_id: id }, ctx.allTools);
    await fireBridges(ctx, resolvedNs, 'speculate', { id, namespace: resolvedNs }, ctx.allTools);

    return {
      id,
      content_type: 'speculative',
      namespace: resolvedNs,
      keywords,
      salience,
    };
  },
};
