/**
 * Abstract phase output hygiene (#83).
 *
 * Three things one live store showed in every run: the model's title line
 * (`Pattern: *X*`) stored verbatim as the memory name with its asterisks and
 * newline; the same synthesis minted twice in one run in different words; and
 * abstractions citing — and so re-attaching edges to — intentionally faded
 * memories.
 */

import { describe, it, expect, vi } from 'vitest';
import { abstractCrossDomain, parseAbstraction } from './cognition.js';
import { stripMarkdownFormatting } from './thought-quality.js';
import { newFSRSState } from './fsrs.js';
import { SqliteCortexStore } from '../stores/sqlite.js';
import type { EmbedProvider } from '../core/embed.js';
import type { LLMProvider } from '../core/llm.js';
import type { Memory, MemoryCategory } from '../core/types.js';

describe('parseAbstraction', () => {
  it('splits a "Pattern: *Title*" line from the body and drops the markdown', () => {
    const parsed = parseAbstraction(
      'Pattern: *Silent Success as a Structural Failure Mode*  \nThis abstraction connects the silent wander failure and the markdown folder. It matters because invisible failure becomes systemic.',
    );
    expect(parsed).toEqual({
      name: 'Silent Success as a Structural Failure Mode',
      definition: 'This abstraction connects the silent wander failure and the markdown folder. It matters because invisible failure becomes systemic.',
    });
  });

  it('handles "Pattern Name:" plus a labelled explanation paragraph', () => {
    const parsed = parseAbstraction(
      'Pattern Name: *Convergent Structural Emergence*  \n\nExplanation: Across these diverse concepts, structure emerges from constraint. It matters because the constraint is the design.',
    );
    expect(parsed?.name).toBe('Convergent Structural Emergence');
    expect(parsed?.definition).toBe('Across these diverse concepts, structure emerges from constraint. It matters because the constraint is the design.');
  });

  it('handles the one-line "Pattern: X — explanation" form', () => {
    const parsed = parseAbstraction(
      'Pattern: Resource-Driven Evolution of AI Systems — The shutdown of the VPS and the subscription gap both show that cost shapes what persists. It matters because budget is architecture.',
    );
    expect(parsed?.name).toBe('Resource-Driven Evolution of AI Systems');
    expect(parsed?.definition).toBe('The shutdown of the VPS and the subscription gap both show that cost shapes what persists. It matters because budget is architecture.');
  });

  it('names plain prose from its first sentence and keeps the whole text as the definition', () => {
    const text = 'Silent failure is structural, not incidental. When a system cannot see itself fail, the failure compounds until something outside notices.';
    const parsed = parseAbstraction(text);
    expect(parsed?.name).toBe('Silent failure is structural, not incidental');
    expect(parsed?.definition).toBe(text);
  });

  it('returns null for a title with no body', () => {
    expect(parseAbstraction('Pattern: *Just a Label*')).toBeNull();
    expect(parseAbstraction('   ')).toBeNull();
  });

  it('never produces a name over the label limit or containing a newline', () => {
    const parsed = parseAbstraction(
      'Pattern: A very long title that goes on and on well past sixty characters to see what happens to it\nBody sentence here.',
    );
    expect(parsed?.name.length).toBeLessThanOrEqual(60);
    expect(parsed?.name).not.toContain('\n');
  });
});

describe('stripMarkdownFormatting single emphasis', () => {
  it('strips paired single asterisks and underscores but leaves snake_case alone', () => {
    expect(stripMarkdownFormatting('Pattern: *Trade-Offs in Progress* — each _scenario_ uses source_files.'))
      .toBe('Pattern: Trade-Offs in Progress — each scenario uses source_files.');
    expect(stripMarkdownFormatting('a * b')).toBe('a * b');
  });
});

// ─── Phase behaviour ──────────────────────────────────────────────────────────

const VEC: Record<string, number[]> = {
  sky: [1, 0, 0],
  sea: [0, 1, 0],
  cloud: [0, 0, 1],
  sun: [0, 0.6, 0.8],
};
const ABSTRACT_VEC = [0.5, 0.5, 0.5];

