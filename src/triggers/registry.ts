import type { NamespaceConfig, IngestionTriggerConfig } from '../core/config.js';

export interface ResolvedTrigger {
  event: string;
  pipeline: string[];
  namespace: string;
}

export class TriggerRegistry {
  private readonly triggers: Map<string, ResolvedTrigger[]> = new Map();

  constructor(namespaces: Record<string, NamespaceConfig>) {
    for (const [nsName, nsConfig] of Object.entries(namespaces)) {
      if (!nsConfig.ingestion_triggers) continue;
      for (const [eventName, triggerConfig] of Object.entries(
        nsConfig.ingestion_triggers as Record<string, IngestionTriggerConfig>,
      )) {
        const resolved: ResolvedTrigger = {
          event: eventName,
          pipeline: triggerConfig.pipeline,
          namespace: nsName,
        };
        const existing = this.triggers.get(eventName) ?? [];
        existing.push(resolved);
        this.triggers.set(eventName, existing);
      }
    }
  }

  /** Get all triggers for a given event. */
  getTriggersForEvent(event: string): ResolvedTrigger[] {
    return this.triggers.get(event) ?? [];
  }

  /** Get triggers for a specific event in a specific namespace. */
  getTriggersForEventInNamespace(event: string, namespace: string): ResolvedTrigger[] {
    return this.getTriggersForEvent(event).filter((t) => t.namespace === namespace);
  }

  /** Get all registered event names. */
  getRegisteredEvents(): string[] {
    return Array.from(this.triggers.keys());
  }
}
