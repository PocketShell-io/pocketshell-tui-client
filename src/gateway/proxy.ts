/**
 * `gateway proxy <device-id>`: the OpenSSH ProxyCommand stdio bridge.
 * Port of pocketshell/gateway/proxy.py; same wire protocol, same hardening.
 *
 * 1. `GET wss://<gw>/api/v1/hosts/<id>/ssh` — no query, no Origin, no
 *    compression, no environment proxy, TLS verification always on.
 * 2. First TEXT frame `{"type":"auth","v":1,"token":<jwt>,"device_id":<id>}`.
 * 3. Gateway answers TEXT `ready` (exact keys, v===1, device_id must match)
 *    or `error` + an application close code. One 30 s deadline covers
 *    TCP + TLS + upgrade + auth + ready.
 * 4. Then raw SSH bytes in BINARY messages both ways (≤ 32 KiB writes,
 *    ≤ 64 KiB reads); any TEXT after ready is a protocol violation.
 *
 * stdout carries SSH bytes only. Failures print ONE line on stderr,
 * `pocketshell-tui-client-proxy: <CODE>: <message>`, which the ssh/gateway
 * Connection parses back into a typed error (ssh itself only says 255);
 * when stderr is a terminal (an interactive attach without multiplexing)
 * the line is the human form instead, `gateway: host offline (<id>): ...`.
 * With `--status-file`, a failure before the tunnel is up is ALSO written
 * there (atomically, 0600, inside our private dir only): with ControlPersist
 * OpenSSH sends a ProxyCommand's stderr to /dev/null, so the file is the
 * only way the marker reaches the client. Gateway-supplied text is
 * sanitized first. The token never leaves memory except in the auth frame.
 */
import { trace } from '../trace.js';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import type { Readable, Writable } from 'node:stream';
import WebSocket from 'ws';
import { TransportRefused } from '../account/errors.js';
import { PROXY_MARKER, writeStatusFile } from '../transport/openssh.js';
import { clientSshUrl, validateDeviceId, type GatewayEndpoint } from './endpoint.js';
import { isPlainObject, parseStrictJson, sanitizeRemoteText, StrictJsonError } from './text.js';

export const EXIT = {
  OK: 0,
  INTERNAL: 1,
  USAGE: 2,
  NO_TOKEN: 3,
  CONNECT: 4,
  TIMEOUT: 5,
  PROTOCOL: 6,
  UNAUTHORIZED: 7,
  NOT_FOUND: 8,
  HOST_OFFLINE: 9,
  QUOTA: 10,
  LOST: 11,
  /** The transport policy refused to send credentials (fail-closed env proxy). Never a login problem. */
  TRANSPORT_REFUSED: 12,
} as const;

/** Stable machine codes for the stderr marker, one per exit status. */
export const EXIT_CODE_NAME: Record<number, string> = {
  1: 'INTERNAL',
  2: 'USAGE',
  3: 'NOT_LOGGED_IN',
  4: 'CONNECT_FAILED',
  5: 'GATEWAY_TIMEOUT',
  6: 'GATEWAY_PROTOCOL',
  7: 'GATEWAY_UNAUTHORIZED',
  8: 'DEVICE_NOT_FOUND',
  9: 'HOST_OFFLINE',
  10: 'GATEWAY_QUOTA',
  11: 'CONNECTION_LOST',
  12: 'TRANSPORT_REFUSED',
};

/** Short human summaries for the terminal form of the failure line. */
const SUMMARY: Record<string, string> = {
  INTERNAL: 'internal error',
  USAGE: 'invalid arguments',
  NOT_LOGGED_IN: 'not logged in',
  CONNECT_FAILED: 'cannot connect',
  GATEWAY_TIMEOUT: 'timed out',
  GATEWAY_PROTOCOL: 'protocol error',
  GATEWAY_UNAUTHORIZED: 'not authorized',
  DEVICE_NOT_FOUND: 'unknown device',
  HOST_OFFLINE: 'host offline',
  GATEWAY_QUOTA: 'quota exceeded',
  CONNECTION_LOST: 'connection lost',
  TRANSPORT_REFUSED: 'proxy refused',
};

