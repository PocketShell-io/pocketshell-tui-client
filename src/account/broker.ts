/**
 * Minimal HTTP client for the broker's device-flow/CLI endpoints (port of
 * `broker.py`), on an explicit `node:http`/`node:https` stack:
 *
 * - The base URL went through `validateBrokerUrl` (https; http only for
 *   loopback under INSECURE_DEV). TLS verification is always on.
 * - `node:http`/`node:https` with a fresh agent per request never consult
 *   `HTTP(S)_PROXY` (only undici's global fetch does, under
 *   NODE_USE_ENV_PROXY), so `direct` really is direct. A trusted proxy is
 *   used only via an explicit CONNECT tunnel (`PSC_TRUSTED_PROXY`, see
 *   `transport.ts`); anything else is refused before any byte is sent.
 * - Every request — bearer or not — goes through the transport policy: the
 *   device code and the issued tokens in the JSON bodies are credentials too.
 * - Redirects are never followed (`redirect: 'manual'` equivalent): a 3xx is
 *   returned as a failure status, so `Authorization` is never replayed
 *   elsewhere.
 * - Every request has a timeout; bodies are streamed and capped at 64 KiB.
 * - Responses must be strict JSON objects; every field used is type-checked.
 * - No `Origin` header. Tokens travel only in `Authorization` or the JSON
 *   body, never in a URL or an error message.
 */
import { request as httpRequest, Agent as HttpAgent, type IncomingMessage } from 'node:http';
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { VERSION } from '../version.js';
import { AccountError, BrokerRateLimited, BrokerUnavailable, LOGIN_HINT, NotLoggedIn, TransportRefused } from './errors.js';
import { isObject, loadsStrict } from './json.js';
import { cleanText } from './sanitize.js';
import {
  proxyIdentifier,
  resolveBrokerTransport,
  type BrokerTransport,
} from './transport.js';

export type { BrokerTransport };

export const MAX_BODY_BYTES = 64 * 1024;
export const DEFAULT_TIMEOUT_MS = 15_000;
/** Cap for a proxy's CONNECT response head (status line + headers). */
const MAX_CONNECT_HEAD_BYTES = 16 * 1024;

const ERROR_CODE_RE = /^[a-z0-9_]{1,64}$/;
const DEVICE_CODE_RE = /^[A-Za-z0-9_-]{16,512}$/;
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MAX_JWT_LEN = 8192;
const GATEWAY_TOKEN_MAX_TTL = 300;
const CLOCK_SKEW = 300;
/** `psc_` + base64url; a bounded range so a longer token doesn't brick clients. */
export const SESSION_TOKEN_RE = /^psc_[A-Za-z0-9_-]{32,128}$/;

