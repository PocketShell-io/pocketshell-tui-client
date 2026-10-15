/**
 * psc's key vault glue around `@pocketshell/core`'s KeyVaultStore: the
 * read-only CLI-session transport and verifier, the
 * per-process store, "remember on this device", and which saved host maps
 * to which vault binding.
 *
 * Reads go through the CLI session (`GET /cli/settings/{slot}`); the server
 * only ever sees ciphertext and, in phase 2, the AUTH verifier input.
 * Plaintext keys exist only in this process's memory (see agent.ts).
 *
 * Locked-state routing without network I/O: every unlock writes a
 * non-secret bindings cache (`vault-bindings.json`, 0600: which saved host
 * maps to which key id and policy). A connect to a host the cache says is
 * vault-bound asks for the passphrase on a terminal, or fails VAULT_LOCKED
 * (exit 3); every other host keeps the existing key resolution.
 */
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as broker from '../account/broker.js';
import { sessionBrokerUrl } from '../account/config.js';
import * as credentials from '../account/credentials.js';
import type { HostEntry } from '../hosts/store.js';
import { clientConfigDir } from '../paths.js';
import {
  KeyVaultStore,
  type HostKeyBinding,
  type VaultKdfParams,
  type VaultSecretResult,
  type VaultServerStatus,
  type VaultServerVerifier,
  type VaultSlotTransport,
} from '@pocketshell/core';
import { isKeyId, VaultError, type GatewayAuth, type VaultSecret } from './format.js';
import { startHolder, stopHolder } from './holder.js';
import { accountKey, forgetRemembered, loadRemembered, saveRemembered, type RememberBackend, type RememberRecord } from './remember.js';
import { decryptSyncEnvelope, parseAccountHosts, type AccountHost } from './syncEnvelope.js';

export { KeyVaultStore } from '@pocketshell/core';
export type {
  HostKeyBinding,
  VaultRememberRecord,
  VaultSecretResult,
  VaultServerVerifier,
  VaultSlotTransport,
  VaultUnlockResult,
} from '@pocketshell/core';
export { VaultError, type GatewayAuth, type VaultSecret } from './format.js';

const READ_ONLY = 'psc reads the vault only; manage keys on the web';

/** The last typed transport failure (NOT_LOGGED_IN, VAULT_UNAVAILABLE, ...), so its code survives core's result. */
let lastPullError: Error | null = null;

/** The account a store belongs to, plus how to reach its slots. */
export interface VaultAccount {
  /** Stable per-account id (remember records and the bindings cache are scoped to it). */
  readonly id: string;
  readonly transport: VaultSlotTransport;
  readonly verifier: VaultServerVerifier;
}

/**
 * This device's account id from the stored login, even an expired one (for
 * lock/logout cleanup, which must work without a valid session). Null when
 * there is no readable login.
 */
export function storedAccountId(): string | null {
  let creds: credentials.Credentials;
  try {
    creds = credentials.load({ allowSharedMode: true });
  } catch {
    return null;
  }
  try {
    return accountKey(sessionBrokerUrl(creds.brokerUrl), creds.email);
  } catch {
    return accountKey(creds.brokerUrl, creds.email);
  }
}

/** The logged-in CLI session's account (throws NotLoggedIn without one). */
export function cliAccount(options: broker.HttpOptions = {}): VaultAccount {
  const creds = credentials.requireSession();
  const base = sessionBrokerUrl(creds.brokerUrl);
  return {
    id: accountKey(base, creds.email),
    transport: {
      async pull(slot) {
        try {
          const got = await broker.getCliSlot(base, creds.accessToken, slot, options);
          return got === null ? { kind: 'absent' } : { kind: 'ok', version: got.version, data: got.data };
        } catch (error) {
          if ((error as { code?: unknown }).code === 'VAULT_VERIFY_REQUIRED') return { kind: 'gated' };
          lastPullError = error as Error; // core folds it into {kind:'error'}; resultError restores it
          throw error;
        }
      },
      // Read-only: psc never writes vault slots (keys are managed on the web).
      push: async () => ({ kind: 'error', message: READ_ONLY }),
      delete: async () => {
        throw new VaultError(READ_ONLY, 'VAULT_READ_ONLY');
      },
      list: async () => {
        throw new VaultError(READ_ONLY, 'VAULT_READ_ONLY');
      },
    },
    verifier: {
      verify: (auth) => broker.verifyVaultCli(base, creds.accessToken, Buffer.from(auth).toString('base64url'), options),
      status: async (): Promise<VaultServerStatus> => serverStatus(await broker.getVaultStatusCli(base, creds.accessToken, options)),
      setVerifier: async () => ({ kind: 'unavailable' }),
    },
  };
}

