/**
 * Strict JSON decoding for broker responses and the credentials file (port of
 * `jsonutil.py`): rejects invalid UTF-8, a BOM, duplicate object keys, and
 * nesting deeper than 32. (JSON has no NaN/Infinity literals, so the JS
 * grammar already rejects them.) Error messages never contain the input.
 */

export class StrictJSONError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StrictJSONError';
  }
}

const MAX_DEPTH = 32;
const WS = /[ \t\n\r]*/y;
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const STRING = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;

class Parser {
  pos = 0;
  constructor(private readonly text: string) {}

  private skip(): void {
    WS.lastIndex = this.pos;
    WS.exec(this.text);
    this.pos = WS.lastIndex;
  }

  private match(re: RegExp): string | null {
    re.lastIndex = this.pos;
    const m = re.exec(this.text);
    if (!m) return null;
    this.pos = re.lastIndex;
    return m[0];
  }

  private literal(word: string): boolean {
    if (this.text.startsWith(word, this.pos)) {
      this.pos += word.length;
      return true;
    }
    return false;
  }

  private string(): string {
    const raw = this.match(STRING);
    if (raw === null) throw new StrictJSONError('malformed JSON');
    return JSON.parse(raw) as string;
  }

  value(depth: number): unknown {
    if (depth > MAX_DEPTH) throw new StrictJSONError('too deeply nested');
    this.skip();
    const ch = this.text[this.pos];
    if (ch === '{') {
      this.pos++;
      // defineProperty: a "__proto__" key stays an ordinary own property.
      const out: Record<string, unknown> = {};
      const seen = new Set<string>();
      this.skip();
      if (this.text[this.pos] === '}') {
        this.pos++;
        return out;
      }
      for (;;) {
        this.skip();
        const key = this.string();
        if (seen.has(key)) throw new StrictJSONError('duplicate key');
        seen.add(key);
        this.skip();
        if (this.text[this.pos] !== ':') throw new StrictJSONError('malformed JSON');
        this.pos++;
        const value = this.value(depth + 1);
        Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
        this.skip();
        const sep = this.text[this.pos++];
        if (sep === '}') break;
        if (sep !== ',') throw new StrictJSONError('malformed JSON');
      }
      return out;
    }
    if (ch === '[') {
      this.pos++;
      const out: unknown[] = [];
      this.skip();
      if (this.text[this.pos] === ']') {
        this.pos++;
        return out;
      }
      for (;;) {
        out.push(this.value(depth + 1));
        this.skip();
        const sep = this.text[this.pos++];
        if (sep === ']') break;
        if (sep !== ',') throw new StrictJSONError('malformed JSON');
      }
      return out;
    }
    if (ch === '"') return this.string();
    if (this.literal('true')) return true;
    if (this.literal('false')) return false;
    if (this.literal('null')) return null;
    const num = this.match(NUMBER);
    if (num === null) throw new StrictJSONError('malformed JSON');
    const value = Number(num);
    if (!Number.isFinite(value)) throw new StrictJSONError('non-finite number');
    return value;
  }

  document(): unknown {
    const value = this.value(0);
    this.skip();
    if (this.pos !== this.text.length) throw new StrictJSONError('malformed JSON');
    return value;
  }
}

/** Parse strict JSON text (already decoded). */
export function parseStrict(text: string): unknown {
  if (text.startsWith('\ufeff')) throw new StrictJSONError('byte-order mark');
  return new Parser(text).document();
}

/** Decode UTF-8 bytes strictly and parse them as strict JSON. */
export function loadsStrict(raw: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    throw new StrictJSONError('not UTF-8');
  }
  return parseStrict(text);
}

/** A non-null, non-array object. */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
