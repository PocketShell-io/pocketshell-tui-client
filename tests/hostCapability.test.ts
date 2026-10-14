/** hostCapability.ts: the on-disk per-host backend verdict — keying, TTL, custody, resident learning. */
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hostKeyAlias } from '../src/gateway/endpoint.js';
import {
  CAPABILITY_TTL_MS,
  capabilityKey,
  forgetBackendCapability,
  loadBackendCapability,
  noteResidentCapability,
  storeBackendCapability,
} from '../src/hostCapability.js';

const gatewayHost = (name = 'hetzner'): { name: string; mode: 'gateway'; gateway: { deviceId: string } } => ({
  name,
  mode: 'gateway',
  gateway: { deviceId: 'dev-1' },
});

let xdg: string | undefined;
beforeEach(() => {
  xdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'psc-capability-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  if (xdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = xdg;
});

describe('backend capability cache', () => {
  it('stores and reloads a probed verdict, keyed by host name', () => {
    const host = gatewayHost();
    expect(loadBackendCapability(host)).toBeNull();
    storeBackendCapability(host, { wrapper: true, direct: null, rpc: null });
    expect(loadBackendCapability(host)).toMatchObject({ wrapper: true, direct: null, rpc: null });
  });

  it('expires after 24 h and is refused while stale', () => {
    const host = gatewayHost();
    storeBackendCapability(host, { wrapper: false, direct: '/managed/a', rpc: true });
    expect(loadBackendCapability(host)).not.toBeNull();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + CAPABILITY_TTL_MS + 1);
    expect(loadBackendCapability(host)).toBeNull();
  });

  it('keys by host-key fingerprint: a re-pinned device inherits nothing', async () => {
    const host = gatewayHost();
    const pins = join(process.env.XDG_CONFIG_HOME!, 'pocketshell');
    mkdirSync(pins, { recursive: true, mode: 0o700 });
    const keyType = 'ssh-ed25519';
    const ed25519Blob = (seed: number): string => {
      const string = (value: Buffer): Buffer => {
        const head = Buffer.alloc(4);
        head.writeUInt32BE(value.length, 0);
        return Buffer.concat([head, value]);
      };
      return Buffer.concat([string(Buffer.from(keyType, 'ascii')), string(Buffer.alloc(32, seed))]).toString('base64');
    };
    const line = (seed: number): string =>
      `${hostKeyAlias('dev-1')} ${keyType} ${ed25519Blob(seed)} dev-1`;
    writeFileSync(join(pins, 'gateway_known_hosts'), `${line(1)}\n`, { mode: 0o600 });
    storeBackendCapability(host, { wrapper: true, direct: null, rpc: null });
    expect(loadBackendCapability(host)).not.toBeNull();
    // Same host name, different pinned key: a different trust identity.
    writeFileSync(join(pins, 'gateway_known_hosts'), `${line(2)}\n`, { mode: 0o600 });
    expect(loadBackendCapability(host)).toBeNull();
  });

  it('distinguishes hosts by name', () => {
    storeBackendCapability(gatewayHost('one'), { wrapper: true, direct: null, rpc: null });
    expect(loadBackendCapability(gatewayHost('two'))).toBeNull();
  });

  it('ignores a record measured for a different wrapper binary', () => {
    const host = { ...gatewayHost(), binary: '/opt/other-wrapper' };
    storeBackendCapability(host, { wrapper: true, direct: null, rpc: null });
    expect(loadBackendCapability(host)).not.toBeNull();
    expect(loadBackendCapability({ ...host, binary: undefined })).toBeNull();
  });

  it('writes 0600 under the client config dir and refuses a loosened file', () => {
    const host = gatewayHost();
    storeBackendCapability(host, { wrapper: true, direct: null, rpc: null });
    const file = join(process.env.XDG_CONFIG_HOME!, 'pocketshell-tui-client', 'backend-cache.json');
    expect((statSync(file).mode & 0o777).toString(8)).toBe('600');
    chmodSync(file, 0o644);
    expect(loadBackendCapability(host)).toBeNull();
  });

  it('refuses a stored direct word with control characters', () => {
    const host = gatewayHost();
    const file = join(process.env.XDG_CONFIG_HOME!, 'pocketshell-tui-client', 'backend-cache.json');
    mkdirSync(join(process.env.XDG_CONFIG_HOME!, 'pocketshell-tui-client'), { recursive: true, mode: 0o700 });
    const key = capabilityKey(host);
    const poisoned = {
      version: 1,
      hosts: { [key]: { wrapper: true, direct: 'a\nrm -rf', rpc: null, binary: 'pocketshell', checkedAt: Date.now() } },
    };
    writeFileSync(file, JSON.stringify(poisoned), { mode: 0o600 });
    expect(loadBackendCapability(host)).toBeNull();
  });

  it('forgets a host without touching others', () => {
    const one = gatewayHost('one');
    const two = gatewayHost('two');
    storeBackendCapability(one, { wrapper: true, direct: null, rpc: null });
    storeBackendCapability(two, { wrapper: false, direct: '/managed/a', rpc: null });
    forgetBackendCapability(one);
    expect(loadBackendCapability(one)).toBeNull();
    expect(loadBackendCapability(two)).not.toBeNull();
  });

  it('a resident negotiation proves `a`; an unsupported one only disproves rpc', () => {
    const host = gatewayHost();
    noteResidentCapability(host, true);
    expect(loadBackendCapability(host)).toMatchObject({ wrapper: false, direct: 'a', rpc: true });
    noteResidentCapability(host, false);
    expect(loadBackendCapability(host)).toMatchObject({ rpc: false });
    forgetBackendCapability(host);
    noteResidentCapability(host, false);
    // Nothing else is claimed: an unprobed host stays unprobed.
    expect(loadBackendCapability(host)).toBeNull();
  });
  it('a probe verdict drops a stale rpc claim when a is gone', () => {
    const host = gatewayHost();
    noteResidentCapability(host, true);
    storeBackendCapability(host, { wrapper: true, direct: null, rpc: null });
    expect(loadBackendCapability(host)).toMatchObject({ wrapper: true, direct: null, rpc: null });
  });

  it('does not rewrite an unchanged fresh verdict on every request', () => {
    const host = gatewayHost();
    noteResidentCapability(host, true);
    const file = join(process.env.XDG_CONFIG_HOME!, 'pocketshell-tui-client', 'backend-cache.json');
    const unchanged = readFileSync(file, 'utf8');
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000);
    noteResidentCapability(host, true);
    expect(readFileSync(file, 'utf8')).toBe(unchanged);
    noteResidentCapability(host, false); // a changed verdict is written
    expect(readFileSync(file, 'utf8')).not.toBe(unchanged);
    expect(loadBackendCapability(host)).toMatchObject({ rpc: false });
  });
});
