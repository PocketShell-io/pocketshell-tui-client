/**
 * OAuth-style device-authorization login (port of `device.py`), UI-agnostic:
 * the caller gets the code through `onPending` and renders it however it likes.
 *
 * 1. `POST /auth/device/start` with a label (`user@hostname`).
 * 2. Rewrite the verification URL onto the trusted web origin (a broker
 *    behind a raw internal hostname keeps only its path/query/hash — port of
 *    dataops bba21c7f), require https on that origin (the pre-filled URL only
 *    when it is exactly `${verification_uri}?code=${user_code}`), then call
 *    `onPending`.
 * 3. Poll `POST /auth/device/token` every `interval` s; slow_down/429 add 5 s
 *    (cap 60); access_denied/expired_token stop; ≤ 5 transient failures.
 * 4. Confirm with `GET /cli/session` and save. If anything fails — including
 *    cancellation — after a token was issued but before it was saved, the
 *    token is revoked best-effort.
 */
import { userInfo, hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import * as broker from './broker.js';
import { sameOrigin, webOrigin } from './config.js';
import { save, preflightStorage, type Credentials } from './credentials.js';
import { AccountError, BrokerUnavailable, LoginCancelled } from './errors.js';
import { cleanText, httpsUrl } from './sanitize.js';
export const MAX_LABEL = 80;
const SLOW_DOWN_STEP = 5;
const MAX_INTERVAL = 60;
const MAX_TRANSIENT_FAILURES = 5;
const AGAIN = 'Run `pocketshell-tui-client login` again.';

/** Crockford-like alphabet without vowels or ambiguous characters. */
export const USER_CODE_RE = /^[BCDFGHJKLMNPQRSTVWXZ2-9]{4}-[BCDFGHJKLMNPQRSTVWXZ2-9]{4}$/;

/** What to show the user while the login waits for approval. All fields are validated/safe to print. */
export interface PendingLogin {
  /** `XXXX-XXXX`, validated against USER_CODE_RE. */
  userCode: string;
  /** https URL on the trusted web origin (falls back to `${origin}/device`). */
  verificationUri: string;
  /** Pre-filled URL (`${verificationUri}?code=${userCode}`), or null when the broker's wasn't exactly that. Open this one if present. */
  verificationUriComplete: string | null;
  /** Seconds until the code expires. */
  expiresIn: number;
}

export interface DeviceLoginOptions {
  /** Validated broker base URL. */
  baseUrl: string;
  label: string;
  /** Called once, before polling starts. */
  onPending: (info: PendingLogin) => void;
  /** Safe-to-print warnings (e.g. an untrusted verification URL was suppressed). */
  onWarning?: (message: string) => void;
  /** Abort → LoginCancelled (exit 130); an issued-but-unsaved token is revoked. */
  signal?: AbortSignal;
  /** Test seams. `sleep` is in seconds; `monotonic` returns seconds. */
  sleep?: (seconds: number, signal?: AbortSignal) => Promise<void>;
  monotonic?: () => number;
  fetch?: typeof fetch;
  /** Explicit transport-policy decision (test seam; bypasses env resolution). */
  transport?: broker.BrokerTransport;
  /** Extra CA (PEM) trusted for the broker TLS (test seam). */
  ca?: string | Buffer;
}

/** `user@hostname`, cleaned and ≤ 80 chars (like Python's getpass.getuser()). */
export function defaultLabel(): string {
  let user = process.env.LOGNAME || process.env.USER || process.env.LNAME || process.env.USERNAME || '';
  if (!user) {
    try {
      user = userInfo().username;
    } catch {
      user = 'user';
    }
  }
  return cleanText(`${user}@${hostname()}`, MAX_LABEL) || 'pocketshell-tui-client';
}

/** Validate a `--label`: 1-80 printable characters, no control/format characters. */
export function validateLabel(label: string): string {
  const cleaned = cleanText(label, 10_000);
  if (!cleaned || cleaned !== label.trim() || Array.from(cleaned).length > MAX_LABEL) {
    throw new AccountError(`--label must be 1-${MAX_LABEL} printable characters without control characters.`, {
      code: 'USAGE',
      exitCode: 2,
    });
  }
  return cleaned;
}

function trusted(value: unknown, origin: string): string | null {
  const url = httpsUrl(value);
  return url !== null && sameOrigin(url, origin) ? url : null;
}

/**
 * Port of dataops bba21c7f: a broker behind a raw internal hostname (e.g. a
 * Lambda-style function URL) returns verification URIs on that host, but only
 * the trusted web origin may ever be shown or opened. Graft the URI's path,
 * query and hash onto `targetOrigin` and drop its host; a URI already on the
 * target origin passes through untouched; anything unparseable or not
 * http(s) is null (the caller suppresses it entirely).
 */
export function rewriteVerificationUri(rawUri: string, targetOrigin: string): string | null {
  let parsed: URL;
  let target: URL;
  try {
    parsed = new URL(rawUri);
    target = new URL(targetOrigin);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.origin === target.origin) return rawUri;
  return `${target.origin}${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/** Shared validation and trusted-origin presentation for terminal and OAuth adapters. */
export function pendingDeviceLogin(
  start: broker.DeviceStart,
  origin: string,
  onWarning?: (message: string) => void,
): PendingLogin {
  const userCode = start.userCode;
  if (typeof userCode !== 'string' || !USER_CODE_RE.test(userCode)) {
    // Never echo it: an unexpected code could carry terminal escapes.
    throw new AccountError(`The broker returned a malformed user code. ${AGAIN}`);
  }
  const rewrite = (uri: unknown): string | null =>
    typeof uri === 'string' ? rewriteVerificationUri(uri, origin) : null;
  let verificationUri = trusted(rewrite(start.verificationUri), origin);
  let completeUri = trusted(rewrite(start.verificationUriComplete), origin);
  if (verificationUri === null) {
    onWarning?.(
      `the broker sent a verification URL outside ${origin}; it was not shown or opened.`,
    );
    verificationUri = `${origin}/device`;
    completeUri = null;
  }
  if (completeUri !== `${verificationUri}?code=${userCode}`) completeUri = null;
  return { userCode, verificationUri, verificationUriComplete: completeUri, expiresIn: start.expiresIn };
}

const defaultSleep = (seconds: number, signal?: AbortSignal): Promise<void> =>
  delay(seconds * 1000, undefined, { signal });
const defaultMonotonic = (): number => performance.now() / 1000;

function cancelled(signal: AbortSignal | undefined, error: unknown): boolean {
  return Boolean(signal?.aborted) || (error as { name?: unknown })?.name === 'AbortError';
}

/**
 * Run the device flow and save the session (does NOT check for an existing
 * login — see `login()` in index.ts for that). Returns the saved credentials.
 */
export async function deviceLogin(options: DeviceLoginOptions): Promise<Credentials> {
  preflightStorage();
  const { baseUrl, label, signal } = options;
  const sleep = options.sleep ?? defaultSleep;
  const monotonic = options.monotonic ?? defaultMonotonic;
  const http = { fetch: options.fetch, transport: options.transport, ca: options.ca, signal };
  // Fail before /auth/device/start when an environment proxy would carry the
  // login (fail-closed): never send the user to the browser first.
  if (http.fetch === undefined) broker.assertBrokerTransport(baseUrl, { transport: http.transport });
  try {
    const origin = webOrigin();
    const start = await broker.startDevice(baseUrl, label, http);
    options.onPending(pendingDeviceLogin(start, origin, options.onWarning));

    const token = await poll(baseUrl, start, sleep, monotonic, http);
    try {
      const session = await broker.getSession(baseUrl, token.accessToken, http);
      if (session.tokenId !== token.tokenId) {
        throw new AccountError("The broker's session check did not match the issued token.");
      }
      const creds: Credentials = {
        brokerUrl: baseUrl,
        accessToken: token.accessToken,
        tokenId: session.tokenId,
        email: cleanText(session.email, 320),
        expiresAt: session.expiresAt,
        label: cleanText(session.label, MAX_LABEL) || label,
      };
      if (signal?.aborted) throw signal.reason;
      save(creds);
      return creds;
    } catch (error) {
      // The cleanup revoke ignores any caller abort (a cancelled login must
      // still revoke the issued-but-unsaved token).
      const reason = await revokeQuietly(baseUrl, token.accessToken, {
        fetch: options.fetch,
        transport: options.transport,
        ca: options.ca,
      });
      if (reason !== null) {
        // Warning only: a failed cleanup revoke must never mask the original error.
        options.onWarning?.(
          `server-side revoke failed: ${reason}; the token stays valid until it expires`,
        );
      }
      throw error;
    }
  } catch (error) {
    if (cancelled(signal, error)) throw new LoginCancelled();
    throw error;
  }
}

async function poll(
  baseUrl: string,
  start: broker.DeviceStart,
  sleep: NonNullable<DeviceLoginOptions['sleep']>,
  monotonic: () => number,
  http: broker.HttpOptions,
): Promise<broker.DeviceToken> {
  const deadline = monotonic() + start.expiresIn;
  let interval = Math.min(start.interval, MAX_INTERVAL);
  let failures = 0;
  for (;;) {
    if (monotonic() + interval > deadline) throw new AccountError(`The login code expired before it was approved. ${AGAIN}`);
    if (http.signal?.aborted) throw http.signal.reason;
    await sleep(interval, http.signal);
    let resp: broker.BrokerResponse;
    try {
      resp = await broker.pollDevice(baseUrl, start.deviceCode, http);
    } catch (error) {
      if (!(error instanceof BrokerUnavailable)) throw error;
      failures += 1;
      if (failures >= MAX_TRANSIENT_FAILURES) throw new AccountError(`${error.message} ${AGAIN}`);
      continue;
    }
    if (resp.status === 200) return broker.parseDeviceToken(resp.data);
    if (resp.status >= 500) {
      failures += 1;
      if (failures >= MAX_TRANSIENT_FAILURES) throw new AccountError(broker.describeFailure(resp, 'Waiting for approval'));
      continue;
    }
    failures = 0;
    const code = broker.errorCode(resp);
    if (resp.status === 429 || code === 'slow_down') {
      interval = Math.min(interval + SLOW_DOWN_STEP, MAX_INTERVAL);
      continue;
    }
    if (resp.status === 400 && code === 'authorization_pending') continue;
    if (code === 'access_denied') throw new AccountError(`The login request was denied in the browser. ${AGAIN}`);
    if (code === 'expired_token') throw new AccountError(`The login code expired before it was approved. ${AGAIN}`);
    throw new AccountError(broker.describeFailure(resp, 'Waiting for approval'));
  }
}

/**
 * Revoke a token best-effort (never throws; ignores any caller abort).
 * Returns null when the broker confirmed the revocation (or it was already
 * gone), else the safe-to-print reason, so callers can warn instead of
 * swallowing the failure.
 */
export async function revokeQuietly(
  baseUrl: string,
  accessToken: string,
  options: Pick<broker.HttpOptions, 'fetch' | 'transport' | 'ca'> | typeof fetch = {},
): Promise<string | null> {
  const http: broker.HttpOptions = typeof options === 'function' ? { fetch: options } : options;
  try {
    if (await broker.logout(baseUrl, accessToken, http)) return null;
    return 'the broker did not confirm the revocation';
  } catch (error) {
    if (error instanceof AccountError) return error.message;
    throw error;
  }
}
