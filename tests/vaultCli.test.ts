/**
 * `psc vault unlock|status|lock|bind` as a subprocess against a fake broker
 * on 127.0.0.1 serving `GET /cli/settings/{slot}` (and, optionally, the
 * phase-2 `/cli/vault/*` routes). The passphrase arrives on fd 3 via
 * PSC_VAULT_PASSPHRASE_FD; it must never appear in output or files.
 */
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { save } from '../src/account/credentials.js';
import { connect } from 'node:net';
import { spawn as spawnChild } from 'node:child_process';
import { holderCredential, holderRunning, holderSocket, stopHolder } from '../src/vault/holder.js';
import { accountKey } from '../src/vault/remember.js';
import { buildVault, sshKeygen, type BuiltVault } from './vaultFixture.js';

const ROOT = resolve(__dirname, '..');
const TOKEN = `psc_${'B'.repeat(43)}`;
const PASS = 'cli test passphrase';
let built: BuiltVault;
let server: Server;
let base = '';
let slots = new Map<string, string>();
let hits: string[] = [];
let verifyAnswer: { status: number; body: unknown } | null = null;
let routeMissing = false;
let unconfigured = false;

beforeAll(async () => {
  const k = sshKeygen('ed25519');
  built = await buildVault({
    passphrase: PASS,
    keys: [{ name: 'box key', pem: k.pem }],
    passwords: [{ name: 'nas password', password: 'nas-pw-for-tests' }],
    hosts: { box: { key: 'box key', gatewayAuth: 'managed' }, nasbox: { key: 'nas password', gatewayAuth: 'managed' } },
  });
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on('end', () => {
      hits.push(`${req.method} ${req.url}`);
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'invalid_token' });
      const m = /^\/cli\/settings\/([A-Za-z0-9_-]+)$/.exec(req.url ?? '');
      if (req.method === 'GET' && m && unconfigured) return send(503, { error: 'vault_not_configured' });
      if (req.method === 'GET' && m && !routeMissing) {
        const data = slots.get(m[1]!);
        return data === undefined ? send(404, { error: 'not_found' }) : send(200, { slot: m[1], version: 1, updatedAt: 'x', size: data.length, data });
      }
      if (req.method === 'POST' && req.url === '/cli/vault/verify' && verifyAnswer) return send(verifyAnswer.status, verifyAnswer.body);
      send(404, { message: 'Not Found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);
afterAll(async () => {
  await new Promise((r) => server.close(r));
});

const savedEnv = { ...process.env };
let xdg = '';
// One private runtime dir for the whole file: holders live there, never in the real one.
const runtime = mkdtempSync(join(tmpdir(), 'psc-vault-run-'));
afterAll(() => {
  rmSync(runtime, { recursive: true, force: true });
});
beforeEach(() => {
  process.env.XDG_RUNTIME_DIR = runtime;
  xdg = mkdtempSync(join(tmpdir(), 'psc-vault-cli-'));
  process.env.XDG_CONFIG_HOME = xdg;
  process.env.POCKETSHELL_BROKER_URL = base;
  process.env.POCKETSHELL_BROKER_INSECURE_DEV = '1';
  slots = new Map(built.slots);
  hits = [];
  verifyAnswer = null;
  routeMissing = false;
  unconfigured = false;
  save({ brokerUrl: base, accessToken: TOKEN, tokenId: 'tok_v', email: 'you@example.com', expiresAt: Math.floor(Date.now() / 1000) + 86400, label: 'me@box' });
});
afterEach(async () => {
  await stopHolder();
  process.env = { ...savedEnv };
  rmSync(xdg, { recursive: true, force: true });
});

function psc(args: string[], passphrase?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const env: NodeJS.ProcessEnv = { ...process.env, PSC_JSON: '', PSC_DAEMON: '0', DBUS_SESSION_BUS_ADDRESS: '' };
    if (passphrase !== undefined) env.PSC_VAULT_PASSPHRASE_FD = '3';
    const child = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'src/cli.ts'), ...args], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr!.on('data', (d: Buffer) => (stderr += d.toString()));
    const fd3 = child.stdio[3] as NodeJS.WritableStream;
    fd3.on('error', () => {});
    fd3.end(passphrase ?? '');
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code: code ?? 1, stdout, stderr });
    });
  });
}

