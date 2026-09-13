/**
 * Document provenance on digest (#84).
 *
 * A digested document's frontmatter `type` and `tags` used to be dropped, so an
 * observation extracted from a style-transfer exercise, a cross-model debate or
 * a dream journal was stored with the same `declarative` content type and the
 * same provenance shape as one from a journal. On one live store a sentence the
 * agent wrote imitating its owner became, after a dream, a fact about the owner.
 */

import { describe, it, expect, vi } from 'vitest';
import { classifyDocument, digestDocument, withDocProvenance } from './digest.js';
import { SqliteCortexStore } from '../stores/sqlite.js';
import type { EmbedProvider } from '../core/embed.js';
import type { LLMProvider } from '../core/llm.js';

describe('classifyDocument', () => {
  it('treats workshop / experiment types as speculation', () => {
    expect(classifyDocument({ type: 'workshop', tags: ['creative'] }).treat_as).toBe('speculation');
    expect(classifyDocument({ type: 'Experiment' }).treat_as).toBe('speculation');
  });

  it('treats journal / knowledge / untyped documents as fact', () => {
    expect(classifyDocument({ type: 'journal' }).treat_as).toBe('fact');
    expect(classifyDocument({ type: 'knowledge', tags: ['research'] }).treat_as).toBe('fact');
    expect(classifyDocument({}).treat_as).toBe('fact');
  });

  it('flags non-factual tags even on an otherwise factual type', () => {
    const p = classifyDocument({ type: 'note', tags: ['Style-Transfer', 'michael'] });
    expect(p.treat_as).toBe('speculation');
    expect(p.reason).toBe('tag: style-transfer');
    expect(p.source_tags).toEqual(['style-transfer', 'michael']);
  });

  it('lower-cases and records type and tags, and honours an override', () => {
    const p = classifyDocument({ type: 'Workshop', tags: 'experiments, humor' }, 'fact');
    expect(p).toMatchObject({ source_type: 'workshop', source_tags: ['experiments', 'humor'], treat_as: 'fact' });
    expect(classifyDocument({ type: 'journal' }, 'speculation').treat_as).toBe('speculation');
  });
});

describe('withDocProvenance', () => {
  it('stamps type and tags and downgrades declarative to speculative for non-factual documents', async () => {
    const store = new SqliteCortexStore(':memory:');
    const wrapped = withDocProvenance(store, {
      source_type: 'workshop', source_tags: ['experiments'], treat_as: 'speculation', reason: 'type: workshop',
    });
    const id = await wrapped.putObservation({
      content: 'Virgil was surprised Idapixl learned more about his music in 20 minutes than most people.',
      source_file: 'x.md', source_section: 'digest:extract:reflection', salience: 0.5, processed: false,
      prediction_error: null, created_at: new Date(), updated_at: new Date(), embedding: [1, 0, 0], keywords: [],
      content_type: 'declarative',
    });
    const obs = (await store.getUnprocessedObservations(10)).find((o) => o.id === id);
    expect(obs?.content_type).toBe('speculative');
    expect(obs?.source_type).toBe('workshop');
    expect(obs?.source_tags).toEqual(['experiments']);
  });

  it('leaves non-declarative content types and factual documents alone', async () => {
    const store = new SqliteCortexStore(':memory:');
    const base = {
      content: 'A question about the sky?', source_file: '', source_section: '', salience: 0.5, processed: false,
      prediction_error: null, created_at: new Date(), updated_at: new Date(), embedding: [1, 0, 0], keywords: [],
    };
    const spec = withDocProvenance(store, { source_tags: [], treat_as: 'speculation', reason: 'x' });
    const q = await spec.putObservation({ ...base, content_type: 'interrogative' });
    const fact = withDocProvenance(store, { source_type: 'journal', source_tags: [], treat_as: 'fact', reason: 'x' });
    const d = await fact.putObservation({ ...base, content: 'The sky is blue today.', content_type: 'declarative' });
    const all = await store.getUnprocessedObservations(10);
    expect(all.find((o) => o.id === q)?.content_type).toBe('interrogative');
    expect(all.find((o) => o.id === d)?.content_type).toBe('declarative');
    expect(all.find((o) => o.id === d)?.source_type).toBe('journal');
  });

  it('passes every other store method through to the real store', async () => {
    const store = new SqliteCortexStore(':memory:');
    const wrapped = withDocProvenance(store, { source_tags: [], treat_as: 'fact', reason: 'x' });
    expect(await wrapped.getAllMemories()).toEqual([]);
    expect(await wrapped.findNearest([1, 0, 0], 1)).toEqual([]);
  });
});

describe('digestDocument extract with provenance', () => {
  const embed: EmbedProvider = { embed: vi.fn(async () => [1, 0, 0]) };
  const llm = {
    name: 'fake', modelId: 'fake',
    generate: vi.fn(async () => ''),
    generateJSON: vi.fn(async () => ([
      { text: 'Written in Virgil\'s voice: he learned more about my music in 20 minutes than most people.', type: 'reflection', salience: 0.6 },
      { text: 'The Finishing System was born from early assistant-brain mode.', type: 'fact', salience: 0.7 },
    ])),
  } as unknown as LLMProvider;

  const doc = (fm: string) => `---\n${fm}\n---\n# Style Transfer — Virgil Voice\n\nso i went in tonight and was like, ok, show me everything. he learned more about my music in twenty minutes than most people do.`;

  it('stores a workshop document\'s "facts" as speculative, with type and tags', async () => {
    const store = new SqliteCortexStore(':memory:');
    const result = await digestDocument(doc('type: workshop\ntags: [experiments, style-transfer]'), store, embed, llm, {
      pipeline: ['extract'], source_file: 'workshop/Style Transfer.md',
    });
    expect(result.observation_ids).toHaveLength(2);
    const obs = await store.getUnprocessedObservations(10);
    const fact = obs.find((o) => o.source_section === 'digest:extract:fact');
    expect(fact?.content_type).toBe('speculative');
    expect(fact?.source_type).toBe('workshop');
    expect(fact?.source_tags).toEqual(['experiments', 'style-transfer']);
    expect(obs.find((o) => o.source_section === 'digest:extract:reflection')?.content_type).toBe('reflective');
  });

  it('stores a journal document\'s facts as declarative', async () => {
    const store = new SqliteCortexStore(':memory:');
    await digestDocument(doc('type: journal\ntags: [session]'), store, embed, llm, { pipeline: ['extract'] });
    const fact = (await store.getUnprocessedObservations(10)).find((o) => o.source_section === 'digest:extract:fact');
    expect(fact?.content_type).toBe('declarative');
    expect(fact?.source_type).toBe('journal');
  });

  it('lets treat_as override the frontmatter in both directions', async () => {
    const store = new SqliteCortexStore(':memory:');
    await digestDocument(doc('type: workshop'), store, embed, llm, { pipeline: ['extract'], treat_as: 'fact' });
    await digestDocument(doc('type: journal'), store, embed, llm, { pipeline: ['extract'], treat_as: 'speculation' });
    const facts = (await store.getUnprocessedObservations(10)).filter((o) => o.source_section === 'digest:extract:fact');
    expect(facts.map((o) => [o.source_type, o.content_type]).sort()).toEqual([
      ['journal', 'speculative'],
      ['workshop', 'declarative'],
    ]);
  });
});
