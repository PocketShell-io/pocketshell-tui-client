/**
 * In-band reauth in the gateway proxy: the daemon path (`reauth` option)
 * advertises the capability, refreshes the token ~60 s before expiry, and
 * rewrites the lease receipt on every acknowledgement. Old gateways (no
 * cap) and classic connections (no option) are byte-for-byte unchanged.
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { resolveEndpoint } from '../src/gateway/endpoint.js';
import { EXIT, runProxy, writeLeaseReceipt } from '../src/gateway/proxy.js';

/** A lease path the status-file writer accepts: an `st-<hex>` name in a private dir. */
function leasePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'psc-reauth-')), `st-${randomBytes(12).toString('hex')}`);
}

interface Fake {
  port: number;
  requests: IncomingMessage[];
  authFrames: unknown[];
  reauthFrames: unknown[];
  readyWithCaps: boolean;
  onReauth: (ws: WebSocket, frame: { token: string }) => void;
  client: WebSocket | null;
  close(): Promise<void>;
}

const servers: Fake[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const dirs: string[] = [];

async function fakeGateway(): Promise<Fake> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const fake: Fake = {
    port: (wss.address() as AddressInfo).port,
    requests: [],
    authFrames: [],
    reauthFrames: [],
    readyWithCaps: false,
    onReauth: () => {},
    client: null,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve());
      }),
  };
  wss.on('connection', (ws, req) => {
    fake.requests.push(req);
    fake.client = ws;
    ws.once('message', (data, isBinary) => {
      if (isBinary) return ws.close(4400);
      const frame = JSON.parse(data.toString());
      fake.authFrames.push(frame);
      ws.send(
        JSON.stringify({
          type: 'ready',
          v: 1,
          device_id: 'home-lab',
          ssh_host_key: 'ssh-ed25519 AAAA',
          ...(fake.readyWithCaps ? { caps: ['reauth'] } : {}),
        }),
      );
      ws.on('message', (raw: Buffer, binary: boolean) => {
        if (binary) return ws.close(4400, 'binary not expected');
        const text = JSON.parse(raw.toString());
        if (text.type !== 'reauth') return ws.close(4400, 'unexpected text');
        fake.reauthFrames.push(text);
        fake.onReauth(ws, text);
      });
    });
  });
  servers.push(fake);
  return fake;
}

interface Minted {
  token: string;
  expiresAt: number;
}

function start(
  port: number,
  opts: {
    mints?: Minted[];
    leaseFile?: string;
    echo?: boolean;
  } = {},
) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const lines: string[] = [];
  const out: Buffer[] = [];
  stdout.on('data', (chunk: Buffer) => out.push(chunk));
  let mints = 0;
  const mint = async (): Promise<Minted> => {
    const next = opts.mints?.[mints] ?? { token: `jwt-${mints}`, expiresAt: Math.floor(Date.now() / 1000) + 300 };
    mints++;
    return next;
  };
  const leaseFile = opts.leaseFile ?? leasePath();
  dirs.push(join(leaseFile, '..'));
  const result = runProxy({
    deviceId: 'home-lab',
    endpoint: resolveEndpoint(`ws://127.0.0.1:${port}`, true),
    tokenProvider: async () => (await mint()).token,
    reauth: { leaseFile, mint },
    stdin,
    stdout,
    diagnostic: (line) => lines.push(line),
    handshakeTimeoutMs: 5_000,
  });
  return { result, stdin, stdout, lines, output: () => Buffer.concat(out), leaseFile, mintCount: () => mints };
}

