/**
 * Hygiene for text and JSON that come from the gateway (untrusted).
 *
 * - sanitizeRemoteText: make server-provided text safe to print on a
 *   terminal (port of tokens.py `sanitize_remote_text`).
 * - parseStrictJson: JSON.parse with duplicate-key rejection and a
 *   float/int distinction, so control frames can be checked as strictly as
 *   the Python CLI does (`object_pairs_hook` + `type(v) is int`).
 */

// ESC-introduced sequences: CSI, OSC (BEL/ST-terminated), DCS/SOS/PM/APC, two-byte escapes.
const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[PX^_][^\x1b]*(?:\x1b\\)?|[ -/]*[0-~])/g;

export const REMOTE_TEXT_LIMIT = 200;

/**
 * Remove ANSI/VT sequences, then every Unicode control/format/surrogate/
 * private-use/unassigned character and line/paragraph separators; fold
 * whitespace to single spaces on one line; cap the length.
 */
export function sanitizeRemoteText(text: unknown, limit = REMOTE_TEXT_LIMIT): string {
  if (typeof text !== 'string') return '';
  const stripped = text.replace(ANSI_RE, '');
  let kept = '';
  for (const ch of stripped) {
    if ('\t\n\r\v\f'.includes(ch)) kept += ' ';
    else if (/^[\p{C}\p{Zl}\p{Zp}]$/u.test(ch)) continue;
    else if (/^\p{Zs}$/u.test(ch)) kept += ' ';
    else kept += ch;
  }
  const out = kept.split(/\s+/u).filter(Boolean).join(' ');
  const chars = [...out];
  if (chars.length > limit) return `${chars.slice(0, Math.max(0, limit - 1)).join('')}…`;
  return out;
}

// --- strict JSON ------------------------------------------------------------

/** A number written with a fraction or exponent (`1.0`, `1e0`): not an integer literal. */
export class JsonFloat {
  constructor(readonly value: number) {}
}

export type StrictJson = null | boolean | number | JsonFloat | string | StrictJson[] | { [key: string]: StrictJson };

export class StrictJsonError extends Error {}

const MAX_DEPTH = 64;

/**
 * Parse RFC 8259 JSON strictly: no duplicate object keys, no trailing
 * garbage, bounded nesting. Integer literals become numbers, other numbers
 * JsonFloat. Throws StrictJsonError.
 */
export function parseStrictJson(text: string): StrictJson {
  let pos = 0;
  const fail = (what: string): never => {
    throw new StrictJsonError(`${what} at offset ${pos}`);
  };
  const ws = () => {
    while (pos < text.length && ' \t\n\r'.includes(text[pos]!)) pos++;
  };
  const value = (depth: number): StrictJson => {
    if (depth > MAX_DEPTH) fail('nesting too deep');
    ws();
    const c = text[pos];
    if (c === '{') {
      pos++;
      const obj: { [key: string]: StrictJson } = Object.create(null);
      const seen = new Set<string>();
      ws();
      if (text[pos] === '}') {
        pos++;
        return obj;
      }
      for (;;) {
        ws();
        if (text[pos] !== '"') fail('expected a string key');
        const key = string();
        if (seen.has(key)) fail('duplicate key');
        seen.add(key);
        ws();
        if (text[pos] !== ':') fail("expected ':'");
        pos++;
        obj[key] = value(depth + 1);
        ws();
        if (text[pos] === ',') {
          pos++;
          continue;
        }
        if (text[pos] === '}') {
          pos++;
          return obj;
        }
        fail("expected ',' or '}'");
      }
    }
    if (c === '[') {
      pos++;
      const arr: StrictJson[] = [];
      ws();
      if (text[pos] === ']') {
        pos++;
        return arr;
      }
      for (;;) {
        arr.push(value(depth + 1));
        ws();
        if (text[pos] === ',') {
          pos++;
          continue;
        }
        if (text[pos] === ']') {
          pos++;
          return arr;
        }
        fail("expected ',' or ']'");
      }
    }
    if (c === '"') return string();
    if (text.startsWith('true', pos)) {
      pos += 4;
      return true;
    }
    if (text.startsWith('false', pos)) {
      pos += 5;
      return false;
    }
    if (text.startsWith('null', pos)) {
      pos += 4;
      return null;
    }
    const m = /^-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(text.slice(pos, pos + 400));
    if (!m) return fail('unexpected character');
    pos += m[0].length;
    const n = Number(m[0]);
    if (!Number.isFinite(n)) fail('number out of range');
    return m[1] || m[2] ? new JsonFloat(n) : n;
  };
  const string = (): string => {
    const start = pos;
    pos++; // opening quote
    for (;;) {
      if (pos >= text.length) fail('unterminated string');
      const ch = text.charCodeAt(pos);
      if (ch === 0x22) break;
      if (ch < 0x20) fail('control character in string');
      if (ch === 0x5c) {
        const esc = text[pos + 1];
        if (esc === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(pos + 2, pos + 6))) fail('bad \\u escape');
          pos += 6;
          continue;
        }
        if (esc === undefined || !'"\\/bfnrt'.includes(esc)) fail('bad escape');
        pos += 2;
        continue;
      }
      pos++;
    }
    pos++; // closing quote
    return JSON.parse(text.slice(start, pos)) as string;
  };
  const result = value(0);
  ws();
  if (pos !== text.length) fail('trailing data');
  return result;
}

export function isPlainObject(value: StrictJson): value is { [key: string]: StrictJson } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof JsonFloat);
}
