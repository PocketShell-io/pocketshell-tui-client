/**
 * Styled text for the TUI: segments of plain text plus a style, measured in
 * terminal cells (wide CJK/emoji = 2, combining marks = 0), truncated with an
 * ellipsis, and serialized to ANSI only at the very end. Pure; no I/O.
 */

export type Style =
  | 'plain'
  | 'bold'
  | 'dim'
  | 'inverse'
  | 'yellow'
  | 'cyan'
  | 'cyanBold'
  | 'red'
  | 'redBold'
  | 'green'
  | 'magenta'
  | 'title'
  | 'key';

export interface Seg {
  text: string;
  style?: Style;
  /** Drawn inverted on top of its style (the selection bar). */
  invert?: boolean;
}

export type Line = Seg[];

/** `full`: colors + attributes; `mono` (NO_COLOR): attributes only; `none`: no escapes at all (tests). */
export type ColorMode = 'full' | 'mono' | 'none';

const SGR: Record<Style, { color: string; mono: string }> = {
  plain: { color: '', mono: '' },
  bold: { color: '1', mono: '1' },
  dim: { color: '2', mono: '2' },
  inverse: { color: '7', mono: '7' },
  yellow: { color: '33', mono: '' },
  cyan: { color: '36', mono: '' },
  cyanBold: { color: '1;36', mono: '1' },
  red: { color: '31', mono: '' },
  redBold: { color: '1;31', mono: '1' },
  green: { color: '32', mono: '' },
  magenta: { color: '35', mono: '' },
  title: { color: '1;35', mono: '1' },
  key: { color: '1;36', mono: '1' },
};

/** Terminal cell width of one code point. Good enough for box drawing, ●, CJK and common emoji. */
export function codePointWidth(cp: number): number {
  if (cp === 0) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x0483 && cp <= 0x0489) ||
    (cp >= 0x0591 && cp <= 0x05bd) ||
    (cp >= 0x0610 && cp <= 0x061a) ||
    (cp >= 0x064b && cp <= 0x065f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x2064) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    cp === 0xfeff ||
    (cp >= 0xe0100 && cp <= 0xe01ef)
  ) {
    return 0;
  }
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x231a && cp <= 0x231b) ||
    (cp >= 0x2329 && cp <= 0x232a) ||
    (cp >= 0x23e9 && cp <= 0x23ec) ||
    (cp >= 0x25fd && cp <= 0x25fe) ||
    (cp >= 0x2614 && cp <= 0x2615) ||
    (cp >= 0x2648 && cp <= 0x2653) ||
    (cp >= 0x26aa && cp <= 0x26ab) ||
    (cp >= 0x26bd && cp <= 0x26be) ||
    (cp >= 0x2705 && cp <= 0x2705) ||
    (cp >= 0x274c && cp <= 0x274c) ||
    (cp >= 0x2753 && cp <= 0x2755) ||
    (cp >= 0x2795 && cp <= 0x2797) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x1fa70 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** Cell width of plain text (no escape sequences). */
export function textWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += codePointWidth(ch.codePointAt(0)!);
  return width;
}

export function lineWidth(line: Line): number {
  let width = 0;
  for (const seg of line) width += textWidth(seg.text);
  return width;
}

/** Replace control characters (tabs, escapes, CR) with something printable and harmless. */
export function sanitize(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\t/g, '  ').replace(/[\x00-\x08\x0a-\x1f\x7f\x80-\x9f]/g, '');
}

/** The first `width` cells of `text`; a wide char that would straddle the edge becomes a space. */
export function takeCells(text: string, width: number): string {
  if (width <= 0) return '';
  let out = '';
  let used = 0;
  for (const ch of text) {
    const w = codePointWidth(ch.codePointAt(0)!);
    if (used + w > width) {
      if (used < width) out += ' '.repeat(width - used);
      return out;
    }
    out += ch;
    used += w;
  }
  return out;
}

/** Truncate plain text to `width` cells, ending in `…` when it had to cut. */
export function truncate(text: string, width: number): string {
  if (width <= 0) return '';
  if (textWidth(text) <= width) return text;
  if (width === 1) return '…';
  const head = takeCells(text, width - 1);
  return `${head}${' '.repeat(Math.max(0, width - 1 - textWidth(head)))}…`;
}

/** Pad (or truncate) plain text to exactly `width` cells. */
export function padEnd(text: string, width: number): string {
  const cut = truncate(text, width);
  return cut + ' '.repeat(Math.max(0, width - textWidth(cut)));
}

