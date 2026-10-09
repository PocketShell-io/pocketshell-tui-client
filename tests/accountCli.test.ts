/**
 * `login`/`logout`/`whoami` as a subprocess (stdout/exit-code contract), and
 * credentials-file compatibility with the Python `pocketshell` CLI. Fake
 * broker on 127.0.0.1, temp XDG_CONFIG_HOME.
 */
import { execFile, spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadCredentials } from '../src/account/index.js';
import { save } from '../src/account/credentials.js';

const ROOT = resolve(__dirname, '..');
const PY_SRC = '/home/alexey/git/pocketshell-cli/src';
const TOKEN = `psc_${'A'.repeat(43)}`;
const CODE = 'BCDF-GHJK';
const now = (): number => Math.floor(Date.now() / 1000);

type Reply = { status: number; body?: unknown };
let server: Server;
let base = '';
let routes: Record<string, () => Reply> = {};
let hits: string[] = [];

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on('end', () => {
      const key = `${req.method} ${req.url}`;
      hits.push(key);
      const reply = routes[key]?.() ?? { status: 404 };
      res.writeHead(reply.status, { 'Content-Type': 'application/json' });
      res.end(reply.body === undefined ? '' : JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
});

const savedEnv = { ...process.env };
let xdg = '';
let entry = '';
beforeEach(() => {
  xdg = mkdtempSync(join(tmpdir(), 'psc-account-cli-'));
  process.env.XDG_CONFIG_HOME = xdg;
  process.env.POCKETSHELL_BROKER_URL = base;
  process.env.POCKETSHELL_BROKER_INSECURE_DEV = '1';
  routes = {};
  hits = [];
  // A tiny entry with only the account commands, so other in-progress commands can't interfere.
  entry = join(xdg, 'entry.mts');
  writeFileSync(
    entry,
    `import { Command } from ${JSON.stringify(join(ROOT, 'node_modules/commander/esm.mjs'))};\n` +
      `import { registerAccount } from ${JSON.stringify(join(ROOT, 'src/commands/account.ts'))};\n` +
      `const program = new Command();\nregisterAccount(program);\nawait program.parseAsync(process.argv);\n`,
  );
});
afterEach(() => {
  process.env = { ...savedEnv };
  rmSync(xdg, { recursive: true, force: true });
});

function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', entry, ...args],
      { cwd: ROOT, env: { ...process.env, PSC_JSON: '' }, timeout: 30_000 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        done({ code, stdout, stderr });
      },
    );
  });
}

function storeCreds(): void {
  save({ brokerUrl: base, accessToken: TOKEN, tokenId: 'tok_1', email: 'you@example.com', expiresAt: now() + 86400, label: 'me@box' });
}

const credPath = (): string => join(xdg, 'pocketshell', 'credentials.json');

