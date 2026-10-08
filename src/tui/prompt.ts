/** A tiny inline line editor: value + cursor, edited by parsed keys. Pure. */
import type { Key } from './keys.js';
import { codePointWidth, type Line, type Style } from './text.js';

export interface LineInput {
  /** Code points, so the cursor never lands inside a surrogate pair. */
  chars: string[];
  /** Insertion point, 0..chars.length. */
  cursor: number;
}

export type EditResult = { input: LineInput; done: 'submit' | 'cancel' | null };

export function lineInput(value = ''): LineInput {
  const chars = Array.from(value);
  return { chars, cursor: chars.length };
}

export function inputValue(input: LineInput): string {
  return input.chars.join('');
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && !/\s/.test(ch);
}

export function editLine(input: LineInput, key: Key): EditResult {
  const { chars, cursor } = input;
  const keep = (next: LineInput): EditResult => ({ input: next, done: null });
  if (key.name === 'enter') return { input, done: 'submit' };
  if (key.name === 'escape') return { input, done: 'cancel' };
  if (key.name === 'char' && key.ch !== undefined && !key.meta) {
    const inserted = Array.from(key.ch.replace(/[\r\n]+/g, ' '));
    return keep({ chars: [...chars.slice(0, cursor), ...inserted, ...chars.slice(cursor)], cursor: cursor + inserted.length });
  }
  if (key.name === 'backspace' || (key.ctrl && key.name === 'h')) {
    if (cursor === 0) return keep(input);
    return keep({ chars: [...chars.slice(0, cursor - 1), ...chars.slice(cursor)], cursor: cursor - 1 });
  }
  if (key.name === 'delete' || (key.ctrl && key.name === 'd')) {
    if (cursor >= chars.length) return keep(input);
    return keep({ chars: [...chars.slice(0, cursor), ...chars.slice(cursor + 1)], cursor });
  }
  if (key.name === 'left' || (key.ctrl && key.name === 'b')) return keep({ chars, cursor: Math.max(0, cursor - 1) });
  if (key.name === 'right' || (key.ctrl && key.name === 'f')) return keep({ chars, cursor: Math.min(chars.length, cursor + 1) });
  if (key.name === 'home' || (key.ctrl && key.name === 'a')) return keep({ chars, cursor: 0 });
  if (key.name === 'end' || (key.ctrl && key.name === 'e')) return keep({ chars, cursor: chars.length });
  if (key.ctrl && key.name === 'u') return keep({ chars: chars.slice(cursor), cursor: 0 });
  if (key.ctrl && key.name === 'k') return keep({ chars: chars.slice(0, cursor), cursor });
  if (key.ctrl && key.name === 'w') {
    let start = cursor;
    while (start > 0 && !isWordChar(chars[start - 1])) start -= 1;
    while (start > 0 && isWordChar(chars[start - 1])) start -= 1;
    return keep({ chars: [...chars.slice(0, start), ...chars.slice(cursor)], cursor: start });
  }
  return keep(input);
}

/**
 * Render `label` + the input into `width` cells with a drawn (inverse)
 * cursor, scrolling horizontally so the cursor stays visible.
 */
export function renderInput(label: string, labelStyle: Style, input: LineInput, width: number, placeholder = ''): Line {
  const labelWidth = Array.from(label).reduce((sum, ch) => sum + codePointWidth(ch.codePointAt(0)!), 0);
  const room = Math.max(1, width - labelWidth);
  const widths = input.chars.map((ch) => codePointWidth(ch.codePointAt(0)!));
  // Choose the first visible char so [start, cursor] (plus the cursor cell) fits.
  let start = 0;
  let span = widths.slice(0, input.cursor).reduce((a, b) => a + b, 0) + 1;
  while (span > room && start < input.cursor) {
    span -= widths[start]!;
    start += 1;
  }
  const line: Line = [{ text: label, style: labelStyle }];
  let used = 0;
  let before = '';
  for (let i = start; i < input.cursor; i += 1) {
    before += input.chars[i];
    used += widths[i]!;
  }
  line.push({ text: before });
  const under = input.chars[input.cursor] ?? ' ';
  line.push({ text: under, invert: true });
  used += input.cursor < input.chars.length ? widths[input.cursor]! : 1;
  let after = '';
  for (let i = input.cursor + 1; i < input.chars.length; i += 1) {
    if (used + widths[i]! > room) break;
    after += input.chars[i];
    used += widths[i]!;
  }
  if (after) line.push({ text: after });
  if (input.chars.length === 0 && placeholder) line.push({ text: placeholder.slice(0, Math.max(0, room - 1)), style: 'dim' });
  return line;
}
