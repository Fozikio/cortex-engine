/**
 * table.ts — aligned columns.
 *
 * Column widths are measured on visible text so styled cells stay aligned,
 * and the last column is never padded (trailing whitespace shows up in diffs
 * and copied output).
 */

import { visibleWidth } from './color.js';
import { truncate } from './symbols.js';

export interface Column {
  header?: string;
  /** Fixed width. Omit to size from content. */
  width?: number;
  align?: 'left' | 'right';
}

export interface TableOptions {
  columns?: Column[];
  indent?: number;
  gap?: number;
  /** Total budget; columns are trimmed to fit. Defaults to terminal width. */
  maxWidth?: number;
}

/** Render `rows` as aligned columns. Returns the block without a trailing newline. */
export function table(rows: string[][], opts: TableOptions = {}): string {
  if (rows.length === 0) return '';

  const indent = opts.indent ?? 2;
  const gap = opts.gap ?? 2;
  const columns = opts.columns ?? [];
  const colCount = Math.max(...rows.map((r) => r.length));

  const header = columns.some((col) => col.header);
  const body = header ? [columns.map((col) => col.header ?? ''), ...rows] : rows;

  // Natural width per column, honouring any fixed widths.
  const widths: number[] = [];
  for (let i = 0; i < colCount; i++) {
    const fixed = columns[i]?.width;
    widths[i] = fixed ?? Math.max(...body.map((r) => visibleWidth(r[i] ?? '')));
  }

  // Shrink the widest flexible column until the row fits the budget.
  const budget = opts.maxWidth ?? process.stdout.columns ?? 80;
  const rowWidth = () => indent + widths.reduce((a, b) => a + b, 0) + gap * (colCount - 1);
  while (rowWidth() > budget) {
    let widest = -1;
    for (let i = 0; i < colCount; i++) {
      if (columns[i]?.width !== undefined) continue;
      if (widest === -1 || widths[i] > widths[widest]) widest = i;
    }
    if (widest === -1 || widths[widest] <= 4) break;
    widths[widest] -= 1;
  }

  return body
    .map((row) => {
      const cells: string[] = [];
      for (let i = 0; i < colCount; i++) {
        const raw = row[i] ?? '';
        const cell = visibleWidth(raw) > widths[i] ? truncate(raw, widths[i]) : raw;
        const pad = Math.max(0, widths[i] - visibleWidth(cell));
        // Never pad the final column.
        if (i === colCount - 1) cells.push(columns[i]?.align === 'right' ? ' '.repeat(pad) + cell : cell);
        else cells.push(columns[i]?.align === 'right' ? ' '.repeat(pad) + cell : cell + ' '.repeat(pad));
      }
      return ' '.repeat(indent) + cells.join(' '.repeat(gap)).trimEnd();
    })
    .join('\n');
}
