/**
 * Broker transport policy under environment proxies (fail-closed, explicit
 * trust). The policy itself (`src/account/transport.ts`) is pure: every test
 * below passes `env` explicitly and never reads `process.env`, except the
 * handful marked otherwise that pin `process.env` to the hostile shape and
 * restore it afterwards.
 *
 * The HTTPS broker + CONNECT proxy tests use an embedded test CA (valid
 * 2026-2036, SANs IP:127.0.0.1 + DNS:localhost), so no new dependencies and
 * no runtime certificate generation are needed.
 */
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { connect as netConnect, createServer as createNetServer, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as broker from '../src/account/broker.js';
import { save } from '../src/account/credentials.js';
import { deviceLogin } from '../src/account/device.js';
import { logout, TransportRefused } from '../src/account/index.js';
import {
  envProxyOptIn,
  matchesNoProxy,
  resolveBrokerTransport,
  tlsVerificationWeakened,
} from '../src/account/transport.js';

// -- test PKI (fixtures/test-pki; openssl CA, server SANs IP:127.0.0.1,DNS:localhost, valid 2026-2036) --

const PKI_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'test-pki');
const CA_CRT = readFileSync(join(PKI_DIR, 'ca.crt'), 'utf8');
const SRV_CRT = readFileSync(join(PKI_DIR, 'server.crt'), 'utf8');
const SRV_KEY = readFileSync(join(PKI_DIR, 'server.key'), 'utf8');

// -- fixtures -----------------------------------------------------------------

interface Recorded {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: string;
}
type Reply = { status: number; body?: unknown };
type Handler = (req: Recorded) => Reply;

let httpServer: Server;
let httpBase = '';
let httpsServer: HttpsServer;
let httpsBase = '';
let routes: Record<string, Handler> = {};
let requests: Recorded[] = [];

function serve(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const rec: Recorded = {
      method: req.method ?? '',
      path: req.url ?? '',
      headers: req.headers,
      body: Buffer.concat(chunks).toString(),
    };
    requests.push(rec);
    const handler = routes[`${rec.method} ${rec.path}`];
    const reply = handler ? handler(rec) : { status: 404, body: { error: 'not_found' } };
    const text = reply.body === undefined ? '' : JSON.stringify(reply.body);
    res.writeHead(reply.status, { 'Content-Type': 'application/json' });
    res.end(text);
  });
}

