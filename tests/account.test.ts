/**
 * Account login against a fake broker on 127.0.0.1 (POCKETSHELL_BROKER_URL +
 * POCKETSHELL_BROKER_INSECURE_DEV=1), with a temp XDG_CONFIG_HOME. Never
 * touches the real ~/.config/pocketshell or the production broker.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AccountError,
  BrokerRateLimited,
  BrokerUnavailable,
  CredentialsUnsafe,
  isLoggedIn,
  loadCredentials,
  login,
  LoginCancelled,
  logout,
  mintGatewayToken,
  mintGatewayTokenWithExpiry,
  NotLoggedIn,
  validateLabel,
  whoami,
  type PendingLogin,
} from '../src/account/index.js';
import { sessionBrokerUrl, validateBrokerUrl, webOrigin } from '../src/account/config.js';
import { load, save, serialize, type Credentials } from '../src/account/credentials.js';
import { loadsStrict, parseStrict } from '../src/account/json.js';
import { cleanText, httpsUrl } from '../src/account/sanitize.js';

// -- fake broker ---------------------------------------------------------------

interface Recorded {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: string;
}
type Reply = { status: number; body?: unknown; raw?: string; headers?: Record<string, string> };
type Handler = (req: Recorded) => Reply | Promise<Reply>;

let server: Server;
let base = '';
let routes: Record<string, Handler> = {};
let requests: Recorded[] = [];

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const rec: Recorded = { method: req.method ?? '', path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString() };
      requests.push(rec);
      const handler = routes[`${rec.method} ${rec.path}`];
      Promise.resolve(handler ? handler(rec) : { status: 404, body: { error: 'not_found' } }).then(
        (reply) => {
          const text = reply.raw ?? (reply.body === undefined ? '' : JSON.stringify(reply.body));
          res.writeHead(reply.status, { 'Content-Type': 'application/json', ...reply.headers });
          res.end(text);
        },
        () => res.destroy(),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const savedEnv = { ...process.env };
let xdg = '';

beforeEach(() => {
  xdg = mkdtempSync(join(tmpdir(), 'psc-account-'));
  process.env.XDG_CONFIG_HOME = xdg;
  process.env.POCKETSHELL_BROKER_URL = base;
  process.env.POCKETSHELL_BROKER_INSECURE_DEV = '1';
  delete process.env.POCKETSHELL_DEV_WEB_ORIGIN;
  routes = {};
  requests = [];
});

afterEach(() => {
  process.env = { ...savedEnv };
  rmSync(xdg, { recursive: true, force: true });
});

// -- fixtures ----------------------------------------------------------------

const TOKEN = `psc_${'A'.repeat(43)}`;
const OLD_TOKEN = `psc_${'B'.repeat(43)}`;
const CODE = 'BCDF-GHJK';
const VERIFY = 'https://app.pocketshell.io/device';
const now = (): number => Math.floor(Date.now() / 1000);

function deviceStart(over: Record<string, unknown> = {}): Handler {
  return () => ({
    status: 200,
    body: {
      device_code: 'dc_0123456789abcdefXYZ',
      user_code: CODE,
      verification_uri: VERIFY,
      verification_uri_complete: `${VERIFY}?code=${CODE}`,
      expires_in: 600,
      interval: 1,
      ...over,
    },
  });
}

function tokenSequence(replies: Reply[]): Handler {
  let i = 0;
  return () => replies[Math.min(i++, replies.length - 1)]!;
}

const issued: Reply = {
  status: 200,
  body: { access_token: TOKEN, token_type: 'Bearer', token_id: 'tok_1', expires_at: now() + 86400 * 30, email: 'you@example.com' },
};
const pending: Reply = { status: 400, body: { error: 'authorization_pending' } };

function sessionOk(tokenId = 'tok_1', email = 'you@example.com'): Handler {
  return (req) =>
    req.headers.authorization === `Bearer ${TOKEN}`
      ? { status: 200, body: { email, token_id: tokenId, label: 'me@box', created_at: 1, expires_at: now() + 86400 * 30 } }
      : { status: 401, body: { error: 'invalid_token' } };
}

function happyRoutes(): void {
  routes['POST /auth/device/start'] = deviceStart();
  routes['POST /auth/device/token'] = tokenSequence([pending, { status: 400, body: { error: 'slow_down' } }, issued]);
  routes['GET /cli/session'] = sessionOk();
  routes['POST /cli/logout'] = () => ({ status: 204 });
}

function fakeClock(): { sleep: (s: number) => Promise<void>; monotonic: () => number; slept: number[] } {
  let t = 1000;
  const slept: number[] = [];
  return {
    slept,
    monotonic: () => t,
    sleep: async (s: number) => {
      slept.push(s);
      t += s;
    },
  };
}

async function runLogin(extra: Partial<Parameters<typeof login>[0]> = {}): Promise<{
  creds: Credentials;
  pendingInfo: PendingLogin[];
  warnings: string[];
  slept: number[];
}> {
  const clock = fakeClock();
  const pendingInfo: PendingLogin[] = [];
  const warnings: string[] = [];
  const creds = await login({
    label: 'me@box',
    onPending: (info) => pendingInfo.push(info),
    onWarning: (w) => warnings.push(w),
    sleep: clock.sleep,
    monotonic: clock.monotonic,
    ...extra,
  });
  return { creds, pendingInfo, warnings, slept: clock.slept };
}

async function loginError(extra: Partial<Parameters<typeof login>[0]> = {}): Promise<{ error: AccountError; pendingInfo: PendingLogin[]; warnings: string[] }> {
  const clock = fakeClock();
  const pendingInfo: PendingLogin[] = [];
  const warnings: string[] = [];
  try {
    await login({
      label: 'me@box',
      onPending: (info) => pendingInfo.push(info),
      onWarning: (w) => warnings.push(w),
      sleep: clock.sleep,
      monotonic: clock.monotonic,
      ...extra,
    });
  } catch (error) {
    return { error: error as AccountError, pendingInfo, warnings };
  }
  throw new Error('login unexpectedly succeeded');
}

function storeCreds(over: Partial<Credentials> = {}): Credentials {
  const creds: Credentials = {
    brokerUrl: base,
    accessToken: TOKEN,
    tokenId: 'tok_1',
    email: 'you@example.com',
    expiresAt: now() + 86400,
    label: 'me@box',
    ...over,
  };
  save(creds);
  return creds;
}

const credPath = (): string => join(xdg, 'pocketshell', 'credentials.json');

// -- login ---------------------------------------------------------------------

describe('login (device flow)', () => {
  it('pending → slow_down → success: saves 0600 in 0700, Python format', async () => {
    happyRoutes();
    const { creds, pendingInfo, slept } = await runLogin();
    expect(pendingInfo).toEqual([
      { userCode: CODE, verificationUri: VERIFY, verificationUriComplete: `${VERIFY}?code=${CODE}`, expiresIn: 600 },
    ]);
    // interval 1, then 1 (pending), then +5 after slow_down.
    expect(slept).toEqual([1, 1, 6]);
    expect(creds).toMatchObject({ brokerUrl: base, accessToken: TOKEN, tokenId: 'tok_1', email: 'you@example.com', label: 'me@box' });
    expect(statSync(credPath()).mode & 0o777).toBe(0o600);
    expect(statSync(join(xdg, 'pocketshell')).mode & 0o777).toBe(0o700);
    const text = readFileSync(credPath(), 'utf8');
    const doc = JSON.parse(text);
    expect(Object.keys(doc)).toEqual(['access_token', 'broker_url', 'email', 'expires_at', 'label', 'token_id', 'version']);
    expect(doc).toMatchObject({ version: 1, broker_url: base, access_token: TOKEN, token_id: 'tok_1', email: 'you@example.com', label: 'me@box' });
    expect(text.startsWith('{\n  "access_token": ')).toBe(true);
    expect(text.endsWith('}\n')).toBe(true);
    // The start request carried the label; polls carried the device code in the body only.
    const start = requests.find((r) => r.path === '/auth/device/start')!;
    expect(JSON.parse(start.body)).toEqual({ label: 'me@box' });
    const polls = requests.filter((r) => r.path === '/auth/device/token');
    expect(polls).toHaveLength(3);
    expect(JSON.parse(polls[0]!.body)).toEqual({ device_code: 'dc_0123456789abcdefXYZ' });
    // No Origin header ever; the session token only in Authorization.
    expect(requests.every((r) => r.headers.origin === undefined)).toBe(true);
    const session = requests.find((r) => r.path === '/cli/session')!;
    expect(session.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(requests.every((r) => !r.path.includes(TOKEN) && !r.path.includes('dc_'))).toBe(true);
    expect(isLoggedIn()).toBe(true);
    expect(loadCredentials()?.email).toBe('you@example.com');
  });

  it('a pre-existing lax directory we own is tightened to 0700', async () => {
    happyRoutes();
    mkdirSync(join(xdg, 'pocketshell'), { mode: 0o755 });
    chmodSync(join(xdg, 'pocketshell'), 0o755);
    await runLogin();
    expect(statSync(join(xdg, 'pocketshell')).mode & 0o777).toBe(0o700);
  });

  it('access_denied stops with a clear message and saves nothing', async () => {
    routes['POST /auth/device/start'] = deviceStart();
    routes['POST /auth/device/token'] = tokenSequence([pending, { status: 400, body: { error: 'access_denied' } }]);
    const { error } = await loginError();
    expect(error).toBeInstanceOf(AccountError);
    expect(error.message).toMatch(/denied in the browser/);
    expect(existsSync(credPath())).toBe(false);
  });

  it('expired_token stops', async () => {
    routes['POST /auth/device/start'] = deviceStart();
    routes['POST /auth/device/token'] = tokenSequence([{ status: 400, body: { error: 'expired_token' } }]);
    const { error } = await loginError();
    expect(error.message).toMatch(/code expired/);
  });

  it('gives up locally when the code lifetime runs out', async () => {
    routes['POST /auth/device/start'] = deviceStart({ expires_in: 3, interval: 1 });
    routes['POST /auth/device/token'] = tokenSequence([pending]);
    const { error } = await loginError();
    expect(error.message).toMatch(/code expired/);
    expect(requests.filter((r) => r.path === '/auth/device/token')).toHaveLength(3);
  });

  it('429 and slow_down add 5 s each, capped at 60', async () => {
    routes['POST /auth/device/start'] = deviceStart({ interval: 50 });
    routes['POST /auth/device/token'] = tokenSequence([{ status: 429 }, { status: 400, body: { error: 'slow_down' } }, issued]);
    routes['GET /cli/session'] = sessionOk();
    const { slept } = await runLogin();
    expect(slept).toEqual([50, 55, 60]);
  });

  it('5 transient failures in a row give up', async () => {
    routes['POST /auth/device/start'] = deviceStart();
    routes['POST /auth/device/token'] = tokenSequence([{ status: 503 }]);
    const { error } = await loginError();
    expect(error.message).toMatch(/Waiting for approval failed \(HTTP 503\)/);
    expect(requests.filter((r) => r.path === '/auth/device/token')).toHaveLength(5);
  });

  it('refuses a malformed user code without printing it', async () => {
    routes['POST /auth/device/start'] = deviceStart({ user_code: 'AAAA-\u001b[2J' });
    const { error, pendingInfo } = await loginError();
    expect(error.message).toMatch(/malformed user code/);
    expect(error.message).not.toContain('AAAA');
    expect(pendingInfo).toEqual([]);
    for (const bad of ['bcdf-ghjk', 'BCDF-GHJ1', 'AEIO-UBCD', 'BCDFGHJK']) {
      routes['POST /auth/device/start'] = deviceStart({ user_code: bad });
      expect((await loginError()).error.message).toMatch(/malformed user code/);
    }
  });

  it('never shows an untrusted verification URL', async () => {
    happyRoutes();
    routes['POST /auth/device/start'] = deviceStart({
      verification_uri: 'https://app.pocketshell.io.evil.example/device',
      verification_uri_complete: `https://app.pocketshell.io.evil.example/device?code=${CODE}`,
    });
    const { pendingInfo, warnings } = await runLogin();
    expect(pendingInfo[0]).toMatchObject({ verificationUri: 'https://app.pocketshell.io/device', verificationUriComplete: null });
    expect(warnings.join()).toMatch(/outside https:\/\/app\.pocketshell\.io; it was not shown/);
    expect(JSON.stringify(pendingInfo)).not.toContain('evil');
  });

  it('drops a pre-filled URL whose code differs from the printed one', async () => {
    happyRoutes();
    routes['POST /auth/device/start'] = deviceStart({ verification_uri_complete: `${VERIFY}?code=ZZZZ-ZZZZ` });
    const { pendingInfo } = await runLogin();
    expect(pendingInfo[0]).toMatchObject({ verificationUri: VERIFY, verificationUriComplete: null, userCode: CODE });
  });

  it('http verification URLs are untrusted too', async () => {
    happyRoutes();
    routes['POST /auth/device/start'] = deviceStart({ verification_uri: 'http://app.pocketshell.io/device' });
    const { pendingInfo, warnings } = await runLogin();
    expect(pendingInfo[0]!.verificationUri).toBe('https://app.pocketshell.io/device');
    expect(warnings).toHaveLength(1);
  });

  it('does not follow a redirect', async () => {
    routes['POST /auth/device/start'] = () => ({ status: 307, headers: { Location: `${base}/elsewhere` } });
    routes['POST /elsewhere'] = () => ({ status: 200, body: {} });
    const { error } = await loginError();
    expect(error.message).toMatch(/Starting the login failed \(HTTP 307\)/);
    expect(requests.some((r) => r.path === '/elsewhere')).toBe(false);
  });

  it('rejects an oversize response body', async () => {
    routes['POST /auth/device/start'] = () => ({ status: 200, raw: JSON.stringify({ pad: 'x'.repeat(70 * 1024) }) });
    const { error } = await loginError();
    expect(error.message).toMatch(/too large/);
  });

  it('rejects duplicate-key JSON', async () => {
    routes['POST /auth/device/start'] = () => ({
      status: 200,
      raw: `{"device_code":"dc_0123456789abcdefXYZ","user_code":"${CODE}","user_code":"ZZZZ-ZZZZ","expires_in":600}`,
    });
    const { error } = await loginError();
    expect(error.message).toMatch(/malformed response \(HTTP 200\)/);
  });

  it('rejects a non-object JSON body', async () => {
    routes['POST /auth/device/start'] = () => ({ status: 200, raw: '[1,2]' });
    expect((await loginError()).error.message).toMatch(/malformed response/);
  });

  it('revokes the new token when the session check does not match', async () => {
    happyRoutes();
    routes['GET /cli/session'] = sessionOk('tok_OTHER');
    const { error } = await loginError();
    expect(error.message).toMatch(/did not match/);
    expect(existsSync(credPath())).toBe(false);
    const revoke = requests.find((r) => r.path === '/cli/logout');
    expect(revoke?.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('refuses to replace an unexpired login without --force; --force revokes the old one', async () => {
    happyRoutes();
    storeCreds({ accessToken: OLD_TOKEN, email: 'old@example.com' });
    const { error } = await loginError();
    expect(error.code).toBe('ALREADY_LOGGED_IN');
    expect(error.message).toMatch(/Already logged in as old@example.com/);
    expect(requests).toHaveLength(0);

    await runLogin({ force: true });
    expect(loadCredentials()?.accessToken).toBe(TOKEN);
    const revokes = requests.filter((r) => r.path === '/cli/logout');
    expect(revokes.map((r) => r.headers.authorization)).toEqual([`Bearer ${OLD_TOKEN}`]);
  });

  it('replaces an expired login without --force', async () => {
    happyRoutes();
    storeCreds({ accessToken: OLD_TOKEN, expiresAt: now() - 10 });
    await runLogin();
    expect(loadCredentials()?.accessToken).toBe(TOKEN);
    expect(requests.some((r) => r.path === '/cli/logout')).toBe(false);
  });

  it('cancellation while polling → LoginCancelled (exit 130)', async () => {
    routes['POST /auth/device/start'] = deviceStart();
    routes['POST /auth/device/token'] = tokenSequence([pending]);
    const controller = new AbortController();
    let polls = 0;
    const { error } = await loginError({
      signal: controller.signal,
      sleep: async () => {
        if (++polls === 3) controller.abort();
      },
    });
    expect(error).toBeInstanceOf(LoginCancelled);
    expect(error.exitCode).toBe(130);
    expect(error.code).toBe('CANCELLED');
  });

  it('cancellation after the token was issued revokes it and saves nothing', async () => {
    happyRoutes();
    const controller = new AbortController();
    routes['GET /cli/session'] = async (req) => {
      controller.abort();
      await new Promise((r) => setTimeout(r, 20));
      return sessionOk()(req);
    };
    const { error } = await loginError({ signal: controller.signal });
    expect(error).toBeInstanceOf(LoginCancelled);
    expect(existsSync(credPath())).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(requests.find((r) => r.path === '/cli/logout')?.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('validates --label', () => {
    expect(validateLabel('  laptop  ')).toBe('laptop');
    expect(() => validateLabel('a\u001b[31mb')).toThrow(/--label must be/);
    expect(() => validateLabel('x'.repeat(81))).toThrow(/--label must be/);
    expect(() => validateLabel('   ')).toThrow(/--label must be/);
    expect(validateLabel('x'.repeat(80))).toHaveLength(80);
  });
});

// -- whoami / logout ---------------------------------------------------------

describe('whoami', () => {
  it('verified against the broker', async () => {
    storeCreds();
    routes['GET /cli/session'] = sessionOk('tok_1', 'server@example.com');
    const { info, warnings } = await whoami();
    expect(info).toEqual({
      broker_url: base,
      email: 'server@example.com',
      expires_at: expect.any(Number),
      label: 'me@box',
      logged_in: true,
      token_id: 'tok_1',
      verified: true,
    });
    expect(Object.keys(info)).toEqual(['broker_url', 'email', 'expires_at', 'label', 'logged_in', 'token_id', 'verified']);
    expect(warnings).toEqual([]);
  });

  it('broker down → local copy, verified false, warning', async () => {
    const down = 'http://127.0.0.1:9';
    process.env.POCKETSHELL_BROKER_URL = down;
    storeCreds({ brokerUrl: down });
    const { info, warnings } = await whoami();
    expect(info.verified).toBe(false);
    expect(info.email).toBe('you@example.com');
    expect(warnings[0]).toMatch(/could not verify the session with the broker: Could not reach/);
  });

  it('429 is not "not logged in"', async () => {
    storeCreds();
    routes['GET /cli/session'] = () => ({ status: 429, body: { error: 'rate_limited' } });
    const { info, warnings } = await whoami();
    expect(info.verified).toBe(false);
    expect(warnings[0]).toMatch(/rate limiting/);
  });

  it('401 → NotLoggedIn, file kept', async () => {
    storeCreds();
    routes['GET /cli/session'] = () => ({ status: 401 });
    await expect(whoami()).rejects.toBeInstanceOf(NotLoggedIn);
    expect(existsSync(credPath())).toBe(true);
  });

  it('a different POCKETSHELL_BROKER_URL is never contacted', async () => {
    storeCreds();
    process.env.POCKETSHELL_BROKER_URL = 'http://127.0.0.1:9';
    const { info, warnings } = await whoami();
    expect(info.verified).toBe(false);
    expect(warnings[0]).toMatch(/not verified: POCKETSHELL_BROKER_URL .* differs/);
    expect(requests).toHaveLength(0);
  });

  it('no credentials → NotLoggedIn with exit 3', async () => {
    const error = await whoami().catch((e: unknown) => e as NotLoggedIn);
    expect(error).toBeInstanceOf(NotLoggedIn);
    expect(error).toMatchObject({ code: 'NOT_LOGGED_IN', exitCode: 3 });
  });
});

describe('logout', () => {
  it('revokes and deletes', async () => {
    storeCreds();
    routes['POST /cli/logout'] = () => ({ status: 204 });
    expect(await logout()).toMatchObject({ result: 'logged_out', revoked: true, warning: null });
    expect(existsSync(credPath())).toBe(false);
    expect(requests[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('401 counts as logged out', async () => {
    storeCreds();
    routes['POST /cli/logout'] = () => ({ status: 401 });
    expect(await logout()).toMatchObject({ result: 'logged_out', warning: null });
    expect(existsSync(credPath())).toBe(false);
  });

  it('429 keeps the file and throws BrokerRateLimited (exit 1)', async () => {
    storeCreds();
    routes['POST /cli/logout'] = () => ({ status: 429, body: { error: 'rate_limited' } });
    const error = await logout().catch((e: unknown) => e as BrokerRateLimited);
    expect(error).toBeInstanceOf(BrokerRateLimited);
    expect(error).not.toBeInstanceOf(NotLoggedIn);
    expect(error).toMatchObject({ code: 'BROKER_RATE_LIMITED', exitCode: 1 });
    expect(existsSync(credPath())).toBe(true);
  });

  it('broker down → deleted with a warning', async () => {
    const down = 'http://127.0.0.1:9';
    process.env.POCKETSHELL_BROKER_URL = down;
    storeCreds({ brokerUrl: down });
    const result = await logout();
    expect(result.result).toBe('logged_out');
    expect(result.warning).toMatch(/Could not reach/);
    expect(result.expiresAt).toBeGreaterThan(now());
    expect(existsSync(credPath())).toBe(false);
  });

  it('a different broker env → not sent there, still deleted', async () => {
    storeCreds();
    process.env.POCKETSHELL_BROKER_URL = 'http://127.0.0.1:9';
    const result = await logout();
    expect(result.warning).toMatch(/differs/);
    expect(requests).toHaveLength(0);
    expect(existsSync(credPath())).toBe(false);
  });

  it('not logged in → not_logged_in', async () => {
    expect((await logout()).result).toBe('not_logged_in');
  });

  it('a too-permissive file we own is still revoked, then deleted', async () => {
    storeCreds();
    chmodSync(credPath(), 0o644);
    routes['POST /cli/logout'] = () => ({ status: 200 });
    expect((await logout()).result).toBe('logged_out');
    expect(requests).toHaveLength(1);
  });

  it('a symlink is removed without contacting the broker', async () => {
    storeCreds();
    const real = join(xdg, 'elsewhere.json');
    writeFileSync(real, readFileSync(credPath()), { mode: 0o600 });
    rmSync(credPath());
    symlinkSync(real, credPath());
    expect((await logout()).result).toBe('removed_unsafe');
    expect(requests).toHaveLength(0);
    expect(existsSync(real)).toBe(true);
  });
});

// -- gateway token -------------------------------------------------------------

const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url');
const JWT = `${b64({ alg: 'EdDSA', typ: 'JWT' })}.${b64({ sub: 'u' })}.c2ln`;

describe('mintGatewayToken', () => {
  it('returns a validated JWT', async () => {
    storeCreds();
    routes['POST /cli/gateway/token'] = () => ({ status: 200, body: { token: JWT, token_type: 'Bearer', expires_at: now() + 300 } });
    expect(await mintGatewayToken()).toBe(JWT);
    expect(requests[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const full = await mintGatewayTokenWithExpiry();
    expect(full.expiresAt).toBeGreaterThan(now());
  });

  it.each([
    ['not three segments', { token: 'abc.def', expires_at: 'now+300' }],
    ['header not JSON', { token: `${Buffer.from('nope').toString('base64url')}.e30.c2ln`, expires_at: 'now+300' }],
    ['header without alg', { token: `${b64({ typ: 'JWT' })}.e30.c2ln`, expires_at: 'now+300' }],
    ['bad token_type', { token: JWT, token_type: 'MAC', expires_at: 'now+300' }],
  ])('rejects a malformed token: %s', async (_name, body) => {
    storeCreds();
    const fixed = { ...body, expires_at: now() + 300 };
    routes['POST /cli/gateway/token'] = () => ({ status: 200, body: fixed });
    await expect(mintGatewayToken()).rejects.toThrow(/malformed gateway-token response \(field '(token|token_type)'\)/);
  });

  it('rejects an implausible expiry (too far, or already past the skew)', async () => {
    storeCreds();
    for (const expires of [now() + 601 + 5, now() - 301 - 5]) {
      routes['POST /cli/gateway/token'] = () => ({ status: 200, body: { token: JWT, expires_at: expires } });
      await expect(mintGatewayToken()).rejects.toThrow(/implausible expiry/);
    }
    routes['POST /cli/gateway/token'] = () => ({ status: 200, body: { token: JWT, expires_at: now() + 590 } });
    expect(await mintGatewayToken()).toBe(JWT);
  });

  it('401 → NotLoggedIn (exit 3); 429 → BrokerRateLimited, never NotLoggedIn', async () => {
    storeCreds();
    routes['POST /cli/gateway/token'] = () => ({ status: 401 });
    await expect(mintGatewayToken()).rejects.toMatchObject({ code: 'NOT_LOGGED_IN', exitCode: 3 });
    routes['POST /cli/gateway/token'] = () => ({ status: 429 });
    const error = await mintGatewayToken().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BrokerRateLimited);
    expect(error).toBeInstanceOf(BrokerUnavailable);
    expect(error).not.toBeInstanceOf(NotLoggedIn);
    expect(existsSync(credPath())).toBe(true);
  });

  it('no session / expired session → NotLoggedIn without network', async () => {
    await expect(mintGatewayToken()).rejects.toBeInstanceOf(NotLoggedIn);
    storeCreds({ expiresAt: now() - 1 });
    await expect(mintGatewayToken()).rejects.toThrow(/expired/);
    expect(requests).toHaveLength(0);
  });

  it('unreachable broker → BrokerUnavailable', async () => {
    process.env.POCKETSHELL_BROKER_URL = 'http://127.0.0.1:9';
    storeCreds({ brokerUrl: 'http://127.0.0.1:9' });
    await expect(mintGatewayToken()).rejects.toMatchObject({ code: 'BROKER_UNAVAILABLE' });
  });
});

// -- credentials file checks ---------------------------------------------------

describe('credentials file', () => {
  it.each([0o640, 0o604, 0o660, 0o606])('mode %o → not logged in, contents never echoed', (fileMode) => {
    storeCreds();
    chmodSync(credPath(), fileMode);
    expect(loadCredentials()).toBeNull();
    expect(isLoggedIn()).toBe(false);
    let error: unknown;
    try {
      load();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(CredentialsUnsafe);
    expect((error as Error).message).toMatch(/accessible by other users/);
    expect((error as Error).message).not.toContain(TOKEN);
  });

  it('a symlink is refused', () => {
    storeCreds();
    const real = join(xdg, 'real.json');
    writeFileSync(real, readFileSync(credPath()), { mode: 0o600 });
    rmSync(credPath());
    symlinkSync(real, credPath());
    expect(() => load()).toThrow(/is a symlink/);
    expect(loadCredentials()).toBeNull();
  });

  it('a directory writable by others is refused', () => {
    storeCreds();
    chmodSync(join(xdg, 'pocketshell'), 0o777);
    expect(() => load()).toThrow(/writable by others/);
  });

  it('a lax dir with no file is just "not logged in"', () => {
    mkdirSync(join(xdg, 'pocketshell'), { mode: 0o777 });
    chmodSync(join(xdg, 'pocketshell'), 0o777);
    const error = (() => {
      try {
        load();
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(NotLoggedIn);
    expect(error).not.toBeInstanceOf(CredentialsUnsafe);
  });

  it('a non-regular file is refused', () => {
    mkdirSync(join(xdg, 'pocketshell', 'credentials.json'), { recursive: true, mode: 0o700 });
    chmodSync(join(xdg, 'pocketshell'), 0o700);
    expect(() => load()).toThrow(/not a regular file/);
  });

  it('corrupt / wrong version / duplicate keys → not logged in', () => {
    storeCreds();
    const good = JSON.parse(readFileSync(credPath(), 'utf8'));
    const write = (text: string): void => {
      rmSync(credPath());
      writeFileSync(credPath(), text, { mode: 0o600 });
    };
    for (const text of [
      'not json',
      JSON.stringify({ ...good, version: 2 }),
      JSON.stringify({ ...good, access_token: 'nope' }),
      JSON.stringify({ ...good, expires_at: '1' }),
      JSON.stringify(good).replace('{', `{"email":"x",`),
    ]) {
      write(text);
      expect(() => load()).toThrow(/corrupt or from an unsupported version/);
    }
  });

  it('serializes like Python json.dumps(indent=2, sort_keys=True) with ensure_ascii', () => {
    const text = serialize({ brokerUrl: 'https://b', accessToken: TOKEN, tokenId: 't', email: 'é@x', expiresAt: 5, label: 'l😀' });
    expect(text).toBe(
      `{\n  "access_token": "${TOKEN}",\n  "broker_url": "https://b",\n  "email": "\\u00e9@x",\n  "expires_at": 5,\n` +
        `  "label": "l\\ud83d\\ude00",\n  "token_id": "t",\n  "version": 1\n}\n`,
    );
  });
});

// -- pure helpers --------------------------------------------------------------

describe('strict JSON', () => {
  it('rejects duplicate keys at any depth, BOM, bad UTF-8, trailing data, deep nesting', () => {
    expect(() => parseStrict('{"a":1,"a":2}')).toThrow(/duplicate key/);
    expect(() => parseStrict('{"x":{"a":1,"a":1}}')).toThrow(/duplicate key/);
    expect(() => parseStrict('[{"a":1,"a":1}]')).toThrow(/duplicate key/);
    expect(() => parseStrict('\ufeff{}')).toThrow(/byte-order mark/);
    expect(() => loadsStrict(new Uint8Array([0x7b, 0xff, 0x7d]))).toThrow(/not UTF-8/);
    expect(() => parseStrict('{} x')).toThrow(/malformed/);
    expect(() => parseStrict('NaN')).toThrow(/malformed/);
    expect(() => parseStrict('{"a":01}')).toThrow(/malformed/);
    expect(() => parseStrict('"a\tb"')).toThrow(/malformed/);
    expect(() => parseStrict('['.repeat(40) + ']'.repeat(40))).toThrow(/too deeply nested/);
    expect(parseStrict('['.repeat(32) + ']'.repeat(32))).toBeTruthy();
  });

  it('parses ordinary JSON identically to JSON.parse', () => {
    const text = '{"a":[1,-2.5e3,true,false,null,"\\u00e9\\n"],"b":{},"c":[],"__proto__":{"x":1}}';
    const value = parseStrict(text) as Record<string, unknown>;
    expect(value.a).toEqual(JSON.parse(text).a);
    expect(Object.keys(value)).toEqual(['a', 'b', 'c', '__proto__']);
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  });
});

describe('broker URL and sanitizing', () => {
  it('validates and normalizes broker URLs like config.py', () => {
    expect(validateBrokerUrl('https://Broker.Example.com/api/')).toBe('https://broker.example.com/api');
    expect(validateBrokerUrl('HTTPS://b.example:443')).toBe('https://b.example:443');
    expect(() => validateBrokerUrl('http://broker.example.com')).toThrow(/must use https/);
    expect(() => validateBrokerUrl('https://u:p@b.example')).toThrow(/credentials/);
    expect(() => validateBrokerUrl('https://b.example/?x=1')).toThrow(/query or fragment/);
    expect(() => validateBrokerUrl('https://b.example#f')).toThrow(/query or fragment/);
    expect(() => validateBrokerUrl('ftp://b.example')).toThrow(/must use https/);
    expect(() => validateBrokerUrl('https://b.example:99999')).toThrow(/not a valid URL/);
    expect(() => validateBrokerUrl('https://b .example')).toThrow(/invalid characters/);
    expect(() => validateBrokerUrl('https:///path')).toThrow(/no host/);
    expect(validateBrokerUrl('http://localhost:8080')).toBe('http://localhost:8080');
    expect(validateBrokerUrl('http://[::1]:8080/')).toBe('http://[::1]:8080');
    expect(validateBrokerUrl('http://127.0.0.2')).toBe('http://127.0.0.2');
    expect(() => validateBrokerUrl('http://10.0.0.1')).toThrow(/must use https/);
    delete process.env.POCKETSHELL_BROKER_INSECURE_DEV;
    expect(() => validateBrokerUrl('http://127.0.0.1')).toThrow(/must use https/);
  });

  it('a session only goes to its stored broker', () => {
    process.env.POCKETSHELL_BROKER_URL = 'https://other.example';
    expect(() => sessionBrokerUrl('https://b.example')).toThrow(NotLoggedIn);
    process.env.POCKETSHELL_BROKER_URL = 'https://B.example/';
    expect(sessionBrokerUrl('https://b.example')).toBe('https://b.example');
    delete process.env.POCKETSHELL_BROKER_URL;
    expect(sessionBrokerUrl('https://b.example')).toBe('https://b.example');
    expect(() => sessionBrokerUrl('https://b.example', 'https://c.example')).toThrow(/requested broker URL/);
  });

  it('POCKETSHELL_DEV_WEB_ORIGIN needs POCKETSHELL_BROKER_URL and a bare https origin', () => {
    process.env.POCKETSHELL_DEV_WEB_ORIGIN = 'https://Staging.Example:8443/';
    expect(webOrigin()).toBe('https://staging.example:8443');
    process.env.POCKETSHELL_DEV_WEB_ORIGIN = 'https://staging.example/device';
    expect(() => webOrigin()).toThrow(/bare https origin/);
    process.env.POCKETSHELL_DEV_WEB_ORIGIN = 'http://staging.example';
    expect(() => webOrigin()).toThrow(/bare https origin/);
    delete process.env.POCKETSHELL_BROKER_URL;
    expect(webOrigin()).toBe('https://app.pocketshell.io');
  });

  it('strips control, escape and invisible format characters', () => {
    expect(cleanText('a\u001b]52;c;Zm9v\u0007b\u202ec\u200bd\r\ne')).toBe('a]52;c;Zm9vbcde');
    expect(cleanText('x'.repeat(10), 5)).toBe('xx...');
    expect(cleanText(42)).toBe('');
    expect(httpsUrl('https://app.pocketshell.io/device')).toBe('https://app.pocketshell.io/device');
    expect(httpsUrl('https://user@app.pocketshell.io/')).toBeNull();
    expect(httpsUrl('https://app.pocketshell.io/ x')).toBeNull();
    expect(httpsUrl('javascript:alert(1)')).toBeNull();
  });
});
