/**
 * Broker base-URL resolution and validation (port of `config.py`).
 *
 * The session token is sent to whatever this resolves to, so the rules are
 * strict: https only, no userinfo/query/fragment. Plain http is allowed only
 * for a loopback host with `POCKETSHELL_BROKER_INSECURE_DEV=1`.
 */
import { isIPv4 } from 'node:net';
import { AccountError, NotLoggedIn } from './errors.js';
import { cleanText, isPrintableAscii } from './sanitize.js';
import { splitUrl } from './url.js';

/** The production broker (same as the Python CLI). */
export const DEFAULT_BROKER_URL = 'https://a7sota2qic.execute-api.eu-west-1.amazonaws.com';
export const ENV_BROKER_URL = 'POCKETSHELL_BROKER_URL';
export const ENV_INSECURE_DEV = 'POCKETSHELL_BROKER_INSECURE_DEV';
/** The only origin whose verification URLs `login` prints or opens. */
export const DEFAULT_WEB_ORIGIN = 'https://app.pocketshell.io';
/** Where the user reviews and revokes CLI sessions. */
export const SESSIONS_URL = `${DEFAULT_WEB_ORIGIN}/device/sessions`;
export const ENV_DEV_WEB_ORIGIN = 'POCKETSHELL_DEV_WEB_ORIGIN';

export function insecureDevEnabled(): boolean {
  return process.env[ENV_INSECURE_DEV] === '1';
}

function isLoopback(host: string): boolean {
  if (host === 'localhost') return true;
  if (isIPv4(host)) {
    // Python's ipaddress rejects leading zeros; node's isIPv4 does too.
    return host.startsWith('127.');
  }
  // IPv6 loopback in any spelling (::1, 0:0:0:0:0:0:0:1, ...).
  if (host.includes(':') && !host.includes('%')) {
    try {
      return new URL(`http://[${host}]/`).hostname === '[::1]';
    } catch {
      return false;
    }
  }
  return false;
}

const quote = (s: string): string => `'${s}'`;

/**
 * The normalized broker base URL (lower-cased scheme/host, trailing `/`
 * removed), or throw AccountError if it isn't acceptable.
 */
export function validateBrokerUrl(raw: string): string {
  const shown = quote(cleanText(raw, 120));
  if (typeof raw !== 'string' || !raw.trim()) throw new AccountError('broker URL is empty');
  const value = raw.trim();
  if (value.length > 2048 || !isPrintableAscii(value)) {
    throw new AccountError(`broker URL ${shown} contains invalid characters`);
  }
  const parts = splitUrl(value);
  if (!parts) throw new AccountError(`broker URL ${shown} is not a valid URL`);
  const host = parts.hostname;
  if (!host) throw new AccountError(`broker URL ${shown} has no host`);
  if (parts.netloc.includes('@')) throw new AccountError(`broker URL ${shown} must not contain credentials`);
  if (parts.query || parts.fragment || value.endsWith('?') || value.endsWith('#')) {
    throw new AccountError(`broker URL ${shown} must not have a query or fragment`);
  }
  if (parts.scheme === 'http') {
    if (!(insecureDevEnabled() && isLoopback(host))) {
      throw new AccountError(
        `broker URL ${shown} must use https ` +
          `(plain http is only allowed for a loopback host with ${ENV_INSECURE_DEV}=1)`,
      );
    }
  } else if (parts.scheme !== 'https') {
    throw new AccountError(`broker URL ${shown} must use https`);
  }
  let netloc = host.includes(':') ? `[${host}]` : host;
  if (parts.port !== null) netloc = `${netloc}:${parts.port}`;
  const normalized = `${parts.scheme}://${netloc}${parts.path.replace(/\/+$/, '')}`;
  try {
    new URL(normalized);
  } catch {
    throw new AccountError(`broker URL ${shown} is not a valid URL`);
  }
  return normalized;
}

/** `$POCKETSHELL_BROKER_URL` if set, else the production broker (validated). */
export function resolveBrokerUrl(): string {
  return validateBrokerUrl(process.env[ENV_BROKER_URL] || DEFAULT_BROKER_URL);
}

function normalizeOrNull(raw: string): string | null {
  try {
    return validateBrokerUrl(raw);
  } catch {
    return null;
  }
}

/**
 * The ONLY URL an existing session may be sent to: the stored one. Throws
 * NotLoggedIn when the stored URL is no longer acceptable, or when
 * `requested` (default: `$POCKETSHELL_BROKER_URL`) names a different broker.
 */
export function sessionBrokerUrl(stored: string, requested?: string): string {
  const target = normalizeOrNull(stored);
  if (target === null) {
    throw new NotLoggedIn(
      'The broker URL stored with your login is not allowed by the current settings; ' +
        'run `pocketshell-tui-client login`.',
    );
  }
  let source: string;
  if (requested === undefined) {
    requested = process.env[ENV_BROKER_URL] || undefined;
    source = ENV_BROKER_URL;
  } else {
    source = 'the requested broker URL';
  }
  if (requested !== undefined && normalizeOrNull(requested) !== target) {
    throw new NotLoggedIn(
      `${source} (${cleanText(requested, 120)}) differs from the broker you logged in to ` +
        `(${cleanText(target, 120)}); refusing to send your session to it. Unset it, or run ` +
        '`pocketshell-tui-client login --force` for that broker.',
    );
  }
  return target;
}

function originParts(url: string): [string, string, number] | null {
  const parts = splitUrl(url);
  if (!parts || parts.scheme !== 'https' || !parts.hostname || parts.netloc.includes('@')) return null;
  return ['https', parts.hostname.replace(/\.+$/, ''), parts.port ?? 443];
}

/**
 * The trusted approval-page origin. `$POCKETSHELL_DEV_WEB_ORIGIN` is honoured
 * only together with `$POCKETSHELL_BROKER_URL`, and must be a bare https origin.
 */
export function webOrigin(): string {
  const raw = process.env[ENV_DEV_WEB_ORIGIN] || '';
  if (!raw || !process.env[ENV_BROKER_URL]) return DEFAULT_WEB_ORIGIN;
  const value = raw.trim();
  const shown = quote(cleanText(value, 120));
  const parsed = /^[\x20-\x7e]*$/.test(value) ? originParts(value) : null;
  const rest = splitUrl(value);
  if (parsed === null || rest === null || (rest.path !== '' && rest.path !== '/') || rest.query || rest.fragment) {
    throw new AccountError(`${ENV_DEV_WEB_ORIGIN} ${shown} must be a bare https origin like https://host[:port]`);
  }
  const [scheme, host, port] = parsed;
  const netloc = host.includes(':') ? `[${host}]` : host;
  return `${scheme}://${netloc}${port === 443 ? '' : `:${port}`}`;
}

/** Same https origin (scheme, host ignoring a trailing dot, port defaulting to 443). */
export function sameOrigin(url: string, origin: string): boolean {
  const a = originParts(url);
  const b = originParts(origin);
  return a !== null && b !== null && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}
