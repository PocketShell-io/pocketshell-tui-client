/**
 * Hand a vault credential to the system OpenSSH client without writing it
 * to disk.
 *
 * - A key: a minimal in-process ssh-agent (REQUEST_IDENTITIES, SIGN_REQUEST)
 *   on a socket inside a fresh 0700 directory. Only the PUBLIC key is written
 *   there, so ssh can run with `IdentitiesOnly=yes -i <pub>` and offers
 *   exactly this key; the private half stays in this process's heap.
 * - A password (ssh mode only): an SSH_ASKPASS helper script in the same
 *   directory that asks this process for the password over a second socket.
 *   It answers only a password prompt, never a host-key confirmation.
 *
 * `close()` stops the servers and removes the directory. The agent answers
 * on this process's event loop: ssh must be spawned asynchronously.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { controlDir } from '../transport/openssh.js';
import { VaultError, type VaultSecret } from './format.js';
import { parsePrivateKey, publicKeyLine, Reader, sshString, type SshKey } from './sshKey.js';

const SSH_AGENT_FAILURE = 5;
const SSH_AGENTC_REQUEST_IDENTITIES = 11;
const SSH_AGENT_IDENTITIES_ANSWER = 12;
const SSH_AGENTC_SIGN_REQUEST = 13;
const SSH_AGENT_SIGN_RESPONSE = 14;
const MAX_MESSAGE = 256 * 1024;

function frame(type: number, body: Buffer = Buffer.alloc(0)): Buffer {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(body.length + 1);
  head[4] = type;
  return Buffer.concat([head, body]);
}

/** Answer one agent request for `key`. Exported for tests. */
export function agentReply(key: SshKey, message: Buffer): Buffer {
  const type = message[0];
  try {
    if (type === SSH_AGENTC_REQUEST_IDENTITIES) {
      const count = Buffer.alloc(4);
      count.writeUInt32BE(1);
      return frame(SSH_AGENT_IDENTITIES_ANSWER, Buffer.concat([count, sshString(key.publicBlob), sshString(key.comment)]));
    }
    if (type === SSH_AGENTC_SIGN_REQUEST) {
      const r = new Reader(message.subarray(1));
      const blob = r.bytes();
      const data = r.bytes();
      const flags = r.done ? 0 : r.u32();
      if (!blob.equals(key.publicBlob)) return frame(SSH_AGENT_FAILURE);
      return frame(SSH_AGENT_SIGN_RESPONSE, sshString(key.sign(Buffer.from(data), flags)));
    }
  } catch {
    /* malformed request */
  }
  return frame(SSH_AGENT_FAILURE);
}

function serveFramed(socket: Socket, handle: (message: Buffer) => Buffer): void {
  let pending = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4) {
      const len = pending.readUInt32BE(0);
      if (len === 0 || len > MAX_MESSAGE) {
        socket.destroy();
        return;
      }
      if (pending.length < 4 + len) break;
      const message = pending.subarray(4, 4 + len);
      pending = pending.subarray(4 + len);
      socket.write(handle(message));
    }
  });
  socket.on('error', () => socket.destroy());
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

/** The ssh options and environment that route auth through this credential. */
export interface SshCredential {
  /** `-i` target: the public key file (key) or undefined (password). */
  identityFile?: string;
  /** The in-process agent's socket (key credentials). */
  agentSocket?: string;
  /** Extra `-o` options. */
  options: string[];
  /** Environment additions for the ssh process. */
  env: Record<string, string>;
  /** Password auth needs prompts: the caller must drop BatchMode. */
  password: boolean;
  close(): Promise<void>;
}

/** POSIX single-quoted shell word. */
const shq = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

