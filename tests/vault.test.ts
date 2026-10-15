/**
 * psc's key vault wiring over core's KeyVaultStore: the unlock flow
 * (wrong passphrase, server verifier, gated header), remember on this
 * device, the bindings cache and connect-time routing. Crypto itself is
 * core's (and tested there). Throwaway keys and passphrases only.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { KeyVaultStore } from '@pocketshell/core';
import type { HostEntry } from '../src/hosts/store.js';
import {
  bindingsFile,
  cachedBinding,
  matchAccountAlias,
  refreshBindings,
  rememberVault,
  secretOrThrow,
  serverStatus,
  unlockRemembered,
  type VaultAccount,
} from '../src/vault/index.js';
import { keychain, loadRemembered, rememberFile, saveRemembered, setKeychainForTests, type Keychain } from '../src/vault/remember.js';
import { unlockInteractively, vaultCredentialFor, WRONG_PASSPHRASE } from '../src/vault/session.js';
import { buildVault, fakeVerifier, memoryTransport, sshKeygen, syncEnvelope, unavailableVerifier, type BuiltVault } from './vaultFixture.js';

const PASS = 'correct horse battery staple';
let ed: { pem: string; publicLine: string };
let built: BuiltVault;
let edId = '';
let pwId = '';

beforeAll(async () => {
  ed = sshKeygen('ed25519');
  built = await buildVault({
    passphrase: PASS,
    keys: [{ name: 'hetzner', pem: ed.pem }],
    passwords: [{ name: 'nas password', password: 'pw-for-tests' }],
    hosts: {
      hetzner: { key: 'hetzner', gatewayAuth: 'managed' },
      nas: { key: 'nas password', gatewayAuth: 'managed' },
      legacy: { key: 'hetzner', gatewayAuth: 'host' },
    },
    syncPassphrase: 'sync-pass-for-tests',
  });
  edId = built.keyIds.hetzner!;
  pwId = built.keyIds['nas password']!;
}, 60_000);

const savedEnv = { ...process.env };
beforeEach(() => {
  const xdg = mkdtempSync(join(tmpdir(), 'psc-vault-'));
  process.env.XDG_CONFIG_HOME = xdg;
  process.env.XDG_RUNTIME_DIR = join(xdg, 'run');
  delete process.env.PSC_VAULT_PASSPHRASE_FD;
  setKeychainForTests(null);
});
afterEach(() => {
  rmSync(process.env.XDG_CONFIG_HOME!, { recursive: true, force: true });
  process.env = { ...savedEnv };
  setKeychainForTests(undefined);
});

let accounts = 0;
/** A fresh account id per call, so the per-process store never leaks between tests. */
function account(slots = built.slots, verifier = unavailableVerifier): VaultAccount & { pulls: string[] } {
  const transport = memoryTransport(slots);
  return { id: `acct-${++accounts}`, transport, verifier, pulls: transport.pulls };
}
const newStore = (a: VaultAccount): KeyVaultStore => new KeyVaultStore({ transport: a.transport, verifier: a.verifier });

describe('unlock through core', () => {
  it('opens the vault built on the web and decrypts a key and a password', async () => {
    const store = newStore(account());
    expect(await store.unlock(PASS)).toEqual({ kind: 'ok' });
    expect(store.getHostBinding('hetzner')).toEqual({ keyId: edId, gatewayAuth: 'managed' });
    expect(store.getSyncPassphrase()).toBe('sync-pass-for-tests');
    expect(secretOrThrow(await store.decryptKeyForHost('hetzner'))).toEqual({ kind: 'key', pem: expect.stringContaining('OPENSSH PRIVATE KEY') });
    expect(secretOrThrow(await store.decryptKeyForHost('nas'))).toEqual({ kind: 'password', password: 'pw-for-tests' });
  });

  it('psc never writes: the transport only ever pulls vault slots', async () => {
    const a = account();
    const store = newStore(a);
    await store.unlock(PASS);
    await store.decryptKeyForHost('hetzner');
    expect(a.pulls.length).toBeGreaterThan(0);
    expect(a.pulls.every((s) => s === 'vault' || s.startsWith('vk-'))).toBe(true);
  });

  it('maps W2 /cli/vault/status to core status (kdf present in gated mode)', () => {
    expect(serverStatus(null)).toEqual({ kind: 'unavailable' });
    expect(serverStatus({ epoch: 3, hasVerifier: true, retryAfter: 2 })).toEqual({ kind: 'ok', epoch: 3, hasVerifier: true, retryAfterMs: 2000 });
    expect(serverStatus({ epoch: 1, hasVerifier: true, retryAfter: 0, kdf: built.kdf })).toMatchObject({ kdf: built.kdf });
  });

  it('typed errors for every decrypt outcome', () => {
    expect(() => secretOrThrow({ kind: 'locked' })).toThrow(expect.objectContaining({ code: 'VAULT_LOCKED', exitCode: 3 }));
    expect(() => secretOrThrow({ kind: 'gated' })).toThrow(expect.objectContaining({ code: 'VAULT_LOCKED' }));
    expect(() => secretOrThrow({ kind: 'missingKey', keyId: edId })).toThrow(expect.objectContaining({ code: 'VAULT_KEY_MISSING' }));
  });
});

