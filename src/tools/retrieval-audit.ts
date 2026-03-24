/**
 * retrieval_audit — analyze retrieval traces to find patterns.
 *
 * Inspects stored retrieval traces to identify which tools get retried,
 * which heuristic rules misfire, and where routing may be suboptimal.
 */

import type { ToolDefinition, ToolContext } from '../mcp/tools.js';

const RETRIEVAL_TRACES = 'retrieval_traces';

export const retrievalAuditTool: ToolDefinition = {
  name: 'retrieval_audit',
  description:
    'Analyze retrieval traces to find patterns — which tools get retried, which heuristic rules misfire, where routing is consistently wrong.',
  inputSchema: {
    type: 'object',
    properties: {
      days: {
        type: 'number',
        description: 'How many days of traces to analyze (default: 7)',
      },
      namespace: { type: 'string', description: 'Namespace (defaults to default)' },
    },
  },

  async handler(args: Record<string, unknown>, ctx: ToolContext): Promise<Record<string, unknown>> {
    const days = typeof args['days'] === 'number' ? args['days'] : 7;
    const namespace = typeof args['namespace'] === 'string' ? args['namespace'] : undefined;

    const store = ctx.namespaces.getStore(namespace);

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const traces = await store.query(
      RETRIEVAL_TRACES,
      [{ field: 'timestamp', op: '>=', value: cutoff.toISOString() }],
      { orderBy: 'timestamp', orderDir: 'desc', limit: 1000 },
    );

    if (traces.length === 0) {
      return { message: 'No retrieval traces found', days, trace_count: 0 };
    }

    const toolCounts: Record<string, number> = {};
    const retryCounts: Record<string, number> = {};
    const retryTargets: Record<string, Record<string, number>> = {};
    const ruleCounts: Record<string, number> = {};
    const ruleRetries: Record<string, number> = {};
    let totalRetries = 0;
    let totalReferenced = 0;
    let routerCalls = 0;

    // ML classifier tracking
    const mlIntentCounts: Record<string, number> = {};
    const mlIntentRetries: Record<string, number> = {};
    let mlTracesTotal = 0;
    let mlAgreeCount = 0;
    let mlDisagreeRetries = 0;
    let mlDisagreeTotal = 0;
    let mlConfidenceSum = 0;

    // Intent taxonomy mapping (ML to heuristic equivalents)
    const mlToHeuristic: Record<string, string> = {
      'recalling-specific': 'operational',
      'exploring-related': 'exploratory',
      'finding-tension': 'signal-surfacing',
      'mapping-structure': 'graph-exploration',
      'resuming': 'operational',
      'seeking-novelty': 'exploratory',
      'ambiguous': 'ambiguous',
    };

    for (const trace of traces) {
      const tool = typeof trace['tool_used'] === 'string' ? trace['tool_used'] : 'unknown';
      toolCounts[tool] = (toolCounts[tool] ?? 0) + 1;

      if (trace['retry_within_60s'] === true) {
        totalRetries++;
        retryCounts[tool] = (retryCounts[tool] ?? 0) + 1;
        const retryTo = typeof trace['retry_tool'] === 'string' ? trace['retry_tool'] : 'unknown';
        if (!retryTargets[tool]) retryTargets[tool] = {};
        retryTargets[tool][retryTo] = (retryTargets[tool][retryTo] ?? 0) + 1;
      }

      if (trace['result_referenced'] === true) {
        totalReferenced++;
      }

      if (typeof trace['heuristic_rule_fired'] === 'string') {
        const rule = trace['heuristic_rule_fired'];
        ruleCounts[rule] = (ruleCounts[rule] ?? 0) + 1;
        if (trace['retry_within_60s'] === true) {
          ruleRetries[rule] = (ruleRetries[rule] ?? 0) + 1;
        }
      }

      // ML classifier metrics
      if (typeof trace['ml_intent'] === 'string') {
        mlTracesTotal++;
        const mlIntent = trace['ml_intent'];
        mlIntentCounts[mlIntent] = (mlIntentCounts[mlIntent] ?? 0) + 1;
        if (typeof trace['ml_confidence'] === 'number') {
          mlConfidenceSum += trace['ml_confidence'];
        }
        if (trace['retry_within_60s'] === true) {
          mlIntentRetries[mlIntent] = (mlIntentRetries[mlIntent] ?? 0) + 1;
        }

        // Agreement check
        const mappedIntent = mlToHeuristic[mlIntent] ?? 'ambiguous';
        const heuristicIntent =
          typeof trace['detected_intent'] === 'string' ? trace['detected_intent'] : 'ambiguous';
        if (mappedIntent === heuristicIntent) {
          mlAgreeCount++;
        } else {
          mlDisagreeTotal++;
          if (trace['retry_within_60s'] === true) {
            mlDisagreeRetries++;
          }
        }
      }

      if (tool === 'retrieve') routerCalls++;
    }

    const retryRate = traces.length > 0 ? totalRetries / traces.length : 0;
    const referenceRate = traces.length > 0 ? totalReferenced / traces.length : 0;

    const result: Record<string, unknown> = {
      period_days: days,
      trace_count: traces.length,
      router_calls: routerCalls,
      direct_calls: traces.length - routerCalls,

      overall: {
        retry_rate: Math.round(retryRate * 100) + '%',
        reference_rate: Math.round(referenceRate * 100) + '%',
        total_retries: totalRetries,
        total_referenced: totalReferenced,
      },

      tool_usage: toolCounts,
      retries_by_tool: retryCounts,
      retry_flows: retryTargets,

      heuristic_rules: Object.entries(ruleCounts).map(([rule, count]) => ({
        rule,
        fires: count,
        retries: ruleRetries[rule] ?? 0,
        accuracy: Math.round(((count - (ruleRetries[rule] ?? 0)) / count) * 100) + '%',
      })),
    };

    // ML classifier section — only when A/B data exists
    if (mlTracesTotal > 0) {
      result['ml_classifier'] = {
        traces_with_ml: mlTracesTotal,
        coverage: Math.round((mlTracesTotal / traces.length) * 100) + '%',
        avg_confidence: Math.round((mlConfidenceSum / mlTracesTotal) * 100) + '%',
        agreement_rate: Math.round((mlAgreeCount / mlTracesTotal) * 100) + '%',
        disagree_retry_rate:
          mlDisagreeTotal > 0
            ? Math.round((mlDisagreeRetries / mlDisagreeTotal) * 100) + '%'
            : 'n/a',
        intent_distribution: Object.entries(mlIntentCounts)
          .sort(([, a], [, b]) => b - a)
          .map(([intent, count]) => ({
            intent,
            count,
            retries: mlIntentRetries[intent] ?? 0,
            retry_rate: Math.round(((mlIntentRetries[intent] ?? 0) / count) * 100) + '%',
          })),
      };
    }

    return result;
  },
};
