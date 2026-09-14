/**
 * Boundary-aligned chunking (#96).
 *
 * Fixed-offset windows stored mid-word fragments as observations. Every chunk
 * must now start where a paragraph or sentence starts, nothing shorter than a
 * sentence is stored alone, and the whole document is still covered.
 */

import { describe, it, expect } from 'vitest';
import { chunkDocument, splitParagraphs, splitSentences } from './chunk.js';

const SENTENCES = [
  'The intake was the fault, not the dream.',
  'Twenty-one journal entries sat in a collection the graph never read, so the March backfill was the only intake for six months.',
  'I fixed it three ways: a backfill script, a line in the session brief, and an engine issue for digest-on-write.',
  'The attended dream that followed minted the first memories from lived experience since April.',
  'It also exposed two new damage classes, which is what a measured fix is for.',
  'Nothing clean regressed.',
];

/** Build a multi-paragraph document of at least `minChars`, from real sentences. */
function document(minChars: number, perParagraph = 3): string {
  const paragraphs: string[] = [];
  let i = 0;
  let total = 0;
  while (total < minChars) {
    const sentences: string[] = [];
    for (let k = 0; k < perParagraph; k++) sentences.push(SENTENCES[(i++) % SENTENCES.length]);
    const p = sentences.join(' ');
    paragraphs.push(p);
    total += p.length + 2;
  }
  return paragraphs.join('\n\n');
}

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** True when `chunk` begins at a position in `body` that follows a sentence terminator, a paragraph break, or the start. */
function startsAtBoundary(body: string, chunk: string): boolean {
  const probe = chunk.slice(0, 40);
  const at = body.indexOf(probe);
  if (at < 0) return false;
  if (at === 0) return true;
  const prefix = body.slice(0, at);
  if (!/\s$/.test(prefix)) return false; // no whitespace before the chunk: it starts mid-word
  return /[.!?…][)"”'\]]*$/.test(prefix.replace(/\s+$/, ''));
}

describe('splitParagraphs / splitSentences', () => {
  it('splits on blank lines and trims', () => {
    expect(splitParagraphs('a\n\n  b  \n\n\nc\n')).toEqual(['a', 'b', 'c']);
  });

  it('splits on terminators followed by whitespace, keeping closing quotes with the sentence', () => {
    expect(splitSentences('He said "no." Then he left! Really? Yes… fine.'))
      .toEqual(['He said "no."', 'Then he left!', 'Really?', 'Yes…', 'fine.']);
  });

  it('does not split on a period inside a version or a file name', () => {
    expect(splitSentences('Since v2.1.64 the .mcp.json file is read. Done.'))
      .toEqual(['Since v2.1.64 the .mcp.json file is read.', 'Done.']);
  });
});

describe('chunkDocument', () => {
  it('starts every chunk at a paragraph or sentence boundary and covers the whole document', () => {
    const body = document(3200);
    expect(body.length).toBeGreaterThan(3000);
    const { head, chunks } = chunkDocument(body, { head_chars: 2000, chunk_chars: 600, min_chars: 120 });

    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of [head, ...chunks]) {
      expect(startsAtBoundary(body, chunk)).toBe(true);
      expect(chunk).toMatch(/[.!?…]$/);
      expect(chunk.length).toBeGreaterThanOrEqual(120);
    }
    expect(norm([head, ...chunks].join(' '))).toBe(norm(body));
  });

  it('never cuts at a fixed offset', () => {
    // 2,000 lands inside a word for this document; the old code stored the tail from there.
    const body = document(2600);
    const { head, chunks } = chunkDocument(body);
    expect(head.length).toBeLessThanOrEqual(2000);
    expect(head).not.toBe(body.slice(0, 2000));
    for (const chunk of chunks) expect(/^[A-Z"“(\[]/.test(chunk)).toBe(true);
  });

  it('keeps the head to whole paragraphs, at least one, within the target', () => {
    const body = document(3000);
    const paragraphs = splitParagraphs(body);
    const { head } = chunkDocument(body, { head_chars: 500 });
    const headParagraphs = splitParagraphs(head);
    expect(headParagraphs.length).toBeGreaterThanOrEqual(1);
    expect(headParagraphs).toEqual(paragraphs.slice(0, headParagraphs.length));
    expect(head.length).toBeLessThanOrEqual(500);
    expect(body.startsWith(head)).toBe(true);
  });

  it('falls back to sentence boundaries inside a paragraph longer than the target', () => {
    const long = Array.from({ length: 30 }, (_, i) => SENTENCES[i % SENTENCES.length]).join(' ');
    expect(long).not.toContain('\n');
    const { head, chunks } = chunkDocument(long, { head_chars: 600, chunk_chars: 400, min_chars: 80 });
    for (const chunk of [head, ...chunks]) {
      expect(startsAtBoundary(long, chunk)).toBe(true);
      expect(chunk).toMatch(/[.!?…]$/);
    }
    expect(norm([head, ...chunks].join(' '))).toBe(norm(long));
  });

  it('splits a sentence longer than the target on whitespace only', () => {
    const words = Array.from({ length: 300 }, (_, i) => `word${i}`).join(' ');
    const { head, chunks } = chunkDocument(words, { head_chars: 400, chunk_chars: 300, min_chars: 50 });
    for (const chunk of [head, ...chunks]) {
      const at = words.indexOf(chunk);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(at === 0 || words[at - 1] === ' ').toBe(true);
      const end = at + chunk.length;
      expect(end === words.length || words[end] === ' ').toBe(true);
    }
    expect(norm([head, ...chunks].join(' '))).toBe(norm(words));
  });

  it('merges a trailing fragment into the previous chunk instead of storing it alone', () => {
    const body = document(2800) + '\n\nSo I fixed it.';
    const { chunks } = chunkDocument(body);
    expect(chunks.some((c) => c === 'So I fixed it.')).toBe(false);
    expect(chunks[chunks.length - 1].endsWith('So I fixed it.')).toBe(true);
  });

  it('puts a lone fragment after the head into the head', () => {
    const body = document(1500) + '\n\nOne more line.';
    const { head, chunks } = chunkDocument(body, { head_chars: 2000 });
    expect(chunks).toEqual([]);
    expect(head.endsWith('One more line.')).toBe(true);
  });

  it('returns nothing for an empty document', () => {
    expect(chunkDocument('')).toEqual({ head: '', chunks: [] });
    expect(chunkDocument(' \n\n \n')).toEqual({ head: '', chunks: [] });
  });
});
