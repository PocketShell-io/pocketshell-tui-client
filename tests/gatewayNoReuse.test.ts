/** Isolated source regressions: no SSH, client CLI, broker or socket is executed. */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  account: 'A', authorized: 'A', pin: 'key-A', trusted: 'key-A', dir: '', pinFile: '',
  login: vi.fn(), runs: vi.fn(), attach: vi.fn(), controls: vi.fn(),
  receipts: [] as string[], attempts: [] as string[], mode: 'normal',
}));
vi.mock('../src/account/index.js', () => ({ requireLogin: fake.login }));
vi.mock('../src/gateway/pins.js', async () => {
  const { hostKeyAlias } = await import('../src/gateway/endpoint.js');
  return {
  PinError: class extends Error {},
  pinFilePath: () => fake.pinFile,
  requirePinEntry: () => ({ alias: hostKeyAlias('Lab') }),
  };
});
vi.mock('../src/transport/openssh.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/transport/openssh.js')>(),
  findSsh: () => '/fixture-only/ssh', controlDir: () => fake.dir,
  controlPathFor: fake.controls, runSshCaptured: fake.runs,
}));
vi.mock('../src/transport/process.js', () => ({ runInteractive: fake.attach }));

import { openGatewayConnection, buildGatewaySshArgv } from '../src/transport/gateway.js';
import { buildSshArgv } from '../src/transport/ssh.js';
import { resolveEndpoint, hostKeyAlias } from '../src/gateway/endpoint.js';
import { PROXY_MARKER, writeStatusFile } from '../src/transport/openssh.js';