describe('CLI', () => {
  it('whoami --json when not logged in → NOT_LOGGED_IN error document, exit 3', async () => {
    const r = await cli(['whoami', '--json']);
    expect(r.code).toBe(3);
    expect(r.stdout.trim().split('\n').map((l) => JSON.parse(l))).toEqual([
      { ok: false, error: { code: 'NOT_LOGGED_IN', message: expect.stringMatching(/not logged in/i) } },
    ]);
    const human = await cli(['whoami']);
    expect(human.code).toBe(3);
    expect(human.stderr).toMatch(/not logged in/i);
  });

  it('login --json streams pending then logged_in; whoami --json verifies', async () => {
    routes['POST /auth/device/start'] = () => ({
      status: 200,
      body: {
        device_code: 'dc_0123456789abcdefXYZ',
        user_code: CODE,
        verification_uri: 'https://app.pocketshell.io/device',
        verification_uri_complete: `https://app.pocketshell.io/device?code=${CODE}`,
        expires_in: 600,
        interval: 1,
      },
    });
    let polls = 0;
    routes['POST /auth/device/token'] = () =>
      ++polls < 2
        ? { status: 400, body: { error: 'authorization_pending' } }
        : { status: 200, body: { access_token: TOKEN, token_id: 'tok_1', expires_at: now() + 86400, email: 'you@example.com' } };
    const session = { status: 200, body: { email: 'you@example.com', token_id: 'tok_1', label: 'agent-box', expires_at: now() + 86400 } };
    routes['GET /cli/session'] = () => session;

    const r = await cli(['login', '--json', '--label', 'agent-box', '--no-open']);
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toEqual([
      {
        event: 'pending',
        userCode: CODE,
        verificationUri: 'https://app.pocketshell.io/device',
        verificationUriComplete: `https://app.pocketshell.io/device?code=${CODE}`,
        expiresIn: 600,
      },
      { ok: true, event: 'logged_in', email: 'you@example.com', label: 'agent-box', expiresAt: expect.any(Number) },
    ]);
    expect(statSync(credPath()).mode & 0o777).toBe(0o600);

    const again = await cli(['login', '--json']);
    expect(again.code).toBe(1);
    expect(JSON.parse(again.stdout)).toMatchObject({ ok: false, error: { code: 'ALREADY_LOGGED_IN' } });

    const who = await cli(['whoami', '--json']);
    expect(who.code).toBe(0);
    expect(JSON.parse(who.stdout)).toMatchObject({
      ok: true,
      loggedIn: true,
      verified: true,
      email: 'you@example.com',
      label: 'agent-box',
      brokerUrl: base,
      tokenId: 'tok_1',
      expiresAt: expect.any(Number),
    });
  }, 30_000);

  it('login human output', async () => {
    routes['POST /auth/device/start'] = () => ({
      status: 200,
      body: { device_code: 'dc_0123456789abcdefXYZ', user_code: CODE, verification_uri: 'https://evil.example/device', expires_in: 600, interval: 1 },
    });
    routes['POST /auth/device/token'] = () => ({ status: 400, body: { error: 'access_denied' } });
    const r = await cli(['login', '--no-open']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('To log in, open:  https://app.pocketshell.io/device\nand enter code:   BCDF-GHJK');
    expect(r.stdout).toContain('Confirm the code shown in the browser matches: BCDF-GHJK');
    expect(r.stdout).toContain('Waiting for approval (Ctrl+C to cancel)...');
    expect(r.stdout + r.stderr).not.toContain('evil.example');
    expect(r.stderr).toMatch(/warning: the broker sent a verification URL outside/);
    expect(r.stderr).toMatch(/error: The login request was denied/);
  }, 30_000);

  it('login with a bad --label is a usage error', async () => {
    const r = await cli(['login', '--json', '--label', 'x'.repeat(81)]);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, error: { code: 'USAGE' } });
    expect(hits).toEqual([]);
  });

  it('logout --json: 429 keeps the file and exits 1; then 401 counts as logged out', async () => {
    storeCreds();
    routes['POST /cli/logout'] = () => ({ status: 429, body: { error: 'rate_limited' } });
    const r = await cli(['logout', '--json']);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, error: { code: 'BROKER_RATE_LIMITED' } });
    expect(existsSync(credPath())).toBe(true);

    routes['POST /cli/logout'] = () => ({ status: 401 });
    const ok = await cli(['logout', '--json']);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.stdout)).toMatchObject({ ok: true, loggedIn: false, result: 'logged_out', warning: null, expiresAt: null });
    expect(existsSync(credPath())).toBe(false);

    const none = await cli(['logout']);
    expect(none.code).toBe(0);
    expect(none.stdout).toBe('Not logged in.\n');
  }, 30_000);
});

// -- Python interop --------------------------------------------------------------

const python = spawnSync('python3', ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(PY_SRC)}); import pocketshell.account.credentials`], {
  encoding: 'utf8',
});
const havePython = python.status === 0 && existsSync(PY_SRC);

function py(code: string): string {
  const r = spawnSync('python3', ['-c', `import sys, json; sys.path.insert(0, ${JSON.stringify(PY_SRC)})\n${code}`], {
    encoding: 'utf8',
    env: { ...process.env },
  });
  if (r.status !== 0) throw new Error(`python failed: ${r.stderr}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('RESULT '));
  return line ? line.slice('RESULT '.length) : '';
}

describe.skipIf(!havePython)('compatibility with the Python CLI', () => {
  it('a file written by Python save() is read by us', () => {
    py(
      `from pocketshell.account.credentials import Credentials, save\n` +
        `save(Credentials(broker_url=${JSON.stringify(base)}, access_token=${JSON.stringify(TOKEN)}, token_id="tok_py", ` +
        `email="py@example.com", expires_at=${now() + 3600}, label="py@host"))\nprint("RESULT ok")`,
    );
    expect(statSync(credPath()).mode & 0o777).toBe(0o600);
    expect(loadCredentials()).toMatchObject({ brokerUrl: base, accessToken: TOKEN, tokenId: 'tok_py', email: 'py@example.com', label: 'py@host' });
  });

  it('a file written by us is read by Python load(), byte-identical to its own', () => {
    const expiresAt = now() + 3600;
    save({ brokerUrl: base, accessToken: TOKEN, tokenId: 'tok_ts', email: 'é@example.com', expiresAt, label: 'ts@host' });
    const ours = readFileSync(credPath(), 'utf8');
    const loaded = JSON.parse(py(`from pocketshell.account.credentials import load\nprint("RESULT " + json.dumps(load().to_json()))`));
    expect(loaded).toEqual({ version: 1, broker_url: base, access_token: TOKEN, token_id: 'tok_ts', email: 'é@example.com', expires_at: expiresAt, label: 'ts@host' });
    py(
      `from pocketshell.account.credentials import Credentials, save\n` +
        `save(Credentials(broker_url=${JSON.stringify(base)}, access_token=${JSON.stringify(TOKEN)}, token_id="tok_ts", ` +
        `email="\\u00e9@example.com", expires_at=${expiresAt}, label="ts@host"))\nprint("RESULT ok")`,
    );
    expect(readFileSync(credPath(), 'utf8')).toBe(ours);
  });
});
