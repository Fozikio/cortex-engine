/**
 * Digest scores on the 0–1 salience scale.
 *
 * `detectSalience` returned 5–7 and the observe / reflect / predict steps
 * subtracted whole points from it, so every observation a digested document
 * produced (except the extract step, which divided by 10) carried 1–10 into a
 * 0–1 field. The ranking factor multiplied that straight through. These pin
 * every write site the observe step has, and the override path.
 */

import { describe, it, expect, vi } from 'vitest';
import { digestDocument } from './digest.js';
import { SqliteCortexStore } from '../stores/sqlite.js';
import type { EmbedProvider } from '../core/embed.js';
import type { LLMProvider } from '../core/llm.js';

const embed: EmbedProvider = { embed: vi.fn(async () => [1, 0, 0]) };
const llm = {
  name: 'fake', modelId: 'fake',
  generate: vi.fn(async () => ''),
  generateJSON: vi.fn(async () => []),
} as unknown as LLMProvider;

const SENTENCE = 'The intake was the fault, not the dream, and the backfill was the only intake for six months. ';

function longDocument(frontmatter: string): string {
  const paragraphs: string[] = [];
  while (paragraphs.join('\n\n').length < 3200) paragraphs.push(SENTENCE.repeat(4).trim());
  return `---\n${frontmatter}\n---\n${paragraphs.join('\n\n')}`;
}

async function observations(store: SqliteCortexStore) {
  return store.getUnprocessedObservations(100);
}

describe('digest salience scale', () => {
  it('stores a long active document as a 0.7 summary and 0.5 chunks, never above 1', async () => {
    const store = new SqliteCortexStore(':memory:');
    await digestDocument(longDocument('status: active'), store, embed, llm, { pipeline: ['observe'] });
    const obs = await observations(store);
    const summary = obs.find((o) => o.source_section === 'summary');
    const chunks = obs.filter((o) => o.source_section === 'chunk');
    expect(summary?.salience).toBeCloseTo(0.7);
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) expect(c.salience).toBeCloseTo(0.5);
    for (const o of obs) expect(o.salience).toBeLessThanOrEqual(1);
  });

  it('scores a short untyped document at 0.5', async () => {
    const store = new SqliteCortexStore(':memory:');
    await digestDocument('Just a short note about nothing in particular.', store, embed, llm, { pipeline: ['observe'] });
    const [obs] = await observations(store);
    expect(obs.salience).toBeCloseTo(0.5);
  });

  it('honours a frontmatter salience on either scale', async () => {
    const legacy = new SqliteCortexStore(':memory:');
    await digestDocument(longDocument('salience: 8'), legacy, embed, llm, { pipeline: ['observe'] });
    expect((await observations(legacy)).find((o) => o.source_section === 'summary')?.salience).toBeCloseTo(0.8);

    const modern = new SqliteCortexStore(':memory:');
    await digestDocument(longDocument('salience: 0.8'), modern, embed, llm, { pipeline: ['observe'] });
    expect((await observations(modern)).find((o) => o.source_section === 'summary')?.salience).toBeCloseTo(0.8);
  });

  it('normalises an explicit override on the legacy scale', async () => {
    const store = new SqliteCortexStore(':memory:');
    await digestDocument('A short note.', store, embed, llm, { pipeline: ['observe'], salience: 6 });
    const [obs] = await observations(store);
    expect(obs.salience).toBeCloseTo(0.6);
  });

  it('keeps reflect-step insights a tenth below the document, floored, not a whole point', async () => {
    const store = new SqliteCortexStore(':memory:');
    const reflecting = {
      ...llm,
      generate: vi.fn(async () => 'This connects the backfill gap to the intake fault in a way worth keeping.\nA second insight that is also long enough to be stored.'),
    } as unknown as LLMProvider;
    await digestDocument('---\ntype: journal\n---\nA journal entry short enough to observe whole.', store, embed, reflecting, { pipeline: ['reflect'] });
    const insights = (await observations(store)).filter((o) => o.source_section === 'digest:reflect');
    expect(insights.length).toBe(2);
    for (const i of insights) expect(i.salience).toBeCloseTo(0.6);
  });
});