/** Map `GET /cli/vault/status` (W2: {epoch, hasVerifier, retryAfter, kdf?}) to core's status. */
export function serverStatus(body: Record<string, unknown> | null): VaultServerStatus {
  if (body === null || typeof body.epoch !== 'number' || typeof body.hasVerifier !== 'boolean') return { kind: 'unavailable' };
  const retry = typeof body.retryAfter === 'number' && body.retryAfter > 0 ? Math.min(body.retryAfter, 86_400) * 1000 : 0;
  const status: VaultServerStatus = { kind: 'ok', epoch: body.epoch, hasVerifier: body.hasVerifier, retryAfterMs: retry };
  if (typeof body.kdf === 'object' && body.kdf !== null) status.kdf = body.kdf as VaultKdfParams;
  return status;
}

// -- the per-process store -----------------------------------------------------

let current: { account: string; store: KeyVaultStore } | null = null;

/** This process's store for `account` (one at a time; switching accounts locks the old one). */
export function storeFor(account: VaultAccount): KeyVaultStore {
  if (current !== null && current.account === account.id) return current.store;
  current?.store.lock();
  const store = new KeyVaultStore({ transport: account.transport, verifier: account.verifier });
  current = { account: account.id, store };
  return store;
}

async function unlockWithRecord(store: KeyVaultStore, record: RememberRecord): Promise<'ok' | 'stale'> {
  const dek = new Uint8Array(Buffer.from(record.dek, 'base64url'));
  const auth = record.auth ? new Uint8Array(Buffer.from(record.auth, 'base64url')) : null;
  try {
    const result = await store.unlockWithRememberedDek({ vaultId: record.vaultId, epoch: record.epoch, dek, ...(auth ? { auth } : {}) });
    if (result.kind === 'ok') return 'ok';
    if (result.kind === 'stale' || result.kind === 'noVault') return 'stale';
    if (result.kind === 'rateLimited') {
      throw new VaultError(
        `The server is rate limiting vault unlocks; try again in ${Math.ceil(result.retryAfterMs / 1000)}s.`,
        'VAULT_RATE_LIMITED',
        1,
      );
    }
    throw resultError(result);
  } finally {
    dek.fill(0);
    auth?.fill(0);
  }
}

/** Errors for the unlock outcomes every path shares. */
export function resultError(result: { kind: string; message?: string }): Error {
  if (result.kind === 'error' && lastPullError !== null && result.message?.includes(lastPullError.message)) return lastPullError;
  if (result.kind === 'unsupportedVersion') {
    return new VaultError('Your vault uses a newer format than this psc understands; update psc (npm i -g @pocketshell/tui-client).', 'VAULT_UNSUPPORTED', 1);
  }
  if (result.kind === 'corrupt') return new VaultError('The vault on your account is malformed.', 'VAULT_MALFORMED', 1);
  return new VaultError(`Could not unlock the vault: ${result.message ?? result.kind}`, 'VAULT_ERROR', 1);
}

/** Unlock from this device's remembered record (no passphrase); a stale one is deleted. */
export async function unlockRemembered(account: VaultAccount, store: KeyVaultStore): Promise<RememberBackend | null> {
  const remembered = loadRemembered(account.id);
  if (remembered === null) return null;
  if ((await unlockWithRecord(store, remembered.record)) === 'ok') return remembered.backend;
  forgetRemembered(account.id);
  return null;
}

