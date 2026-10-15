import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGatewaySshArgv, cliInvocation, sshEnvironment } from '../transport/gateway.js';
import { controlDir, findSsh, newStatusFilePath, readStatusFile, shQuote } from '../transport/openssh.js';
import { ConnectionError } from '../transport/types.js';
import { resolveEndpoint } from '../gateway/endpoint.js';
import { pinFilePath, requirePinEntry } from '../gateway/pins.js';
import { requests } from './context.js';
import { USER_BIN_PATH } from '@pocketshell/core';
import { frames, frame } from './framing.js';
import type { HostEntry } from '../hosts/store.js';
import { trace } from '../trace.js';
const MAX_RPC = 16 << 20;
export class RpcFailure extends ConnectionError {
  constructor(
    code: string,
    message: string,
    readonly notDispatched = false,
    details?: Record<string, unknown>,
  ) {
    super(
      message,
      code,
      code === 'SESSION_NOT_FOUND' || code === 'SESSION_AMBIGUOUS'
        ? 5
        : code === 'NOT_LOGGED_IN'
          ? 3
          : code === 'USAGE' || code === 'invalid_request'
            ? 2
            : code === 'operation_failed'
              ? 1
              : code === 'RPC_TIMEOUT'
                ? 124
                : 4,
      details,
    );
  }
}
interface Reply {
  protocol: number;
  id: string;
  result?: unknown;
  meta?: { generation: string; ageMs: number; processAgeMs?: number };
  error?: { code: string; message: string; notDispatched?: boolean; details?: Record<string, unknown> };
}

/** A protocol-2 push event frame: no `id`, always an `event`. */
export interface EventFrame {
  protocol: 2;
  event: 'snapshot' | 'screen' | 'ended' | 'heartbeat';
  subscription: string;
  topic: string;
  seq: number;
  data?: unknown;
  /** Frames that displaced dropped predecessors; every frame is full state. */
  gap?: boolean;
  generation?: string;
}
interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: NodeJS.Timeout;
  mutation: boolean;
  context?: ReturnType<typeof requests.getStore>;
}
function expiryReceipt(path: string): number {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== process.geteuid?.() || st.mode & 0o077 || st.size > 256)
      throw Error('unsafe lease receipt');
    const b = Buffer.alloc(st.size);
    readSync(fd, b, 0, b.length, 0);
    const match = /^PSC_LEASE: ([0-9]+)\n$/.exec(b.toString('ascii'));
    if (!match) throw Error('invalid lease receipt');
    const expiry = Number(match[1]) * 1000;
    if (expiry <= Date.now() || expiry > Date.now() + 330_000) throw Error('invalid lease expiry');
    return expiry;
  } finally {
    closeSync(fd);
    try {
      unlinkSync(path);
    } catch {}
  }
}
/** The remote shell command that serves the resident RPC helper. Pure for tests. */
export function helperCommand(protocol: 1 | 2 = 2): string {
  const helper = process.env.PSC_RPC_BINARY ?? 'a';
  if (helper !== 'a' && (!helper.startsWith('/') || /[\x00-\x1f\x7f]/.test(helper)))
    throw Error('development helper must be an absolute path');
  // Resolve the helper exactly like the legacy transport does: a managed
  // endpoint may export `a` as a shell function (bash inherits `BASH_FUNC_a%%`
  // even into non-interactive ssh exec shells) pinning its own helper ahead
  // of PATH, and the raw ssh PATH may not include the user bins at all. The
  // prefix is a no-op where neither applies, and is skipped for an absolute
  // development helper functions cannot shadow. Protocol 2 is negotiated
  // first (a strict superset); a helper that rejects it exits non-255 while
  // we are still negotiating, which retries once with protocol 1.
  return helper === 'a'
    ? `export PATH="${USER_BIN_PATH}:$PATH"; unset -f a; exec a rpc --stdio --protocol ${protocol}`
    : `exec ${shQuote(helper)} rpc --stdio --protocol ${protocol}`;
}
/** Capabilities of the negotiated helper (protocol 2 carries the push fields). */
export interface HelperCapabilities {
  protocol?: number;
  pscSchema?: number;
  selectorModes?: string[];
  versions?: { pocketshell?: unknown; aplexer?: unknown };
  methods?: string[];
  generation?: string;
  maxCaptureBytes?: number;
}

