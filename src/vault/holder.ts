/**
 * The vault holder: keeps an unlocked vault for later psc invocations
 * without storing anything, and acts as their ssh-agent.
 *
 * `psc vault unlock` (without --remember) starts one detached psc process
 * that unlocks its own KeyVaultStore from the remember record (handed over
 * on a pipe, never argv, env or disk) and keeps it in memory. It answers
 * this user on a 0600 socket inside the private 0700 control dir, and it
 * never hands out the DEK, AUTH or a private key: a connect asks for a
 * host's credential and gets the path of an agent socket the holder serves
 * for that key (signing only), or, for a vault password, an SSH_ASKPASS
 * helper that the holder answers. Index metadata (key names, types,
 * bindings) is served for `psc vault status`.
 *
 * It wipes everything and exits on `psc vault lock`, after an idle period
 * with no request (default 30 min, PSC_VAULT_IDLE_MINUTES), 12 h after it
 * started whatever the use, or on a signal.
 * POSIX only; Windows remembers with DPAPI instead.
 */
import { spawn } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, rmSync } from 'node:fs';
import { connect, createServer, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import type { HostKeyBinding, KeyVaultStore, VaultKeyEntry } from '@pocketshell/core';
import { cliInvocation } from '../transport/gateway.js';
import { controlDir } from '../transport/openssh.js';
import { startCredential, type SshCredential } from './agent.js';
import { VaultError, type GatewayAuth } from './format.js';
import type { RememberRecord } from './remember.js';

export const DEFAULT_IDLE_MINUTES = 30;
/** However busy, a holder locks after this long (a fresh `psc vault unlock` starts a new one). */
export const MAX_HOLD_HOURS = 12;
const MAX_LINE = 64 * 1024;

export function holderSupported(): boolean {
  return process.platform !== 'win32';
}

/** In the private control dir (checked owned by us, 0700, no ssh-expandable characters). */
export function holderSocket(): string {
  return join(controlDir(), 'vault-holder.sock');
}

export function idleMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.PSC_VAULT_IDLE_MINUTES);
  const minutes = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 24 * 60) : DEFAULT_IDLE_MINUTES;
  return minutes * 60_000;
}

export interface HolderStatus {
  vaultId: string | null;
  epoch: number | null;
  keys: VaultKeyEntry[];
  bindings: Record<string, HostKeyBinding>;
}

/** A credential served by the holder: the caller only points ssh at it. */
export interface HeldCredential {
  credential: SshCredential;
  gatewayAuth: GatewayAuth;
  keyId: string;
}

type Request =
  | { op: 'ping' }
  | { op: 'lock' }
  | { op: 'status'; account: string }
  | { op: 'credential'; account: string; alias?: string | null; keyId?: string; gatewayAuth?: GatewayAuth; expectPrompt?: string };