/** Injection points (tests, cancellation). */
export interface HttpOptions {
  /**
   * Replacement for the whole HTTP stack. A test seam: an injected fetch
   * bypasses environment-proxy resolution by construction (only test code
   * can pass it), so the transport policy is not consulted.
   */
  fetch?: typeof fetch;
  /**
   * Explicit transport-policy decision (test seam): bypasses environment
   * resolution and uses exactly this transport. A `refused` decision throws
   * before any network I/O.
   */
  transport?: BrokerTransport;
  /**
   * Extra CA (PEM) trusted for the broker TLS connection (test seam for the
   * in-test HTTPS broker; production always uses the system store, strictly).
   */
  ca?: string | Buffer;
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

/**
 * Throw when the transport policy refuses `baseUrl`. Called before any
 * network I/O (device login calls it before `/auth/device/start`, so a
 * refused transport fails before the user is sent to the browser). A test
 * seam (`fetch`/`transport`) bypasses environment resolution.
 */
export function assertBrokerTransport(baseUrl: string, options: Pick<HttpOptions, 'fetch' | 'transport'> = {}): void {
  if (options.fetch !== undefined) return;
  const decision =
    options.transport ??
    resolveBrokerTransport(new URL(baseUrl), process.env, process.execArgv, process.env.NODE_OPTIONS);
  if (decision.kind === 'refused') throw new TransportRefused(decision.reason);
}

async function readCappedFetch(res: Response): Promise<Uint8Array> {
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

// -- explicit node:http(s) transport -------------------------------------------

function proxyPortOf(proxy: URL): number {
  return proxy.port ? Number(proxy.port) : proxy.protocol === 'https:' ? 443 : 80;
}

/** A proxy-side failure (the broker was never reached through it). Never carries credentials. */
function proxyTransportError(proxy: URL, error: unknown, timedOut: boolean): BrokerUnavailable {
  const id = proxyIdentifier(proxy);
  const name = (error as { name?: unknown })?.name;
  if (timedOut || name === 'TimeoutError') {
    return new BrokerUnavailable(`The configured proxy (${id}) did not respond in time.`);
  }
  let cause: unknown = (error as { cause?: unknown })?.cause ?? error;
  for (let i = 0; i < 3 && (cause as { cause?: unknown })?.cause; i++) cause = (cause as { cause?: unknown }).cause;
  const code = (cause as { code?: unknown })?.code;
  if (typeof code === 'string' && TLS_CODES.test(code)) {
    return new BrokerUnavailable('TLS verification with the PocketShell broker failed.');
  }
  const reason = typeof code === 'string' ? code : cleanText((cause as Error)?.message ?? String(cause), 120);
  return new BrokerUnavailable(`Could not reach the PocketShell broker through the configured proxy (${id}, ${cleanText(reason, 120)}).`);
}

function abortable(timeoutMs: number, signal: AbortSignal | undefined): { signal: AbortSignal; timeout: AbortSignal } {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return { signal: timeout, timeout };
  return { signal: AbortSignal.any([timeout, signal]), timeout };
}

/** Open a TCP connection with timeout/abort (used only for the proxy leg). */
function tcpConnect(host: string, port: number, signal: AbortSignal): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    let settled = false;
    const socket = netConnect({ host, port });
    const done = (error: unknown | null, value?: Socket): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (error) {
        socket.destroy();
        reject(error);
      } else resolve(value!);
    };
    const onAbort = (): void => done(signal.reason);
    if (signal.aborted) {
      done(signal.reason);
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    socket.once('connect', () => done(null, socket));
    socket.once('error', (error) => done(error));
  });
}

function writeAll(socket: Socket, text: string, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      socket.destroy();
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    socket.write(text, (error) => {
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    });
  });
}

/**
 * Open a TLS session to the broker through an explicit HTTP CONNECT tunnel.
 * Verification to the broker hostname stays strict (`rejectUnauthorized`);
 * the proxy only ever sees the CONNECT authority and, when the proxy URL
 * carries userinfo, a `Proxy-Authorization` header addressed to the proxy.
 */
export async function connectThroughProxy(
  proxy: URL,
  targetHost: string,
  targetPort: number,
  options: { signal?: AbortSignal; timeoutMs?: number; ca?: string | Buffer } = {},
): Promise<TLSSocket> {
  const ms = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { signal, timeout } = abortable(ms, options.signal);
  const id = proxyIdentifier(proxy);
  const failProxy = (error: unknown): never => {
    if (options.signal?.aborted) throw options.signal.reason;
    throw proxyTransportError(proxy, error, timeout.aborted);
  };
  let tcp: Socket;
  try {
    tcp = await tcpConnect(proxy.hostname, proxyPortOf(proxy), signal);
  } catch (error) {
    return failProxy(error);
  }
  try {
    // Proxy userinfo goes here and nowhere else.
    let auth = '';
    if (proxy.username || proxy.password) {
      const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
      auth = `Proxy-Authorization: Basic ${Buffer.from(credentials, 'utf8').toString('base64')}\r\n`;
    }
    await writeAll(tcp, `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n${auth}\r\n`, signal);
    const head = await readUntilHead(tcp, signal, id);
    const status = parseConnectStatus(head);
    if (status !== 200) {
      throw new BrokerUnavailable(
        `The configured proxy (${id}) refused the connection to the broker (HTTP ${status}).`,
      );
    }
  } catch (error) {
    tcp.destroy();
    if (error instanceof BrokerUnavailable || options.signal?.aborted) {
      if (options.signal?.aborted && !(error instanceof BrokerUnavailable)) throw options.signal.reason;
      throw error;
    }
    return failProxy(error);
  }
  const tlsSocket = tlsConnect({
    socket: tcp,
    servername: targetHost,
    rejectUnauthorized: true,
    ...(options.ca !== undefined ? { ca: options.ca } : {}),
    ALPNProtocols: ['http/1.1'],
  });
  try {
    await waitSecure(tlsSocket, signal);
  } catch (error) {
    tlsSocket.destroy();
    if (options.signal?.aborted) throw options.signal.reason;
    if (error instanceof BrokerUnavailable) throw error;
    throw proxyTransportError(proxy, error, timeout.aborted);
  }
  return tlsSocket;
}