beforeAll(async () => {
  httpServer = createHttpServer(serve);
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  httpBase = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  httpsServer = createHttpsServer({ key: SRV_KEY, cert: SRV_CRT }, serve);
  await new Promise<void>((resolve) => httpsServer.listen(0, '127.0.0.1', resolve));
  httpsBase = `https://127.0.0.1:${(httpsServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => httpServer.close(resolve));
  await new Promise((resolve) => httpsServer.close(resolve));
});

const savedEnv = { ...process.env };
let xdg = '';

beforeEach(() => {
  xdg = mkdtempSync(join(tmpdir(), 'psc-transport-'));
  process.env.XDG_CONFIG_HOME = xdg;
  process.env.POCKETSHELL_BROKER_URL = httpBase;
  process.env.POCKETSHELL_BROKER_INSECURE_DEV = '1';
  routes = {};
  requests = [];
});

afterEach(() => {
  process.env = { ...savedEnv };
  rmSync(xdg, { recursive: true, force: true });
});

/** Pin `process.env` for one callback, then restore (for the hostile-env tests). */
async function withEnv(vars: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const HOSTILE = {
  NODE_USE_ENV_PROXY: '1',
  HTTPS_PROXY: 'http://127.0.0.1:9',
  HTTP_PROXY: 'http://127.0.0.1:9',
};

/** A minimal HTTP CONNECT proxy in-test (records authorities + headers). */
interface ConnectSeen {
  authority: string;
  headers: Record<string, string>;
}

async function startConnectProxy(target: { host: string; port: number }, status = 200): Promise<{
  port: number;
  seen: ConnectSeen[];
  close: () => Promise<void>;
}> {
  const seen: ConnectSeen[] = [];
  const server = createNetServer((client: Socket) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      client.removeListener('data', onData);
      const head = buf.subarray(0, end).toString('latin1');
      const rest = buf.subarray(end + 4);
      const [requestLine = '', ...headerLines] = head.split('\r\n');
      const authority = /^CONNECT\s+(\S+)\s+HTTP\/\d/.exec(requestLine)?.[1] ?? '';
      const headers: Record<string, string> = {};
      for (const line of headerLines) {
        const idx = line.indexOf(':');
        if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
      }
      seen.push({ authority, headers });
      if (status !== 200) {
        client.end(`HTTP/1.1 ${status} Forbidden\r\nContent-Length: 0\r\n\r\n`);
        return;
      }
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const upstream = netConnect(target, () => {
        if (rest.length > 0) upstream.write(rest);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
    };
    client.on('data', onData);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    seen,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

// -- NO_PROXY matcher ----------------------------------------------------------

describe('matchesNoProxy', () => {
  it.each([
    ['wildcard', 'broker.example', 443, '*', true],
    ['exact', 'broker.example', 443, 'broker.example', true],
    ['exact is case-insensitive', 'Broker.Example', 443, 'bRoKeR.eXaMpLe', true],
    ['subdomain via bare domain', 'api.broker.example', 443, 'broker.example', true],
    ['leading dot matches domain and subdomains', 'broker.example', 443, '.broker.example', true],
    ['leading dot matches subdomain', 'api.broker.example', 443, '.broker.example', true],
    ['suffix without a dot boundary does not match', 'notbroker.example', 443, 'broker.example', false],
    ['unrelated host', 'other.example', 443, 'broker.example', false],
    ['empty list', 'broker.example', 443, '', false],
    ['undefined', 'broker.example', 443, undefined, false],
    ['comma and space separated', 'b.example', 443, 'a.example, b.example c.example', true],
    ['trailing dots ignored', 'broker.example.', 443, 'broker.example.', true],
    ['port restriction matches', 'broker.example', 8443, 'broker.example:8443', true],
    ['port restriction rejects another port', 'broker.example', 443, 'broker.example:8443', false],
    ['default https port equals 443', 'broker.example', 443, 'broker.example:443', true],
    ['bad port never matches', 'broker.example', 443, 'broker.example:banana', false],
    ['IPv4 exact', '127.0.0.1', 8080, '127.0.0.1', true],
    ['IPv4 with port', '127.0.0.1', 8080, '127.0.0.1:8080', true],
    ['IPv4 wrong port', '127.0.0.1', 8081, '127.0.0.1:8080', false],
    ['IPv4 is not a subdomain match', '127.0.0.1', 80, '27.0.0.1', false],
    ['bracketed IPv6', '::1', 8080, '[::1]', true],
    ['bracketed IPv6 with port', '::1', 8080, '[::1]:8080', true],
    ['bracketed IPv6 wrong port', '::1', 8081, '[::1]:8080', false],
    ['unmatched entry ignored', 'broker.example', 443, '???', false],
  ])('%s', (_name, host, port, list, expected) => {
    expect(matchesNoProxy(host as string, port as number, list as string | undefined)).toBe(expected as boolean);
  });
});

// -- policy decisions ----------------------------------------------------------

const url = (s: string): URL => new URL(s);

describe('resolveBrokerTransport', () => {
  it('direct when the process never opted into env proxies, even with proxies set', () => {
    const env = { HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9' };
    expect(resolveBrokerTransport(url('https://broker.example'), env, [], undefined)).toEqual({ kind: 'direct' });
  });

  it('direct when opted in but no proxy is configured', () => {
    expect(resolveBrokerTransport(url('https://broker.example'), { NODE_USE_ENV_PROXY: '1' }, [], undefined)).toEqual({
      kind: 'direct',
    });
  });

  it('refused under the hostile repro env, naming the fixes', () => {
    const decision = resolveBrokerTransport(url('https://broker.example'), { ...HOSTILE }, [], undefined);
    expect(decision.kind).toBe('refused');
    const reason = (decision as { reason: string }).reason;
    expect(reason).toContain('NO_PROXY');
    expect(reason).toContain('PSC_TRUSTED_PROXY');
    expect(reason).toContain('NODE_USE_ENV_PROXY');
  });

  it('never prints proxy credentials in the refusal', () => {
    const env = {
      NODE_USE_ENV_PROXY: '1',
      HTTPS_PROXY: 'http://alice:s3cret@127.0.0.1:9',
    };
    const decision = resolveBrokerTransport(url('https://broker.example'), env, [], undefined);
    expect(decision.kind).toBe('refused');
    const reason = (decision as { reason: string }).reason;
    expect(reason).not.toContain('alice');
    expect(reason).not.toContain('s3cret');
    expect(reason).toContain('http://127.0.0.1:9');
  });

  it('http brokers use HTTP_PROXY (not HTTPS_PROXY)', () => {
    const onlyHttps = { NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://127.0.0.1:9' };
    expect(resolveBrokerTransport(url('http://127.0.0.1:1'), onlyHttps, [], undefined)).toEqual({ kind: 'direct' });
    const onlyHttp = { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: 'http://127.0.0.1:9' };
    expect(resolveBrokerTransport(url('http://127.0.0.1:1'), onlyHttp, [], undefined).kind).toBe('refused');
  });

  it('https brokers prefer HTTPS_PROXY and fall back to HTTP_PROXY (fail-closed superset)', () => {
    const viaHttp = { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: 'http://127.0.0.1:9' };
    expect(resolveBrokerTransport(url('https://broker.example'), viaHttp, [], undefined).kind).toBe('refused');
  });

  it('NO_PROXY bypasses the broker host', () => {
    const env = { ...HOSTILE, NO_PROXY: 'broker.example' };
    expect(resolveBrokerTransport(url('https://broker.example'), env, [], undefined)).toEqual({ kind: 'direct' });
    expect(resolveBrokerTransport(url('https://api.broker.example'), env, [], undefined)).toEqual({ kind: 'direct' });
    const other = { ...HOSTILE, NO_PROXY: 'other.example' };
    expect(resolveBrokerTransport(url('https://broker.example'), other, [], undefined).kind).toBe('refused');
  });

  it('NO_PROXY port restriction applies to the broker port', () => {
    const bypass = { ...HOSTILE, NO_PROXY: 'broker.example:443' };
    expect(resolveBrokerTransport(url('https://broker.example'), bypass, [], undefined)).toEqual({ kind: 'direct' });
    expect(resolveBrokerTransport(url('https://broker.example:8443/x'), bypass, [], undefined).kind).toBe('refused');
  });

  it('trusted proxy: PSC_TRUSTED_PROXY equal to the effective proxy', () => {
    const env = { ...HOSTILE, PSC_TRUSTED_PROXY: 'http://127.0.0.1:9' };
    const decision = resolveBrokerTransport(url('https://broker.example'), env, [], undefined);
    expect(decision.kind).toBe('trusted-proxy');
    if (decision.kind === 'trusted-proxy') {
      expect(decision.proxy.hostname).toBe('127.0.0.1');
      expect(decision.proxy.port).toBe('9');
    }
  });

  it('trusted proxy comparison ignores userinfo, casing and trailing slashes', () => {
    for (const trusted of [
      'http://127.0.0.1:9/',
      'http://user:pw@127.0.0.1:9',
      'HTTP://127.0.0.1:9',
      'http://127.0.0.1:9',
    ]) {
      const env = { NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://alice:x@127.0.0.1:9/', PSC_TRUSTED_PROXY: trusted };
      const decision = resolveBrokerTransport(url('https://broker.example'), env, [], undefined);
      expect(decision.kind, trusted).toBe('trusted-proxy');
    }
  });

  it('trusted proxy keeps userinfo for Proxy-Authorization', () => {
    const env = {
      NODE_USE_ENV_PROXY: '1',
      HTTPS_PROXY: 'http://alice:s3cret@127.0.0.1:9',
      PSC_TRUSTED_PROXY: 'http://127.0.0.1:9',
    };
    const decision = resolveBrokerTransport(url('https://broker.example'), env, [], undefined);
    expect(decision.kind).toBe('trusted-proxy');
    if (decision.kind === 'trusted-proxy') expect(decision.proxy.username).toBe('alice');
  });

  it('PSC_TRUSTED_PROXY naming another proxy is refused', () => {
    const env = { ...HOSTILE, PSC_TRUSTED_PROXY: 'http://127.0.0.1:10' };
    const decision = resolveBrokerTransport(url('https://broker.example'), env, [], undefined);
    expect(decision.kind).toBe('refused');
    expect((decision as { reason: string }).reason).toContain('does not match');
  });

  it('a trusted proxy never applies to a plain-http broker', () => {
    const env = { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: 'http://127.0.0.1:9', PSC_TRUSTED_PROXY: 'http://127.0.0.1:9' };
    const decision = resolveBrokerTransport(url('http://127.0.0.1:1'), env, [], undefined);
    expect(decision.kind).toBe('refused');
    expect((decision as { reason: string }).reason).toMatch(/only applies to https/);
  });

  it('TLS weakening refuses even a trusted proxy', () => {
    const base = { ...HOSTILE, PSC_TRUSTED_PROXY: 'http://127.0.0.1:9' };
    expect(
      resolveBrokerTransport(url('https://broker.example'), { ...base, NODE_TLS_REJECT_UNAUTHORIZED: '0' }, [], undefined).kind,
    ).toBe('refused');
    expect(resolveBrokerTransport(url('https://broker.example'), base, ['--tls-min-v1.0'], undefined).kind).toBe(
      'refused',
    );
    expect(resolveBrokerTransport(url('https://broker.example'), base, [], '--insecure-http-parser').kind).toBe(
      'refused',
    );
    expect(tlsVerificationWeakened({ NODE_TLS_REJECT_UNAUTHORIZED: '0' }, [], undefined)).toBe(true);
    expect(tlsVerificationWeakened({}, ['--tls-max-v1.2'], undefined)).toBe(true);
    expect(tlsVerificationWeakened({}, [], '--tls-min-v1.0')).toBe(true);
    expect(tlsVerificationWeakened({}, [], '--insecure-http-parser')).toBe(true);
    expect(tlsVerificationWeakened({}, [], undefined)).toBe(false);
  });

  it('--use-env-proxy in execArgv or NODE_OPTIONS opts in', () => {
    expect(envProxyOptIn({}, ['--use-env-proxy'], undefined)).toBe(true);
    expect(envProxyOptIn({}, [], '--use-env-proxy')).toBe(true);
    expect(envProxyOptIn({}, [], undefined)).toBe(false);
    const env = { HTTP_PROXY: 'http://127.0.0.1:9' };
    expect(resolveBrokerTransport(url('http://127.0.0.1:1'), env, ['--use-env-proxy'], undefined).kind).toBe('refused');
  });

  it('an unparseable proxy URL fails closed', () => {
    const env = { NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://alice@:not a url' };
    expect(resolveBrokerTransport(url('https://broker.example'), env, [], undefined).kind).toBe('refused');
    const badTrusted = { ...HOSTILE, PSC_TRUSTED_PROXY: ':::' };
    expect(resolveBrokerTransport(url('https://broker.example'), badTrusted, [], undefined).kind).toBe('refused');
  });
});

// -- broker.request enforcement -----------------------------------------------

describe('broker request transport', () => {
  const TOKEN = `psc_${'A'.repeat(43)}`;

  it('an injected fetch bypasses proxy resolution, even under a hostile process env', async () => {
    await withEnv({ ...HOSTILE }, async () => {
      const stub = (async () =>
        new Response(JSON.stringify({ token: 'x' }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
      const resp = await broker.request('https://broker.example', 'GET', '/x', { fetch: stub, bearer: TOKEN });
      expect(resp).toEqual({ status: 200, data: { token: 'x' } });
    });
  });

  it('JSON-body credential requests are policed the same as bearer ones (no request made)', async () => {
    await withEnv({ ...HOSTILE }, async () => {
      const poll = await broker.pollDevice(httpBase, 'dc_0123456789abcdefXYZ').catch((e: unknown) => e);
      expect(poll).toBeInstanceOf(TransportRefused);
      expect(poll).toMatchObject({ code: 'TRANSPORT_REFUSED', exitCode: 1 });
      expect((poll as Error).message).toContain('unset NODE_USE_ENV_PROXY');
      await expect(broker.pollDevice(httpBase, 'dc_0123456789abcdefXYZ')).rejects.toThrow(/NO_PROXY/);
      await expect(
        broker.getSession(httpBase, TOKEN),
      ).rejects.toThrow(/Refusing to send PocketShell broker credentials/);
      expect(requests).toHaveLength(0);
    });
  });

  it('an injected direct transport ignores the ambient proxy env', async () => {
    routes['GET /ping'] = () => ({ status: 200, body: { pong: true } });
    await withEnv({ ...HOSTILE }, async () => {
      const resp = await broker.request(httpBase, 'GET', '/ping', { transport: { kind: 'direct' } });
      expect(resp.data).toEqual({ pong: true });
    });
    expect(requests).toHaveLength(1);
  });

  it('direct https works with an explicit CA (strict TLS, system store untouched)', async () => {
    routes['GET /cli/session'] = () => ({
      status: 200,
      body: { email: 'e', token_id: 't', label: 'l', created_at: 1, expires_at: 9_999_999_999 },
    });
    const resp = await broker.request(httpsBase, 'GET', '/cli/session', {
      transport: { kind: 'direct' },
      ca: CA_CRT,
      bearer: TOKEN,
    });
    expect(resp.status).toBe(200);
    expect(requests[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('tunnels https through a trusted CONNECT proxy with Proxy-Authorization', async () => {
    routes['GET /cli/session'] = () => ({
      status: 200,
      body: { email: 'e', token_id: 't', label: 'l', created_at: 1, expires_at: 9_999_999_999 },
    });
    const target = new URL(httpsBase);
    const proxy = await startConnectProxy({ host: '127.0.0.1', port: Number(target.port) });
    try {
      const proxyUrl = new URL(`http://alice:s3cret@127.0.0.1:${proxy.port}`);
      const resp = await broker.request(httpsBase, 'GET', '/cli/session', {
        transport: { kind: 'trusted-proxy', proxy: proxyUrl },
        ca: CA_CRT,
        bearer: TOKEN,
      });
      expect(resp.status).toBe(200);
      expect(resp.data).toMatchObject({ email: 'e' });
      // The request really went through the tunnel…
      expect(proxy.seen).toHaveLength(1);
      expect(proxy.seen[0]!.authority).toBe(`127.0.0.1:${target.port}`);
      expect(proxy.seen[0]!.headers['proxy-authorization']).toBe(
        `Basic ${Buffer.from('alice:s3cret').toString('base64')}`,
      );
      // …and the broker still saw end-to-end TLS with the bearer.
      expect(requests).toHaveLength(1);
      expect(requests[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    } finally {
      await proxy.close();
    }
  });

  it('a proxy refusing CONNECT surfaces as BrokerUnavailable', async () => {
    const target = new URL(httpsBase);
    const proxy = await startConnectProxy({ host: '127.0.0.1', port: Number(target.port) }, 403);
    try {
      await expect(
        broker.request(httpsBase, 'GET', '/cli/session', {
          transport: { kind: 'trusted-proxy', proxy: new URL(`http://127.0.0.1:${proxy.port}`) },
          ca: CA_CRT,
          bearer: TOKEN,
        }),
      ).rejects.toThrow(/refused the connection/);
    } finally {
      await proxy.close();
    }
  });
});