/** The machine-readable failure line (stderr when piped, and the status file). */
export function markerLine(codeName: string, message: string): string {
  return `${PROXY_MARKER}: ${codeName}: ${message}`;
}

/** The human failure line, for a terminal: `gateway: host offline (laptop): ...`. */
export function friendlyLine(codeName: string, message: string, deviceId: string): string {
  return `gateway: ${SUMMARY[codeName] ?? 'failed'} (${sanitizeRemoteText(deviceId, 80)}): ${message}`;
}

/**
 * Record a failure in the status file, if one was requested. Never throws:
 * a refused path (outside a private dir of ours, existing tmp, symlink)
 * just means the client falls back to stderr / ssh's own diagnostics.
 */
export function recordStatus(statusFile: string | undefined, line: string): void {
  if (!statusFile) return;
  try {
    writeStatusFile(statusFile, line);
  } catch {
    /* refused or unwritable */
  }
}

export const CLOSE_CODE_EXIT: Record<number, number> = {
  4400: EXIT.PROTOCOL,
  4401: EXIT.UNAUTHORIZED,
  4403: EXIT.UNAUTHORIZED,
  4404: EXIT.NOT_FOUND,
  4408: EXIT.TIMEOUT,
  4429: EXIT.QUOTA,
  4503: EXIT.HOST_OFFLINE,
};

export const ERROR_CODE_EXIT: Record<string, number> = {
  protocol: EXIT.PROTOCOL,
  unauthorized: EXIT.UNAUTHORIZED,
  signature: EXIT.UNAUTHORIZED,
  revoked: EXIT.UNAUTHORIZED,
  not_found: EXIT.NOT_FOUND,
  host_offline: EXIT.HOST_OFFLINE,
  quota: EXIT.QUOTA,
  timeout: EXIT.TIMEOUT,
};

export const HANDSHAKE_TIMEOUT_MS = 30_000;
export const CHUNK_BYTES = 32 * 1024;
export const MAX_MESSAGE_BYTES = 64 * 1024;
export const MAX_CONTROL_BYTES = 16 * 1024;
const ERROR_CLOSE_WAIT_MS = 2_000;
const PROTOCOL_VERSION = 1;
const MAX_TOKEN_CHARS = 16384;
const HIGH_WATER = 1 << 20;
const LOW_WATER = 256 * 1024;
/** In-band reauth sends the next token this long before the current one expires. */
export const REAUTH_LEAD_MS = 60_000;
/** How often minting is retried while a refresh is due, and the floor between refresh attempts. */
export const REAUTH_RETRY_MS = 10_000;
/** How long a sent reauth frame may wait for its acknowledgement. */
export const REAUTH_REPLY_MS = 10_000;

/** Atomically rewrite the daemon's lease receipt (unix seconds; same safety checks as every status file). */
export function writeLeaseReceipt(path: string, expiresAtSeconds: number): void {
  writeStatusFile(path, `PSC_LEASE: ${expiresAtSeconds}`);
}

// --- control frames ---------------------------------------------------------

export class ControlFrameError extends Error {}

export type ControlFrame =
  | { type: 'ready'; v: 1; device_id: string; ssh_host_key: string; caps?: string[] }
  | { type: 'error'; v: 1; code: string; message: string };

const READY_KEYS = ['device_id', 'ssh_host_key', 'type', 'v'];
const ERROR_KEYS = ['code', 'message', 'type', 'v'];
const REAUTH_OK_KEYS = ['expires_at', 'type', 'v'];
const CAP_RE = /^[a-z0-9_]{1,32}$/;

/**
 * Strictly parse a pre-ready TEXT frame: ≤ 16 KiB, a JSON object with no
 * duplicate keys, type ready|error with exactly its keys (ready may also
 * carry an optional `caps` array of capability words), `v` the integer
 * literal 1, string fields strings.
 */
