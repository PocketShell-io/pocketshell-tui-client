/**
 * Minimal HTTP client for the broker's device-flow/CLI endpoints (port of
 * `broker.py`), on Node's global `fetch`:
 *
 * - The base URL went through `validateBrokerUrl` (https; http only for
 *   loopback under INSECURE_DEV). TLS verification is fetch's default (on).
 * - Redirects are never followed (`redirect: 'manual'`): a 3xx is returned
 *   as a failure status, so `Authorization` is never replayed elsewhere.
 * - Every request has a timeout; bodies are streamed and capped at 64 KiB.
 * - Responses must be strict JSON objects; every field used is type-checked.
 * - No `Origin` header (Node's fetch doesn't add one). Tokens travel only in
 *   `Authorization` or the JSON body, never in a URL or an error message.
 * - Node's fetch ignores HTTP(S)_PROXY unless the process opted in with
 *   NODE_USE_ENV_PROXY / --use-env-proxy; then token requests are refused.
 */
import { VERSION } from '../version.js';
import { AccountError, BrokerRateLimited, BrokerUnavailable, LOGIN_HINT, NotLoggedIn } from './errors.js';
import { isObject, loadsStrict } from './json.js';
import { cleanText } from './sanitize.js';

export const MAX_BODY_BYTES = 64 * 1024;
export const DEFAULT_TIMEOUT_MS = 15_000;

const ERROR_CODE_RE = /^[a-z0-9_]{1,64}$/;
const DEVICE_CODE_RE = /^[A-Za-z0-9_-]{16,512}$/;
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MAX_JWT_LEN = 8192;
const GATEWAY_TOKEN_MAX_TTL = 300;
const CLOCK_SKEW = 300;
/** `psc_` + base64url; a bounded range so a longer token doesn't brick clients. */
export const SESSION_TOKEN_RE = /^psc_[A-Za-z0-9_-]{32,128}$/;

const RATE_LIMITED =
  'The PocketShell broker is rate limiting requests from this network (HTTP 429); try again shortly.';

/** Injection points (tests, cancellation). */
export interface HttpOptions {
  fetch?: typeof fetch;
  /** Cancels the request; an abort surfaces as the signal's reason. */
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface BrokerResponse {
  status: number;
  data: Record<string, unknown> | null;
}

function get(data: Record<string, unknown> | null, key: string): unknown {
  return data && Object.hasOwn(data, key) ? data[key] : undefined;
}

/** The OAuth-style `error` code if it is a plain identifier. */
export function errorCode(resp: BrokerResponse): string | null {
  const code = get(resp.data, 'error');
  return typeof code === 'string' && ERROR_CODE_RE.test(code) ? code : null;
}

function envProxyEnabled(): boolean {
  const flags = [...process.execArgv, ...(process.env.NODE_OPTIONS ?? '').split(/\s+/)];
  const optedIn = process.env.NODE_USE_ENV_PROXY === '1' || flags.includes('--use-env-proxy');
  if (!optedIn) return false;
  return ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].some((name) => process.env[name]);
}

async function readCapped(res: Response): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new AccountError('The broker response was too large; refusing to parse it.');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

const TLS_CODES = /^(ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|HOSTNAME_MISMATCH)/;

function transportError(error: unknown, timedOut: boolean): BrokerUnavailable {
  const name = (error as { name?: unknown })?.name;
  if (timedOut || name === 'TimeoutError') return new BrokerUnavailable('The PocketShell broker did not respond in time.');
  let cause: unknown = (error as { cause?: unknown })?.cause ?? error;
  // undici wraps a few levels deep sometimes.
  for (let i = 0; i < 3 && (cause as { cause?: unknown })?.cause; i++) cause = (cause as { cause?: unknown }).cause;
  const code = (cause as { code?: unknown })?.code;
  if (typeof code === 'string' && TLS_CODES.test(code)) {
    return new BrokerUnavailable('TLS verification with the PocketShell broker failed.');
  }
  const reason = typeof code === 'string' ? code : cleanText((cause as Error)?.message ?? String(cause), 120);
  return new BrokerUnavailable(`Could not reach the PocketShell broker (${cleanText(reason, 120)}).`);
}

/**
 * Send one request. `body === undefined` on POST sends an empty body.
 * Returns the status and the parsed JSON object (null for an empty body or an
 * unparseable error body). Throws BrokerUnavailable for transport failures,
 * AccountError for an oversize body or a malformed success.
 */
