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
  RUMINATE_FREEWRITE,
  RUMINATE_EXTRACT,
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
      'salience-score': 1,
      'abstract-subsume': 1,
      'query-explain-relevance': 1,
      'reflect-topic': 1,
      'reflect-system': 1,
      'agent-findings-extract': 1,
      'ruminate-freewrite': 1,
      'ruminate-extract': 1,
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

    const freewrite = RUMINATE_FREEWRITE.build({
      context: 'THE_CONTEXT', topicInstruction: 'THE_TOPIC',
    });
    expect(freewrite).toContain('THE_CONTEXT');
    expect(freewrite).toContain('THE_TOPIC');

    expect(RUMINATE_EXTRACT.build({ text: 'THE_RUMINATION' })).toContain('THE_RUMINATION');
  });

  it('is immune to String.replace $-pattern injection (unlike the old templates)', () => {
    // The old ruminate templates used .replace('{context}', context), where a
    // context containing "$&" or "$'" would be expanded as a replacement
    // pattern and corrupt the prompt. build() concatenates, so content passes
    // through verbatim.
    const hostile = "salary is $100; pattern tokens: $& $' $` $1 {context}";
    const built = RUMINATE_FREEWRITE.build({ context: hostile, topicInstruction: 'x' });
    expect(built).toContain(hostile);
  });

  it('keeps the /no_think prefix on HyDE for thinking models', () => {
    expect(HYDE_EXPAND.build({ query: 'q' }).startsWith('/no_think')).toBe(true);
  });
});
