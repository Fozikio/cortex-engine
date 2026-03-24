/**
 * ops_append — log an operational breadcrumb with auto-expiry.
 */

import type { ToolDefinition } from '../mcp/tools.js';
import type { OpsEntryType } from '../core/types.js';
import { extractKeywords } from '../engines/keywords.js';
import { str, optStr } from './_helpers.js';

export const opsAppendTool: ToolDefinition = {
  name: 'ops_append',
  description: 'Log an operational breadcrumb — session notes, project milestones, decisions, or handoffs. Entries auto-expire after 30 days. Use the project parameter to group entries across sessions.',
  inputSchema: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'The operational log entry content' },
      type: { type: 'string', enum: ['log', 'instruction', 'handoff', 'milestone', 'decision'], description: 'Entry type (default: log)' },
      project: { type: 'string', description: 'Project name for per-project sub-logs' },
      namespace: { type: 'string', description: 'Namespace (defaults to default namespace)' },
    },
    required: ['content'],
  },
  async handler(args, ctx) {
    const content = str(args, 'content');
    const type = (optStr(args, 'type') ?? 'log') as OpsEntryType;
    const project = optStr(args, 'project') ?? null;
    const namespace = optStr(args, 'namespace');

    const store = ctx.namespaces.getStore(namespace);
    const provenance = ctx.session.getProvenance();
    const keywords = extractKeywords(content);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days

    const id = await store.appendOps({
      content,
      type,
      status: 'active',
      project,
      session_ref: provenance.model_id,
      keywords,
      created_at: now,
      updated_at: now,
      expires_at: expiresAt,
      provenance,
    });

    return {
      id,
      type,
      project,
      namespace: namespace ?? ctx.namespaces.getDefaultNamespace(),
      keywords,
    };
  },
};