export async function request(
  baseUrl: string,
  method: 'GET' | 'POST',
  path: string,
  options: HttpOptions & { body?: Record<string, unknown>; bearer?: string } = {},
): Promise<BrokerResponse> {
  if (options.bearer !== undefined && envProxyEnabled()) {
    throw new AccountError(
      'NODE_USE_ENV_PROXY routes fetch through an environment proxy; refusing to send credentials through it.',
    );
  }
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': `pocketshell-client/${VERSION}`,
  };
  let payload: string | undefined;
  if (method === 'POST') {
    payload = '';
    if (options.body !== undefined) {
      payload = JSON.stringify(options.body);
      headers['Content-Type'] = 'application/json';
    }
  }
  if (options.bearer !== undefined) headers.Authorization = `Bearer ${options.bearer}`;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  const doFetch = options.fetch ?? fetch;
  const fail = (error: unknown): never => {
    if (options.signal?.aborted) throw options.signal.reason;
    if (error instanceof AccountError) throw error;
    throw transportError(error, timeout.aborted);
  };
  let res: Response;
  try {
    res = await doFetch(baseUrl + path, { method, headers, body: payload, redirect: 'manual', signal });
  } catch (error) {
    return fail(error);
  }
  let raw: Uint8Array;
  try {
    raw = await readCapped(res);
  } catch (error) {
    return fail(error instanceof AccountError ? error : new BrokerUnavailable('The PocketShell broker connection failed.'));
  }
  // An opaque redirect (status 0) is still a refused redirect.
  const status = res.status === 0 ? 302 : res.status;
  return { status, data: parse(raw, status) };
}

function parse(raw: Uint8Array, status: number): Record<string, unknown> | null {
  if (!new TextDecoder().decode(raw).trim()) return null;
  let value: unknown = null;
  try {
    value = loadsStrict(raw);
  } catch {
    value = null;
  }
  if (isObject(value)) return value;
  if (status >= 400 || (status >= 300 && status < 400)) return null;
  throw new AccountError(`The broker returned a malformed response (HTTP ${status}).`);
}

export function describeFailure(resp: BrokerResponse, what: string): string {
  const code = errorCode(resp);
  return `${what} failed (HTTP ${resp.status}${code ? `, ${code}` : ''}).`;
}

function malformed(what: string, key: string): AccountError {
  return new AccountError(`The broker returned a malformed ${what} response (field '${key}').`);
}

function reqStr(data: Record<string, unknown> | null, key: string, what: string, maxLen = 512): string {
  const value = get(data, key);
  if (typeof value !== 'string' || !value || value.length > maxLen) throw malformed(what, key);
  return value;
}

function reqInt(data: Record<string, unknown> | null, key: string, what: string, lo: number, hi: number): number {
  const value = get(data, key);
  if (typeof value !== 'number' || !Number.isInteger(value) || value < lo || value > hi) throw malformed(what, key);
  return value;
}

function rateLimitCheck(resp: BrokerResponse): void {
  if (resp.status === 429) throw new BrokerRateLimited(RATE_LIMITED);
}

// -- endpoints ---------------------------------------------------------------

export interface DeviceStart {
  /** Bearer secret for the pairing: never print it. */
  deviceCode: string;
  userCode: string;
  /** Unvalidated: the caller checks it's https on the trusted origin. */
  verificationUri: unknown;
  verificationUriComplete: unknown;
  expiresIn: number;
  interval: number;
}

/** `POST /auth/device/start {label}`. */
export async function startDevice(baseUrl: string, label: string, options: HttpOptions = {}): Promise<DeviceStart> {
  const resp = await request(baseUrl, 'POST', '/auth/device/start', { ...options, body: { label } });
  if (resp.status === 429) {
    throw new AccountError('Too many login attempts from this network; wait a few minutes and try again.');
  }
  if (resp.status !== 200) throw new AccountError(describeFailure(resp, 'Starting the login'));
  const what = 'device-start';
  const deviceCode = reqStr(resp.data, 'device_code', what);
  if (!DEVICE_CODE_RE.test(deviceCode)) throw malformed(what, 'device_code');
  const interval = get(resp.data, 'interval') ?? 5;
  if (typeof interval !== 'number' || !Number.isInteger(interval) || interval < 0 || interval > 300) {
    throw malformed(what, 'interval');
  }
  return {
    deviceCode,
    userCode: reqStr(resp.data, 'user_code', what, 64),
    verificationUri: get(resp.data, 'verification_uri'),
    verificationUriComplete: get(resp.data, 'verification_uri_complete'),
    expiresIn: reqInt(resp.data, 'expires_in', what, 1, 3600),
    interval: Math.max(interval, 1),
  };
}

/** `POST /auth/device/token {device_code}` — one poll; the caller interprets the status. */
export function pollDevice(baseUrl: string, deviceCode: string, options: HttpOptions = {}): Promise<BrokerResponse> {
  return request(baseUrl, 'POST', '/auth/device/token', { ...options, body: { device_code: deviceCode } });
}

export interface DeviceToken {
  accessToken: string;
  tokenId: string;
  expiresAt: number;
  email: string;
}

