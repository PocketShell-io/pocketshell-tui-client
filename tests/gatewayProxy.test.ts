/**
 * The proxy against an in-process fake gateway (a local `ws` server that
 * speaks the client route of the gateway protocol).
 */
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { NotLoggedIn } from '../src/account/index.js';
import { resolveEndpoint } from '../src/gateway/endpoint.js';
import { EXIT, runProxy } from '../src/gateway/proxy.js';
import { PROXY_MARKER } from '../src/transport/openssh.js';

interface Fake {
  port: number;
  requests: IncomingMessage[];
  authFrames: unknown[];
  close(): Promise<void>;
}

const servers: Fake[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

/** A fake gateway; `onAuth` runs after a well-formed auth frame arrives. */
async function fakeGateway(
  onAuth: (ws: WebSocket) => void,
  options: { verifyClient?: (info: unknown, cb: (ok: boolean, code?: number) => void) => void } = {},
): Promise<Fake> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, ...options });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const fake: Fake = {
    port: (wss.address() as AddressInfo).port,
    requests: [],
    authFrames: [],
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve());
      }),
  };
  wss.on('connection', (ws, req) => {
    fake.requests.push(req);
    ws.once('message', (data, isBinary) => {
      if (isBinary) return ws.close(4400);
      const frame = JSON.parse(data.toString());
      fake.authFrames.push(frame);
      onAuth(ws);
    });
  });
  servers.push(fake);
  return fake;
}

const READY = JSON.stringify({ type: 'ready', v: 1, device_id: 'home-lab', ssh_host_key: 'ssh-ed25519 AAAA' });

function start(port: number, opts: { tokenProvider?: () => Promise<string>; handshakeTimeoutMs?: number; deviceId?: string } = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const lines: string[] = [];
  const out: Buffer[] = [];
  stdout.on('data', (chunk: Buffer) => out.push(chunk));
  const result = runProxy({
    deviceId: opts.deviceId ?? 'home-lab',
    endpoint: resolveEndpoint(`ws://127.0.0.1:${port}`, true),
    tokenProvider: opts.tokenProvider ?? (async () => 'jwt.token.value'),
    stdin,
    stdout,
    diagnostic: (line) => lines.push(line),
    handshakeTimeoutMs: opts.handshakeTimeoutMs ?? 5_000,
  });
  return { result, stdin, stdout, lines, output: () => Buffer.concat(out) };
}

