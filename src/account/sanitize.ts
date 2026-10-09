/**
 * Make server-provided strings safe to show in a terminal (port of the
 * Python CLI's `account/sanitize.py`).
 *
 * The broker (and anything between us and it) is not trusted to send benign
 * text: ESC sequences could rewrite the terminal and bidi/zero-width format
 * characters could disguise a URL. Everything a server returns goes through
 * `cleanText` before it is printed, and URLs we print or open must pass
 * `httpsUrl`.
 */
import { splitUrl } from './url.js';

const MAX_URL = 2048;
// Unicode C* (Cc, Cf, Cs, Co, Cn) plus line/paragraph separators.
const UNSAFE = /[\p{C}\u2028\u2029]/gu;

/**
 * Strip control/format/unassigned characters, trim, and cap the length (in
 * code points; an over-long value ends in `...`). Non-strings render as `""`.
 */
export function cleanText(value: unknown, maxLen = 200): string {
  if (typeof value !== 'string') return '';
  const text = value.replace(UNSAFE, '').trim();
  const chars = Array.from(text);
  if (chars.length > maxLen) return `${chars.slice(0, maxLen - 3).join('')}...`;
  return text;
}

/** True when every character is printable, non-space ASCII (0x21-0x7E). */
export function isPrintableAscii(value: string): boolean {
  return /^[\x21-\x7e]*$/.test(value);
}

/**
 * `value` unchanged if it is a plain, printable `https://host/...` URL, else
 * `null` (non-string, non-ASCII, whitespace/control, other scheme, userinfo,
 * no host, bad port, over-long).
 */
export function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > MAX_URL) return null;
  if (!isPrintableAscii(value)) return null;
  const parts = splitUrl(value);
  if (!parts || parts.scheme !== 'https' || !parts.hostname || parts.netloc.includes('@')) return null;
  return value;
}
