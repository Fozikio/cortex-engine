/**
 * Document chunking for digest (#96).
 *
 * The observe step used to window a long document at fixed character offsets:
 * the first 2,000 characters as a summary, then 500-character slices. Every
 * boundary fell wherever the count landed — mid-word, mid-sentence — and each
 * slice was embedded, prediction-error gated and stored as a declarative
 * observation. On one live store two of five sampled observations began
 * mid-word ("ing the model the neighbour…", "l through to its heuristic…").
 * A memory minted from a fragment is not a memory of anything.
 *
 * Chunks now close on paragraph boundaries, fall back to sentence boundaries
 * when a paragraph is longer than the target, and split on whitespace only
 * when a single sentence is. A chunk shorter than `min_chars` is merged into
 * its neighbour rather than stored alone. Sizes are targets, not limits: a
 * boundary beats a byte count.
 */

export interface ChunkOptions {
  /** Target size of the leading chunk, stored at full salience (default 2000). */
  head_chars?: number;
  /** Target size of each following chunk (default 600). */
  chunk_chars?: number;
  /** A chunk shorter than this is merged into a neighbour (default 120). */
  min_chars?: number;
}

export interface ChunkedDocument {
  /** The leading chunk: whole paragraphs from the top, up to about head_chars. */
  head: string;
  /** The rest of the document in boundary-aligned chunks. */
  chunks: string[];
}

interface Unit {
  text: string;
  /** Index of the paragraph the unit came from — units from one paragraph rejoin with a space. */
  para: number;
}

/** A sentence ends at . ! ? or … optionally followed by closing quotes/brackets, then whitespace. */
const SENTENCE_BREAK = /(?<=[.!?…][)"”'\]]*)\s+(?=\S)/;

export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n[ \t]*\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

export function splitSentences(text: string): string[] {
  return text
    .split(SENTENCE_BREAK)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Split on whitespace so no piece exceeds `max`; never inside a word. */
function splitWords(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf(' ', max);
    if (cut <= 0) cut = rest.indexOf(' ', max); // one token longer than max: take it whole
    if (cut <= 0) break;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

/** Paragraphs as units; a paragraph over the target becomes sentence units; a sentence over it, word-bounded pieces. */
function toUnits(body: string, target: number): Unit[] {
  const units: Unit[] = [];
  splitParagraphs(body).forEach((para, i) => {
    if (para.length <= target) {
      units.push({ text: para, para: i });
      return;
    }
    for (const sentence of splitSentences(para)) {
      if (sentence.length <= target) {
        units.push({ text: sentence, para: i });
      } else {
        for (const piece of splitWords(sentence, target)) units.push({ text: piece, para: i });
      }
    }
  });
  return units;
}

function joinUnits(units: Unit[]): string {
  let out = '';
  for (let i = 0; i < units.length; i++) {
    if (i === 0) {
      out = units[i].text;
      continue;
    }
    out += (units[i].para === units[i - 1].para ? ' ' : '\n\n') + units[i].text;
  }
  return out;
}

/** Greedy packing: a group closes when the next unit would push it past `target`. Groups are never empty. */
function pack(units: Unit[], target: number): Unit[][] {
  const groups: Unit[][] = [];
  let current: Unit[] = [];
  for (const unit of units) {
    if (current.length > 0 && joinUnits([...current, unit]).length > target) {
      groups.push(current);
      current = [];
    }
    current.push(unit);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * Split a document into a head and boundary-aligned chunks. Every chunk
 * starts at a paragraph or sentence start (or, for a sentence longer than the
 * target, at a word start), and no chunk shorter than `min_chars` is emitted
 * while it has a neighbour to join.
 */
export function chunkDocument(body: string, options: ChunkOptions = {}): ChunkedDocument {
  const headChars = options.head_chars ?? 2000;
  const chunkChars = options.chunk_chars ?? 600;
  const minChars = options.min_chars ?? 120;

  const units = toUnits(body, Math.min(chunkChars, headChars));
  if (units.length === 0) return { head: '', chunks: [] };

  // Head: whole units from the top until the next would pass head_chars; at least one.
  const headUnits: Unit[] = [];
  for (const unit of units) {
    if (headUnits.length > 0 && joinUnits([...headUnits, unit]).length > headChars) break;
    headUnits.push(unit);
  }

  const groups = pack(units.slice(headUnits.length), chunkChars);

  // Fragments join the previous group; a short first group joins the next one.
  const merged: Unit[][] = [];
  for (const group of groups) {
    if (merged.length > 0 && joinUnits(group).length < minChars) {
      merged[merged.length - 1].push(...group);
    } else {
      merged.push(group);
    }
  }
  if (merged.length >= 2 && joinUnits(merged[0]).length < minChars) {
    const first = merged.shift() as Unit[];
    merged[0].unshift(...first);
  }

  // A lone trailing fragment with no chunk to join goes into the head.
  if (merged.length === 1 && joinUnits(merged[0]).length < minChars) {
    return { head: joinUnits([...headUnits, ...merged[0]]), chunks: [] };
  }

  return { head: joinUnits(headUnits), chunks: merged.map(joinUnits) };
}