const ASKPASS_SCRIPT = (node: string, socket: string, prompt: string): string => `#!/bin/sh
# PocketShell vault askpass: answers only this host's password prompt, once.
[ "$1" = ${shq(prompt)} ] || exit 1
exec "${node}" -e '
const s = require("net").connect(process.argv[1]);
let out = Buffer.alloc(0);
s.on("data", (d) => { out = Buffer.concat([out, d]); });
s.on("end", () => { if (out.length) { process.stdout.write(out); process.stdout.write("\\n"); } else process.exit(1); });
s.on("error", () => process.exit(1));
' "${socket}"
`;

function privateDir(): string {
  // The control dir is already checked private and free of characters ssh
  // (or the askpass script) would expand.
  const base = controlDir();
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(base, 'vk-'));
  chmodSync(dir, 0o700);
  return dir;
}

/** How long an unanswered password helper stays up. */
export const PASSWORD_HELPER_TTL_MS = 120_000;

/**
 * Start the agent (key) or askpass server (password) for one connection.
 * A password needs `expectPrompt`, the exact `user@host's password: ` ssh
 * will show for this host (see expectedPasswordPrompt): any other prompt
 * (a ProxyJump host, a host-key question) gets nothing. The password is
 * answered once, then the helper closes; unused, it closes after 2 min.
 */
export async function startCredential(secret: VaultSecret, options: { expectPrompt?: string } = {}): Promise<SshCredential> {
  if (process.platform === 'win32') {
    throw new VaultError('Vault keys are not wired to Windows OpenSSH yet; use an identity file for this host.', 'VAULT_UNSUPPORTED_PLATFORM', 2);
  }
  const dir = privateDir();
  const servers: Server[] = [];
  const close = async (): Promise<void> => {
    await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    if (secret.kind === 'key') {
      const key = parsePrivateKey(secret.pem);
      const sock = join(dir, 'agent.sock');
      const pub = join(dir, 'id.pub');
      const server = createServer((socket) => serveFramed(socket, (message) => agentReply(key, message)));
      servers.push(server);
      await listen(server, sock);
      chmodSync(sock, 0o600);
      writeFileSync(pub, `${publicKeyLine(key)}\n`, { mode: 0o600 });
      return {
        identityFile: pub,
        agentSocket: sock,
        // Never forward the vault agent to the host, whatever ~/.ssh/config says.
        options: [`IdentityAgent=${sock}`, 'IdentitiesOnly=yes', 'ForwardAgent=no'],
        env: {},
        password: false,
        close,
      };
    }
    if (!options.expectPrompt || /[\x00-\x1f\x7f]/.test(options.expectPrompt)) {
      throw new VaultError('a vault password needs the exact host prompt to answer', 'VAULT_PASSWORD_UNSUPPORTED', 2);
    }
    let password: string | null = secret.password;
    const sock = join(dir, `ap-${randomBytes(8).toString('hex')}.sock`);
    // One answer, then the helper is gone: NumberOfPasswordPrompts=1 means
    // ssh never asks twice, and nothing else gets the password later.
    const server = createServer((socket) => {
      socket.on('error', () => socket.destroy());
      const answer = password;
      password = null;
      socket.end(answer ?? '');
      server.close();
    });
    servers.push(server);
    await listen(server, sock);
    chmodSync(sock, 0o600);
    const expiry = setTimeout(() => {
      password = null;
      server.close();
    }, PASSWORD_HELPER_TTL_MS);
    expiry.unref();
    if (/["$`\\]/.test(process.execPath)) throw new VaultError('cannot build the askpass helper for this node path', 'VAULT_UNSUPPORTED_PLATFORM', 2);
    const script = join(dir, 'askpass');
    writeFileSync(script, ASKPASS_SCRIPT(process.execPath, sock, options.expectPrompt), { mode: 0o700 });
    return {
      options: [
        // Password only: keyboard-interactive prompts come from the server
        // and cannot be tied to this host.
        'PreferredAuthentications=password',
        'KbdInteractiveAuthentication=no',
        'PubkeyAuthentication=no',
        'NumberOfPasswordPrompts=1',
        'ForwardAgent=no',
      ],
      env: { SSH_ASKPASS: script, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: process.env.DISPLAY ?? ':0' },
      password: true,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
