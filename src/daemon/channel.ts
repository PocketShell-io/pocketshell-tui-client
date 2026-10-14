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
/** One exec channel, retaining OpenSSH host-key verification and the existing private WSS proxy. */
export class HostChannel {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<string, Pending>();
  private closed = false;
  private lease = 0;
  private retirement?: NodeJS.Timeout;
  private keepalive?: NodeJS.Timeout;
  private failures = 0;
  private negotiating = true;
  private statusFile: string;
  private leaseFile: string;
  readonly ready: Promise<unknown>;
  constructor(
    host: HostEntry,
    accountExpires: number,
    private readonly onRetire: (reason: unknown, established: boolean) => void,
    private readonly validatePolicy?: () => void,
  ) {
    const config = host.gateway!;
    const dir = controlDir();
    this.statusFile = newStatusFilePath(dir);
    this.leaseFile = newStatusFilePath(dir);
    // The backend bundle has a separate heavy legacy entry beside it.
    const invocation = process.argv[1]?.endsWith('/daemon.mjs')
      ? [process.execPath, join(dirname(fileURLToPath(import.meta.url)), 'psc.mjs')]
      : cliInvocation();
    const helper = process.env.PSC_RPC_BINARY ?? 'a';
    if (helper !== 'a' && (!helper.startsWith('/') || /[\x00-\x1f\x7f]/.test(helper)))
      throw Error('development helper must be an absolute path');
    const command = `exec ${shQuote(helper)} rpc --stdio --protocol 1`;
    const argv = buildGatewaySshArgv({
      deviceId: config.deviceId,
      endpoint: resolveEndpoint(config.server, config.server?.startsWith('ws://') ?? false),
      alias: requirePinEntry(config.deviceId).alias,
      pinFile: pinFilePath(),
      user: config.user,
      identityFile: config.identityFile,
      invocation,
      kind: 'exec',
      command,
      statusFile: this.statusFile,
      leaseFile: this.leaseFile,
    });
    // Set keepalive before the existing defaults (OpenSSH takes the first value).
    argv.splice(2, 0, '-o', 'ServerAliveInterval=15');
    this.child = spawn(findSsh(), argv, { env: sshEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.on('data', () => {}); // Never record untrusted diagnostics or secret-bearing output.
    this.child.on('error', () => this.close(new RpcFailure('CONNECT_FAILED', 'could not start SSH', true)));
    this.child.on('exit', (code) => {
      const failure = readStatusFile(this.statusFile);
      this.close(
        new RpcFailure(
          failure?.code ??
            (this.negotiating && code !== 255 && code !== null ? 'RPC_UNSUPPORTED' : 'CONNECTION_LOST'),
          failure?.message ?? 'host helper channel closed',
          this.negotiating,
        ),
      );
    });
    void this.read().catch(() => this.close(new RpcFailure('RPC_PROTOCOL', 'host helper protocol failed')));
    this.ready = this.call('capabilities', {}, false, 30_000, true)
      .then((capabilities) => {
        trace('ssh_authenticated');
        trace('helper_ready');
        this.lease = Math.min(expiryReceipt(this.leaseFile), accountExpires) - 30_000;
        if (this.lease <= Date.now())
          throw new RpcFailure('AUTH_LEASE_EXPIRED', 'gateway authorization lease expired', true);
        this.negotiating = false;
        this.retirement = setTimeout(
          () => this.close(new RpcFailure('AUTH_LEASE_EXPIRED', 'gateway authorization lease expired')),
          this.lease - Date.now(),
        );
        this.retirement.unref();
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
        return capabilities;
      })
      .catch((error) => {
        this.close(error);
        throw error;
      });
  }
  private async read(): Promise<void> {
    for await (const value of frames(this.child.stdout, MAX_RPC)) {
      const r = value as Reply;
      if (r.protocol !== 1 || typeof r.id !== 'string' || 'result' in r === 'error' in r)
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
    const data = frame({ protocol: 1, id, method, params }, MAX_RPC);
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
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(p.mutation ? new RpcFailure('OUTCOME_UNKNOWN', 'send outcome unknown; not replayed') : reason);
    }
    this.pending.clear();
    for (const p of [this.statusFile, this.leaseFile])
      try {
        unlinkSync(p);
      } catch {}
    this.onRetire(reason, !this.negotiating);
  }
}
