/**
 * A small `urllib.parse.urlsplit` look-alike, so URL validation and broker-URL
 * normalization behave exactly like the Python CLI's (the WHATWG `URL` parser
 * normalizes too much: it drops default ports, percent-encodes, accepts
 * backslashes).
 */
import { isIPv6 } from 'node:net';

export interface UrlParts {
  /** Lower-cased scheme ('' when none). */
  scheme: string;
  /** Raw authority (between `//` and the path), userinfo included. */
  netloc: string;
  /** Lower-cased host without brackets; null when empty. */
  hostname: string | null;
  /** Explicit port, or null. */
  port: number | null;
  path: string;
  query: string;
  fragment: string;
}

/** Split `url` like Python's urlsplit; null where Python raises ValueError. */
export function splitUrl(url: string): UrlParts | null {
  let rest = url;
  let scheme = '';
  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(rest);
  if (schemeMatch) {
    scheme = schemeMatch[1]!.toLowerCase();
    rest = rest.slice(schemeMatch[0].length);
  }
  let netloc = '';
  if (rest.startsWith('//')) {
    rest = rest.slice(2);
    const end = rest.search(/[/?#]/);
    netloc = end === -1 ? rest : rest.slice(0, end);
    rest = end === -1 ? '' : rest.slice(end);
    if (netloc.includes('[') !== netloc.includes(']')) return null;
  }
  let fragment = '';
  const hash = rest.indexOf('#');
  if (hash !== -1) {
    fragment = rest.slice(hash + 1);
    rest = rest.slice(0, hash);
  }
  let query = '';
  const q = rest.indexOf('?');
  if (q !== -1) {
    query = rest.slice(q + 1);
    rest = rest.slice(0, q);
  }
  const hostinfo = netloc.slice(netloc.lastIndexOf('@') + 1);
  let hostname: string;
  let portText: string;
  if (hostinfo.includes('[')) {
    const open = hostinfo.indexOf('[');
    const close = hostinfo.indexOf(']', open);
    if (close === -1) return null;
    hostname = hostinfo.slice(open + 1, close).toLowerCase();
    if (!isIPv6(hostname.split('%')[0]!)) return null;
    const after = hostinfo.slice(close + 1);
    portText = after.includes(':') ? after.slice(after.indexOf(':') + 1) : '';
  } else {
    const colon = hostinfo.indexOf(':');
    hostname = (colon === -1 ? hostinfo : hostinfo.slice(0, colon)).toLowerCase();
    portText = colon === -1 ? '' : hostinfo.slice(colon + 1);
  }
  let port: number | null = null;
  if (portText) {
    if (!/^[0-9]+$/.test(portText)) return null;
    port = Number(portText);
    if (port > 65535) return null;
  }
  return { scheme, netloc, hostname: hostname || null, port, path: rest, query, fragment };
}
