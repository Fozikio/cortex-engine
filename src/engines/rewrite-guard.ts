/**
 * Rewrite guard (#98, after #86).
 *
 * A damaging rewrite has the same signature whichever phase writes it: a
 * number, date or quotation from the old definition is gone; first person
 * became third; the memory's name is restated as an opener ("Interrogation:
 * Gemini Asks Hard Questions — A process where…"); a capitalised entity
 * appears that neither the old definition nor the evidence mentions; or a
 * qualifier is added that nothing in the evidence contains ("but only in
 * configurations where the runtime explicitly supports…"). These are the
 * checks the post-dream diff ran by hand on one live store. Running them
 * before the write means the old definition is kept and no belief-history
 * row is spent on the damage.
 */

export interface RewriteGuardInput {
  /** The memory's name, to catch it being restated as the opener. */
  name: string;
  /** The definition as stored. */
  old: string;
  /** The proposed replacement. */
  next: string;
  /** Texts the rewrite may legitimately draw entities and qualifiers from. */
  evidence?: string[];
}

export interface RewriteGuardResult {
  /** True when the rewrite keeps everything the old definition committed to. */
  ok: boolean;
  /** One entry per tripped check, in the order checked. */
  reasons: string[];
}

const BOILERPLATE_OPENER = /^(this|the) (concept|memory|belief|refined concept|insight|pattern)\b|^concept [ab]\b/i;
const NUMBER = /\b\d[\d.,%:/-]*\b/g;
const QUOTE = /["“][^"”]{3,}["”]/g;
const FIRST_PERSON = /\b(I|I'm|I've|I'd|I'll|my|me|mine|myself)\b/g;
const CAPITALISED = /\b[A-Z][A-Za-z0-9#.-]{2,}\b/g;

/** Sentence-starters and function words that are capitalised without naming anything. */
const STOP_CAPS = new Set([
  'The', 'This', 'That', 'These', 'Those', 'When', 'What', 'Which', 'Where', 'While', 'After', 'Before',
  'Both', 'Each', 'Every', 'From', 'With', 'Without', 'Since', 'Then', 'There', 'They', 'Their', 'Them',
  'Because', 'However', 'Instead', 'Also', 'Only', 'Some', 'Many', 'Most', 'More', 'Such', 'Over', 'Under',
  'Into', 'Given', 'And', 'But', 'For', 'Not', 'Its', 'Our', 'You', 'Your', 'His', 'Her', 'She', 'Who',
  'How', 'Why', 'Yes', 'Now', 'Here', 'Thus', 'Hence', 'Although', 'Though', 'Unless', 'Until', 'Once',
  'Still', 'Even', 'Just', 'Like', 'Rather', 'Whether', 'Beyond', 'Within', 'Across', 'Among', 'Between',
  'During', 'Through', 'Toward', 'Towards', 'Upon', 'About', 'Above', 'Below', 'Behind', 'Around', 'Along',
  'Against', 'Despite', 'Except', 'Including', 'Regarding', 'Perhaps', 'Maybe', 'Often', 'Sometimes',
  'Usually', 'Always', 'Never', 'Already', 'Another', 'Any', 'All', 'One', 'Two', 'Three', 'First',
  'Second', 'Third', 'New', 'Old', 'Nothing', 'Something', 'Everything', 'Anything', 'Someone', 'Later',
  'Earlier', 'Today', 'Tonight', 'Yesterday', 'Tomorrow', 'Meanwhile', 'Otherwise', 'Therefore', 'Yet',
]);

/** Qualifiers a reviewer adds when it has nothing concrete to say. */
const HEDGE = /\b(?:may|might|could) (?:not|only|vary|depend|differ)\b|\bbut only\b|\bin (?:some|certain|specific|particular) (?:cases|contexts|configurations|situations|environments|circumstances)\b|\bdepending on\b|\bnot necessarily\b|\bpotentially\b|\backnowledg(?:e|es|ed|ing)\b|\b(?:it is|it's) (?:important|worth) (?:to note|noting)\b|\bgenerally\b|\btypically\b|\bin general\b|\bwhere (?:supported|applicable|available)\b|\bsubject to\b|\bto some extent\b|\bas a construct\b/gi;

const numbers = (s: string): string[] => s.match(NUMBER) ?? [];
const quotes = (s: string): string[] => (s.match(QUOTE) ?? []).map((q) => q.slice(1, -1));
const firstPerson = (s: string): number => (s.match(FIRST_PERSON) ?? []).length;
const hedges = (s: string): Set<string> => new Set((s.match(HEDGE) ?? []).map((h) => h.toLowerCase()));
const entities = (s: string): Set<string> =>
  new Set((s.match(CAPITALISED) ?? []).filter((w) => !STOP_CAPS.has(w)));

/** True when `text` opens with `name` followed by a separator or a copula. */
function opensWithName(text: string, name: string): boolean {
  const n = name.trim();
  if (!n || !text.toLowerCase().startsWith(n.toLowerCase())) return false;
  return /^\s*(?:[:—–-]|\bis\b|\brefers\b|\bdescribes\b|\bmeans\b)/.test(text.slice(n.length));
}

/**
 * Check a proposed definition against the one it replaces. Anything the old
 * definition committed to — its numbers, quotations, voice, and the entities
 * it names — must survive; anything new must come from the evidence.
 */
export function checkRewrite(input: RewriteGuardInput): RewriteGuardResult {
  const { name, old } = input;
  const next = input.next.trim();
  const evidence = (input.evidence ?? []).join(' ');
  const reasons: string[] = [];

  if (BOILERPLATE_OPENER.test(next)) reasons.push('boilerplate opener');
  if (opensWithName(next, name) && !opensWithName(old, name)) reasons.push('name restated as opener');

  const lostNumbers = numbers(old).filter((x) => !next.includes(x));
  if (lostNumbers.length > 0) reasons.push(`dropped numbers: ${lostNumbers.slice(0, 5).join(' ')}`);

  const lostQuotes = quotes(old).filter((q) => !next.includes(q));
  if (lostQuotes.length > 0) reasons.push(`dropped quotations: ${lostQuotes.length}`);

  if (firstPerson(old) > 0 && firstPerson(next) === 0) reasons.push('first person became third person');

  const known = entities(`${old} ${evidence}`);
  const foreign = [...entities(next)].filter((w) => !known.has(w));
  if (foreign.length > 0) reasons.push(`new entities: ${foreign.slice(0, 8).join(', ')}`);

  const allowed = hedges(`${old} ${evidence}`);
  const added = [...hedges(next)].filter((h) => !allowed.has(h));
  if (added.length > 0) reasons.push(`added hedges: ${added.slice(0, 5).join(', ')}`);

  return { ok: reasons.length === 0, reasons };
}