describe('gateway proxy in-band reauth', () => {
  it('opts in on the auth frame, renews before expiry, and rewrites the receipt', async () => {
    const fake = await fakeGateway();
    fake.readyWithCaps = true;
    // The initial token expires in 61 s: the first refresh is due in ~1 s.
    const first: Minted = { token: 'jwt-first', expiresAt: Math.floor(Date.now() / 1000) + 61 };
    const second: Minted = { token: 'jwt-second', expiresAt: Math.floor(Date.now() / 1000) + 121 };
    const run = start(fake.port, { mints: [first, second] });
    fake.onReauth = (ws, frame) => {
      expect(typeof frame.token).toBe('string');
      ws.send(JSON.stringify({ type: 'reauth_ok', v: 1, expires_at: second.expiresAt }));
    };
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    expect(fake.authFrames).toEqual([
      { type: 'auth', v: 1, token: 'jwt-first', device_id: 'home-lab', caps: ['reauth'] },
    ]);
    // Wait for the ~1 s refresh deadline plus the round trip, then the
    // receipt carries the acknowledged expiry (the initial write is covered
    // by the unacknowledged-expiry test below).
    await new Promise<void>((resolve) => setTimeout(resolve, 2_500));
    expect(fake.reauthFrames).toEqual([{ type: 'reauth', v: 1, token: 'jwt-second' }]);
    expect(readFileSync(run.leaseFile, 'utf8')).toBe(`PSC_LEASE: ${second.expiresAt}\n`);
    expect((statSync(run.leaseFile).mode & 0o777).toString(8)).toBe('600');
    run.stdin.end();
    expect(await run.result).toBe(EXIT.OK);
    expect(run.lines).toEqual([]);
  });

  it('writes the initial receipt before any renewal can land', async () => {
    const fake = await fakeGateway();
    fake.readyWithCaps = true;
    // Far from any refresh deadline, so the initial state is stable.
    const first: Minted = { token: 'jwt-first', expiresAt: Math.floor(Date.now() / 1000) + 240 };
    const run = start(fake.port, { mints: [first] });
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    expect(readFileSync(run.leaseFile, 'utf8')).toBe(`PSC_LEASE: ${first.expiresAt}\n`);
    expect(fake.reauthFrames).toEqual([]);
    run.stdin.end();
    expect(await run.result).toBe(EXIT.OK);
  });

  it('schedules the next renewal from the acknowledged expiry', async () => {
    const fake = await fakeGateway();
    fake.readyWithCaps = true;
    const short = Math.floor(Date.now() / 1000) + 61;
    const run = start(fake.port, { mints: [{ token: 'jwt-0', expiresAt: short }] });
    let renewals = 0;
    fake.onReauth = (ws, frame) => {
      renewals++;
      // Each acknowledgement pushes the deadline 61 s out again.
      ws.send(JSON.stringify({ type: 'reauth_ok', v: 1, expires_at: Math.floor(Date.now() / 1000) + 61 }));
      expect(frame.token).toBe(`jwt-${renewals}`);
    };
    await new Promise<void>((resolve) => setTimeout(resolve, 4_000));
    expect(renewals).toBeGreaterThanOrEqual(2);
    run.stdin.end();
    expect(await run.result).toBe(EXIT.OK);
  });

  it('a gateway without the cap is never sent reauth frames', async () => {
    const fake = await fakeGateway();
    fake.readyWithCaps = false;
    const run = start(fake.port, { mints: [{ token: 'jwt-0', expiresAt: Math.floor(Date.now() / 1000) + 61 }] });
    await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
    // The opt-in was offered on the auth frame but the gateway did not take it.
    expect(fake.authFrames[0]).toMatchObject({ caps: ['reauth'] });
    expect(fake.reauthFrames).toEqual([]);
    run.stdin.end();
    expect(await run.result).toBe(EXIT.OK);
  });

  it('a malformed acknowledgement is a protocol violation', async () => {
    const fake = await fakeGateway();
    fake.readyWithCaps = true;
    const run = start(fake.port, { mints: [{ token: 'jwt-0', expiresAt: Math.floor(Date.now() / 1000) + 61 }] });
    fake.onReauth = (ws) => {
      ws.send(JSON.stringify({ type: 'reauth_ok', v: 1, expires_at: 'soon' }));
    };
    const code = await run.result;
    expect(code).toBe(EXIT.PROTOCOL);
    expect(run.lines[0]).toContain('GATEWAY_PROTOCOL');
  });

  it('an unsolicited text frame after ready is still a violation', async () => {
    const fake = await fakeGateway();
    fake.readyWithCaps = false;
    const run = start(fake.port);
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    // No renewal is pending: any post-ready text is a protocol violation.
    fake.client?.send(JSON.stringify({ type: 'reauth_ok', v: 1, expires_at: 1 }));
    const code = await run.result;
    expect(code).toBe(EXIT.PROTOCOL);
  });

  it('a close after a renewal lets the stream die as today', async () => {
    const fake = await fakeGateway();
    fake.readyWithCaps = true;
    const run = start(fake.port, { mints: [{ token: 'jwt-0', expiresAt: Math.floor(Date.now() / 1000) + 61 }] });
    fake.onReauth = (ws) => {
      ws.send(JSON.stringify({ type: 'reauth_ok', v: 1, expires_at: Math.floor(Date.now() / 1000) + 61 }));
      setTimeout(() => ws.close(4401, 'unauthorized'), 50);
    };
    const code = await run.result;
    expect(code).toBe(EXIT.UNAUTHORIZED);
  });

  it('writeLeaseReceipt is atomic-shaped and second-precise', () => {
    const file = leasePath();
    dirs.push(join(file, '..'));
    writeLeaseReceipt(file, 1893456000);
    expect(readFileSync(file, 'utf8')).toBe('PSC_LEASE: 1893456000\n');
    expect((statSync(file).mode & 0o777).toString(8)).toBe('600');
    writeLeaseReceipt(file, 1893456001);
    expect(readFileSync(file, 'utf8')).toBe('PSC_LEASE: 1893456001\n');
  });
});