function readUntilHead(socket: Socket, signal: AbortSignal, proxyId: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const done = (error: unknown | null, head?: string): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      if (error) reject(error);
      else resolve(head!);
    };
    const onAbort = (): void => done(signal.reason);
    const onError = (error: Error): void => done(error);
    const onData = (chunk: Buffer): void => {
      total += chunk.length;
      if (total > MAX_CONNECT_HEAD_BYTES) {
        done(new BrokerUnavailable(`The configured proxy (${proxyId}) sent an oversize CONNECT response.`));
        return;
      }
      chunks.push(chunk);
      const buffered = Buffer.concat(chunks);
      // latin1 maps 1 char to 1 byte, so the string index is a byte index.
      const end = buffered.toString('latin1').indexOf('\r\n\r\n');
      if (end >= 0) {
        const rest = buffered.subarray(end + 4);
        const head = buffered.toString('latin1');
        done(null, head);
        // Return any bytes after the head (the tunnel is raw TCP from here).
        if (rest.length > 0) socket.unshift(rest);
      }
    };
    if (signal.aborted) {
      done(signal.reason);
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    socket.on('data', onData);
    socket.once('error', onError);
  });
}

function parseConnectStatus(head: string): number {
  const firstLine = head.split('\r\n', 1)[0] ?? '';
  const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(firstLine);
  return match?.[1] ? Number(match[1]) : 0;
}

function waitSecure(socket: TLSSocket, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // `secureConnecting` is a runtime property of every TLSSocket; the
    // bundled @types/node does not declare it, hence the structural read.
    const already = (socket as unknown as { secureConnecting?: boolean }).secureConnecting === false;
    if (already) {
      resolve();
      return;
    }
    let settled = false;
    const done = (error: unknown | null): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      socket.removeListener('error', onError);
      socket.removeListener('secureConnect', onSecure);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = (): void => done(signal.reason);
    const onError = (error: Error): void => done(error);
    const onSecure = (): void => done(null);
    if (signal.aborted) {
      done(signal.reason);
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    socket.once('error', onError);
    socket.once('secureConnect', onSecure);
  });
}

function readCappedNode(res: IncomingMessage): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const done = (error: unknown | null, out?: Uint8Array): void => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(out!);
    };
    res.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        res.destroy();
        done(new AccountError('The broker response was too large; refusing to parse it.'));
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => done(null, Buffer.concat(chunks)));
    res.on('error', () => done(new BrokerUnavailable('The PocketShell broker connection failed.')));
  });
}

interface NodeResult {
  status: number;
  raw: Uint8Array;
}

/**
 * One request over `node:http`/`node:https` with a fresh agent (direct), or
 * through an explicit CONNECT tunnel (trusted-proxy). Neither consults
 * environment proxies.
 */