// All fixture state is under this owned isolated candidate, never account storage.
const owned = mkdtempSync(resolve('.fixture-'));
afterAll(() => rmSync(owned, { recursive: true, force: true }));
function receipt(argv: readonly string[]): string | undefined {
  return argv.find((a) => a.startsWith('ProxyCommand='))?.match(/--status-file ([^ ]+)/)?.[1];
}
function record(argv: readonly string[], code: string) {
  const file = receipt(argv);
  expect(file).toBeTruthy();
  fake.receipts.push(file!);
  writeStatusFile(file!, `${PROXY_MARKER}: ${code}: fixture refusal`);
}
function noReuse(argv: readonly string[]) {
  for (const key of ['ControlMaster=no', 'ControlPersist=no', 'ControlPath=none']) expect(argv.filter((x) => x === key)).toHaveLength(1);
  expect(argv.some((x) => x.startsWith('ControlPath=') && x !== 'ControlPath=none')).toBe(false);
  expect(argv).not.toContain('ControlMaster=auto');
  expect(argv.find((x) => x.startsWith('ProxyCommand='))).toContain('gateway proxy Lab');
}
beforeEach(() => {
  vi.clearAllMocks();fake.account = fake.authorized = 'A';fake.pin = fake.trusted = 'key-A';
  fake.dir = owned;fake.pinFile = join(owned, 'fixture-known-hosts');writeFileSync(fake.pinFile, fake.pin);
  fake.receipts = [];fake.attempts = [];fake.mode = 'normal';
  fake.controls.mockReturnValue(join(owned, 'shared-old-master'));
  fake.login.mockImplementation(() => {
    if (fake.account === 'logged-out') throw Object.assign(new Error('fixture login required'), { code: 'NOT_LOGGED_IN' });
    return { account: fake.account };
  });
  fake.runs.mockImplementation(async (_file, argv) => {
    noReuse(argv);fake.attempts.push(fake.account);
    if (fake.account !== fake.authorized) { record(argv, 'DEVICE_NOT_FOUND'); return { exitCode: 255, stdout: '', stderr: '', timedOut: false }; }
    if (readFileSync(fake.pinFile, 'utf8') !== fake.trusted) return { exitCode: 255, stdout: '', stderr: 'Host key verification failed.', timedOut: false };
    if (fake.mode === 'timeout') { record(argv, 'HOST_OFFLINE'); return { exitCode: null, stdout: '', stderr: '', timedOut: true }; }
    return { exitCode: 7, stdout: 'fixture output', stderr: 'fixture stderr', timedOut: false };
  });
  fake.attach.mockImplementation(async (_file, argv) => { noReuse(argv);record(argv, 'HOST_OFFLINE');return 255; });
});
const config = { deviceId: 'Lab', server: 'wss://fixture.invalid', user: 'alexey' };
describe('production gateway fresh authorization and full pin boundary', () => {
  it('uses the actual production open/exec argv on each call and never allocates a master', async () => {
    const conn = await openGatewayConnection('lab', config);
    expect(await conn.exec('first', { timeoutMs: 20 })).toMatchObject({ exitCode: 7, stdout: 'fixture output' });
    await conn.exec('second', { timeoutMs: 20 });
    expect(fake.attempts).toEqual(['A', 'A']);expect(fake.controls).not.toHaveBeenCalled();
    const paths = fake.runs.mock.calls.map((c) => receipt(c[1]));expect(new Set(paths).size).toBe(2);
    expect(readdirSync(owned).filter((n) => n.startsWith('st-'))).toEqual([]);
    await conn.close();await conn.close();
  });
  it('cannot serve B through A after a synthetic account switch, even on an existing Connection', async () => {
    const a = await openGatewayConnection('lab', config);await a.exec('first', { timeoutMs: 20 });
    fake.account = 'B';
    await expect(a.exec('old-object', { timeoutMs: 20 })).rejects.toMatchObject({ code: 'DEVICE_NOT_FOUND' });
    const b = await openGatewayConnection('lab', config);
    await expect(b.exec('new-object', { timeoutMs: 20 })).rejects.toMatchObject({ code: 'DEVICE_NOT_FOUND' });
    expect(fake.attempts).toEqual(['A', 'B', 'B']);expect(fake.login).toHaveBeenCalledTimes(2);
    expect(new Set(fake.receipts).size).toBe(2);expect(fake.receipts.every((p) => !readdirSync(owned).includes(p.split('/').pop()!))).toBe(true);
  });
  it('rechecks changed pin bytes on the next command instead of reusing the earlier trust', async () => {
    const conn = await openGatewayConnection('lab', config);await conn.exec('first', { timeoutMs: 20 });
    writeFileSync(fake.pinFile, 'key-B');
    await expect(conn.exec('after-pin-change', { timeoutMs: 20 })).rejects.toMatchObject({ code: 'HOST_KEY_FAILED' });
    expect(fake.attempts).toEqual(['A', 'A']);
  });
  it('retains production logged-out account guard without starting a runner', async () => {
    fake.account = 'logged-out';
    await expect(openGatewayConnection('lab', config)).rejects.toMatchObject({ code: 'NOT_LOGGED_IN', exitCode: 3 });
    expect(fake.runs).not.toHaveBeenCalled();expect(fake.controls).not.toHaveBeenCalled();
  });
  it('consumes unique attach and timeout status receipts and preserves typed refusal/timeout', async () => {
    const conn = await openGatewayConnection('lab', config);
    await expect(conn.attachInteractive('fixture')).rejects.toMatchObject({ code: 'HOST_OFFLINE', exitCode: 4 });
    fake.mode = 'timeout';expect(await conn.exec('fixture', { timeoutMs: 20 })).toMatchObject({ timedOut: true, exitCode: null });
    expect(new Set(fake.receipts).size).toBe(2);expect(readdirSync(owned).filter((n) => n.startsWith('st-'))).toEqual([]);
  });
  it('keeps gateway nonreuse for attach and missing status directory; explicit direct SSH remains multiplexed', () => {
    const base = { deviceId: 'Lab', endpoint: resolveEndpoint('wss://fixture.invalid'), pinFile: fake.pinFile, alias: hostKeyAlias('Lab'), invocation: ['/fixture/node', '/fixture/cli.js'], command: 'fixture' };
    noReuse(buildGatewaySshArgv({ ...base, kind: 'attach', statusDir: null }));
    const direct = buildSshArgv({ config: { destination: 'explicit-direct' }, controlPath: '/fixture/direct-master', kind: 'exec', command: 'fixture' });
    expect(direct).toContain('ControlMaster=auto');expect(direct).toContain('ControlPath=/fixture/direct-master');expect(direct).toContain('ControlPersist=60');
    expect(direct.some((a) => a.startsWith('ProxyCommand='))).toBe(false);
  });
});
