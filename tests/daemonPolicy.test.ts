import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, unlinkSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
const state = vi.hoisted(() => ({
  creds: {
    brokerUrl: 'https://fixture.invalid',
    accessToken: 'fixture-only',
    tokenId: 'A',
    email: 'fixture',
    expiresAt: Date.now() / 1000 + 300,
    label: 'fixture',
  },
  pin: 'key-A',
  unsafe: false,
  loggedOut: false,
}));
vi.mock('../src/account/index.js', () => ({
  requireLogin: () => {
    if (state.loggedOut || state.creds.expiresAt <= Date.now() / 1000)
      throw Error('fixture credentials expired');
    return state.creds;
  },
}));
vi.mock('../src/gateway/pins.js', () => ({
  pinFilePath: () => '/fixture/pins',
  loadPinEntries: () => {
    if (state.unsafe) throw Error('fixture unsafe pins');
    return new Map([['Lab', { alias: 'fixture', key: { keyType: 'ssh-ed25519', blobB64: state.pin } }]]);
  },
}));
import { gatewayPolicy } from '../src/daemon/policy.js';
const dir = mkdtempSync(resolve('.fixture-policy-'));
const key = join(dir, 'identity');
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  vi.stubEnv('XDG_CONFIG_HOME', join(dir, 'isolated-config'));
  state.loggedOut = false;
  state.unsafe = false;
  state.pin = 'key-A';
  state.creds.tokenId = 'A';
  state.creds.expiresAt = Date.now() / 1000 + 300;
  try {
    unlinkSync(key);
  } catch {}
  writeFileSync(key, 'synthetic fixture identity', { mode: 0o600 });
});
const host = {
  name: 'fixture',
  mode: 'gateway' as const,
  gateway: { deviceId: 'Lab', identityFile: key, server: 'wss://fixture.invalid' },
};
describe('persistent gateway policy generation', () => {
  it('invalidates account, full selected pin, endpoint and identity changes', () => {
    const a = gatewayPolicy(host).generation;
    state.creds.tokenId = 'B';
    expect(gatewayPolicy(host).generation).not.toBe(a);
    state.creds.tokenId = 'A';
    state.pin = 'key-B';
    expect(gatewayPolicy(host).generation).not.toBe(a);
    state.pin = 'key-A';
    expect(
      gatewayPolicy({ ...host, gateway: { ...host.gateway, server: 'wss://other.invalid' } }).generation,
    ).not.toBe(a);
    writeFileSync(key, 'changed fixture bytes');
    expect(gatewayPolicy(host).generation).not.toBe(a);
  });
  it('refuses logout, credential expiry, unsafe pin and identity files', () => {
    state.loggedOut = true;
    expect(() => gatewayPolicy(host)).toThrow();
    state.loggedOut = false;
    state.creds.expiresAt = 0;
    expect(() => gatewayPolicy(host)).toThrow();
    state.creds.expiresAt = Date.now() / 1000 + 300;
    state.unsafe = true;
    expect(() => gatewayPolicy(host)).toThrow();
    state.unsafe = false;
    chmodSync(key, 0o644);
    expect(() => gatewayPolicy(host)).toThrow('unsafe policy file');
    chmodSync(key, 0o600);
    unlinkSync(key);
    symlinkSync('/fixture/never-read', key);
    expect(() => gatewayPolicy(host)).toThrow();
  });
});
