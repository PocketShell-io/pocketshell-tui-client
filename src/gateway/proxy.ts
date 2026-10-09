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
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import type { Readable, Writable } from 'node:stream';
import WebSocket from 'ws';
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

// --- control frames ---------------------------------------------------------

export class ControlFrameError extends Error {}

export type ControlFrame =
  | { type: 'ready'; v: 1; device_id: string; ssh_host_key: string }
  | { type: 'error'; v: 1; code: string; message: string };

const READY_KEYS = ['device_id', 'ssh_host_key', 'type', 'v'];
const ERROR_KEYS = ['code', 'message', 'type', 'v'];

/**
 * Strictly parse a pre-ready TEXT frame: ≤ 16 KiB, a JSON object with no
 * duplicate keys, type ready|error with exactly its keys, `v` the integer
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
  if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i])) {
    throw new ControlFrameError(`${kind} frame has unexpected or missing fields`);
  }
  if (doc.v !== PROTOCOL_VERSION) throw new ControlFrameError(`${kind} frame has an unsupported version`);
  for (const name of strings) {
    if (typeof doc[name] !== 'string') throw new ControlFrameError(`${kind} frame field ${name} is not a string`);
  }
  return doc as unknown as ControlFrame;
}

// --- the bridge -------------------------------------------------------------

export interface ProxyOptions {
  deviceId: string;
  endpoint: GatewayEndpoint;
  /** Mints the broker JWT (account layer). Throwing → exit 3. */
  tokenProvider: () => Promise<string>;
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
}

interface Outcome {
  code: number;
  message: string;
  /** The tunnel had reached `ready`: a session may have run. */
  established?: boolean;
}

function tokenFailure(error: unknown): Outcome {
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
  try {
    token = await options.tokenProvider();
  } catch (error) {
    return tokenFailure(error);
  }
  if (typeof token !== 'string' || token.length > MAX_TOKEN_CHARS || !/^[\x21-\x7e]+$/.test(token)) {
    return { code: EXIT.NO_TOKEN, message: 'the account layer returned a malformed gateway token' };
  }

  const timeoutMs = options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
  return new Promise<Outcome>((resolve) => {
    let phase: 'connecting' | 'auth' | 'error-frame' | 'ready' | 'done' = 'connecting';
    let stdinEof = false;
    let refused: Outcome | null = null;
    let errorWait: NodeJS.Timeout | undefined;

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
      ws.send(JSON.stringify({ type: 'auth', v: PROTOCOL_VERSION, token, device_id: deviceId }));
      token = '';
    });

    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (phase === 'done') return;
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      if (phase === 'ready') {
        if (!isBinary) {
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
      clearTimeout(deadline);
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