export function padStart(text: string, width: number): string {
  const cut = truncate(text, width);
  return ' '.repeat(Math.max(0, width - textWidth(cut))) + cut;
}

/** Shorten a path from the left: `…/git/pocketshell-core`. */
export function truncateLeft(text: string, width: number): string {
  if (width <= 0) return '';
  if (textWidth(text) <= width) return text;
  if (width === 1) return '…';
  const chars = Array.from(text);
  let used = 0;
  let start = chars.length;
  while (start > 0) {
    const w = codePointWidth(chars[start - 1]!.codePointAt(0)!);
    if (used + w > width - 1) break;
    used += w;
    start -= 1;
  }
  return `…${chars.slice(start).join('')}`;
}

/** Word-wrap plain text into lines of at most `width` cells (long words are hard-broken). */
export function wrap(text: string, width: number): string[] {
  if (width <= 0) return [];
  const lines: string[] = [];
  let current = '';
  const push = () => {
    lines.push(current);
    current = '';
  };
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let rest = word;
    while (textWidth(rest) > width) {
      if (current) push();
      const head = takeCells(rest, width);
      lines.push(head);
      rest = Array.from(rest).slice(Array.from(head).length).join('');
    }
    if (!rest) continue;
    if (!current) current = rest;
    else if (textWidth(current) + 1 + textWidth(rest) <= width) current += ` ${rest}`;
    else {
      push();
      current = rest;
    }
  }
  if (current) push();
  return lines;
}

/** Fit a styled line into exactly `width` cells: truncate with `…`, then pad with spaces. */
export function fitLine(line: Line, width: number, fill?: Seg): Line {
  const total = lineWidth(line);
  if (total <= width) {
    const pad = width - total;
    if (pad === 0) return line;
    return [...line, { text: ' '.repeat(pad), style: fill?.style, invert: fill?.invert }];
  }
  const out: Line = [];
  let budget = width - 1;
  let lastStyle: Seg | undefined;
  for (const seg of line) {
    if (budget <= 0) break;
    const w = textWidth(seg.text);
    lastStyle = seg;
    if (w <= budget) {
      out.push(seg);
      budget -= w;
    } else {
      const cut = takeCells(seg.text, budget);
      out.push({ ...seg, text: cut });
      budget -= textWidth(cut);
      break;
    }
  }
  if (budget > 0) out.push({ text: ' '.repeat(budget), style: lastStyle?.style, invert: lastStyle?.invert });
  if (width >= 1) out.push({ text: '…', style: lastStyle?.style ?? 'plain', invert: lastStyle?.invert });
  return out;
}

/** Cells [from, to) of a styled line (wide chars split at the edges become spaces). */
export function sliceLine(line: Line, from: number, to: number): Line {
  const out: Line = [];
  let col = 0;
  for (const seg of line) {
    let text = '';
    for (const ch of seg.text) {
      const w = codePointWidth(ch.codePointAt(0)!);
      const start = col;
      const end = col + w;
      col = end;
      if (end <= from || start >= to) continue;
      if (start < from || end > to) text += ' '.repeat(Math.min(end, to) - Math.max(start, from));
      else text += ch;
    }
    if (text) out.push({ ...seg, text });
    if (col >= to) break;
  }
  return out;
}

/** Paint `top` over `base` starting at column `col` (both lines already `width` cells). */
export function overlayLine(base: Line, top: Line, col: number, width: number): Line {
  const topWidth = lineWidth(top);
  return [...sliceLine(base, 0, col), ...top, ...sliceLine(base, col + topWidth, width)];
}

function sgrFor(seg: Seg, mode: ColorMode): string {
  if (mode === 'none') return '';
  const codes: string[] = [];
  const style = SGR[seg.style ?? 'plain'];
  const code = mode === 'full' ? style.color : style.mono;
  if (code) codes.push(code);
  if (seg.invert) codes.push('7');
  return codes.length ? `\x1b[${codes.join(';')}m` : '';
}

/** Serialize a styled line to a string with SGR escapes (or none). */
export function toAnsi(line: Line, mode: ColorMode): string {
  let out = '';
  for (const seg of line) {
    if (!seg.text) continue;
    const sgr = sgrFor(seg, mode);
    out += sgr ? `${sgr}${seg.text}\x1b[0m` : seg.text;
  }
  return out;
}

/** Plain text of a styled line (tests, debugging). */
export function toPlain(line: Line): string {
  return line.map((seg) => seg.text).join('');
}
