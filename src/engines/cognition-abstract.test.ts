/**
 * Abstract phase output hygiene (#83) and member sampling / shared mechanism (#147).
 *
 * Three things one live store showed in every run: the model's title line
 * (`Pattern: *X*`) stored verbatim as the memory name with its asterisks and
 * newline; the same synthesis minted twice in one run in different words; and
 * abstractions citing — and so re-attaching edges to — intentionally faded
 * memories.
 */

import { describe, it, expect, vi } from 'vitest';
import { abstractCrossDomain, parseAbstraction, ABSTRACTION_SALIENCE } from './cognition.js';
import { stripMarkdownFormatting } from './thought-quality.js';
import { newFSRSState } from './fsrs.js';
import { SqliteCortexStore } from '../stores/sqlite.js';
import type { EmbedProvider } from '../core/embed.js';
import type { LLMProvider } from '../core/llm.js';
import type { Edge, Memory, MemoryCategory } from '../core/types.js';

describe('parseAbstraction', () => {
  it('splits a "Pattern: *Title*" line from the body and drops the markdown', () => {
    const parsed = parseAbstraction(
      'Pattern: *Silent Success as a Structural Failure Mode*  \nThis abstraction connects the silent wander failure and the markdown folder. It matters because invisible failure becomes systemic.',
    );
    expect(parsed).toEqual({
      name: 'Silent Success as a Structural Failure Mode',
      definition: 'This abstraction connects the silent wander failure and the markdown folder. It matters because invisible failure becomes systemic.',
      labelled: true,
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
    // Unlabelled: abstractCrossDomain asks deriveName for a real label (#85).
    expect(parsed?.labelled).toBe(false);
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

const ABSTRACT_VEC = [0.5, 0.5, 0.5];

function memory(
  name: string,
  definition: string,
  category: MemoryCategory,
  embedding: number[],
  extra: Partial<Omit<Memory, 'id'>> = {},
): Omit<Memory, 'id'> {
  const now = new Date();
  return {
    name, definition, category, embedding,
    salience: extra.faded ? 0.3 : 0.7, confidence: 0.7, access_count: 0,
    created_at: now, updated_at: now, last_accessed: now,
    source_files: [], tags: [], fsrs: newFSRSState(),
    ...extra,
  };
}

const ABSTRACTION =
  'A hook that blocks a command before it runs is only as good as its match: the push gate matched text and denied everything, the guardrail matches the command and blocks only the delete. Both say the block belongs on the command, not on the words around it.';

/** The synthesis a model returns when the mechanism is real. */
const GOOD = {
  mechanism: 'a hook that blocks a command before it runs',
  members: ['Push gate fixed', 'Guardrail hook blocks deletes'],
  name: 'Hooks that block commands',
  abstraction: ABSTRACTION,
};

type Answer = Record<string, unknown>;

function makeLLM(answer: Answer | (() => Answer) = GOOD): LLMProvider & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    name: 'fake', modelId: 'fake', prompts,
    generate: vi.fn(async () => 'Unused label'),
    generateJSON: vi.fn(async (prompt: string) => {
      prompts.push(prompt);
      return typeof answer === 'function' ? answer() : answer;
    }),
  } as unknown as LLMProvider & { prompts: string[] };
}

function makeEmbed(): EmbedProvider {
  return { embed: vi.fn(async () => ABSTRACT_VEC) };
}

async function link(store: SqliteCortexStore, a: string, b: string, relation: Edge['relation'] = 'related'): Promise<void> {
  await store.putEdge({ source_id: a, target_id: b, relation, weight: 0.5, evidence: 'x', created_at: new Date() });
}

/**
 * Three hook memories joined in the graph, and one memory about a person
 * with no edges and an orthogonal embedding — the kind of member the old
 * random-category sampling handed the model next to technical memories.
 */
async function seedHooks(store: SqliteCortexStore): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  ids.push = await store.putMemory(memory('Push gate fixed', 'The push gate hook denied every Bash command containing git push; fixed by matching the command, not the text.', 'belief', [1, 0, 0]));
  ids.guard = await store.putMemory(memory('Guardrail hook blocks deletes', 'The guardrail hook blocks rm with a tilde path before the command runs.', 'topic', [0, 1, 0]));
  ids.bom = await store.putMemory(memory('Hook encoding trap', 'A PowerShell hook script with an em dash breaks without a BOM.', 'value', [0, 0, 1]));
  ids.family = await store.putMemory(memory('Family background', 'Virgil grew up moving between cities and learned to rebuild routines from scratch.', 'pattern', [-1, 0, 0]));
  await link(store, ids.push, ids.guard);
  await link(store, ids.push, ids.bom, 'supports');
  await link(store, ids.guard, ids.bom);
  return ids;
}

const minted = async (store: SqliteCortexStore): Promise<Memory[]> =>
  (await store.getAllMemories()).filter((m) => m.memory_origin === 'abstract');

describe('abstractCrossDomain (#147)', () => {
  it('stores a real shared mechanism at lower salience, linked only to the members it spans', async () => {
    const store = new SqliteCortexStore(':memory:');
    const ids = await seedHooks(store);

    const result = await abstractCrossDomain(store, makeEmbed(), makeLLM(), { abstraction_attempts: 1 });

    expect(result.abstractions).toBe(1);
    const [abs] = await minted(store);
    expect(abs.name).toBe('Hooks that block commands');
    expect(abs.definition).toBe(ABSTRACTION);
    expect(abs.salience).toBe(ABSTRACTION_SALIENCE);
    expect(ABSTRACTION_SALIENCE).toBeLessThan(0.8);
    const targets = (await store.getEdgesFrom(abs.id)).filter((e) => e.relation === 'exemplifies').map((e) => e.target_id);
    expect(targets.sort()).toEqual([ids.push, ids.guard].sort());
  });

  it('only shows the model memories related to the seed — never an unconnected one', async () => {
    const store = new SqliteCortexStore(':memory:');
    await seedHooks(store);
    const llm = makeLLM({ none: true });

    await abstractCrossDomain(store, makeEmbed(), llm, { abstraction_attempts: 12 });

    expect(llm.prompts.length).toBeGreaterThan(0);
    for (const p of llm.prompts) expect(p).not.toContain('Family background');
  });

  it('writes nothing when the model answers none', async () => {
    const store = new SqliteCortexStore(':memory:');
    await seedHooks(store);

    const result = await abstractCrossDomain(store, makeEmbed(), makeLLM({ none: true }), { abstraction_attempts: 5 });

    expect(result.abstractions).toBe(0);
    expect(await minted(store)).toHaveLength(0);
  });

  it('rejects a theme that no member uses, however fluent', async () => {
    const store = new SqliteCortexStore(':memory:');
    await seedHooks(store);
    const theme = {
      mechanism: 'agency and constraint shape systems through friction',
      members: ['Push gate fixed', 'Guardrail hook blocks deletes'],
      name: 'Agency and Constraint',
      abstraction: 'The deeper pattern is that agency and constraint shape systems through friction. It matters because boundaries define what can be built.',
    };

    const result = await abstractCrossDomain(store, makeEmbed(), makeLLM(theme), { abstraction_attempts: 3 });

    expect(result.abstractions).toBe(0);
    expect(result.rejected).toBeGreaterThan(0);
    expect(await minted(store)).toHaveLength(0);
  });

  it('does not ask the model at all when the seed has fewer than two related memories', async () => {
    const store = new SqliteCortexStore(':memory:');
    for (const [i, cat] of (['belief', 'topic', 'value'] as MemoryCategory[]).entries()) {
      const v = [0, 0, 0]; v[i] = 1;
      await store.putMemory(memory(`Lone ${i}`, `Lone memory ${i} with nothing near it.`, cat, v));
    }
    const llm = makeLLM();

    const result = await abstractCrossDomain(store, makeEmbed(), llm, { abstraction_attempts: 5 });

    expect(result.abstractions).toBe(0);
    expect(llm.prompts).toHaveLength(0);
  });

  it('never samples a faded memory or an existing abstraction as a member', async () => {
    const store = new SqliteCortexStore(':memory:');
    const ids = await seedHooks(store);
    const fadedId = await store.putMemory(memory('Old hook rule', 'An old hook rule blocked every command.', 'insight', [0.9, 0.1, 0], { faded: true }));
    const absId = await store.putMemory(memory('Earlier synthesis', 'A previous abstraction about hooks and commands.', 'insight', [0.8, 0.2, 0], { memory_origin: 'abstract' }));
    await link(store, ids.push, fadedId);
    await link(store, ids.push, absId);
    const llm = makeLLM({ none: true });

    await abstractCrossDomain(store, makeEmbed(), llm, { abstraction_attempts: 12 });

    for (const p of llm.prompts) {
      expect(p).not.toContain('Old hook rule');
      expect(p).not.toContain('Earlier synthesis');
    }
  });

  it('writes the same synthesis once per run, not once per attempt', async () => {
    const store = new SqliteCortexStore(':memory:');
    await seedHooks(store);

    const result = await abstractCrossDomain(store, makeEmbed(), makeLLM(), { abstraction_attempts: 5 });

    expect(result.abstractions).toBe(1);
    expect(await minted(store)).toHaveLength(1);
  });
});
