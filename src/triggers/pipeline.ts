export interface ToolHandler {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

export interface PipelineResult {
  trigger_event: string;
  namespace: string;
  steps: PipelineStepResult[];
}

export interface PipelineStepResult {
  tool: string;
  status: 'ok' | 'failed' | 'skipped';
  result?: Record<string, unknown>;
  error?: string;
}

export async function executeIngestionPipeline(
  trigger: { event: string; pipeline: string[]; namespace: string },
  content: string,
  metadata: Record<string, unknown>,
  toolLookup: (name: string) => ToolHandler | undefined,
): Promise<PipelineResult> {
  const steps: PipelineStepResult[] = [];

  for (const toolName of trigger.pipeline) {
    const tool = toolLookup(toolName);
    if (!tool) {
      steps.push({ tool: toolName, status: 'skipped', error: `Tool "${toolName}" not found` });
      continue;
    }

    try {
      const result = await tool.handler({
        text: content,
        namespace: trigger.namespace,
        _triggered_by: trigger.event,
        ...metadata,
      });
      steps.push({ tool: toolName, status: 'ok', result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      steps.push({ tool: toolName, status: 'failed', error: message });
      // Continue pipeline — don't let one failure stop others
    }
  }

  return {
    trigger_event: trigger.event,
    namespace: trigger.namespace,
    steps,
  };
}