describe('gateway proxy', () => {
  it('authenticates, waits for ready, then echoes binary both ways; stdin EOF ends cleanly', async () => {
    const seen: number[] = [];
    const fake = await fakeGateway((ws) => {
      ws.send(READY);
      ws.on('message', (data: Buffer, isBinary) => {
        expect(isBinary).toBe(true);
        seen.push(data.length);
        ws.send(data, { binary: true });
      });
    });
    const run = start(fake.port);
    const payload = Buffer.alloc(100_000, 7);
    payload.write('SSH-2.0-test\r\n');
    run.stdin.write(payload);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no echo')), 5_000);
      run.stdout.on('data', () => {
        if (run.output().length >= payload.length) {
          clearTimeout(t);
          resolve();
        }
      });
    });
    run.stdin.end();
    expect(await run.result).toBe(EXIT.OK);
    expect(run.output().equals(payload)).toBe(true);
    expect(Math.max(...seen)).toBeLessThanOrEqual(32 * 1024);
    expect(run.lines).toEqual([]);
    expect(fake.authFrames).toEqual([{ type: 'auth', v: 1, token: 'jwt.token.value', device_id: 'home-lab' }]);
    const req = fake.requests[0]!;
    expect(req.url).toBe('/api/v1/hosts/home-lab/ssh');
    expect(req.headers.origin).toBeUndefined();
    expect(req.headers['sec-websocket-extensions']).toBeUndefined();
  });

  it('does not read stdin before ready (SSH bytes never precede the auth frame)', async () => {
    const order: string[] = [];
    const fake = await fakeGateway((ws) => {
      order.push('auth');
      ws.on('message', () => order.push('data'));
      setTimeout(() => ws.send(READY), 100);
    });
    const run = start(fake.port);
    run.stdin.write('early bytes');
    await new Promise((r) => setTimeout(r, 400));
    run.stdin.end();
    expect(await run.result).toBe(EXIT.OK);
    expect(order).toEqual(['auth', 'data']);
  });

  it('maps an error frame plus close 4503 to HOST_OFFLINE (9) with sanitized text', async () => {
    const fake = await fakeGateway((ws) => {
      ws.send(JSON.stringify({ type: 'error', v: 1, code: 'host_offline', message: '\x1b[31mhost‮ is\nasleep' }));
      ws.close(4503, 'offline');
    });
    const run = start(fake.port);
    expect(await run.result).toBe(EXIT.HOST_OFFLINE);
    expect(run.lines).toEqual([`${PROXY_MARKER}: HOST_OFFLINE: gateway refused: host_offline: host is asleep`]);
  });

  it.each([
    [4400, EXIT.PROTOCOL, 'GATEWAY_PROTOCOL'],
    [4401, EXIT.UNAUTHORIZED, 'GATEWAY_UNAUTHORIZED'],
    [4403, EXIT.UNAUTHORIZED, 'GATEWAY_UNAUTHORIZED'],
    [4404, EXIT.NOT_FOUND, 'DEVICE_NOT_FOUND'],
    [4408, EXIT.TIMEOUT, 'GATEWAY_TIMEOUT'],
    [4429, EXIT.QUOTA, 'GATEWAY_QUOTA'],
    [4503, EXIT.HOST_OFFLINE, 'HOST_OFFLINE'],
    [4999, EXIT.CONNECT, 'CONNECT_FAILED'],
  ])('close %i before ready → exit %i', async (closeCode, exit, name) => {
    const fake = await fakeGateway((ws) => ws.close(closeCode));
    const run = start(fake.port);
    expect(await run.result).toBe(exit);
    expect(run.lines[0]).toMatch(new RegExp(`^${PROXY_MARKER}: ${name}: `));
  });

  it('uses the error code when the gateway sends no close code in time', async () => {
    const fake = await fakeGateway((ws) => ws.send(JSON.stringify({ type: 'error', v: 1, code: 'not_found', message: 'nope' })));
    const run = start(fake.port);
    expect(await run.result).toBe(EXIT.NOT_FOUND);
  });

  it.each([
    ['ready for another device', JSON.stringify({ type: 'ready', v: 1, device_id: 'other-box', ssh_host_key: '' })],
    ['an extra key', JSON.stringify({ type: 'ready', v: 1, device_id: 'home-lab', ssh_host_key: '', x: 1 })],
    ['a duplicate key', '{"type":"ready","v":1,"device_id":"home-lab","device_id":"home-lab","ssh_host_key":""}'],
    ['v as float', '{"type":"ready","v":1.0,"device_id":"home-lab","ssh_host_key":""}'],
    ['not JSON', 'hello'],
  ])('refuses %s as a protocol violation (6)', async (_name, frame) => {
    const fake = await fakeGateway((ws) => ws.send(frame));
    const run = start(fake.port);
    expect(await run.result).toBe(EXIT.PROTOCOL);
    expect(run.lines[0]).toMatch(/GATEWAY_PROTOCOL/);
  });

  it('refuses binary before ready and text after ready', async () => {
    const early = await fakeGateway((ws) => ws.send(Buffer.from('SSH-2.0-x'), { binary: true }));
    const first = start(early.port);
    expect(await first.result).toBe(EXIT.PROTOCOL);
    expect(first.output().length).toBe(0);

    const late = await fakeGateway((ws) => {
      ws.send(READY);
      ws.send('{"type":"ready"}');
    });
    const second = start(late.port);
    expect(await second.result).toBe(EXIT.PROTOCOL);
    expect(second.lines[0]).toMatch(/text message after ready/);
  });

  it('aborts on an oversize message (> 64 KiB)', async () => {
    const fake = await fakeGateway((ws) => {
      ws.send(READY);
      ws.send(Buffer.alloc(70 * 1024), { binary: true });
    });
    const run = start(fake.port);
    expect(await run.result).toBe(EXIT.PROTOCOL);
    expect(run.lines[0]).toMatch(/oversize/);
  });

  it('reports a lost connection after ready (11)', async () => {
    const fake = await fakeGateway((ws) => {
      ws.send(READY);
      setTimeout(() => ws.terminate(), 50);
    });
    const run = start(fake.port);
    expect(await run.result).toBe(EXIT.LOST);
    expect(run.lines[0]).toMatch(/CONNECTION_LOST/);
  });

  it('times out a silent gateway (5)', async () => {
    const fake = await fakeGateway(() => {
      /* never answers */
    });
    const run = start(fake.port, { handshakeTimeoutMs: 300 });
    expect(await run.result).toBe(EXIT.TIMEOUT);
    expect(run.lines[0]).toMatch(/GATEWAY_TIMEOUT: gateway did not answer the auth frame in time/);
  });

  it('reports a refused upgrade (HTTP 401) and an unreachable gateway as connect failures (4)', async () => {
    const fake = await fakeGateway(() => {}, { verifyClient: (_info, cb) => cb(false, 401) });
    const refused = start(fake.port);
    expect(await refused.result).toBe(EXIT.CONNECT);
    expect(refused.lines[0]).toMatch(/HTTP 401/);

    const closed = await fakeGateway(() => {});
    const port = closed.port;
    await closed.close();
    servers.splice(servers.indexOf(closed), 1);
    const unreachable = start(port);
    expect(await unreachable.result).toBe(EXIT.CONNECT);
    expect(unreachable.lines[0]).toMatch(/CONNECT_FAILED: cannot connect to 127\.0\.0\.1/);
  });

  it('exits 3 without dialing when not logged in; refuses a malformed token', async () => {
    const fake = await fakeGateway(() => {});
    const run = start(fake.port, {
      tokenProvider: async () => {
        throw new NotLoggedIn();
      },
    });
    expect(await run.result).toBe(EXIT.NO_TOKEN);
    expect(run.lines[0]).toMatch(new RegExp(`^${PROXY_MARKER}: NOT_LOGGED_IN: not logged in`));
    const bad = start(fake.port, { tokenProvider: async () => 'has space' });
    expect(await bad.result).toBe(EXIT.NO_TOKEN);
    expect(fake.requests).toHaveLength(0);
  });

  it('refuses a bad device id as usage (2)', async () => {
    const fake = await fakeGateway(() => {});
    const run = start(fake.port, { deviceId: '../etc' });
    expect(await run.result).toBe(EXIT.USAGE);
    expect(fake.requests).toHaveLength(0);
  });
});