async function sendViaNode(
  target: URL,
  method: 'GET' | 'POST',
  headers: Record<string, string>,
  payload: string | undefined,
  options: { signal?: AbortSignal; timeoutMs?: number; ca?: string | Buffer; transport: BrokerTransport },
): Promise<NodeResult> {
  const ms = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { signal, timeout } = abortable(ms, options.signal);
  const fail = (error: unknown): never => {
    if (options.signal?.aborted) throw options.signal.reason;
    if (error instanceof AccountError) throw error;
    throw transportError(error, timeout.aborted);
  };
  const secure = target.protocol === 'https:';
  let tunnel: TLSSocket | undefined;
  try {
    if (options.transport.kind === 'trusted-proxy') {
      if (!secure) {
        throw new TransportRefused('A trusted proxy only applies to https broker URLs.');
      }
      tunnel = await connectThroughProxy(options.transport.proxy, target.hostname, Number(target.port || 443), {
        signal: options.signal,
        timeoutMs: ms,
        ...(options.ca !== undefined ? { ca: options.ca } : {}),
      });
    }
  } catch (error) {
    return fail(error);
  }
  // A fresh agent per request: never the global agent, which Node may
  // configure from HTTP(S)_PROXY. The bearer goes to the broker and nowhere else.
  const agent = secure ? new HttpsAgent({ keepAlive: false }) : new HttpAgent({ keepAlive: false });
  try {
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      let req: ReturnType<typeof httpRequest>;
      try {
        const send = secure ? httpsRequest : httpRequest;
        req = send(
          target,
          {
            method,
            headers,
            agent: tunnel ? false : agent,
            ...(tunnel ? { createConnection: () => tunnel } : {}),
            ...(secure ? { rejectUnauthorized: true } : {}),
            ...(secure && options.ca !== undefined ? { ca: options.ca } : {}),
            signal,
          },
          resolve,
        );
      } catch (error) {
        reject(error);
        return;
      }
      req.once('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
    const raw = await readCappedNode(res);
    return { status: res.statusCode ?? 0, raw };
  } catch (error) {
    return fail(error);
  } finally {
    agent.destroy();
    tunnel?.destroy();
  }
}

/**
 * Send one request. `body === undefined` on POST sends an empty body.
 * Returns the status and the parsed JSON object (null for an empty body or an
 * unparseable error body). Throws BrokerUnavailable for transport failures,
 * AccountError for an oversize body, a malformed success, or a refused
 * environment-proxy transport.
 */
export async function request(
  baseUrl: string,
  method: 'GET' | 'POST',
  path: string,
  options: HttpOptions & { body?: Record<string, unknown>; bearer?: string } = {},
): Promise<BrokerResponse> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': `pocketshell-tui-client/${VERSION}`,
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
  if (options.fetch !== undefined) return requestViaFetch(baseUrl + path, method, headers, payload, options);
  const decision =
    options.transport ??
    resolveBrokerTransport(new URL(baseUrl), process.env, process.execArgv, process.env.NODE_OPTIONS);
  if (decision.kind === 'refused') throw new TransportRefused(decision.reason);
  try {
    const { status, raw } = await sendViaNode(new URL(baseUrl + path), method, headers, payload, {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      ...(options.ca !== undefined ? { ca: options.ca } : {}),
      transport: decision,
    });
    return { status, data: parse(raw, status) };
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (error instanceof AccountError) throw error;
    throw transportError(error, false);
  }
}