/** The store's remember record in its stored (base64url) form. */
function recordOf(store: KeyVaultStore): RememberRecord {
  const record = store.exportRememberRecord();
  if (record === null) throw new VaultError('The vault is locked.', 'VAULT_LOCKED', 3);
  try {
    return {
      v: 1,
      vaultId: record.vaultId,
      epoch: record.epoch,
      dek: Buffer.from(record.dek).toString('base64url'),
      ...(record.auth ? { auth: Buffer.from(record.auth).toString('base64url') } : {}),
    };
  } finally {
    record.dek.fill(0);
    record.auth?.fill(0);
  }
}

export function rememberVault(account: VaultAccount, store: KeyVaultStore, backend: RememberBackend): void {
  saveRemembered(account.id, recordOf(store), backend);
}

/** Keep the unlocked vault in the memory-only holder for later invocations (POSIX). */
export function holdVault(account: VaultAccount, store: KeyVaultStore): Promise<boolean> {
  return startHolder(account.id, recordOf(store));
}

/**
 * Lock: wipe the in-memory DEK, stop the holder and forget what this device
 * remembers. Needs no session: the holder and the remember file go
 * unconditionally; the keychain item when the account is known.
 */
export async function lockVault(accountId: string | null): Promise<boolean> {
  if (current !== null) {
    current.store.lock();
    current = null;
  }
  forgetRemembered(accountId);
  return stopHolder();
}

// -- bindings cache ------------------------------------------------------------

export interface CachedBinding extends HostKeyBinding {
  /** The account alias the binding came from (null for a local keyId override). */
  alias: string | null;
}

interface BindingsCache {
  v: 1;
  account: string;
  vaultId: string | null;
  epoch: number | null;
  hosts: Record<string, CachedBinding>;
}

export function bindingsFile(): string {
  return join(clientConfigDir(), 'vault-bindings.json');
}

/** The cache key for a saved host: its gateway device or its name. */
export function hostKey(host: HostEntry): string {
  return host.mode === 'gateway' && host.gateway ? `gw:${host.gateway.deviceId}` : `name:${host.name}`;
}

function readCache(account: string): BindingsCache | null {
  const path = bindingsFile();
  try {
    const st = lstatSync(path);
    if (!st.isFile() || (process.platform !== 'win32' && (st.mode & 0o077) !== 0)) return null;
    const doc = JSON.parse(readFileSync(path, 'utf8')) as BindingsCache;
    if (doc.v !== 1 || doc.account !== account || typeof doc.hosts !== 'object' || doc.hosts === null) return null;
    return doc;
  } catch {
    return null;
  }
}