export function parseControlFrame(text: string): ControlFrame {
  if (Buffer.byteLength(text, 'utf8') > MAX_CONTROL_BYTES) throw new ControlFrameError('control frame too large');
  let doc;
  try {
    doc = parseStrictJson(text);
  } catch (error) {
    if (error instanceof StrictJsonError) throw new ControlFrameError('control frame is not strict JSON');
    throw error;
  }
  if (!isPlainObject(doc)) throw new ControlFrameError('control frame is not a JSON object');
  const kind = doc.type;
  let expected: string[];
  let strings: string[];
  if (kind === 'ready') {
    expected = READY_KEYS;
    strings = ['device_id', 'ssh_host_key'];
  } else if (kind === 'error') {
    expected = ERROR_KEYS;
    strings = ['code', 'message'];
  } else {
    throw new ControlFrameError('unexpected control frame type');
  }
  const keys = Object.keys(doc).sort();
  const hasCaps = kind === 'ready' && 'caps' in doc;
  if (keys.length !== expected.length + (hasCaps ? 1 : 0) || keys.some((key) => key !== 'caps' && !expected.includes(key))) {
    throw new ControlFrameError(`${kind} frame has unexpected or missing fields`);
  }
  if (doc.v !== PROTOCOL_VERSION) throw new ControlFrameError(`${kind} frame has an unsupported version`);
  for (const name of strings) {
    if (typeof doc[name] !== 'string') throw new ControlFrameError(`${kind} frame field ${name} is not a string`);
  }
  let caps: string[] | undefined;
  if (hasCaps) {
    if (!Array.isArray(doc.caps)) throw new ControlFrameError('ready frame field caps is not an array');
    for (const cap of doc.caps) {
      if (typeof cap !== 'string' || !CAP_RE.test(cap)) throw new ControlFrameError('ready frame has an invalid capability word');
    }
    caps = doc.caps as string[];
  }
  return caps === undefined ? (doc as unknown as ControlFrame) : ({ ...(doc as object), caps } as ControlFrame);
}

/**
 * Strictly parse the one TEXT frame allowed after `ready`: a `reauth_ok`
 * acknowledgement carrying the new authorization deadline as unix seconds.
 */
export function parseReauthOk(text: string): number {
  if (Buffer.byteLength(text, 'utf8') > MAX_CONTROL_BYTES) throw new ControlFrameError('control frame too large');
  let doc;
  try {
    doc = parseStrictJson(text);
  } catch (error) {
    if (error instanceof StrictJsonError) throw new ControlFrameError('control frame is not strict JSON');
    throw error;
  }
  if (!isPlainObject(doc)) throw new ControlFrameError('control frame is not a JSON object');
  const keys = Object.keys(doc).sort();
  if (keys.length !== REAUTH_OK_KEYS.length || keys.some((key, i) => key !== REAUTH_OK_KEYS[i])) {
    throw new ControlFrameError('reauth_ok frame has unexpected or missing fields');
  }
  if (doc.type !== 'reauth_ok' || doc.v !== PROTOCOL_VERSION) {
    throw new ControlFrameError('reauth_ok frame has an unsupported type or version');
  }
  const expiresAt = doc.expires_at;
  if (typeof expiresAt !== 'number' || !Number.isInteger(expiresAt) || expiresAt <= 0 || expiresAt > 2 ** 40) {
    throw new ControlFrameError('reauth_ok frame has an invalid expires_at');
  }
  return expiresAt;
}

// --- the bridge -------------------------------------------------------------

