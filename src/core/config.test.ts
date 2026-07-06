/**
 * Tests for resolveModelTier — the consumer contract for
 * config.model_provenance.confidence_tiers.
 */

import { describe, it, expect } from 'vitest';
import { resolveModelTier, DEFAULT_CONFIG } from './config.js';
import type { ModelProvenanceConfig } from './config.js';

const TIERS: ModelProvenanceConfig = {
  default_model: 'unknown',
  confidence_tiers: {
    high: ['claude-opus-4-6', 'gemini-2.5-pro'],
    medium: ['claude-sonnet-4-6', 'gpt-4o'],
    low: ['qwen2.5:14b', 'llama3:8b'],
  },
  conflict_policy: 'weight_by_tier',
};

describe('resolveModelTier', () => {
  it('matches exact model ids', () => {
    expect(resolveModelTier('claude-opus-4-6', TIERS)).toBe('high');
    expect(resolveModelTier('qwen2.5:14b', TIERS)).toBe('low');
  });

  it('matches substrings in either direction', () => {
    // Versioned id contains configured id.
    expect(resolveModelTier('gemini-2.5-pro-preview-0514', TIERS)).toBe('high');
    // Configured id contains reported short id.
    expect(resolveModelTier('gpt-4o', TIERS)).toBe('medium');
  });

  it('is case-insensitive', () => {
    expect(resolveModelTier('Claude-Opus-4-6', TIERS)).toBe('high');
  });

  it('defaults unknown models to medium', () => {
    expect(resolveModelTier('some-new-model', TIERS)).toBe('medium');
  });

  it('defaults to medium without provenance config', () => {
    expect(resolveModelTier('anything', undefined)).toBe('medium');
    expect(resolveModelTier('', TIERS)).toBe('medium');
  });

  it('works against DEFAULT_CONFIG tiers', () => {
    expect(resolveModelTier('qwen2.5:14b', DEFAULT_CONFIG.model_provenance)).toBe('low');
  });
});