/** One exec channel, retaining OpenSSH host-key verification and the existing private WSS proxy. */
export class HostChannel {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<string, Pending>();
  private closed = false;
  private lease = 0;
  private readonly accountExpires: number;
  private retirement?: NodeJS.Timeout;
  private keepalive?: NodeJS.Timeout;
  private failures = 0;
  private negotiating = true;
  private statusFile: string;
  private leaseFile: string;
  /** Protocol-2 push events; set by the replica owner before `ready`. */
  onEvent: ((frame: EventFrame) => void) | undefined;
  /** The protocol the helper finally negotiated (1 until proven otherwise). */
  negotiated: HelperCapabilities = {};
  readonly ready: Promise<HelperCapabilities>;
  constructor(
    host: HostEntry,
    accountExpires: number,
    private readonly onRetire: (reason: unknown, established: boolean) => void,
    private readonly validatePolicy?: () => void,
  ) {
    this.accountExpires = accountExpires;
    const config = host.gateway!;
    const dir = controlDir();
    this.statusFile = newStatusFilePath(dir);
    this.leaseFile = newStatusFilePath(dir);
    // The backend bundle has a separate heavy legacy entry beside it.
    this.invocation = process.argv[1]?.endsWith('/daemon.mjs')
      ? [process.execPath, join(dirname(fileURLToPath(import.meta.url)), 'psc.mjs')]
      : cliInvocation();
    this.child = this.spawnHelper(config, 2);
    this.ready = this.call('capabilities', {}, false, 30_000, true)
      .then((capabilities) => {
        this.negotiated = capabilities as HelperCapabilities;
        trace('ssh_authenticated');
        trace('helper_ready');
        this.armLease(Math.min(expiryReceipt(this.leaseFile), this.accountExpires));
        this.negotiating = false;
        this.keepalive = setInterval(() => {
          void this.call('ping', {}, false, 10_000).then(
            () => {
              this.failures = 0;
            },
            () => {
              if (++this.failures >= 3) this.close();
            },
          );
        }, 15_000);
        this.keepalive.unref();
        return this.negotiated;
      })
      .catch((error: unknown) => {
        // A helper that rejected `--protocol 2` (exit non-255 while
        // negotiating, classified RPC_UNSUPPORTED and never dispatched)
        // gets exactly one protocol-1 retry inside the same channel: old
        // helpers keep today's request/response behavior byte-for-byte.
        if (
          !this.retriedProtocol &&
          error instanceof RpcFailure &&
          error.code === 'RPC_UNSUPPORTED' &&
          error.notDispatched &&
          this.negotiating
        ) {
          this.retriedProtocol = true;
          this.abandonChild();
          this.child = this.spawnHelper(config, 1);
          return this.call('capabilities', {}, false, 30_000, true).then((caps) => {
            this.negotiated = caps as HelperCapabilities;
            trace('ssh_authenticated');
            trace('helper_ready');
            this.armLease(Math.min(expiryReceipt(this.leaseFile), this.accountExpires));
            this.negotiating = false;
            this.startKeepalive();
            return this.negotiated;
          });
        }
        this.close(error);
        throw error;
      });
  }

  private startKeepalive(): void {
    this.keepalive = setInterval(() => {
      void this.call('ping', {}, false, 10_000).then(
        () => {
          this.failures = 0;
        },
        () => {
          if (++this.failures >= 3) this.close();
        },
      );
    }, 15_000);
    this.keepalive.unref();
  }

  private retriedProtocol = false;
  private abandoned = false;
  /** The wire protocol of the child spawned by the current attempt. */
  private wireProtocol: 1 | 2 = 2;
  private readonly invocation: string[];

