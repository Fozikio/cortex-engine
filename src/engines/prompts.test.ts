/**
 * Prompt registry tests — versioning discipline and template integrity.
 *
 * The version snapshot below is the point of this file: any wording change
 * to a prompt shifts model behavior, so it must arrive together with a
 * version bump. If a test here fails after editing a prompt, bump that
 * prompt's version and update the snapshot deliberately.
 */

import { describe, it, expect } from 'vitest';
import {
  PROMPT_REGISTRY,
  promptVersions,
  REFINE_DEFINITION,
  CLASSIFY_CATEGORY,
  EDGE_DISCOVER_PAIR,
  HINDSIGHT_REVIEW,
  ADJUDICATE_CONTRADICTION,
  HYDE_EXPAND,
} from './prompts.js';

describe('prompt registry', () => {
  it('has unique ids', () => {
    const ids = PROMPT_REGISTRY.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('pins prompt versions (bump deliberately when wording changes)', () => {
    expect(promptVersions()).toEqual({
      'refine-definition': 1,
      'edge-revalidate': 1,
      'classify-category': 1,
      'edge-discover-pair': 1,
      'edge-discover-graph': 1,
      'abstract-synthesis': 1,
      'hindsight-review': 1,
      'dream-report': 1,
      'hyde-expand': 1,
      'adjudicate-contradiction': 2,
    });
  });

  it('interpolates params into templates', () => {
    const refine = REFINE_DEFINITION.build({
      definition: 'OLD_DEF',
      observations: ['OBS_ONE', 'OBS_TWO'],
    });
    expect(refine).toContain('OLD_DEF');
    expect(refine).toContain('- OBS_ONE');
    expect(refine).toContain('- OBS_TWO');

    expect(CLASSIFY_CATEGORY.build({ content: 'SOME_TEXT' })).toContain('SOME_TEXT');

    const pair = EDGE_DISCOVER_PAIR.build({
      nameA: 'A_NAME', definitionA: 'A_DEF',
      nameB: 'B_NAME', definitionB: 'B_DEF',
    });
    expect(pair).toContain('A_NAME — A_DEF');
    expect(pair).toContain('B_NAME — B_DEF');

    const hindsight = HINDSIGHT_REVIEW.build({
      name: 'MEM', definition: 'DEF', category: 'belief',
      confidence: 0.87, stability: 30.5, reps: 6, lapses: 0,
      historyNote: 'HISTORY', edgeSummary: 'EDGES',
    });
    expect(hindsight).toContain('0.87');
    expect(hindsight).toContain('30.5 days');
    expect(hindsight).toContain('HISTORY');

    const adjudicate = ADJUDICATE_CONTRADICTION.build({
      claim: 'THE_CLAIM', target: 'THE_TARGET',
    });
    expect(adjudicate).toContain('THE_CLAIM');
    expect(adjudicate).toContain('THE_TARGET');
  });

  it('keeps the /no_think prefix on HyDE for thinking models', () => {
    expect(HYDE_EXPAND.build({ query: 'q' }).startsWith('/no_think')).toBe(true);
  });
});