const json = (out: string): Record<string, unknown> => JSON.parse(out.trim().split('\n').pop()!) as Record<string, unknown>;

/** No file under the temp config contains the passphrase or a private key. */
function assertNoSecretsOnDisk(): void {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
  for (const file of walk(xdg)) {
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain(PASS);
    expect(text).not.toContain('PRIVATE KEY');
  }
}

describe('psc vault', () => {
  it('unlock --remember-file --json, then status without a passphrase, then lock', async () => {
    const r = await psc(['vault', 'unlock', '--remember-file', '--json'], PASS);
    expect(r.code, r.stderr).toBe(0);
    expect(json(r.stdout)).toMatchObject({ ok: true, unlocked: true, remembered: 'file', keys: 2 });
    expect(r.stdout + r.stderr).not.toContain(PASS);
    expect(r.stderr).toMatch(/0600/);
    const file = join(xdg, 'pocketshell-tui-client', 'vault-remember.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    assertNoSecretsOnDisk();

    const s = await psc(['vault', 'status', '--json']);
    expect(s.code, s.stderr).toBe(0);
    expect(json(s.stdout)).toMatchObject({ ok: true, vault: true, unlocked: true, remembered: 'file', keys: expect.arrayContaining([expect.objectContaining({ name: 'box key', type: 'ssh-ed25519' })]) });

    const l = await psc(['vault', 'lock', '--json']);
    expect(json(l.stdout)).toMatchObject({ ok: true, locked: true, forgot: 'file' });
    expect(existsSync(file)).toBe(false);
    const after = await psc(['vault', 'status', '--json']);
    expect(json(after.stdout)).toMatchObject({ unlocked: false, remembered: null });
  }, 120_000);

  it('unlock without --remember: held in memory for later invocations, then lock', async () => {
    const r = await psc(['vault', 'unlock', '--json'], PASS);
    expect(r.code, r.stderr).toBe(0);
    expect(json(r.stdout)).toMatchObject({ ok: true, remembered: null, held: true, idleMinutes: 30 });
    expect(await holderRunning()).toBe(true);
    assertNoSecretsOnDisk();
    const s = await psc(['vault', 'status', '--json']);
    expect(json(s.stdout)).toMatchObject({ unlocked: true, remembered: 'holder' });
    const l = await psc(['vault', 'lock', '--json']);
    expect(json(l.stdout)).toMatchObject({ ok: true, held: true, forgot: null });
    expect(await holderRunning()).toBe(false);
    expect(json((await psc(['vault', 'status', '--json'])).stdout)).toMatchObject({ unlocked: false });
  }, 120_000);

  it('the holder acts as the agent: a signing socket per key, never the DEK, AUTH or private key', async () => {
    const r = await psc(['vault', 'unlock', '--json'], PASS);
    expect(json(r.stdout)).toMatchObject({ held: true });
    const id = accountKey(base, 'you@example.com');
    const held = await holderCredential(id, { alias: 'box' });
    expect(held).toMatchObject({ gatewayAuth: 'managed', credential: { password: false } });
    const listed = await new Promise<string>((done) => {
      const c = spawnChild('ssh-add', ['-L'], { env: { ...process.env, SSH_AUTH_SOCK: held!.credential.agentSocket! } });
      let out = '';
      c.stdout.on('data', (d: Buffer) => (out += d.toString()));
      c.on('close', () => done(out));
    });
    expect(listed).toMatch(/^ssh-ed25519 /);
    expect(await holderCredential(id, { alias: 'unbound-host' })).toBeNull();
    expect(await holderCredential('other-account', { alias: 'box' })).toBeUndefined();
    const raw = await new Promise<string>((done) => {
      const s = connect(holderSocket(), () => s.write(`${JSON.stringify({ op: 'status', account: id })}\n`));
      let out = '';
      s.on('data', (d: Buffer) => (out += d.toString()));
      s.on('end', () => done(out));
    });
    expect(JSON.parse(raw)).toMatchObject({ unlocked: true, keys: expect.arrayContaining([expect.objectContaining({ name: 'box key' })]) });
    expect(raw).not.toMatch(/"dek"|"auth"|PRIVATE KEY/);
    expect(statSync(holderSocket()).mode & 0o777).toBe(0o600);
  }, 120_000);

  it('concurrent unlocks leave exactly one holder (no orphan)', async () => {
    const [a, b] = await Promise.all([psc(['vault', 'unlock', '--json'], PASS), psc(['vault', 'unlock', '--json'], PASS)]);
    expect(a.code + b.code).toBe(0);
    expect(await holderRunning()).toBe(true);
    await stopHolder();
    await new Promise((r) => setTimeout(r, 1500));
    const left = await new Promise<string>((done) => {
      const c = spawnChild('sh', ['-c', 'ps -eo pid,etimes,args | grep "vault __hold" | grep -v grep || true']);
      let out = '';
      c.stdout.on('data', (d: Buffer) => (out += d.toString()));
      c.on('close', () => done(out));
    });
    expect(await holderRunning()).toBe(false);
    expect(left.trim()).toBe('');
  }, 120_000);

  it('holder passwords: a fresh one-shot helper for every ssh spawn', async () => {
    expect(json((await psc(['vault', 'unlock', '--json'], PASS)).stdout)).toMatchObject({ held: true });
    const id = accountKey(base, 'you@example.com');
    const prompt = "u@nas.example's password: ";
    const held = await holderCredential(id, { alias: 'nasbox', expectPrompt: prompt });
    expect(held!.credential.password).toBe(true);
    const ask = (askpass: string): Promise<string> =>
      new Promise((done) => {
        const c = spawnChild(askpass, [prompt]);
        let out = '';
        c.stdout.on('data', (d: Buffer) => (out += d.toString()));
        c.on('close', () => done(out));
      });
    for (let i = 0; i < 3; i++) {
      const helper = await held!.credential.forSpawn!();
      expect(await ask(helper.env.SSH_ASKPASS!)).toBe('nas-pw-for-tests\n');
      expect(await ask(helper.env.SSH_ASKPASS!)).toBe(''); // one-shot
      await helper.done();
    }
  }, 120_000);

  it('the holder locks itself after the idle timeout', async () => {
    process.env.PSC_VAULT_IDLE_MINUTES = '0.02';
    const r = await psc(['vault', 'unlock', '--json'], PASS);
    expect(json(r.stdout)).toMatchObject({ held: true });
    expect(await holderRunning()).toBe(true);
    await new Promise((res) => setTimeout(res, 2500));
    expect(await holderRunning()).toBe(false);
  }, 60_000);

  it('lock works after the login expired; logout locks (holder and remembered key gone)', async () => {
    expect((await psc(['vault', 'unlock', '--remember-file', '--json'], PASS)).code).toBe(0);
    const file = join(xdg, 'pocketshell-tui-client', 'vault-remember.json');
    save({ brokerUrl: base, accessToken: TOKEN, tokenId: 'tok_v', email: 'you@example.com', expiresAt: Math.floor(Date.now() / 1000) - 60, label: 'me@box' });
    const l = await psc(['vault', 'lock', '--json']);
    expect(l.code, l.stdout + l.stderr).toBe(0);
    expect(json(l.stdout)).toMatchObject({ ok: true, locked: true, forgot: 'file' });
    expect(existsSync(file)).toBe(false);

    save({ brokerUrl: base, accessToken: TOKEN, tokenId: 'tok_v', email: 'you@example.com', expiresAt: Math.floor(Date.now() / 1000) + 86400, label: 'me@box' });
    expect(json((await psc(['vault', 'unlock', '--json'], PASS)).stdout)).toMatchObject({ held: true });
    expect(await holderRunning()).toBe(true);
    await psc(['logout', '--json']);
    expect(await holderRunning()).toBe(false);
  }, 120_000);

  it('a wrong passphrase on the fd: the friendly message, exit 1, nothing remembered', async () => {
    const r = await psc(['vault', 'unlock', '--remember-file'], 'not it');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("That passphrase didn't unlock your vault.");
    expect(r.stderr).toContain('https://app.pocketshell.io/keys?reset=1');
    expect(existsSync(join(xdg, 'pocketshell-tui-client', 'vault-remember.json'))).toBe(false);
  }, 60_000);

  it('an over-long passphrase on the fd is refused without reading it all', async () => {
    const r = await psc(['vault', 'unlock', '--json'], 'x'.repeat(200_000));
    expect(r.code).toBe(2);
    expect(json(r.stdout)).toMatchObject({ ok: false, error: { code: 'USAGE', message: expect.stringContaining('too long') } });
  }, 60_000);

  it('--remember without an OS keychain is refused before asking (exit 2)', async () => {
    const r = await psc(['vault', 'unlock', '--remember', '--json'], PASS);
    expect(r.code).toBe(2);
    expect(json(r.stdout)).toMatchObject({ ok: false, error: { code: 'KEYCHAIN_UNAVAILABLE' } });
    expect(hits).toEqual([]);
  }, 60_000);

  it('no terminal and no fd: VAULT_LOCKED, exit 3', async () => {
    const r = await psc(['vault', 'unlock', '--json']);
    expect(r.code).toBe(3);
    expect(json(r.stdout)).toMatchObject({ ok: false, error: { code: 'VAULT_LOCKED' } });
  }, 60_000);

  it('an account without a vault says where to create one', async () => {
    slots = new Map();
    const r = await psc(['vault', 'status', '--json']);
    expect(json(r.stdout)).toMatchObject({ ok: true, vault: false });
    const u = await psc(['vault', 'unlock'], PASS);
    expect(u.code).toBe(1);
    expect(u.stderr).toContain('https://app.pocketshell.io/keys');
  }, 60_000);

  it('phase 2: the server lockout wins over the local check', async () => {
    verifyAnswer = { status: 429, body: { error: 'too_many_attempts', retryAfter: 900 } };
    const r = await psc(['vault', 'unlock', '--json'], PASS);
    expect(r.code).toBe(1);
    expect(json(r.stdout)).toMatchObject({ ok: false, error: { code: 'VAULT_RATE_LIMITED' } });
    expect(hits).toContain('POST /cli/vault/verify');
  }, 60_000);

  it('typed transport failures survive: a dead login is NOT_LOGGED_IN (exit 3), a missing route VAULT_UNAVAILABLE', async () => {
    save({ brokerUrl: base, accessToken: `psc_${'C'.repeat(43)}`, tokenId: 'tok_x', email: 'you@example.com', expiresAt: Math.floor(Date.now() / 1000) + 86400, label: 'me@box' });
    const dead = await psc(['vault', 'status', '--json']);
    expect(dead.code).toBe(3);
    expect(json(dead.stdout)).toMatchObject({ ok: false, error: { code: 'NOT_LOGGED_IN' } });
    save({ brokerUrl: base, accessToken: TOKEN, tokenId: 'tok_v', email: 'you@example.com', expiresAt: Math.floor(Date.now() / 1000) + 86400, label: 'me@box' });
    routeMissing = true;
    const missing = await psc(['vault', 'status', '--json']);
    expect(json(missing.stdout)).toMatchObject({ ok: false, error: { code: 'VAULT_UNAVAILABLE' } });
    routeMissing = false;
    unconfigured = true;
    const off = await psc(['vault', 'status', '--json']);
    expect(json(off.stdout)).toMatchObject({ ok: false, error: { code: 'VAULT_UNAVAILABLE' } });
  }, 60_000);

  it('vault bind sets and clears a local override on a saved host', async () => {
    const add = await psc(['hosts', 'add', 'box2', '--ssh', 'u@box2.example', '--json']);
    expect(add.code, add.stdout + add.stderr).toBe(0);
    const b = await psc(['vault', 'bind', 'box2', '--alias', 'box', '--json']);
    expect(b.code, b.stderr).toBe(0);
    expect(json(b.stdout)).toMatchObject({ ok: true, host: 'box2', vault: { alias: 'box' } });
    const c = await psc(['vault', 'bind', 'box2', '--clear', '--json']);
    expect(json(c.stdout)).toMatchObject({ ok: true, vault: null });
  }, 60_000);
});
