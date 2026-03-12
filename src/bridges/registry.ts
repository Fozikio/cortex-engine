import type { BridgeConfig } from '../core/config.js';

export interface ResolvedBridgeRule {
  bridgeName: string;
  from: string;
  to: string;
  event: string;
  condition?: string;
  pipeline: string[];
  template?: string;
}

export class BridgeRegistry {
  private readonly rules: Map<string, ResolvedBridgeRule[]> = new Map();

  constructor(bridges: BridgeConfig[] = []) {
    for (const bridge of bridges) {
      for (const rule of bridge.on) {
        const key = `${bridge.from}:${rule.event}`;
        const resolved: ResolvedBridgeRule = {
          bridgeName: bridge.name,
          from: bridge.from,
          to: bridge.to,
          event: rule.event,
          condition: rule.condition,
          pipeline: rule.pipeline,
          template: rule.template,
        };
        const existing = this.rules.get(key) || [];
        existing.push(resolved);
        this.rules.set(key, existing);
      }
    }
  }

  /** Get bridge rules triggered by event in source namespace. */
  getRulesForEvent(sourceNamespace: string, event: string): ResolvedBridgeRule[] {
    return this.rules.get(`${sourceNamespace}:${event}`) || [];
  }

  /** Get all registered bridge names. */
  getBridgeNames(): string[] {
    const names = new Set<string>();
    for (const rules of this.rules.values()) {
      for (const rule of rules) names.add(rule.bridgeName);
    }
    return Array.from(names);
  }
}
