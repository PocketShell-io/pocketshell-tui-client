/**
 * The vault holder: keeps an unlocked vault available to later psc
 * invocations without storing anything, like ssh-agent does for keys.
 *
 * `psc vault unlock` (without --remember) starts one detached process that
 * holds the remember record (DEK + AUTH) in memory only and serves it on a
 * 0600 socket inside the private 0700 runtime dir, to this user only. It
 * exits, wiping the record, on `psc vault lock`, after an idle period with
 * no request (default 30 min, PSC_VAULT_IDLE_MINUTES), or on SIGTERM. It is
 * not written to disk at any point; the record reaches it on a pipe.
 *
 * Windows has no equivalent owner-only socket here: the holder is POSIX
 * only, and Windows users remember with DPAPI instead.
 */
import { spawn } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, rmSync } from 'node:fs';
import { connect, createServer, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { cliInvocation } from '../transport/gateway.js';
import { controlDir } from '../transport/openssh.js';
import type { RememberRecord } from './remember.js';

export const DEFAULT_IDLE_MINUTES = 30;
const MAX_LINE = 4096;

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

interface HeldRecord {
  account: string;
  record: RememberRecord;
}

function parseHeld(text: string): HeldRecord | null {
  try {
    const doc = JSON.parse(text) as HeldRecord;
    const r = doc.record;
    if (
      typeof doc.account !== 'string' ||
      typeof r?.vaultId !== 'string' ||
      typeof r.dek !== 'string' ||
      typeof r.epoch !== 'number' ||
      (r.auth !== undefined && typeof r.auth !== 'string')
    ) {
      return null;
    }
    return { account: doc.account, record: { v: 1, vaultId: r.vaultId, epoch: r.epoch, dek: r.dek, ...(r.auth ? { auth: r.auth } : {}) } };
  } catch {
    return null;
  }
}

/** One request/answer line over the holder socket; null when no holder answers. */
function ask(line: string, timeoutMs = 2000): Promise<string | null> {
  if (!holderSupported()) return Promise.resolve(null);
  return new Promise((resolve) => {
    let socket: Socket;
    let out = '';
    let done = false;
    const finish = (value: string | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      socket = connect(holderSocket());
    } catch {
      // no safe runtime dir: no holder
      clearTimeout(timer);
      resolve(null);
      return;
    }
    socket.on('connect', () => socket.write(`${line}\n`));
    socket.on('data', (d: Buffer) => {
      out += d.toString('utf8');
      if (out.length > MAX_LINE * 4) finish(null);
    });
    socket.on('end', () => finish(out));
    socket.on('error', () => finish(null));
  });
}

/** The record the holder keeps for `account`, or null (no holder, other account, locked). */
export async function heldRecord(account: string): Promise<RememberRecord | null> {
  const answer = await ask(`get ${account}`);
  if (!answer) return null;
  return parseHeld(answer.trim())?.record ?? null;
}

/** Tell the holder to wipe and exit. True when one was running. */
export async function stopHolder(): Promise<boolean> {
  return (await ask('lock')) !== null;
}

export async function holderRunning(): Promise<boolean> {
  return (await ask('ping')) === 'pong\n';
}

/**
 * Start (or replace) the holder with `record`. The record goes over the
 * child's stdin, never argv or the environment; resolves once it listens.
 */
export async function startHolder(account: string, record: RememberRecord): Promise<boolean> {
  if (!holderSupported()) return false;
  await stopHolder();
  const [node, ...script] = cliInvocation();
  const child = spawn(node!, [...script, 'vault', '__hold'], {
    detached: true,
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, PSC_DAEMON: '0' },
  });
  const ready = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 10_000);
    child.stdout!.once('data', (d: Buffer) => {
      clearTimeout(timer);
      resolve(d.toString().startsWith('ready'));
    });
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
  child.stdin!.end(`${JSON.stringify({ account, record })}\n`);
  const ok = await ready;
  child.stdout!.destroy();
  child.unref();
  return ok;
}

/** The holder process body (`psc vault __hold`): read the record from stdin, serve it. */
export async function runHolder(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  let held = parseHeld(text.trim());
  chunks.forEach((c) => c.fill(0));
  if (held === null) process.exit(2);

  const path = holderSocket();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  try {
    if (lstatSync(path).isSocket()) rmSync(path, { force: true });
  } catch {
    /* none */
  }
  const idle = idleMs();
  let timer: NodeJS.Timeout;
  const wipeAndExit = (): void => {
    held = null;
    server.close();
    rmSync(path, { force: true });
    process.exit(0);
  };
  const touch = (): void => {
    clearTimeout(timer);
    timer = setTimeout(wipeAndExit, idle);
  };
  const server = createServer((socket) => {
    let line = '';
    socket.on('error', () => socket.destroy());
    socket.on('data', (d: Buffer) => {
      line += d.toString('utf8');
      if (line.length > MAX_LINE) return void socket.destroy();
      const nl = line.indexOf('\n');
      if (nl < 0) return;
      const [verb, account] = line.slice(0, nl).split(' ');
      if (verb === 'ping') return void socket.end('pong\n');
      if (verb === 'lock') {
        socket.end('ok\n', wipeAndExit);
        return;
      }
      if (verb === 'get' && held !== null && account === held.account) {
        touch();
        return void socket.end(`${JSON.stringify(held)}\n`);
      }
      socket.end('');
    });
  });
  process.on('SIGTERM', wipeAndExit);
  process.on('SIGINT', wipeAndExit);
  process.on('SIGHUP', () => {});
  await new Promise<void>((resolve) => server.listen(path, resolve));
  chmodSync(path, 0o600);
  touch();
  process.stdout.write('ready\n');
}
