/**
 * Session — tracks the current MCP session's model provenance.
 *
 * Created at MCP server startup. Auto-injected into every write operation.
 * The caller never has to pass provenance — the engine handles it.
 */

import type { ModelProvenance, ConfidenceTier } from './types.js';
import type { ModelProvenanceConfig } from './config.js';

export class Session {
  private readonly provenance: ModelProvenance;
  private readonly tiers: ModelProvenanceConfig;

  constructor(
    modelId: string,
    modelFamily: string,
    client: string,
    agent: string,
    tiers: ModelProvenanceConfig,
  ) {
    this.provenance = { model_id: modelId, model_family: modelFamily, client, agent };
    this.tiers = tiers;
  }

  /** Get the current session's provenance for write tagging. */
  getProvenance(): ModelProvenance {
    return { ...this.provenance };
  }

  /** Get the confidence tier for the current model. */
  getConfidenceTier(): ConfidenceTier {
    return Session.tierForModel(this.provenance.model_id, this.tiers);
  }

  /** Look up the confidence tier for any model ID. */
  static tierForModel(modelId: string, config: ModelProvenanceConfig): ConfidenceTier {
    for (const [tier, models] of Object.entries(config.confidence_tiers)) {
      if (models.includes(modelId)) {
        return tier as ConfidenceTier;
      }
    }
    return 'low'; // unknown models default to low confidence
  }

  /** Auto-detect model from environment variables. */
  static detectModel(): { modelId: string; modelFamily: string; client: string } {
    // Claude Code sets these
    const claudeModel = process.env['CLAUDE_MODEL'] || process.env['ANTHROPIC_MODEL'];
    if (claudeModel) {
      return { modelId: claudeModel, modelFamily: 'anthropic', client: 'claude-code' };
    }

    // Gemini CLI
    const geminiModel = process.env['GEMINI_MODEL'];
    if (geminiModel) {
      return { modelId: geminiModel, modelFamily: 'google', client: 'gemini-cli' };
    }

    // Cursor
    const cursorModel = process.env['CURSOR_MODEL'];
    if (cursorModel) {
      return { modelId: cursorModel, modelFamily: 'cursor', client: 'cursor' };
    }

    // Cron/batch
    const cronModel = process.env['CORTEX_MODEL'];
    if (cronModel) {
      return {
        modelId: cronModel,
        modelFamily: inferFamily(cronModel),
        client: process.env['CORTEX_CLIENT'] || 'cron',
      };
    }

    return { modelId: 'unknown', modelFamily: 'unknown', client: 'unknown' };
  }
}

function inferFamily(modelId: string): string {
  if (modelId.startsWith('claude')) return 'anthropic';
  if (modelId.startsWith('gemini')) return 'google';
  if (modelId.startsWith('gpt') || modelId.startsWith('o1') || modelId.startsWith('o3')) return 'openai';
  if (modelId.includes(':')) return 'ollama'; // ollama uses name:tag format
  return 'unknown';
}