function memory(name: string, definition: string, category: MemoryCategory, embedding: number[], faded = false): Omit<Memory, 'id'> {
  const now = new Date();
  return {
    name, definition, category, embedding, faded,
    salience: faded ? 0.3 : 0.7, confidence: 0.7, access_count: 0,
    created_at: now, updated_at: now, last_accessed: now,
    source_files: [], tags: [], fsrs: newFSRSState(),
  };
}

const ABSTRACTION =
  'The sky, the sea, the clouds and the sun are one weather system. The blue sky, the deep sea, the white clouds and the bright sun each show a part of it, and that matters because no part explains the weather alone.';

function makeLLM(text = ABSTRACTION): LLMProvider {
  return {
    name: 'fake', modelId: 'fake',
    generate: vi.fn(async () => text),
    generateJSON: vi.fn(async () => ({})),
  } as unknown as LLMProvider;
}

function makeEmbed(): EmbedProvider {
  return { embed: vi.fn(async () => ABSTRACT_VEC) };
}

async function seedThreeCategories(store: SqliteCortexStore): Promise<void> {
  await store.putMemory(memory('The sky is blue', 'The sky is blue on clear days.', 'belief', VEC.sky));
  await store.putMemory(memory('The sea is deep', 'The sea is deep and cold.', 'topic', VEC.sea));
  await store.putMemory(memory('Clouds are white', 'Clouds are white and drift.', 'value', VEC.cloud));
}

describe('abstractCrossDomain', () => {
  it('writes the same synthesis once per run, not once per attempt', async () => {
    const store = new SqliteCortexStore(':memory:');
    await seedThreeCategories(store);

    const result = await abstractCrossDomain(store, makeEmbed(), makeLLM(), { abstraction_attempts: 5 });

    expect(result.abstractions).toBe(1);
    const all = await store.getAllMemories();
    const minted = all.filter((m) => m.memory_origin === 'abstract');
    expect(minted).toHaveLength(1);
    // The first sentence is 62 characters, so the shared 60-character
    // heuristic clips it on a word boundary and marks the elision.
    expect(minted[0].name).toMatch(/^The sky, the sea, the clouds and the sun/);
    expect(minted[0].name.length).toBeLessThanOrEqual(60);
    expect(minted[0].name).not.toMatch(/[*\n]/);
  });

  it('stores the parsed label as the name and the body as the definition', async () => {
    const store = new SqliteCortexStore(':memory:');
    await seedThreeCategories(store);
    const llm = makeLLM(`Pattern: *One Weather System*  \nExplanation: ${ABSTRACTION}`);

    await abstractCrossDomain(store, makeEmbed(), llm, { abstraction_attempts: 1 });

    const minted = (await store.getAllMemories()).find((m) => m.memory_origin === 'abstract');
    expect(minted?.name).toBe('One Weather System');
    expect(minted?.definition).toBe(ABSTRACTION);
  });

  it('never samples a faded memory, so no abstraction edge lands on one', async () => {
    const store = new SqliteCortexStore(':memory:');
    await seedThreeCategories(store);
    const fadedId = await store.putMemory(memory('The sun is bright', 'The sun is bright at noon.', 'pattern', VEC.sun, true));
    // Distinct text per attempt so the within-run check does not short-circuit sampling.
    let n = 0;
    const embed: EmbedProvider = { embed: vi.fn(async () => { n++; return [Math.cos(n), Math.sin(n), 0.1 * n]; }) };
    const llm = makeLLM();

    await abstractCrossDomain(store, embed, llm, { abstraction_attempts: 10, abstraction_dedupe_threshold: 1.01 });

    const edges = await store.getEdgesFrom(fadedId);
    const incoming = (await store.getAllMemories())
      .filter((m) => m.memory_origin === 'abstract');
    expect(incoming.length).toBeGreaterThan(0);
    for (const abs of incoming) {
      const fromAbs = await store.getEdgesFrom(abs.id);
      expect(fromAbs.some((e) => e.target_id === fadedId)).toBe(false);
    }
    expect(edges.some((e) => e.relation === 'exemplifies')).toBe(false);
  });
});
