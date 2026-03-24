/**
 * Shared helpers for cortex-engine tool handlers.
 */

import type { ToolDefinition, ToolContext } from '../mcp/tools.js';
import type { Memory } from '../core/types.js';
import { executeIngestionPipeline } from '../triggers/pipeline.js';
import { checkBridges } from '../bridges/bridge.js';

// ─── Argument Parsers ─────────────────────────────────────────────────────────

export function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string') throw new Error(`Missing required string argument: ${key}`);
  return v;
}

export function optStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' ? v : undefined;
}

export function optNum(args: Record<string, unknown>, key: string, def: number): number {
  const v = args[key];
  return typeof v === 'number' ? v : def;
}

export function optBool(args: Record<string, unknown>, key: string, def: boolean): boolean {
  const v = args[key];
  return typeof v === 'boolean' ? v : def;
}

// ─── Event Helpers ───────────────────────────────────────────────────────────

/** Build a tool lookup function for ingestion pipeline execution. */
export function makeToolLookup(
  activeTools: ToolDefinition[],
  ctx: ToolContext,
): (name: string) => { name: string; handler: (args: Record<string, unknown>) => Promise<Record<string, unknown>> } | undefined {
  return (name: string) => {
    const tool = activeTools.find(t => t.name === name);
    if (!tool) return undefined;
    return { name: tool.name, handler: (args) => tool.handler(args, ctx) };
  };
}

/** Check bridges for a given event in a source namespace. */
export async function fireBridges(
  ctx: ToolContext,
  sourceNamespace: string,
  event: string,
  eventData: Record<string, unknown>,
  allTools: ToolDefinition[],
): Promise<void> {
  const rules = ctx.bridges.getRulesForEvent(sourceNamespace, event);
  if (rules.length === 0) return;

  const toolLookup = makeToolLookup(allTools, ctx);

  await checkBridges(
    rules,
    eventData,
    async (targetNamespace, text, metadata) => {
      const store = ctx.namespaces.getStore(targetNamespace);
      const triggers = ctx.triggers.getTriggersForEventInNamespace(event, targetNamespace);
      for (const trigger of triggers) {
        await executeIngestionPipeline(trigger, text, metadata, toolLookup);
      }
      void store; // store available for future direct pipeline use
    },
    { depth: 0, sourceNamespace, bridgeName: '' },
  );
}

/** Fire ingestion triggers for a given event in a namespace. */
export async function fireTriggers(
  ctx: ToolContext,
  namespace: string,
  event: string,
  content: string,
  metadata: Record<string, unknown>,
  allTools: ToolDefinition[],
): Promise<void> {
  const triggers = ctx.triggers.getTriggersForEventInNamespace(event, namespace);
  const toolLookup = makeToolLookup(allTools, ctx);
  for (const trigger of triggers) {
    await executeIngestionPipeline(trigger, content, metadata, toolLookup);
  }
}

/**
 * epistemicScore — score a memory by information-gain potential.
 * Higher = more worth visiting (under-explored, uncertain, goal-adjacent, stale).
 */
export function epistemicScore(memory: Memory): number {
  let score = 0;
  if (memory.access_count < 3) score += 0.3;
  if (memory.confidence < 0.5) score += 0.2;
  if (memory.category === 'goal') score += 0.4;
  const daysSinceAccess =
    (Date.now() - memory.last_accessed.getTime()) / (1000 * 60 * 60 * 24);
  if (daysSinceAccess > 14) score += 0.2;
  score += Math.random() * 0.3;
  return score;
}