export interface ProxyOptions {
  deviceId: string;
  endpoint: GatewayEndpoint;
  /** Mints the broker JWT (account layer). Throwing → exit 3. Used when `reauth` is absent. */
  tokenProvider: () => Promise<string>;
  /**
   * Opt in to in-band reauth (the daemon path, `--lease-file`): tokens come
   * with their expiry (unix s), the receipt is rewritten on every renewal,
   * and — when the gateway advertises the capability — a fresh token is
   * sent over the open stream ~60 s before the current one expires so the
   * tunnel outlives the 5-minute routing token. Old gateways (no cap)
   * behave exactly as without this option.
   */
  reauth?: {
    leaseFile: string;
    mint: () => Promise<{ token: string; expiresAt: number }>;
  };
  stdin: Readable;
  stdout: Writable;
  /**
   * One diagnostic line (no newline), always the marker form. Default:
   * process.stderr — the marker form, or the human form on a terminal.
   */
  diagnostic?: (line: string) => void;
  /** Also record a pre-tunnel failure here (see the module comment). */
  statusFile?: string;
  handshakeTimeoutMs?: number;
  /** Test seam: clock for reauth scheduling (ms). */
  now?: () => number;
}

interface Outcome {
  code: number;
  message: string;
  /** The tunnel had reached `ready`: a session may have run. */
  established?: boolean;
}

function tokenFailure(error: unknown): Outcome {
  if (error instanceof TransportRefused || (error as { code?: unknown })?.code === 'TRANSPORT_REFUSED') {
    // Ours, not remote text: pass the refusal through verbatim (it names the
    // fixes) under its own marker code, so no slicer or login hint touches it.
    const reason = error instanceof Error ? error.message : String(error);
    return { code: EXIT.TRANSPORT_REFUSED, message: `could not get a gateway token: ${reason}` };
  }
  const detail = sanitizeRemoteText(error instanceof Error ? error.message : String(error), 1000);
  const notLoggedIn = (error as { code?: unknown })?.code === 'NOT_LOGGED_IN';
  return {
    code: EXIT.NO_TOKEN,
    message: notLoggedIn
      ? detail || 'not logged in: run `pocketshell-tui-client login`'
      : `could not get a gateway token: ${detail || 'unknown error'}`,
  };
}

function connectFailure(error: Error & { code?: string }, host: string): Outcome {
  const code = typeof error.code === 'string' ? error.code : '';
  if (code.startsWith('WS_ERR_')) {
    return {
      code: EXIT.PROTOCOL,
      message:
        code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH'
          ? 'gateway sent an oversize message'
          : `gateway protocol violation (${sanitizeRemoteText(code, 60)})`,
    };
  }
  if (/handshake has timed out/i.test(error.message)) return { code: EXIT.TIMEOUT, message: 'gateway handshake timed out' };
  if (/CERT|SSL|TLS|ERR_TLS|UNABLE_TO_|SELF_SIGNED/i.test(code)) {
    return { code: EXIT.CONNECT, message: `TLS failure talking to ${host}: ${sanitizeRemoteText(code || error.message)}` };
  }
  return { code: EXIT.CONNECT, message: `cannot connect to ${host}: ${sanitizeRemoteText(error.message)}` };
}

function closeOutcome(closeCode: number, fallback: number): Outcome {
  const mapped = CLOSE_CODE_EXIT[closeCode];
  if (mapped !== undefined) return { code: mapped, message: `gateway closed the connection (code ${closeCode})` };
  if (closeCode === 1009) return { code: EXIT.PROTOCOL, message: 'gateway sent an oversize message' };
  if (closeCode === 1006 || closeCode === 1005) return { code: fallback, message: 'connection to the gateway was lost' };
  return { code: fallback, message: `gateway closed the connection (code ${closeCode})` };
}