export function parseDeviceToken(data: Record<string, unknown> | null): DeviceToken {
  const what = 'device-token';
  const token = reqStr(data, 'access_token', what, 256);
  if (!SESSION_TOKEN_RE.test(token)) throw malformed(what, 'access_token');
  const tokenType = get(data, 'token_type') ?? 'Bearer';
  if (typeof tokenType !== 'string' || tokenType.toLowerCase() !== 'bearer') throw malformed(what, 'token_type');
  return {
    accessToken: token,
    tokenId: reqStr(data, 'token_id', what, 256),
    expiresAt: reqInt(data, 'expires_at', what, 1, 2 ** 40),
    email: reqStr(data, 'email', what, 320),
  };
}

export interface SessionInfo {
  email: string;
  tokenId: string;
  label: string;
  createdAt: unknown;
  expiresAt: number;
}

/** `GET /cli/session`. 401 → NotLoggedIn; 429 → BrokerRateLimited. */
export async function getSession(baseUrl: string, accessToken: string, options: HttpOptions = {}): Promise<SessionInfo> {
  const resp = await request(baseUrl, 'GET', '/cli/session', { ...options, bearer: accessToken });
  rateLimitCheck(resp);
  if (resp.status === 401) throw new NotLoggedIn(`Your PocketShell login is no longer valid; ${LOGIN_HINT}.`);
  if (resp.status !== 200) throw new AccountError(describeFailure(resp, 'Checking the session'));
  const what = 'session';
  const label = get(resp.data, 'label') ?? '';
  if (typeof label !== 'string' || label.length > 512) throw malformed(what, 'label');
  return {
    email: reqStr(resp.data, 'email', what, 320),
    tokenId: reqStr(resp.data, 'token_id', what, 256),
    label,
    createdAt: get(resp.data, 'created_at'),
    expiresAt: reqInt(resp.data, 'expires_at', what, 1, 2 ** 40),
  };
}

/**
 * `POST /cli/logout`. True on 2xx (or 401: already gone). Throws
 * BrokerRateLimited on 429: the session was NOT revoked.
 */
export async function logout(baseUrl: string, accessToken: string, options: HttpOptions = {}): Promise<boolean> {
  const resp = await request(baseUrl, 'POST', '/cli/logout', { timeoutMs: 10_000, ...options, bearer: accessToken });
  rateLimitCheck(resp);
  return (resp.status >= 200 && resp.status < 300) || resp.status === 401;
}

function looksLikeJwt(token: string): boolean {
  if (token.length > MAX_JWT_LEN || !JWT_RE.test(token)) return false;
  const header = token.split('.', 1)[0]!;
  // Python's urlsafe_b64decode rejects a length ≡ 1 (mod 4).
  if (header.length % 4 === 1) return false;
  try {
    const value = loadsStrict(Buffer.from(header, 'base64url'));
    return isObject(value) && typeof get(value, 'alg') === 'string';
  } catch {
    return false;
  }
}

export interface GatewayToken {
  /** Broker JWT: a bearer credential — never print, log, or put in argv/env. */
  token: string;
  /** Unix seconds. */
  expiresAt: number;
}

/** `POST /cli/gateway/token` with JWT-shape and expiry-window checks. */
export async function mintGatewayToken(
  baseUrl: string,
  accessToken: string,
  options: HttpOptions & { now?: number } = {},
): Promise<GatewayToken> {
  const resp = await request(baseUrl, 'POST', '/cli/gateway/token', { ...options, bearer: accessToken });
  rateLimitCheck(resp);
  if (resp.status === 401) throw new NotLoggedIn(`Your PocketShell login is no longer valid; ${LOGIN_HINT}.`);
  if (resp.status === 403) {
    throw new AccountError(
      'The broker refused a gateway token for this account (HTTP 403); ' +
        'check that the account is allowed to use the gateway.',
    );
  }
  if (resp.status !== 200) throw new AccountError(describeFailure(resp, 'Getting a gateway token'));
  const what = 'gateway-token';
  const token = reqStr(resp.data, 'token', what, MAX_JWT_LEN);
  if (!looksLikeJwt(token)) throw malformed(what, 'token');
  const tokenType = get(resp.data, 'token_type') ?? 'Bearer';
  if (typeof tokenType !== 'string' || tokenType.toLowerCase() !== 'bearer') throw malformed(what, 'token_type');
  const expiresAt = reqInt(resp.data, 'expires_at', what, 1, 2 ** 40);
  const current = options.now ?? Date.now() / 1000;
  if (!(current - CLOCK_SKEW < expiresAt && expiresAt <= current + GATEWAY_TOKEN_MAX_TTL + CLOCK_SKEW)) {
    throw new AccountError(
      "The broker returned a gateway token with an implausible expiry; check this machine's clock.",
    );
  }
  return { token, expiresAt };
}
