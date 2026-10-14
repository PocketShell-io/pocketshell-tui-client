import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  dir: '',
  children: [] as any[],
  mode: 'normal',
  leaseMs: 200000,
  argv: [] as string[],
}));
vi.mock('../src/transport/openssh.js', async (original) => ({
  ...(await original<typeof import('../src/transport/openssh.js')>()),
  controlDir: () => fixture.dir,
  findSsh: () => '/fixture/ssh',
}));
vi.mock('../src/gateway/pins.js', () => ({
  pinFilePath: () => join(fixture.dir, 'pins'),
  requirePinEntry: () => ({ alias: 'fixture' }),
}));
vi.mock('../src/transport/gateway.js', () => ({
  cliInvocation: () => ['/fixture/node', '/fixture/cli.js'],
  sshEnvironment: () => ({}),
  buildGatewaySshArgv: (input: any) => {
    fixture.argv = ['ControlMaster=no', 'ControlPath=none', 'ControlPersist=no', input.command];
    writeFileSync(input.leaseFile, `PSC_LEASE: ${Math.floor((Date.now() + fixture.leaseMs) / 1000)}\n`, {
      mode: 0o600,
    });
    return fixture.argv;
  },
}));
vi.mock('node:child_process', () => ({
  spawn: () => {
    const c: any = new EventEmitter();
    c.stdout = new PassThrough();
    c.stderr = new PassThrough();
    c.requests = [];
    let b = Buffer.alloc(0);
    c.kill = vi.fn(() => {
      queueMicrotask(() => c.emit('exit', null));
      return true;
    });
    c.stdin = new Writable({
      write(chunk, _, done) {
        b = Buffer.concat([b, chunk]);
        while (b.length >= 4 && b.length >= b.readUInt32BE(0) + 4) {
          const n = b.readUInt32BE(0);
          const r = JSON.parse(b.subarray(4, 4 + n).toString());
          b = b.subarray(4 + n);
          c.requests.push(r);
          queueMicrotask(() => {
            if (r.method === 'send' && fixture.mode === 'disconnect') {
              c.emit('exit', 255);
              return;
            }
            if (r.method === 'ping' && fixture.mode === 'no-reply') return;
            const out = Buffer.from(
              JSON.stringify({
                protocol: 1,
                id: fixture.mode === 'bad-id' ? 'wrong' : r.id,
                result: { pong: true },
              }),
            );
            const h = Buffer.alloc(4);
            h.writeUInt32BE(out.length);
            c.stdout.write(Buffer.concat([h, out]));
          });
        }
        done();
      },
    });
    fixture.children.push(c);
    return c;
  },
}));
import { HostChannel } from '../src/daemon/channel.js';
const dir = mkdtempSync(resolve('.fixture-channel-'));
fixture.dir = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  fixture.children = [];
  fixture.mode = 'normal';
  fixture.leaseMs = 200000;
});
const host = {
  name: 'fixture',
  mode: 'gateway' as const,
  gateway: { deviceId: 'Lab', server: 'wss://fixture.invalid' },
};
describe('persistent host channel', () => {
  it('keeps one process and exec channel across warm requests', async () => {
    const c = new HostChannel(host, Date.now() + 300000, () => {});
    await c.ready;
    for (let i = 0; i < 5; i++) expect(await c.call('ping', {})).toEqual({ pong: true });
    expect(fixture.children).toHaveLength(1);
    expect(fixture.children[0].requests.map((r: any) => r.method)).toEqual([
      'capabilities',
      ...Array(5).fill('ping'),
    ]);
    expect(fixture.argv).toContain('ControlMaster=no');
    c.close();
  });
  it('reports uncertain dispatched mutations and never replays', async () => {
    const c = new HostChannel(host, Date.now() + 300000, () => {});
    await c.ready;
    fixture.mode = 'disconnect';
    await expect(c.call('send', {}, true)).rejects.toMatchObject({
      code: 'OUTCOME_UNKNOWN',
      notDispatched: false,
    });
    expect(fixture.children[0].requests.filter((r: any) => r.method === 'send')).toHaveLength(1);
  });
  it('closes timed-out reads and rejects protocol mismatches', async () => {
    let c = new HostChannel(host, Date.now() + 300000, () => {});
    await c.ready;
    fixture.mode = 'no-reply';
    await expect(c.call('ping', {}, false, 10)).rejects.toMatchObject({ code: 'RPC_TIMEOUT' });
    fixture.mode = 'bad-id';
    c = new HostChannel(host, Date.now() + 300000, () => {});
    await expect(c.ready).rejects.toMatchObject({ code: 'RPC_PROTOCOL' });
  });
  it('retires before the exact minted authorization expiry', async () => {
    fixture.leaseMs = 1000;
    const retired = vi.fn();
    const c = new HostChannel(host, Date.now() + 300000, retired);
    await expect(c.ready).rejects.toMatchObject({ code: 'AUTH_LEASE_EXPIRED' });
    expect(retired).toHaveBeenCalledOnce();
    expect(fixture.children[0].kill).toHaveBeenCalled();
  });
});
