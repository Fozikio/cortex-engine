/**
 * box.ts — box-drawing helpers.
 *
 * Generalises the ASCII box that health-cmd.ts previously carried inline, so
 * health, doctor, status and the dashboard all draw the same frame. Widths are
 * computed on visible text, so styled content stays aligned.
 */

import { visibleWidth } from './color.js';
import { truncate } from './symbols.js';

export interface BoxChars {
  tl: string; tr: string; bl: string; br: string;
  h: string; v: string;
  lt: string; rt: string;
}

/** Double-rule frame — matches the existing `fozikio health` output. */
export const DOUBLE: BoxChars = {
  tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║', lt: '╠', rt: '╣',
};

/** Single-rule frame — lighter, used by the dashboard. */
export const SINGLE: BoxChars = {
  tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│', lt: '├', rt: '┤',
};

/** ASCII frame for terminals that cannot draw box characters. */
export const ASCII: BoxChars = {
  tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|', lt: '+', rt: '+',
};

export class Box {
  private readonly lines: string[] = [];

  /** @param width Inner width, between the vertical rules. */
  constructor(
    private readonly width = 52,
    private readonly chars: BoxChars = DOUBLE,
  ) {}

  /** Pad to the inner width using visible length, so styling does not skew it. */
  private pad(content: string): string {
    const gap = Math.max(0, this.width - visibleWidth(content));
    return content + ' '.repeat(gap);
  }

  /** Top rule, optionally with an inline title: ┌ title ────┐ */
  top(title?: string): this {
    if (!title) {
      this.lines.push(this.chars.tl + this.chars.h.repeat(this.width) + this.chars.tr);
      return this;
    }
    const label = ` ${truncate(title, Math.max(0, this.width - 4))} `;
    const fill = Math.max(0, this.width - visibleWidth(label) - 1);
    this.lines.push(
      this.chars.tl + this.chars.h + label + this.chars.h.repeat(fill) + this.chars.tr,
    );
    return this;
  }

  bottom(): this {
    this.lines.push(this.chars.bl + this.chars.h.repeat(this.width) + this.chars.br);
    return this;
  }

  divider(): this {
    this.lines.push(this.chars.lt + this.chars.h.repeat(this.width) + this.chars.rt);
    return this;
  }

  /** A centred section heading. */
  heading(title: string): this {
    const label = ` ${title} `;
    const total = Math.max(0, this.width - visibleWidth(label));
    const left = Math.floor(total / 2);
    return this.raw(' '.repeat(left) + label + ' '.repeat(total - left));
  }

  /** A label/value pair at a fixed indent. */
  row(label: string, value: string, indent = 2, labelWidth = 28): this {
    const gap = Math.max(1, labelWidth - visibleWidth(label));
    return this.raw(' '.repeat(indent) + label + ' '.repeat(gap) + value);
  }

  /** A label/value pair nested one level deeper. */
  subrow(label: string, value: string): this {
    return this.row(label, value, 4, 26);
  }

  /** Free-form content, padded and framed. */
  raw(content: string): this {
    this.lines.push(this.chars.v + this.pad(content) + this.chars.v);
    return this;
  }

  /** An empty framed line. */
  blank(): this {
    return this.raw('');
  }

  toString(): string {
    return this.lines.join('\n');
  }

  print(stream: NodeJS.WriteStream = process.stdout): void {
    stream.write(this.toString() + '\n');
  }
}