describe('interactive unlock flow', () => {
  it("says \"That passphrase didn't unlock your vault.\" and retries", async () => {
    const answers = ['wrong one', PASS];
    const said: string[] = [];
    const store = newStore(account());
    await unlockInteractively(store, { readPassphrase: async (i) => answers[i]!, onMessage: (t) => said.push(t), sleep: async () => {} });
    expect(store.state).toBe('unlocked');
    expect(said).toContain(WRONG_PASSPHRASE);
  });

  it('waits out the client backoff after the third miss', async () => {
    const answers = ['a', 'b', 'c', PASS];
    const waits: number[] = [];
    let now = 1_000_000;
    const a = account();
    const store = new KeyVaultStore({ transport: a.transport, verifier: a.verifier, now: () => now });
    await unlockInteractively(store, {
      readPassphrase: async (i) => answers[i]!,
      onMessage: () => {},
      sleep: async (ms) => {
        waits.push(ms);
        now += ms;
      },
    });
    expect(store.state).toBe('unlocked');
    expect(waits).toEqual([1000]);
  }, 30_000);

  it('a one-shot source (fd) fails with VAULT_WRONG_PASSPHRASE and the reset link', async () => {
    await expect(
      unlockInteractively(newStore(account()), { readPassphrase: async () => 'nope', retry: false, onMessage: () => {} }),
    ).rejects.toMatchObject({ code: 'VAULT_WRONG_PASSPHRASE', message: expect.stringContaining('keys?reset=1') });
  });

  it('the server lockout (phase 2) ends the flow with VAULT_RATE_LIMITED', async () => {
    const verifier = fakeVerifier(built.auth);
    const a = account(built.slots, verifier);
    for (let i = 0; i < 5; i++) await newStore(a).unlock('bad');
    await expect(
      unlockInteractively(newStore(a), { readPassphrase: async () => PASS, onMessage: () => {} }),
    ).rejects.toMatchObject({ code: 'VAULT_RATE_LIMITED' });
  }, 30_000);

  it('gated mode: status.kdf → Argon2id → verify → header', async () => {
    const verifier = fakeVerifier(built.auth, built.kdf);
    const transport = memoryTransport(built.slots, { gated: () => !verifier.verified });
    const store = new KeyVaultStore({ transport, verifier });
    await unlockInteractively(store, { readPassphrase: async () => PASS, onMessage: () => {} });
    expect(verifier.verified).toBe(true);
    expect(secretOrThrow(await store.decryptKeyForHost('hetzner')).kind).toBe('key');
  });

  it('without a terminal or fd it is VAULT_LOCKED, exit 3', async () => {
    await expect(unlockInteractively(newStore(account()))).rejects.toMatchObject({ code: 'VAULT_LOCKED', exitCode: 3 });
  });
});