/** The legacy injected-fetch path (a test seam; bypasses proxy resolution). */
async function requestViaFetch(
  url: string,
  method: 'GET' | 'POST',
  headers: Record<string, string>,
  payload: string | undefined,
  options: HttpOptions,
): Promise<BrokerResponse> {
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
    res = await doFetch(url, { method, headers, body: payload, redirect: 'manual', signal });
  } catch (error) {
    return fail(error);
  }
  let raw: Uint8Array;
  try {
    raw = await readCappedFetch(res);
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

const RATE_LIMITED =
  'The PocketShell broker is rate limiting requests from this network (HTTP 429); try again shortly.';

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

/** One account settings slot read with the CLI session; null when absent (404). */
export interface CliSlot {
  data: string;
  version: number;
}

const VAULT_SLOT_RE = /^(main|vault|vk-[A-Za-z0-9_-]{1,61})$/;

/**
 * `GET /cli/settings/{slot}` (read-only, `main` | `vault` | `vk-*`): the
 * zero-knowledge ciphertext the web uploaded. 404 → null. The bearer goes
 * only to the stored broker.
 */
export async function getCliSlot(baseUrl: string, accessToken: string, slot: string, options: HttpOptions = {}): Promise<CliSlot | null> {
  if (!VAULT_SLOT_RE.test(slot)) throw new AccountError(`invalid settings slot ${JSON.stringify(slot)}`, { code: 'USAGE' });
  const resp = await request(baseUrl, 'GET', `/cli/settings/${slot}`, { ...options, bearer: accessToken });
  rateLimitCheck(resp);
  if (resp.status === 401) throw new NotLoggedIn(`Your PocketShell login is no longer valid; ${LOGIN_HINT}.`);
  if (resp.status === 404) {
    // A 404 without the slot handler's code is a route the server does not have yet.
    if (errorCode(resp) === 'not_found') return null;
    throw new AccountError(
      'This PocketShell server does not offer vault access to the terminal client yet (GET /cli/settings).',
      { code: 'VAULT_UNAVAILABLE' },
    );
  }
  if (resp.status === 503) {
    throw new AccountError('The PocketShell server has no key vault configured yet.', { code: 'VAULT_UNAVAILABLE' });
  }
  if (resp.status === 403 && errorCode(resp) === 'vault_verify_required') {
    throw new AccountError('The server wants the vault passphrase again before it hands out keys; run `psc vault unlock`.', {
      code: 'VAULT_VERIFY_REQUIRED',
      exitCode: 3,
    });
  }
  if (resp.status !== 200) throw new AccountError(describeFailure(resp, `Reading the ${slot} slot`));
  const what = 'settings slot';
  return { data: reqStr(resp.data, 'data', what, 16 * 1024), version: reqInt(resp.data, 'version', what, 0, 1_000_000_000) };
}

/** Phase-2 server verifier answer, 1:1 with core's VaultServerVerifier.verify. */
export type VaultVerifyResult =
  | { kind: 'ok' }
  | { kind: 'wrong'; retryAfterMs: number }
  | { kind: 'locked'; retryAfterMs: number }
  | { kind: 'noVerifier' }
  | { kind: 'unavailable' };

/**
 * `POST /cli/vault/verify {auth}` (W2-contract). 404 no_verifier is
 * `noVerifier`; a missing route, 409 verifier_stale, 503 or any other answer
 * is `unavailable`: the client-side check decides and the unlock never fails
 * because of the server. 401 invalid_token is a dead login.
 */
export async function verifyVaultCli(
  baseUrl: string,
  accessToken: string,
  auth: string,
  options: HttpOptions = {},
): Promise<VaultVerifyResult> {
  let resp: BrokerResponse;
  try {
    resp = await request(baseUrl, 'POST', '/cli/vault/verify', { ...options, bearer: accessToken, body: { auth } });
  } catch (error) {
    if (error instanceof BrokerUnavailable) return { kind: 'unavailable' };
    throw error;
  }
  const num = (key: string, cap: number): number | null => {
    const value = get(resp.data, key);
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(value, cap) : null;
  };
  const code = errorCode(resp);
  if (resp.status === 200 && get(resp.data, 'ok') === true) return { kind: 'ok' };
  if (resp.status === 401 && code === 'wrong_passphrase') {
    return { kind: 'wrong', retryAfterMs: (num('retryAfter', 86_400) ?? 0) * 1000 };
  }
  if (resp.status === 429 && (code === 'too_many_attempts' || code === 'rate_limited')) {
    return { kind: 'locked', retryAfterMs: (num('retryAfter', 86_400) ?? 60) * 1000 };
  }
  if (resp.status === 401) throw new NotLoggedIn(`Your PocketShell login is no longer valid; ${LOGIN_HINT}.`);
  if (resp.status === 404 && code === 'no_verifier') return { kind: 'noVerifier' };
  return { kind: 'unavailable' };
}

/** `GET /cli/vault/status` (phase 2): public KDF params when the header is gated. null when absent. */
export async function getVaultStatusCli(baseUrl: string, accessToken: string, options: HttpOptions = {}): Promise<Record<string, unknown> | null> {
  const resp = await request(baseUrl, 'GET', '/cli/vault/status', { ...options, bearer: accessToken });
  if (resp.status === 401 && errorCode(resp) === 'invalid_token') throw new NotLoggedIn(`Your PocketShell login is no longer valid; ${LOGIN_HINT}.`);
  if (resp.status !== 200 || resp.data === null) return null;
  return resp.data;
}
