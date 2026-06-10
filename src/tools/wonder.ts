/**
 * wonder — record an open question or curiosity for later exploration.
 */

import type { ToolDefinition } from '../mcp/tools.js';
import { extractKeywords } from '../engines/keywords.js';
import { str, optStr, optNum, fireTriggers, fireBridges } from './_helpers.js';

export const wonderTool: ToolDefinition = {
  name: 'wonder',
  category: 'memory',
  description: 'Records an open question as an interrogative observation, kept separate from factual memories so it does not pollute knowledge retrieval. Returns the new observation id.',
  whenToUse: 'You want to capture something you are curious about but have not resolved — a question worth revisiting.',
  doNotUse: 'You have a confirmed fact (use observe) or an untested hypothesis (use speculate).',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The question or curiosity (e.g. "Why does the sync daemon stall after 300k seconds?")' },
      namespace: { type: 'string', description: 'Target namespace (defaults to default)' },
      salience: { type: 'number', description: 'Importance score 0.0-1.0 (default: 0.5)' },
      context: { type: 'string', description: 'What prompted this question' },
    },
    required: ['text'],
  },
  async handler(args, ctx) {
    const text = str(args, 'text');
    const namespace = optStr(args, 'namespace');
    const salience = optNum(args, 'salience', 0.5);
    const contextText = optStr(args, 'context') ?? '';

    const store = ctx.namespaces.getStore(namespace);
    const provenance = ctx.session.getProvenance();
    const embedding = await ctx.embed.embed(text);
    const keywords = extractKeywords(text);

    const id = await store.putObservation({
      content: text,
      source_file: contextText,
      source_section: 'wonder',
      salience,
      processed: false,
      prediction_error: null,
      created_at: new Date(),
      updated_at: new Date(),
      embedding,
      keywords,
      provenance,
      content_type: 'interrogative',
    });

    const resolvedNs = namespace ?? ctx.namespaces.getDefaultNamespace();
    ctx.consolidator?.notifyObservation(resolvedNs);
    await fireTriggers(ctx, resolvedNs, 'wonder', text, { observation_id: id }, ctx.allTools);
    await fireBridges(ctx, resolvedNs, 'wonder', { id, namespace: resolvedNs }, ctx.allTools);

    return {
      id,
      content_type: 'interrogative',
      namespace: resolvedNs,
      keywords,
      salience,
    };
  },
};