describe('remember on this device', () => {
  it('refuses the keychain backend when there is none', () => {
    expect(keychain()).toBeNull();
    expect(() => saveRemembered('acct', { v: 1, vaultId: 'x', epoch: 1, dek: 'a'.repeat(43) }, 'keychain')).toThrow(
      expect.objectContaining({ code: 'KEYCHAIN_UNAVAILABLE' }),
    );
    expect(existsSync(rememberFile())).toBe(false);
  });

  it('--remember-file: a 0600 file, then a passphrase-free unlock', async () => {
    const a = account();
    const store = newStore(a);
    await store.unlock(PASS);
    rememberVault(a, store, 'file');
    expect(statSync(rememberFile()).mode & 0o777).toBe(0o600);
    expect(readFileSync(rememberFile(), 'utf8')).not.toContain(PASS);
    const fresh = newStore(a);
    expect(await unlockRemembered(a, fresh)).toBe('file');
    expect(secretOrThrow(await fresh.decryptKeyForHost('hetzner')).kind).toBe('key');
  });

  it('a group/other-readable remember file is ignored and removed', async () => {
    const a = account();
    const store = newStore(a);
    await store.unlock(PASS);
    rememberVault(a, store, 'file');
    chmodSync(rememberFile(), 0o644);
    expect(loadRemembered(a.id)).toBeNull();
    expect(existsSync(rememberFile())).toBe(false);
  });

  it('uses the OS keychain when present (nothing in files)', async () => {
    const items = new Map<string, string>();
    const fake: Keychain = { name: 'fake', get: (k) => items.get(k) ?? null, set: (k, v) => void items.set(k, v), remove: (k) => void items.delete(k) };
    setKeychainForTests(fake);
    const a = account();
    const store = newStore(a);
    await store.unlock(PASS);
    rememberVault(a, store, 'keychain');
    expect(items.size).toBe(1);
    expect(existsSync(rememberFile())).toBe(false);
    expect(await unlockRemembered(a, newStore(a))).toBe('keychain');
  });

  it('a record for another vault (reset) is deleted and asks again', async () => {
    const a = account();
    const store = newStore(a);
    await store.unlock(PASS);
    rememberVault(a, store, 'file');
    const reset = await buildVault({ passphrase: PASS });
    const b: VaultAccount = { id: a.id, transport: memoryTransport(reset.slots), verifier: unavailableVerifier };
    expect(await unlockRemembered(b, newStore(b))).toBeNull();
    expect(existsSync(rememberFile())).toBe(false);
  });

  it('gated mode: the remembered AUTH passes the verify; a changed passphrase makes it stale', async () => {
    const verifier = fakeVerifier(built.auth, built.kdf);
    const gated: VaultAccount = { id: 'acct-gated', transport: memoryTransport(built.slots, { gated: () => !verifier.verified }), verifier };
    const store = newStore(gated);
    await store.unlock(PASS);
    rememberVault(gated, store, 'file');
    verifier.verified = false;
    expect(await unlockRemembered(gated, newStore(gated))).toBe('file');
    const changed = fakeVerifier(new Uint8Array(32).fill(7), built.kdf);
    const c: VaultAccount = { id: 'acct-gated', transport: memoryTransport(built.slots, { gated: () => !changed.verified }), verifier: changed };
    expect(await unlockRemembered(c, newStore(c))).toBeNull();
    expect(existsSync(rememberFile())).toBe(false);
  });
});