  private spawnHelper(config: NonNullable<HostEntry['gateway']>, protocol: 1 | 2): ChildProcessWithoutNullStreams {
    this.wireProtocol = protocol;
    this.negotiating = true;
    const argv = buildGatewaySshArgv({
      deviceId: config.deviceId,
      endpoint: resolveEndpoint(config.server, config?.server?.startsWith('ws://') ?? false),
      alias: requirePinEntry(config.deviceId).alias,
      pinFile: pinFilePath(),
      user: config.user,
      identityFile: config.identityFile,
      invocation: this.invocation,
      kind: 'exec',
      command: helperCommand(protocol),
      statusFile: this.statusFile,
      leaseFile: this.leaseFile,
    });
    // Set keepalive before the existing defaults (OpenSSH takes the first value).
    argv.splice(2, 0, '-o', 'ServerAliveInterval=15');
    const child = spawn(findSsh(), argv, { env: sshEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
    // Every handler ignores events from a child a protocol retry replaced.
    const stale = (): boolean => child !== this.child;
    child.stderr.on('data', () => {}); // Never record untrusted diagnostics or secret-bearing output.
    child.on('error', () => {
      if (stale()) return;
      this.failOpen(new RpcFailure('CONNECT_FAILED', 'could not start SSH', true));
    });
    child.on('exit', (code) => {
      if (stale()) return;
      const failure = readStatusFile(this.statusFile);
      this.failOpen(
        new RpcFailure(
          failure?.code ??
            (this.negotiating && code !== 255 && code !== null ? 'RPC_UNSUPPORTED' : 'CONNECTION_LOST'),
          failure?.message ?? 'host helper channel closed',
          this.negotiating,
        ),
      );
    });
    this.readChild(child).catch(() => {
      if (stale()) return;
      this.failOpen(new RpcFailure('RPC_PROTOCOL', 'host helper protocol failed'));
    });
    return child;
  }

  /**
   * Fail the channel while a protocol fallback may still apply: reject the
   * in-flight negotiation and abandon the child quietly (no retire, no
   * teardown of the channel object) when a protocol-1 retry is due, else
   * the full close path.
   */
  private failOpen(reason: RpcFailure): void {
    if (this.closed || this.abandoned) return;
    if (
      !this.retriedProtocol &&
      this.negotiating &&
      reason.code === 'RPC_UNSUPPORTED' &&
      reason.notDispatched
    ) {
      // The pending capabilities call rejects; the retry in the ready
      // handler respawns with protocol 1.
      this.abandoned = true;
      this.rejectPending(reason);
      return;
    }
    this.close(reason);
  }

  /** Stop the current child without retiring the channel (protocol retry). */
  private abandonChild(): void {
    this.abandoned = false;
    this.pending.clear(); // negotiation-only state; nothing else may be in flight
    this.child.stdin.destroy();
    if (this.child.pid !== undefined) {
      try {
        process.kill(-this.child.pid, 'SIGKILL');
      } catch {
        this.child.kill('SIGKILL');
      }
    }
  }

  private rejectPending(reason: unknown): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(p.mutation ? new RpcFailure('OUTCOME_UNKNOWN', 'send outcome unknown; not replayed') : reason);
    }
    this.pending.clear();
  }

