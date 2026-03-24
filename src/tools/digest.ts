/**
 * digest — ingest a document, extracting facts as observations and generating reflections.
 */

import type { ToolDefinition, ToolContext } from '../mcp/tools.js';
import type { CortexStore } from '../core/store.js';
import { str, optStr, optNum, fireTriggers, fireBridges } from './_helpers.js';
import { digestDocument } from '../engines/digest.js';

export const digestTool: ToolDefinition = {
  name: 'digest',
  description: 'Ingest a document — extracts facts as observations and generates reflections. Use for batch learning from files, plans, articles, or any content worth remembering.',
  inputSchema: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'The document content to digest (markdown, with or without frontmatter)' },
      source_file: { type: 'string', description: 'Source file path for provenance tracking' },
      pipeline: {
        type: 'array',
        items: { type: 'string' },
        description: 'Pipeline steps to run (default: ["observe", "reflect"])',
      },
      namespace: { type: 'string', description: 'Target namespace (defaults to default)' },
      salience: { type: 'number', description: 'Salience override 0.0-1.0 (default: auto-detect)' },
    },
    required: ['content'],
  },
  async handler(args: Record<string, unknown>, ctx: ToolContext) {
    const content = str(args, 'content');
    const sourceFile = optStr(args, 'source_file');
    const namespace = optStr(args, 'namespace');
    const salience = args['salience'] !== undefined ? optNum(args, 'salience', 5) : undefined;
    const rawPipeline = args['pipeline'];
    const pipeline = Array.isArray(rawPipeline)
      ? (rawPipeline as unknown[]).filter((s): s is string => typeof s === 'string')
      : undefined;

    const store: CortexStore = ctx.namespaces.getStore(namespace);
    const resolvedNs = namespace ?? ctx.namespaces.getDefaultNamespace();

    const result = await digestDocument(content, store, ctx.embed, ctx.llm, {
      pipeline,
      namespace: resolvedNs,
      source_file: sourceFile,
      salience,
    });

    await fireTriggers(ctx, resolvedNs, 'observe', content, { observation_ids: result.observation_ids }, ctx.allTools);
    await fireBridges(ctx, resolvedNs, 'observe', { observation_ids: result.observation_ids, source_file: sourceFile }, ctx.allTools);

    return {
      namespace: resolvedNs,
      source_file: sourceFile ?? '',
      observation_ids: result.observation_ids,
      memories_linked: result.memories_linked,
      insights: result.insights,
      pipeline_executed: result.pipeline_executed,
      processed_at: result.processed_at.toISOString(),
      duration_ms: result.duration_ms,
    };
  },
};