/** One request/answer over the holder socket; null when no holder answers. */
function ask(request: Request, timeoutMs = 15_000): Promise<Record<string, unknown> | null> {
  if (!holderSupported()) return Promise.resolve(null);
  return new Promise((resolve) => {
    let socket: Socket | undefined;
    let out = '';
    let done = false;
    const finish = (value: Record<string, unknown> | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket?.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    let s: Socket;
    try {
      s = connect(holderSocket());
    } catch {
      finish(null); // no safe runtime dir: no holder
      return;
    }
    socket = s;
    s.on('connect', () => s.write(`${JSON.stringify(request)}\n`));
    s.on('data', (d: Buffer) => {
      out += d.toString('utf8');
      if (out.length > MAX_LINE) finish(null);
    });
    s.on('end', () => {
      try {
        finish(JSON.parse(out) as Record<string, unknown>);
      } catch {
        finish(null);
      }
    });
    s.on('error', () => finish(null));
  });
}

function holderError(answer: Record<string, unknown>): VaultError | null {
  const error = answer.error as { code?: unknown; message?: unknown; exitCode?: unknown } | undefined;
  if (!error) return null;
  return new VaultError(
    typeof error.message === 'string' ? error.message : 'the vault holder refused',
    typeof error.code === 'string' ? error.code : 'VAULT_ERROR',
    typeof error.exitCode === 'number' ? error.exitCode : 1,
  );
}

export async function holderRunning(): Promise<boolean> {
  return (await ask({ op: 'ping' }, 2000))?.pong === true;
}

/** Tell the holder to wipe and exit. True when one was running. */
export async function stopHolder(): Promise<boolean> {
  return (await ask({ op: 'lock' }, 5000)) !== null;
}

/** Non-secret index metadata from the holder for `account`; null when none holds it. */
export async function holderStatus(account: string): Promise<HolderStatus | null> {
  const answer = await ask({ op: 'status', account }, 5000);
  if (answer === null || answer.unlocked !== true) return null;
  return {
    vaultId: typeof answer.vaultId === 'string' ? answer.vaultId : null,
    epoch: typeof answer.epoch === 'number' ? answer.epoch : null,
    keys: Array.isArray(answer.keys) ? (answer.keys as VaultKeyEntry[]) : [],
    bindings: typeof answer.bindings === 'object' && answer.bindings !== null ? (answer.bindings as Record<string, HostKeyBinding>) : {},
  };
}

/**
 * The holder-served credential for a host: `undefined` when no holder holds
 * this account, `null` when the vault says the host uses its own keys (no
 * binding, or policy `host`).
 */
export async function holderCredential(
  account: string,
  binding: { alias: string | null; keyId?: string; gatewayAuth?: GatewayAuth; expectPrompt?: string | undefined },
): Promise<HeldCredential | null | undefined> {
  const answer = await ask({
    op: 'credential',
    account,
    alias: binding.alias,
    ...(binding.keyId ? { keyId: binding.keyId, gatewayAuth: binding.gatewayAuth ?? 'managed' } : {}),
    ...(binding.expectPrompt ? { expectPrompt: binding.expectPrompt } : {}),
  });
  if (answer === null || answer.held === false) return undefined;
  const error = holderError(answer);
  if (error) throw error;
  if (answer.none === true) return null;
  const c = answer.credential as { identityFile?: unknown; agentSocket?: unknown; options?: unknown; env?: unknown; password?: unknown };
  if (!c || !Array.isArray(c.options) || typeof answer.keyId !== 'string') return undefined;
  return {
    keyId: answer.keyId,
    gatewayAuth: answer.gatewayAuth as GatewayAuth,
    credential: {
      ...(typeof c.identityFile === 'string' ? { identityFile: c.identityFile } : {}),
      ...(typeof c.agentSocket === 'string' ? { agentSocket: c.agentSocket } : {}),
      options: c.options.filter((o): o is string => typeof o === 'string'),
      env: (typeof c.env === 'object' && c.env !== null ? c.env : {}) as Record<string, string>,
      password: c.password === true,
      // The holder owns the agent; it lives until the holder locks.
      close: async () => {},
    },
  };
}

/**
 * Start (or replace) the holder with `record`. The record goes over the
 * child's stdin, never argv or the environment; resolves once it listens
 * with the vault unlocked.
 */
export async function startHolder(account: string, record: RememberRecord | 'remembered'): Promise<boolean> {
  if (!holderSupported()) return false;
  await stopHolder();
  const [node, ...script] = cliInvocation();
  const child = spawn(node!, [...script, 'vault', '__hold'], {
    detached: true,
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, PSC_DAEMON: '0' },
  });
  const ready = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 30_000);
    child.stdout!.once('data', (d: Buffer) => {
      clearTimeout(timer);
      resolve(d.toString().startsWith('ready'));
    });
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
  child.stdin!.on('error', () => {}); // a holder that failed early: `ready` already says false
  child.stdin!.end(`${JSON.stringify(record === 'remembered' ? { account, fromRemembered: true } : { account, record })}\n`);
  const ok = await ready;
  child.stdout!.destroy();
  child.unref();
  return ok;
}

/**
 * The holder process body (`psc vault __hold`). `open` builds the store for
 * its account; `remembered` loads this device's remembered record (used
 * when the daemon needs a vault key: the daemon itself never unlocks).
 */
