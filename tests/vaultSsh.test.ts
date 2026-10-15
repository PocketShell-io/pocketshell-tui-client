/**
 * Vault credentials against real OpenSSH: key parsing for every supported
 * type, the in-process agent seen by ssh-add / ssh-keygen -Y, the askpass
 * helper's prompt filter, and a real login to a private throwaway sshd
 * (own host key, own authorized_keys, 127.0.0.1, never ~/.ssh).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startCredential } from '../src/vault/agent.js';
import { parsePrivateKey, publicKeyLine } from '../src/vault/sshKey.js';
import { buildSshArgv } from '../src/transport/ssh.js';
import { findSsh, runSshCaptured } from '../src/transport/openssh.js';
import { sshKeygen } from './vaultFixture.js';

const savedEnv = { ...process.env };
let xdg = '';
beforeEach(() => {
  xdg = mkdtempSync(join(tmpdir(), 'psc-vssh-'));
  process.env.XDG_RUNTIME_DIR = join(xdg, 'run');
});
afterEach(() => {
  process.env = { ...savedEnv };
  rmSync(xdg, { recursive: true, force: true });
});

/** Async run: the agent answers on this process's event loop, so never spawnSync against it. */
function run(file: string, args: string[], options: { env?: NodeJS.ProcessEnv; input?: string } = {}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { env: options.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(options.input ?? '');
  });
}

const strip = (line: string): string => line.split(' ').slice(0, 2).join(' ');

describe('parsePrivateKey', () => {
  const cases: Array<['ed25519' | 'rsa' | 'ecdsa', number | undefined, string]> = [
    ['ed25519', undefined, 'ssh-ed25519'],
    ['rsa', 2048, 'ssh-rsa'],
    ['ecdsa', 256, 'ecdsa-sha2-nistp256'],
    ['ecdsa', 384, 'ecdsa-sha2-nistp384'],
    ['ecdsa', 521, 'ecdsa-sha2-nistp521'],
  ];
  for (const [type, bits, sshType] of cases) {
    it(`${sshType}: the public line matches ssh-keygen's`, () => {
      const k = sshKeygen(type, bits);
      const key = parsePrivateKey(k.pem);
      expect(key.type).toBe(sshType);
      expect(strip(publicKeyLine(key))).toBe(strip(k.publicLine));
    });
  }

  it('accepts a PKCS#8 PEM and refuses an encrypted key without leaking it', () => {
    const rsa = spawnSync('openssl', ['genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048'], { encoding: 'utf8' });
    if (rsa.status === 0) expect(parsePrivateKey(rsa.stdout).type).toBe('ssh-rsa');
    const enc = '-----BEGIN OPENSSH PRIVATE KEY-----\n' + Buffer.concat([Buffer.from('openssh-key-v1\0'), Buffer.from([0, 0, 0, 10]), Buffer.from('aes256-ctr')]).toString('base64') + '\n-----END OPENSSH PRIVATE KEY-----\n';
    expect(() => parsePrivateKey(enc)).toThrow(/still encrypted/);
    expect(() => parsePrivateKey('-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----')).toThrow(/still encrypted/);
  });
});

describe('in-process agent', () => {
  for (const [type, bits] of [['ed25519', undefined], ['rsa', 2048], ['ecdsa', 384]] as const) {
    it(`${type}: ssh-add lists it and ssh-keygen -Y signs through it`, async () => {
      const k = sshKeygen(type, bits);
      const cred = await startCredential({ kind: 'key', pem: k.pem });
      try {
        const env = { ...process.env, SSH_AUTH_SOCK: cred.agentSocket! };
        const listed = await run('ssh-add', ['-L'], { env });
        expect(listed.status).toBe(0);
        expect(strip(listed.stdout.trim())).toBe(strip(k.publicLine));
        const data = join(xdg, 'msg');
        writeFileSync(data, 'hello vault');
        const signed = await run('ssh-keygen', ['-Y', 'sign', '-f', cred.identityFile!, '-n', 'file', data], { env });
        expect(signed.status, signed.stderr).toBe(0);
        writeFileSync(join(xdg, 'allowed'), `t ${strip(k.publicLine)}\n`);
        const verified = await run('ssh-keygen', ['-Y', 'verify', '-f', join(xdg, 'allowed'), '-I', 't', '-n', 'file', '-s', `${data}.sig`], {
          input: 'hello vault',
        });
        expect(verified.status, verified.stderr).toBe(0);
        // only the public key is on disk
        expect(readFileSync(cred.identityFile!, 'utf8')).not.toContain('PRIVATE');
      } finally {
        await cred.close();
      }
      expect(existsSync(cred.agentSocket!)).toBe(false);
    });
  }
});