function writeCache(cache: BindingsCache): void {
  const path = bindingsFile();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(dirname(path), 0o700);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function clearBindingsCache(): void {
  rmSync(bindingsFile(), { force: true });
}

function destinationHost(destination: string): { user?: string; host: string } {
  const at = destination.lastIndexOf('@');
  return at > 0 ? { user: destination.slice(0, at), host: destination.slice(at + 1) } : { host: destination };
}

/** The account alias a saved host corresponds to: override, same name, gateway device, or a unique ssh-target match. */
export function matchAccountAlias(host: HostEntry, aliases: ReadonlySet<string>, accountHosts: readonly AccountHost[]): string | null {
  if (host.vault?.alias !== undefined) return aliases.has(host.vault.alias) ? host.vault.alias : null;
  if (aliases.has(host.name)) return host.name;
  const candidates = accountHosts.filter((a) => aliases.has(a.name)).filter((a) => {
    if (host.mode === 'gateway') return host.gateway !== undefined && a.deviceId === host.gateway.deviceId;
    if (host.mode !== 'ssh' || !host.ssh) return false;
    const target = destinationHost(host.ssh.destination);
    if (!a.hostname || a.hostname.toLowerCase() !== target.host.toLowerCase()) return false;
    const user = host.ssh.user ?? target.user;
    if (user !== undefined && a.user && a.user !== user) return false;
    if (host.ssh.port !== undefined && a.port !== undefined && a.port !== host.ssh.port) return false;
    return true;
  });
  return candidates.length === 1 ? candidates[0]!.name : null;
}

/** The binding for one host from the unlocked store (a local keyId override wins). */
export function bindingFor(host: HostEntry, store: KeyVaultStore, alias: string | null): CachedBinding | null {
  if (host.vault?.keyId !== undefined) {
    return { keyId: host.vault.keyId, gatewayAuth: host.vault.gatewayAuth ?? 'managed', alias: null };
  }
  if (alias === null) return null;
  const binding = store.getHostBinding(alias);
  return binding ? { ...binding, alias } : null;
}

/**
 * Recompute the bindings cache for `hosts` from the unlocked store. Hosts
 * whose name is not an account alias are matched through the `main` host
 * list, decrypted with the sync passphrase the index carries (decision #2).
 */
export async function refreshBindings(
  account: VaultAccount,
  store: KeyVaultStore,
  hosts: readonly HostEntry[],
): Promise<Record<string, CachedBinding>> {
  const aliases = new Set(Object.keys(store.listHostBindings()));
  let accountHosts: AccountHost[] = [];
  const sync = store.getSyncPassphrase();
  const needsMain = hosts.some((h) => h.mode !== 'local' && h.vault?.keyId === undefined && h.vault?.alias === undefined && !aliases.has(h.name));
  if (needsMain && sync !== null && aliases.size > 0) {
    try {
      const main = await account.transport.pull('main');
      if (main.kind === 'ok') accountHosts = parseAccountHosts(await decryptSyncEnvelope(main.data, sync));
    } catch {
      accountHosts = []; // matching by name still works
    }
  }
  // Entries for hosts outside `hosts` (gateway devices not saved locally)
  // survive while the vault is the same one; listed hosts are recomputed.
  const previous = readCache(account.id);
  const out: Record<string, CachedBinding> = previous !== null && previous.vaultId === store.vaultId ? { ...previous.hosts } : {};
  for (const host of hosts) {
    if (host.mode === 'local') continue;
    const binding = bindingFor(host, store, matchAccountAlias(host, aliases, accountHosts));
    if (binding !== null) out[hostKey(host)] = binding;
    else delete out[hostKey(host)];
  }
  writeCache({ v: 1, account: account.id, vaultId: store.vaultId, epoch: store.epoch, hosts: out });
  return out;
}

/** The cached (or local override) binding for a host, without network I/O. */
export function cachedBinding(accountId: string | null, host: HostEntry): CachedBinding | null {
  if (host.vault?.keyId !== undefined) return { keyId: host.vault.keyId, gatewayAuth: host.vault.gatewayAuth ?? 'managed', alias: null };
  if (accountId === null) return null;
  const binding = readCache(accountId)?.hosts[hostKey(host)];
  return binding && isKeyId(binding.keyId) ? binding : null;
}

/** A decrypt result as a secret, or a typed VaultError. */
export function secretOrThrow(result: VaultSecretResult): VaultSecret {
  switch (result.kind) {
    case 'key':
    case 'password':
      return result;
    case 'locked':
      throw new VaultError('The key vault is locked; run `psc vault unlock`.', 'VAULT_LOCKED', 3);
    case 'gated':
      throw new VaultError('The server wants the vault passphrase again; run `psc vault unlock`.', 'VAULT_LOCKED', 3);
    case 'unbound':
      throw new VaultError('That host has no vault key bound; bind one on the web (Keys).', 'VAULT_UNBOUND', 1);
    case 'missingKey':
      throw new VaultError(
        `The vault key this host uses (${result.keyId}) is not on your account any more; re-upload it or rebind the host on the web.`,
        'VAULT_KEY_MISSING',
        1,
      );
    case 'corrupt':
      throw new VaultError(
        'A vault key could not be decrypted (the vault was reset or the blob is corrupt); run `psc vault unlock` again.',
        'VAULT_RESET',
        3,
      );
    case 'error':
      throw new VaultError(`Could not read the vault key: ${result.message}`, 'VAULT_ERROR', 1);
  }
}

export type { GatewayAuth as VaultGatewayAuth };
