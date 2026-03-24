/**
 * notice — fast-path observation without embedding.
 * Stored immediately, embedded during the next embed-pending job.
 */

import type { ToolDefinition } from '../mcp/tools.js';
import { str, optStr, optNum } from './_helpers.js';

const OBSERVATIONS_COLLECTION = 'observations';

export const noticeTool: ToolDefinition = {
  name: 'notice',
  description:
    'Store an observation without embedding (fast path). Embedding happens during the next embed-pending job. Use for low-latency logging.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The observation text' },
      file: { type: 'string', description: 'Source file path' },
      salience: { type: 'number', description: 'Importance 0.0-1.0 (default: 0.3)' },
      namespace: { type: 'string', description: 'Namespace (defaults to default)' },
    },
    required: ['text'],
  },

  async handler(args, ctx) {
    const text = str(args, 'text');
    const file = optStr(args, 'file') ?? 'unknown';
    const salience = optNum(args, 'salience', 0.3);
    const namespace = optStr(args, 'namespace');

    const store = ctx.namespaces.getStore(namespace);
    const now = new Date().toISOString();

    const id = await store.put(OBSERVATIONS_COLLECTION, {
      content: text,
      source_file: file,
      source_section: '',
      salience,
      processed: false,
      prediction_error: null,
      created_at: now,
      embedding: null,
      keywords: [],
    });

    return { action: 'noticed', observation_id: id };
  },
};
