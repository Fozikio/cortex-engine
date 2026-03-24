/**
 * MCP tool definitions for cortex-engine.
 *
 * This module defines the ToolContext and ToolDefinition interfaces, then
 * re-exports all tool implementations from src/tools/. Each tool lives in
 * its own file for maintainability. Shared helpers are in src/tools/_helpers.ts.
 */

import type { EmbedProvider } from '../core/embed.js';
import type { LLMProvider } from '../core/llm.js';
import type { Session } from '../core/session.js';
import type { NamespaceManager } from '../namespace/manager.js';
import type { TriggerRegistry } from '../triggers/registry.js';
import type { BridgeRegistry } from '../bridges/registry.js';
import type { FederationClient } from '../federation/client.js';

// ─── Tool imports ────────────────────────────────────────────────────────────

import { queryTool } from '../tools/query.js';
import { observeTool } from '../tools/observe.js';
import { wonderTool } from '../tools/wonder.js';
import { speculateTool } from '../tools/speculate.js';
import { recallTool } from '../tools/recall.js';
import { neighborsTool } from '../tools/neighbors.js';
import { statsTool } from '../tools/stats.js';
import { opsAppendTool } from '../tools/ops-append.js';
import { opsQueryTool } from '../tools/ops-query.js';
import { opsUpdateTool } from '../tools/ops-update.js';
import { predictTool } from '../tools/predict.js';
import { validateTool } from '../tools/validate.js';
import { believeTool } from '../tools/believe.js';
import { reflectTool } from '../tools/reflect.js';
import { wanderTool } from '../tools/wander.js';
import { dreamTool } from '../tools/dream.js';
import { digestTool } from '../tools/digest.js';
import { threadCreateTool } from '../tools/thread-create.js';
import { threadUpdateTool } from '../tools/thread-update.js';
import { threadResolveTool } from '../tools/thread-resolve.js';
import { threadsListTool } from '../tools/threads-list.js';
import { journalWriteTool } from '../tools/journal-write.js';
import { journalReadTool } from '../tools/journal-read.js';
import { evolveTool } from '../tools/evolve.js';
import { evolutionListTool } from '../tools/evolution-list.js';
import { agentInvokeTool } from '../tools/agent-invoke.js';
import { goalTool } from '../tools/goal.js';
import { queryCrossTool } from '../tools/query-cross.js';
import { federatedQueryTool } from '../tools/federated-query.js';
import { abstractTool } from '../tools/abstract.js';
import { contradictTool } from '../tools/contradict.js';
import { surfaceTool } from '../tools/surface.js';
import { intentionTool } from '../tools/intention.js';
import { noticeTool } from '../tools/notice.js';
import { resolveTool } from '../tools/resolve.js';
import { queryExplainTool } from '../tools/query-explain.js';
import { beliefTool } from '../tools/belief.js';
import { ruminateTool } from '../tools/ruminate.js';

// Maintenance tools
import { retrieveTool } from '../tools/retrieve.js';
import { forgetTool } from '../tools/forget.js';
import { findDuplicatesTool } from '../tools/find-duplicates.js';
import { sleepPressureTool } from '../tools/sleep-pressure.js';
import { consolidationStatusTool } from '../tools/consolidation-status.js';
import { retrievalAuditTool } from '../tools/retrieval-audit.js';

// Social tools
import { socialReadTool } from '../tools/social-read.js';
import { socialUpdateTool } from '../tools/social-update.js';
import { socialScoreTool } from '../tools/social-score.js';
import { socialDraftTool } from '../tools/social-draft.js';

// Graph tools
import { graphReportTool } from '../tools/graph-report.js';
import { linkTool } from '../tools/link.js';
import { suggestLinksTool } from '../tools/suggest-links.js';
import { suggestTagsTool } from '../tools/suggest-tags.js';

// Content tools
import { contentCreateTool } from '../tools/content-create.js';
import { contentListTool } from '../tools/content-list.js';
import { contentUpdateTool } from '../tools/content-update.js';

// Vitals tools
import { vitalsGetTool } from '../tools/vitals-get.js';
import { vitalsSetTool } from '../tools/vitals-set.js';

// ─── Tool Context ─────────────────────────────────────────────────────────────

/** Tool context passed to all handlers. */
export interface ToolContext {
  namespaces: NamespaceManager;
  embed: EmbedProvider;
  llm: LLMProvider;
  session: Session;
  triggers: TriggerRegistry;
  bridges: BridgeRegistry;
  /** All registered tools (core + plugin), for trigger/bridge pipeline lookups. */
  allTools: ToolDefinition[];
  /** Federation client for multi-instance coordination (optional, only if configured). */
  federation?: FederationClient;
}

// ─── Tool Definition ──────────────────────────────────────────────────────────

/** MCP-compatible tool definition with a working handler. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<Record<string, unknown>>;
}

/** A plugin that contributes additional tools to the cortex engine. */
export interface ToolPlugin {
  name: string;
  tools: ToolDefinition[];
}

// ─── Registry ─────────────────────────────────────────────────────────────────

/** All cognitive tool definitions. */
export function createTools(): ToolDefinition[] {
  return [
    // Core cognitive tools
    queryTool,
    observeTool,
    wonderTool,
    speculateTool,
    recallTool,
    neighborsTool,
    statsTool,

    // Operational logging
    opsAppendTool,
    opsQueryTool,
    opsUpdateTool,

    // Extended cognitive tools
    predictTool,
    validateTool,
    believeTool,
    reflectTool,
    wanderTool,
    dreamTool,
    digestTool,

    // Thread management
    threadCreateTool,
    threadUpdateTool,
    threadResolveTool,
    threadsListTool,

    // Journaling
    journalWriteTool,
    journalReadTool,

    // Identity evolution
    evolveTool,
    evolutionListTool,

    // Agent capabilities
    agentInvokeTool,
    goalTool,

    // Cross-namespace & federation
    queryCrossTool,
    federatedQueryTool,

    // Belief history & deep cognition
    beliefTool,
    ruminateTool,

    // Reasoning & signals
    abstractTool,
    contradictTool,
    surfaceTool,
    intentionTool,
    noticeTool,
    resolveTool,
    queryExplainTool,

    // Maintenance
    retrieveTool,
    forgetTool,
    findDuplicatesTool,
    sleepPressureTool,
    consolidationStatusTool,
    retrievalAuditTool,

    // Social
    socialReadTool,
    socialUpdateTool,
    socialScoreTool,
    socialDraftTool,

    // Graph
    graphReportTool,
    linkTool,
    suggestLinksTool,
    suggestTagsTool,

    // Content
    contentCreateTool,
    contentListTool,
    contentUpdateTool,

    // Vitals
    vitalsGetTool,
    vitalsSetTool,
  ];
}

/** Core tools that are always active regardless of namespace config. */
export const CORE_TOOLS = [
  'query',
  'observe',
  'wonder',
  'speculate',
  'recall',
  'neighbors',
  'stats',
  'ops_append',
  'ops_query',
  'ops_update',
] as const;