describe('askpass helper', () => {
  it('answers a password prompt, refuses anything else (host-key confirmation)', async () => {
    const cred = await startCredential({ kind: 'password', password: 'pw for tests' });
    try {
      const askpass = cred.env.SSH_ASKPASS!;
      const ok = await run(askpass, ["u@h's password: "]);
      expect(ok.status).toBe(0);
      expect(ok.stdout).toBe('pw for tests\n');
      const hostKey = await run(askpass, ['Are you sure you want to continue connecting (yes/no/[fingerprint])?']);
      expect(hostKey.status).not.toBe(0);
      expect(hostKey.stdout).toBe('');
      expect(cred.password).toBe(true);
      expect(cred.env.SSH_ASKPASS_REQUIRE).toBe('force');
    } finally {
      await cred.close();
    }
  });
});

const SSHD = '/usr/sbin/sshd';
const sshdUsable = existsSync(SSHD) && existsSync('/run/sshd') && process.platform !== 'win32';

describe.skipIf(!sshdUsable)('end to end: a private sshd accepts the vault key', () => {
  let dir = '';
  let port = 0;
  let sshd: ChildProcess | null = null;
  let key: { pem: string; publicLine: string };
  let other: { pem: string; publicLine: string };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'psc-vsshd-'));
    key = sshKeygen('ed25519');
    other = sshKeygen('ed25519');
    const host = join(dir, 'host_ed25519');
    spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', host]);
    writeFileSync(join(dir, 'authorized_keys'), `${key.publicLine}\n`, { mode: 0o600 });
    port = await new Promise<number>((resolve) => {
      const s = createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    writeFileSync(
      join(dir, 'sshd_config'),
      [
        `Port ${port}`,
        'ListenAddress 127.0.0.1',
        `HostKey ${host}`,
        `AuthorizedKeysFile ${join(dir, 'authorized_keys')}`,
        'PasswordAuthentication no',
        'KbdInteractiveAuthentication no',
        'UsePAM no',
        'StrictModes no',
        `PidFile ${join(dir, 'sshd.pid')}`,
      ].join('\n') + '\n',
    );
    writeFileSync(join(dir, 'known_hosts'), `[127.0.0.1]:${port} ${readFileSync(`${host}.pub`, 'utf8')}`);
    sshd = spawn(SSHD, ['-D', '-e', '-f', join(dir, 'sshd_config')], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 500));
  }, 30_000);

  afterAll(() => {
    sshd?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  async function login(pem: string): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    const cred = await startCredential({ kind: 'key', pem });
    try {
      const argv = buildSshArgv({
        config: { destination: '127.0.0.1', port, user: process.env.USER ?? 'nobody' },
        controlPath: null,
        kind: 'exec',
        command: 'echo vault-ok',
        vault: { identityFile: cred.identityFile!, options: cred.options, password: false, keepOwnIdentity: false },
      });
      // Hermetic: ignore ~/.ssh/config and known_hosts, trust only this sshd.
      const at = argv.indexOf('--');
      argv.splice(at, 0, '-F', 'none', '-o', `UserKnownHostsFile=${join(dir, 'known_hosts')}`, '-o', 'GlobalKnownHostsFile=/dev/null');
      return await runSshCaptured(findSsh(), argv, { timeoutMs: 20_000, env: { ...process.env, SSH_AUTH_SOCK: '' } });
    } finally {
      await cred.close();
    }
  }

  it('logs in with the vault key held only in memory', async () => {
    const out = await login(key.pem);
    expect(out.stderr).not.toMatch(/Permission denied/);
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('vault-ok');
  }, 30_000);

  it('a key the host does not know is refused', async () => {
    const out = await login(other.pem);
    expect(out.exitCode).toBe(255);
  }, 30_000);
});