export async function runHolder(
  open: (account: string) => KeyVaultStore | null,
  remembered: (account: string) => RememberRecord | null,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  let parsed: { account?: unknown; record?: RememberRecord; fromRemembered?: boolean } | null = null;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { account?: unknown; record?: RememberRecord; fromRemembered?: boolean };
  } catch {
    parsed = null;
  }
  chunks.forEach((c) => c.fill(0));
  const account = typeof parsed?.account === 'string' ? parsed.account : null;
  const record = parsed?.fromRemembered === true && account ? remembered(account) : parsed?.record;
  const opened = account ? open(account) : null;
  if (!account || !record || !opened) process.exit(2);
  const store: KeyVaultStore = opened;
  const dek = new Uint8Array(Buffer.from(record.dek, 'base64url'));
  const auth = record.auth ? new Uint8Array(Buffer.from(record.auth, 'base64url')) : null;
  const unlocked = await store.unlockWithRememberedDek({ vaultId: record.vaultId, epoch: record.epoch, dek, ...(auth ? { auth } : {}) });
  dek.fill(0);
  auth?.fill(0);
  parsed = null;
  if (unlocked.kind !== 'ok') process.exit(3);

  const path = holderSocket();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  // A concurrent unlock may have started another holder: replace it rather
  // than unlink a live socket and orphan it.
  for (let i = 0; i < 20 && (await holderRunning()); i++) {
    await stopHolder();
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    if (lstatSync(path).isSocket()) rmSync(path, { force: true });
  } catch {
    /* none */
  }
  const served = new Map<string, Promise<SshCredential>>();
  const idle = idleMs();
  let timer: NodeJS.Timeout | undefined;
  const wipeAndExit = async (): Promise<void> => {
    store.lock();
    server.close();
    await Promise.all([...served.values()].map(async (c) => (await c.catch(() => null))?.close()));
    rmSync(path, { force: true });
    process.exit(0);
  };
  const touch = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => void wipeAndExit(), idle);
  };

  const credential = async (request: Extract<Request, { op: 'credential' }>): Promise<Record<string, unknown>> => {
    const binding: HostKeyBinding | null = request.keyId
      ? { keyId: request.keyId, gatewayAuth: request.gatewayAuth ?? 'managed' }
      : request.alias
        ? store.getHostBinding(request.alias)
        : null;
    if (binding === null || binding.gatewayAuth === 'host') return { none: true };
    const decrypt = async (): Promise<SshCredential> => {
      const secret = await store.decryptKey(binding.keyId);
      if (secret.kind === 'key') return startCredential(secret);
      // A password helper is one-shot and per request: it is never cached here.
      if (secret.kind === 'password') return startCredential(secret, request.expectPrompt ? { expectPrompt: request.expectPrompt } : {});
      const relock = secret.kind === 'gated' || secret.kind === 'locked';
      throw new VaultError(
        secret.kind === 'missingKey'
          ? `The vault key this host uses (${binding.keyId}) is not on your account any more; re-upload it or rebind the host on the web.`
          : relock
            ? 'The server wants the vault passphrase again; run `psc vault unlock`.'
            : 'A vault key could not be decrypted; run `psc vault unlock` again.',
        secret.kind === 'missingKey' ? 'VAULT_KEY_MISSING' : relock ? 'VAULT_LOCKED' : 'VAULT_RESET',
        secret.kind === 'missingKey' ? 1 : 3,
      );
    };
    const isPassword = store.getKey(binding.keyId)?.type === 'password';
    let pending = isPassword ? undefined : served.get(binding.keyId);
    if (!pending) {
      pending = decrypt();
      if (isPassword) {
        // Its own expiry closes it; track it only so a lock can close it early.
        const key = `pw:${Math.random()}`;
        served.set(key, pending);
        setTimeout(() => served.delete(key), 130_000).unref();
      } else {
        served.set(binding.keyId, pending);
      }
      pending.catch(() => served.delete(binding.keyId));
    }
    const c = await pending;
    return {
      keyId: binding.keyId,
      gatewayAuth: binding.gatewayAuth,
      credential: { identityFile: c.identityFile, agentSocket: c.agentSocket, options: c.options, env: c.env, password: c.password },
    };
  };

  const handle = async (request: Request): Promise<Record<string, unknown>> => {
    if (request.op === 'ping') return { pong: true };
    if (request.op === 'lock' || request.account !== account) return { held: false };
    touch();
    if (request.op === 'status') {
      return { unlocked: true, vaultId: store.vaultId, epoch: store.epoch, keys: store.listKeys(), bindings: store.listHostBindings() };
    }
    try {
      return await credential(request);
    } catch (error) {
      const e = error as VaultError;
      return { error: { code: e.code ?? 'VAULT_ERROR', message: e.message, exitCode: e.exitCode ?? 1 } };
    }
  };

  const server = createServer((socket) => {
    let line = '';
    socket.on('error', () => socket.destroy());
    socket.on('data', (d: Buffer) => {
      line += d.toString('utf8');
      if (line.length > MAX_LINE) return void socket.destroy();
      const nl = line.indexOf('\n');
      if (nl < 0) return;
      let request: Request;
      try {
        request = JSON.parse(line.slice(0, nl)) as Request;
      } catch {
        return void socket.destroy();
      }
      if (request.op === 'lock') {
        socket.end('{"ok":true}', () => void wipeAndExit());
        return;
      }
      void handle(request).then((answer) => socket.end(JSON.stringify(answer)));
    });
  });
  process.on('SIGTERM', () => void wipeAndExit());
  process.on('SIGINT', () => void wipeAndExit());
  process.on('SIGHUP', () => {});
  const listening = await new Promise<boolean>((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(path, () => resolve(true));
  });
  if (!listening) {
    store.lock();
    process.exit(4);
  }
  chmodSync(path, 0o600);
  touch();
  setTimeout(() => void wipeAndExit(), MAX_HOLD_HOURS * 3_600_000).unref();
  process.stdout.write('ready\n');
}