// -- device login --------------------------------------------------------------

describe('device login transport', () => {
  const TOKEN = `psc_${'A'.repeat(43)}`;
  const CODE = 'BCDF-GHJK';
  const now = (): number => Math.floor(Date.now() / 1000);

  function happyRoutes(): void {
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
        : {
            status: 200,
            body: { access_token: TOKEN, token_type: 'Bearer', token_id: 'tok_1', expires_at: now() + 86400, email: 'you@example.com' },
          };
    routes['GET /cli/session'] = () => ({
      status: 200,
      body: { email: 'you@example.com', token_id: 'tok_1', label: 'me@box', created_at: 1, expires_at: now() + 86400 },
    });
    routes['POST /cli/logout'] = () => ({ status: 204 });
  }

  function fakeClock(): { sleep: (s: number) => Promise<void>; monotonic: () => number } {
    let t = 1000;
    return { monotonic: () => t, sleep: async (s: number) => void (t += s) };
  }

  it('refuses before /auth/device/start under a hostile env (no request made)', async () => {
    happyRoutes();
    const clock = fakeClock();
    const pending: unknown[] = [];
    await withEnv({ ...HOSTILE }, async () => {
      await expect(
        deviceLogin({
          baseUrl: httpBase,
          label: 'me@box',
          onPending: (info) => pending.push(info),
          sleep: clock.sleep,
          monotonic: clock.monotonic,
        }),
      ).rejects.toThrow(/NO_PROXY|PSC_TRUSTED_PROXY/);
    });
    expect(pending).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  it('succeeds with a NO_PROXY bypass under a hostile env', async () => {
    happyRoutes();
    const clock = fakeClock();
    const pending: unknown[] = [];
    await withEnv({ ...HOSTILE, NO_PROXY: '127.0.0.1' }, async () => {
      const creds = await deviceLogin({
        baseUrl: httpBase,
        label: 'me@box',
        onPending: (info) => pending.push(info),
        sleep: clock.sleep,
        monotonic: clock.monotonic,
      });
      expect(creds.accessToken).toBe(TOKEN);
    });
    expect(pending).toHaveLength(1);
    expect(requests.some((r) => r.path === '/auth/device/start')).toBe(true);
  });

  it('succeeds through a trusted proxy (https broker, CONNECT tunnel, test CA)', async () => {
    happyRoutes();
    const target = new URL(httpsBase);
    const proxy = await startConnectProxy({ host: '127.0.0.1', port: Number(target.port) });
    try {
      const clock = fakeClock();
      const pending: unknown[] = [];
      const proxyUrl = new URL(`http://127.0.0.1:${proxy.port}`);
      await withEnv({ NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: proxyUrl.toString() }, async () => {
        const creds = await deviceLogin({
          baseUrl: httpsBase,
          label: 'me@box',
          onPending: (info) => pending.push(info),
          sleep: clock.sleep,
          monotonic: clock.monotonic,
          transport: { kind: 'trusted-proxy', proxy: proxyUrl },
          ca: CA_CRT,
        });
        expect(creds.accessToken).toBe(TOKEN);
      });
      expect(pending).toHaveLength(1);
      expect(proxy.seen.length).toBeGreaterThan(0);
    } finally {
      await proxy.close();
    }
  });

  it('a failed cleanup revoke warns without masking the original error', async () => {
    happyRoutes();
    routes['GET /cli/session'] = () => ({
      status: 200,
      body: { email: 'you@example.com', token_id: 'tok_OTHER', label: 'me@box', created_at: 1, expires_at: now() + 86400 },
    });
    routes['POST /cli/logout'] = () => ({ status: 500, body: { error: 'boom' } });
    const clock = fakeClock();
    const warnings: string[] = [];
    let thrown: unknown;
    try {
      await deviceLogin({
        baseUrl: httpBase,
        label: 'me@box',
        onPending: () => undefined,
        onWarning: (w) => warnings.push(w),
        sleep: clock.sleep,
        monotonic: clock.monotonic,
      });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toMatch(/did not match/);
    expect(warnings.join('\n')).toMatch(/server-side revoke failed/);
  });
});

// -- logout revoke surfacing ---------------------------------------------------

describe('logout revoke surfacing', () => {
  const TOKEN = `psc_${'A'.repeat(43)}`;
  const now = (): number => Math.floor(Date.now() / 1000);

  function storeDown(): void {
    save({
      brokerUrl: 'http://127.0.0.1:9',
      accessToken: TOKEN,
      tokenId: 'tok_1',
      email: 'you@example.com',
      expiresAt: now() + 86400,
      label: 'me@box',
    });
  }

  it('an unreachable broker still deletes, with revoked:false and a revokeError', async () => {
    process.env.POCKETSHELL_BROKER_URL = 'http://127.0.0.1:9';
    storeDown();
    const result = await logout();
    expect(result.result).toBe('logged_out');
    expect(result.revoked).toBe(false);
    expect(result.warning).toMatch(/Could not reach/);
    expect(result.revokeError).toMatchObject({ code: 'BROKER_UNAVAILABLE' });
    expect(result.expiresAt).toBeGreaterThan(now());
  });

  it('a 500 on revoke is reported, not swallowed', async () => {
    routes['POST /cli/logout'] = () => ({ status: 500, body: { error: 'boom' } });
    save({
      brokerUrl: httpBase,
      accessToken: TOKEN,
      tokenId: 'tok_1',
      email: 'you@example.com',
      expiresAt: now() + 86400,
      label: 'me@box',
    });
    const result = await logout();
    expect(result).toMatchObject({ result: 'logged_out', revoked: false });
    expect(result.revokeError).toMatchObject({ code: 'ACCOUNT_ERROR' });
    expect(requests).toHaveLength(1);
  });
});