describe('host bindings', () => {
  const sshHost = (name: string, destination: string, extra: Partial<HostEntry> = {}): HostEntry => ({ name, mode: 'ssh', ssh: { destination }, ...extra });
  const accountHosts = [
    { name: 'hetzner', hostname: '203.0.113.7', user: 'root', port: 22 },
    { name: 'nas', hostname: 'nas.lan', user: 'admin' },
    { name: 'gw-box', hostname: 'gw', deviceId: 'box-123' },
  ];
  const aliases = new Set(['hetzner', 'nas', 'gw-box']);

  function seedCache(a: VaultAccount, hosts: Record<string, unknown>): void {
    mkdirSync(dirname(bindingsFile()), { recursive: true });
    writeFileSync(bindingsFile(), JSON.stringify({ v: 1, account: a.id, vaultId: built.vaultId, epoch: 1, hosts }), { mode: 0o600 });
  }

  it('matches by name, override, gateway device or a unique ssh target', () => {
    expect(matchAccountAlias(sshHost('hetzner', 'x'), aliases, [])).toBe('hetzner');
    expect(matchAccountAlias(sshHost('h', 'root@203.0.113.7'), aliases, accountHosts)).toBe('hetzner');
    expect(matchAccountAlias(sshHost('h', 'other@203.0.113.7'), aliases, accountHosts)).toBeNull();
    expect(matchAccountAlias({ name: 'b', mode: 'gateway', gateway: { deviceId: 'box-123' } }, aliases, accountHosts)).toBe('gw-box');
    expect(matchAccountAlias(sshHost('z', 'nas.lan', { vault: { alias: 'nas' } }), aliases, [])).toBe('nas');
    expect(matchAccountAlias(sshHost('z', 'nas.lan', { vault: { alias: 'gone' } }), aliases, accountHosts)).toBeNull();
  });

  it('refreshBindings reads the main host list with the vault-held sync passphrase', async () => {
    const slots = new Map(built.slots);
    slots.set('main', syncEnvelope(JSON.stringify({ hosts: accountHosts }), 'sync-pass-for-tests'));
    const a = account(slots);
    const store = newStore(a);
    await store.unlock(PASS);
    const hosts = [sshHost('box', 'root@203.0.113.7'), sshHost('legacy', 'l'), sshHost('other', 'o'), { name: 'local', mode: 'local' } as HostEntry];
    const out = await refreshBindings(a, store, hosts);
    expect(out).toEqual({
      'name:box': { keyId: edId, gatewayAuth: 'managed', alias: 'hetzner' },
      'name:legacy': { keyId: edId, gatewayAuth: 'host', alias: 'legacy' },
    });
    expect(statSync(bindingsFile()).mode & 0o777).toBe(0o600);
    expect(readFileSync(bindingsFile(), 'utf8')).not.toContain('PRIVATE');
    expect(cachedBinding(a.id, hosts[0]!)).toMatchObject({ keyId: edId });
    expect(cachedBinding('another-account', hosts[0]!)).toBeNull();
  });

  it('connect: unbound and `host`-policy hosts never touch the network; bound + locked is VAULT_LOCKED', async () => {
    const a = account();
    seedCache(a, {
      'name:hetzner': { keyId: edId, gatewayAuth: 'managed', alias: 'hetzner' },
      'name:legacy': { keyId: edId, gatewayAuth: 'host', alias: 'legacy' },
    });
    expect(await vaultCredentialFor(sshHost('plain', 'p'), { account: a })).toBeNull();
    expect(await vaultCredentialFor(sshHost('legacy', 'l'), { account: a })).toBeNull();
    expect(a.pulls).toEqual([]);
    await expect(vaultCredentialFor(sshHost('hetzner', 'h'), { account: a })).rejects.toMatchObject({ code: 'VAULT_LOCKED', exitCode: 3 });
  });

  it('connect: a bound host gets an agent-backed credential; a gateway host refuses a password', async () => {
    const a = account();
    seedCache(a, {
      'name:hetzner': { keyId: edId, gatewayAuth: 'both', alias: 'hetzner' },
      'gw:nas-dev': { keyId: pwId, gatewayAuth: 'managed', alias: 'nas' },
    });
    const opts = { account: a, unlock: { readPassphrase: async () => PASS, onMessage: () => {} } };
    const cred = await vaultCredentialFor(sshHost('hetzner', 'h'), opts);
    // the index says managed: the index wins over the stale cache
    expect(cred!.gatewayAuth).toBe('managed');
    expect(readFileSync(cred!.credential.identityFile!, 'utf8')).toContain(ed.publicLine.split(' ')[1]);
    expect(cred!.credential.options).toContain('IdentitiesOnly=yes');
    await cred!.credential.close();
    expect(existsSync(cred!.credential.identityFile!)).toBe(false);
    await expect(vaultCredentialFor({ name: 'nas', mode: 'gateway', gateway: { deviceId: 'nas-dev' } }, opts)).rejects.toMatchObject({
      code: 'VAULT_PASSWORD_UNSUPPORTED',
    });
  });

  it('a local keyId override binds without any account alias', async () => {
    const a = account();
    const host = sshHost('box', 'b', { vault: { keyId: edId } });
    expect(cachedBinding(a.id, host)).toEqual({ keyId: edId, gatewayAuth: 'managed', alias: null });
    const cred = await vaultCredentialFor(host, { account: a, unlock: { readPassphrase: async () => PASS, onMessage: () => {} } });
    expect(cred!.keyId).toBe(edId);
    await cred!.credential.close();
  });
});