/** Run the bridge; resolve with the process exit status. Never rejects. */
export async function runProxy(options: ProxyOptions): Promise<number> {
  let outcome: Outcome;
  try {
    outcome = await bridge(options);
  } catch (error) {
    outcome = { code: EXIT.INTERNAL, message: `internal error (${error instanceof Error ? error.name : 'unknown'})` };
  }
  if (outcome.code !== EXIT.OK && outcome.message) {
    const codeName = EXIT_CODE_NAME[outcome.code] ?? 'INTERNAL';
    const marker = markerLine(codeName, outcome.message);
    // Only pre-tunnel failures: they prove no session ran, and the client
    // is still waiting to read the file (a later loss in a background
    // master would only leave a stale file behind).
    if (!outcome.established) recordStatus(options.statusFile, marker);
    try {
      if (options.diagnostic) options.diagnostic(marker);
      else if (process.stderr.isTTY) process.stderr.write(`${friendlyLine(codeName, outcome.message, options.deviceId)}\n`);
      else process.stderr.write(`${marker}\n`);
    } catch {
      /* stderr gone */
    }
  }
  return outcome.code;
}

async function bridge(options: ProxyOptions): Promise<Outcome> {
  const { deviceId, endpoint, stdin, stdout } = options;
  try {
    validateDeviceId(deviceId);
  } catch (error) {
    return { code: EXIT.USAGE, message: (error as Error).message };
  }
  const url = clientSshUrl(endpoint, deviceId);

  let token: string;
  let tokenExpiresAt = 0;
  if (options.reauth) {
    let minted: { token: string; expiresAt: number };
    try {
      minted = await options.reauth.mint();
    } catch (error) {
      return tokenFailure(error);
    }
    token = minted.token;
    tokenExpiresAt = minted.expiresAt;
    try {
      writeLeaseReceipt(options.reauth.leaseFile, tokenExpiresAt);
    } catch {
      // Without a writable receipt the daemon cannot re-arm on renewal;
      // the tunnel still serves its initial token lifetime as today.
      options.reauth = undefined;
    }
  } else {
    try {
      token = await options.tokenProvider();
    } catch (error) {
      return tokenFailure(error);
    }
  }
  if (typeof token !== 'string' || token.length > MAX_TOKEN_CHARS || !/^[\x21-\x7e]+$/.test(token)) {
    return { code: EXIT.NO_TOKEN, message: 'the account layer returned a malformed gateway token' };
  }

  const now = options.now ?? Date.now;
  const timeoutMs = options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
  return new Promise<Outcome>((resolve) => {
    let phase: 'connecting' | 'auth' | 'error-frame' | 'ready' | 'done' = 'connecting';
    let stdinEof = false;
    let refused: Outcome | null = null;
    let errorWait: NodeJS.Timeout | undefined;
    // In-band reauth state: armed only after `ready` advertised the cap.
    let reauthSupported = false;
    let reauthTimer: NodeJS.Timeout | undefined;
    let reauthReplyTimer: NodeJS.Timeout | undefined;
    let reauthPending = false;
    let reauthBroken = false;

    // A fresh agent per connection: never the global agent, which Node may
    // configure from HTTP(S)_PROXY (NODE_USE_ENV_PROXY). The token goes to
    // the gateway the user named and nowhere else.
    const agent = endpoint.secure ? new HttpsAgent({ keepAlive: false }) : new HttpAgent({ keepAlive: false });
    const ws = new WebSocket(url, {
      agent,
      perMessageDeflate: false,
      maxPayload: MAX_MESSAGE_BYTES,
      handshakeTimeout: timeoutMs,
      followRedirects: false,
      rejectUnauthorized: true,
      headers: { 'User-Agent': 'pocketshell-tui-client' },
    });

    const deadline = setTimeout(() => {
      finish({
        code: EXIT.TIMEOUT,
        message: phase === 'auth' ? 'gateway did not answer the auth frame in time' : 'gateway handshake timed out',
      });
    }, timeoutMs);

    const onStdinData = (chunk: Buffer) => {
      for (let off = 0; off < chunk.length; off += CHUNK_BYTES) {
        ws.send(chunk.subarray(off, off + CHUNK_BYTES), { binary: true }, () => {
          if (ws.bufferedAmount < LOW_WATER && stdin.isPaused()) stdin.resume();
        });
      }
      if (ws.bufferedAmount > HIGH_WATER) stdin.pause();
    };
    const onStdinEnd = () => {
      // ssh closed our stdin: the session is over. The protocol has no
      // half-close, so close the WebSocket; the close event finishes.
      stdinEof = true;
      ws.close(1000);
    };
    const onStdoutError = () => {
      // ssh went away (EPIPE): nothing left to deliver to.
      stdinEof = true;
      ws.close(1000);
      finish({ code: EXIT.OK, message: '' });
    };

    function finish(result: Outcome): void {
      if (phase === 'done') return;
      if (phase === 'ready') result = { ...result, established: true };
      phase = 'done';
      clearTimeout(deadline);
      if (errorWait) clearTimeout(errorWait);
      if (reauthTimer) clearTimeout(reauthTimer);
      if (reauthReplyTimer) clearTimeout(reauthReplyTimer);
      stdin.off('data', onStdinData);
      stdin.off('end', onStdinEnd);
      stdin.off('error', onStdinEnd);
      stdin.pause();
      if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
      agent.destroy();
      resolve(result);
    }

    function protocolViolation(reason: string, message: string): void {
      try {
        ws.close(1002, reason);
      } catch {
        /* not open */
      }
      finish({ code: EXIT.PROTOCOL, message });
    }

    /** Arm the next in-band refresh: ~60 s before the current token expires. */
    function scheduleReauth(expiresAtSeconds: number): void {
      if (!options.reauth || !reauthSupported || reauthBroken) return;
      const at = expiresAtSeconds * 1000 - REAUTH_LEAD_MS;
      const delay = Math.max(at - now(), 0);
      if (reauthTimer) clearTimeout(reauthTimer);
      reauthTimer = setTimeout(() => void renew(), delay);
    }

    async function renew(): Promise<void> {
      if (phase !== 'ready' || !options.reauth || !reauthSupported || reauthBroken || reauthPending) return;
      let minted: { token: string; expiresAt: number };
      try {
        minted = await options.reauth.mint();
      } catch {
        // No fresh token (broker unreachable, logged out): retry until the
        // current token expires; the gateway then closes the stream.
        if (reauthTimer) clearTimeout(reauthTimer);
        reauthTimer = setTimeout(() => void renew(), REAUTH_RETRY_MS);
        return;
      }
      if (minted.expiresAt * 1000 <= now() + REAUTH_LEAD_MS) {
        // A token that is already within the refresh window cannot push the
        // deadline out; retry shortly rather than spinning.
        if (reauthTimer) clearTimeout(reauthTimer);
        reauthTimer = setTimeout(() => void renew(), REAUTH_RETRY_MS);
        return;
      }
      reauthPending = true;
      tokenExpiresAt = minted.expiresAt;
      if (reauthReplyTimer) clearTimeout(reauthReplyTimer);
      reauthReplyTimer = setTimeout(() => {
        // No acknowledgement: stop renewing and let the stream die at expiry.
        reauthPending = false;
        reauthBroken = true;
      }, REAUTH_REPLY_MS);
      ws.send(JSON.stringify({ type: 'reauth', v: PROTOCOL_VERSION, token: minted.token }));
      minted = { token: '', expiresAt: 0 };
    }

    ws.on('unexpected-response', (req, res) => {
      const status = res.statusCode ?? 0;
      const location = status >= 300 && status < 400 ? ' (redirects are not followed)' : '';
      res.resume();
      req.destroy();
      finish({ code: EXIT.CONNECT, message: `gateway refused the WebSocket upgrade (HTTP ${status})${location}` });
    });

    ws.on('error', (error: Error & { code?: string }) => {
      if (phase === 'done') return;
      if (phase === 'ready' && !String(error.code ?? '').startsWith('WS_ERR_')) return; // the close event classifies it
      finish(connectFailure(error, endpoint.host));
    });

    ws.on('open', () => {
      if (phase !== 'connecting') return;
      phase = 'auth';
      const auth: Record<string, unknown> = { type: 'auth', v: PROTOCOL_VERSION, token, device_id: deviceId };
      if (options.reauth) auth.caps = ['reauth'];
      ws.send(JSON.stringify(auth));
      token = '';
    });

    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (phase === 'done') return;
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      if (phase === 'ready') {
        if (!isBinary) {
          // The single TEXT frame allowed after ready is the reauth
          // acknowledgement, and only while one is outstanding.
          if (reauthPending) {
            let expiresAt: number;
            try {
              expiresAt = parseReauthOk(buf.toString('utf8'));
            } catch {
              reauthPending = false;
              reauthBroken = true;
              protocolViolation('bad reauth_ok', `gateway sent an invalid reauth acknowledgement (protocol violation)`);
              return;
            }
            if (reauthReplyTimer) clearTimeout(reauthReplyTimer);
            reauthPending = false;
            tokenExpiresAt = expiresAt;
            try {
              writeLeaseReceipt(options.reauth!.leaseFile, expiresAt);
              scheduleReauth(expiresAt);
            } catch {
              // The receipt could not be rewritten: the daemon will treat
              // the lease as expired; keep the tunnel but stop renewing.
              reauthBroken = true;
            }
            return;
          }
          protocolViolation('text after ready', 'gateway sent a text message after ready (protocol violation); connection aborted');
          return;
        }
        if (!stdout.write(buf)) {
          ws.pause();
          stdout.once('drain', () => ws.resume());
        }
        return;
      }
      if (phase === 'error-frame') return; // waiting for the close code only
      if (isBinary) {
        protocolViolation('binary before ready', 'gateway sent SSH data before ready (protocol violation)');
        return;
      }
      let frame: ControlFrame;
      try {
        if (buf.length > MAX_CONTROL_BYTES) throw new ControlFrameError('control frame too large');
        frame = parseControlFrame(buf.toString('utf8'));
      } catch (error) {
        if (!(error instanceof ControlFrameError)) throw error;
        protocolViolation('bad control frame', `gateway sent an invalid control frame: ${error.message}`);
        return;
      }
      if (frame.type === 'error') {
        const code = sanitizeRemoteText(frame.code, 40);
        refused = {
          code: ERROR_CODE_EXIT[frame.code] ?? EXIT.CONNECT,
          message: `gateway refused: ${code}: ${sanitizeRemoteText(frame.message)}`,
        };
        phase = 'error-frame';
        // Give the gateway a moment to send its close code, which is the
        // more precise classification.
        errorWait = setTimeout(() => finish(refused!), ERROR_CLOSE_WAIT_MS);
        return;
      }
      if (frame.device_id !== deviceId) {
        protocolViolation(
          'device mismatch',
          'gateway answered ready for a different device (protocol violation); connection aborted',
        );
        return;
      }
      // frame.ssh_host_key is advisory and deliberately ignored: OpenSSH
      // verifies the host key against the client's own pin file.
      phase = 'ready';
      trace('wss_ready');
      clearTimeout(deadline);
      reauthSupported = Boolean(options.reauth) && (frame.caps ?? []).includes('reauth');
      if (reauthSupported && tokenExpiresAt > 0) scheduleReauth(tokenExpiresAt);
      stdout.on('error', onStdoutError);
      stdin.on('data', onStdinData);
      stdin.on('end', onStdinEnd);
      stdin.on('error', onStdinEnd);
      stdin.resume();
    });

    ws.on('close', (closeCode: number) => {
      if (phase === 'done') return;
      if (phase === 'error-frame' && refused) {
        const mapped = CLOSE_CODE_EXIT[closeCode];
        finish(mapped !== undefined ? { code: mapped, message: refused.message } : refused);
        return;
      }
      if (phase === 'ready') {
        if (stdinEof || closeCode === 1000 || closeCode === 1001) finish({ code: EXIT.OK, message: '' });
        else finish(closeOutcome(closeCode, EXIT.LOST));
        return;
      }
      finish(closeOutcome(closeCode, EXIT.CONNECT));
    });
  });
}
