/**
 * Shared-mechanism check (#147). The rejected fixtures are the shapes of two
 * live abstractions: a theme ("friction and identity") gluing a technical
 * memory to a personal one, and a term every memory in the store uses.
 */

import { describe, it, expect } from 'vitest';
import { checkMechanism, documentFrequency } from './abstraction-check.js';

const PUSH = { name: 'Push gate fixed', text: 'The push gate hook denied every Bash command containing git push; fixed by matching the command, not the text.' };
const GUARD = { name: 'Guardrail hook blocks deletes', text: 'The guardrail hook blocks rm with a tilde path before the command runs.' };
const FAMILY = { name: 'Family background', text: 'Virgil grew up moving between cities and learned to rebuild routines from scratch.' };
const members = [PUSH, GUARD, FAMILY];

const smallPool = { df: documentFrequency(members.map((m) => `${m.name} ${m.text}`)), poolSize: 3 };

describe('checkMechanism', () => {
  it('accepts a mechanism that names a term two cited members share', () => {
    const r = checkMechanism({
      mechanism: 'a hook that blocks a command before it runs',
      cited: ['Push gate fixed', 'Guardrail hook blocks deletes'],
      members, ...smallPool,
    });
    expect(r.ok).toBe(true);
    expect(r.sharedTerms).toEqual(expect.arrayContaining(['hook', 'command']));
    expect(r.citedMembers.map((m) => m.name)).toEqual(['Push gate fixed', 'Guardrail hook blocks deletes']);
  });

  it('rejects a theme that no cited member uses', () => {
    const r = checkMechanism({
      mechanism: 'systems develop through friction and identity',
      cited: ['Push gate fixed', 'Family background'],
      members, ...smallPool,
    });
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain('mechanism names no concrete term the cited members share');
  });

  it('rejects a term too common in a real-sized pool to count as shared', () => {
    const filler = Array.from({ length: 40 }, (_, i) => `Memory ${i} about a hook in some command.`);
    const df = documentFrequency([...members.map((m) => `${m.name} ${m.text}`), ...filler]);
    const r = checkMechanism({
      mechanism: 'a hook on a command',
      cited: ['Push gate fixed', 'Guardrail hook blocks deletes'],
      members, df, poolSize: 43,
    });
    expect(r.ok).toBe(false);
  });

  it('needs at least two cited members that were actually shown', () => {
    const r = checkMechanism({
      mechanism: 'a hook that blocks a command',
      cited: ['Push gate fixed', 'Something never shown'],
      members, ...smallPool,
    });
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toMatch(/spans 1 of the shown members/);
  });

  it('matches cited names loosely (case, punctuation, shortened)', () => {
    const r = checkMechanism({
      mechanism: 'a hook that blocks a command',
      cited: ['push gate', 'GUARDRAIL HOOK BLOCKS DELETES.'],
      members, ...smallPool,
    });
    expect(r.ok).toBe(true);
  });

  it('rejects a missing mechanism or a non-array members field', () => {
    expect(checkMechanism({ mechanism: '', cited: ['Push gate fixed', 'Guardrail hook blocks deletes'], members, ...smallPool }).reasons)
      .toContain('no mechanism stated');
    expect(checkMechanism({ mechanism: 'a hook', cited: 'Push gate fixed', members, ...smallPool }).ok).toBe(false);
  });
});

describe('checkMechanism — restatements (#147)', () => {
  // Shapes of the two Muzak memories one copy run "abstracted" into a third copy.
  const A = { name: 'Muzak was designed to sedate anxious elevator riders', text: "Muzak was designed to sedate anxious elevator riders through functional acoustic engineering that used patented 'Stimulus Progression', a system of 15-minute blocks engineered to create a subconscious sense of forward movement." };
  const B = { name: 'Muzak Stimulus Progression was a patented system', text: "Muzak's 'Stimulus Progression' was a patented system for behavioral engineering through ambient sound, using 15-minute blocks of music engineered to create a subconscious sense of forward movement." };

  it('counts two retellings of one fact as one member', () => {
    const r = checkMechanism({
      mechanism: 'Stimulus Progression, 15-minute blocks of engineered music',
      cited: [A.name, B.name],
      members: [A, B], df: documentFrequency([A.text, B.text]), poolSize: 2,
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/restate one another/);
  });

  it('keeps "stimulus" whole', () => {
    const r = checkMechanism({
      mechanism: 'a hook that blocks a command',
      cited: ['Push gate fixed', 'Guardrail hook blocks deletes'],
      members, ...smallPool,
    });
    expect(r.ok).toBe(true);
    expect(checkMechanism({ mechanism: 'stimulus', cited: [A.name, PUSH.name], members: [A, PUSH], df: new Map(), poolSize: 2 }).sharedTerms)
      .not.toContain('stimulu');
  });
});