  private async readChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    for await (const value of frames(child.stdout, MAX_RPC)) {
      if (child !== this.child) return; // a protocol retry replaced this child
      const r = value as Reply & Partial<EventFrame>;
      if (r.event !== undefined) {
        // Protocol-2 push events carry no id; route them to the replica.
        if (
          this.negotiated.protocol === 2 &&
          typeof r.subscription === 'string' &&
          typeof r.topic === 'string' &&
          typeof r.seq === 'number' &&
          ['snapshot', 'screen', 'ended', 'heartbeat'].includes(r.event)
        ) {
          this.onEvent?.(r as unknown as EventFrame);
          continue;
        }
        throw Error('invalid event frame');
      }
      if (r.protocol === undefined || typeof r.id !== 'string' || 'result' in r === 'error' in r)
        throw Error('invalid RPC response');
      const p = this.pending.get(r.id);
      if (!p) throw Error('unknown response ID');
      this.pending.delete(r.id);
      clearTimeout(p.timer);
      if (r.error)
        p.reject(
          new RpcFailure(
            this.negotiating &&
            ['unsupported_method', 'unsupported_protocol'].includes(r.error.code) &&
            r.error.notDispatched
              ? 'RPC_UNSUPPORTED'
              : r.error.code,
            r.error.message,
            !!r.error.notDispatched,
            r.error.details,
          ),
        );
      else {
        if (
          r.meta &&
          typeof r.meta.generation === 'string' &&
          /^[A-Za-z0-9._:-]{1,128}$/.test(r.meta.generation) &&
          typeof r.meta.ageMs === 'number' &&
          Number.isFinite(r.meta.ageMs) &&
          r.meta.ageMs >= 0 &&
          p.context
        ) {
          p.context.freshness = {
            generation: r.meta.generation,
            ageMs: r.meta.ageMs,
            ...(typeof r.meta.processAgeMs === 'number' &&
            Number.isFinite(r.meta.processAgeMs) &&
            r.meta.processAgeMs >= 0
              ? { processAgeMs: r.meta.processAgeMs }
              : {}),
          };
        }
        p.resolve(r.result);
      }
    }
  }

  /** Subscribe to protocol-2 push topics (the helper answers {subscription, seq}). */
  subscribe(topics: string[], params: Record<string, unknown> = {}): Promise<{ subscription: string; seq: number }> {
    return this.call('subscribe', { topics, ...params }, false, 30_000) as Promise<{ subscription: string; seq: number }>;
  }

  unsubscribe(subscription: string): Promise<{ unsubscribed: string }> {
    return this.call('unsubscribe', { subscription }, false, 10_000) as Promise<{ unsubscribed: string }>;
  }

  /**
   * Arm the retirement timer for `expiry` (30 s of grace included): at fire,
   * re-read the lease receipt — the proxy rewrites it whenever in-band
   * reauth renewed the token — and re-arm on a later expiry, or close as
   * expired. The account-session expiry and policy-generation checks still
   * close the channel regardless of the lease.
   */
  private armLease(expiry: number): void {
    this.lease = expiry - 30_000;
    if (this.lease <= Date.now()) throw new RpcFailure('AUTH_LEASE_EXPIRED', 'gateway authorization lease expired', true);
    this.retirement = setTimeout(() => this.leaseExpired(), this.lease - Date.now());
    this.retirement.unref();
  }

  private leaseExpired(): void {
    if (this.closed) return;
    let renewed = 0;
    try {
      renewed = expiryReceipt(this.leaseFile);
    } catch {
      renewed = 0; // missing/unsafe receipt: no renewal happened
    }
    const next = renewed === 0 ? 0 : Math.min(renewed, this.accountExpires);
    if (next - 30_000 > Date.now()) {
      trace('lease_renewed');
      this.armLease(next);
      return;
    }
    this.close(new RpcFailure('AUTH_LEASE_EXPIRED', 'gateway authorization lease expired'));
  }
  async call(
    method: string,
    params: unknown,
    mutation = false,
    timeoutMs = 30_000,
    negotiation = false,
  ): Promise<unknown> {
    if (!negotiation) await this.ready;
    if (!negotiation) {
      try {
        this.validatePolicy?.();
      } catch (error) {
        this.close(error);
        throw error;
      }
    }
    if (this.closed || (!negotiation && this.lease <= Date.now()))
      throw new RpcFailure('CONNECTION_LOST', 'host helper unavailable', true);
    if (this.pending.size >= 64 || this.child.stdin.writableLength > 2 << 20)
      throw new RpcFailure('RPC_BUSY', 'host helper busy', true);
    const signal = requests.getStore()?.signal;
    if (signal?.aborted) throw new RpcFailure('CANCELLED', 'request cancelled', true);
    const id = randomUUID();
    const data = frame({ protocol: this.wireProtocol, id, method, params }, MAX_RPC);
    trace('request_dispatch');
    return new Promise((resolve, reject) => {
      const cancel = () =>
        this.close(
          new RpcFailure(mutation ? 'OUTCOME_UNKNOWN' : 'CANCELLED', 'request cancelled after dispatch'),
        );
      const timer = setTimeout(
        () =>
          this.close(
            new RpcFailure(mutation ? 'OUTCOME_UNKNOWN' : 'RPC_TIMEOUT', 'host helper request timed out'),
          ),
        timeoutMs,
      );
      const clean = () => signal?.removeEventListener('abort', cancel);
      this.pending.set(id, {
        context: requests.getStore(),
        mutation,
        timer,
        resolve: (v) => {
          clean();
          if (mutation) trace('pty_write_complete');
          resolve(v);
        },
        reject: (e) => {
          clean();
          reject(e);
        },
      });
      signal?.addEventListener('abort', cancel, { once: true });
      this.child.stdin.write(data, (error) => {
        if (error)
          this.close(
            new RpcFailure(
              mutation ? 'OUTCOME_UNKNOWN' : 'CONNECTION_LOST',
              'host helper channel write failed',
            ),
          );
      });
    });
  }
  close(reason: unknown = new RpcFailure('CONNECTION_LOST', 'host helper channel retired')): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.retirement);
    clearInterval(this.keepalive);
    this.child.stdin.destroy();
    const killOwned = (signal: NodeJS.Signals) => {
      if (this.child.pid !== undefined) {
        try {
          process.kill(-this.child.pid, signal);
        } catch {}
      } else this.child.kill(signal);
    };
    killOwned('SIGTERM');
    const kill = setTimeout(() => killOwned('SIGKILL'), 1000);
    kill.unref();
    this.child.once('exit', () => clearTimeout(kill));
    this.rejectPending(reason);
    for (const p of [this.statusFile, this.leaseFile])
      try {
        unlinkSync(p);
      } catch {}
    this.onRetire(reason, !this.negotiating);
  }
}
