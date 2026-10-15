/**
 * The interactive unlock flow (shared by `psc vault unlock` and a connect to
 * a vault-bound host while locked) and the connect-time lookup of a host's
 * vault credential.
 */
import { requests } from '../daemon/context.js';
import { listHosts, type HostEntry } from '../hosts/store.js';
import { startCredential, type SshCredential } from './agent.js';
import { VaultError, type GatewayAuth } from './format.js';
import {
  bindingFor,
  cachedBinding,
  cliAccount,
  holdVault,
  refreshBindings,
  secretOrThrow,
  storeFor,
  unlockRemembered,
  type KeyVaultStore,
  type VaultAccount,
} from './index.js';
import { canPrompt, passphraseFd, promptPassphrase, readPassphraseFd } from './passphrase.js';

export const WRONG_PASSPHRASE = "That passphrase didn't unlock your vault.";
export const KEYS_URL = 'https://app.pocketshell.io/keys';
export const RESET_URL = 'https://app.pocketshell.io/keys?reset=1';
const FORGOT = `Forgot it? Reset the vault at ${RESET_URL} (your keys must then be uploaded again).`;
const MAX_TTY_ATTEMPTS = 10;

export interface UnlockFlowOptions {
  /** Where the passphrase comes from; default: PSC_VAULT_PASSPHRASE_FD, else the terminal. */
  readPassphrase?: (attempt: number) => Promise<string>;
  /** One-shot sources (fd) do not retry. */
  retry?: boolean;
  /** Progress / retry messages (stderr). */
  onMessage?: (text: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The default passphrase source for this process, or null when there is none. */
export function defaultPassphraseSource(): { read: (attempt: number) => Promise<string>; retry: boolean } | null {
  const fd = passphraseFd();
  if (fd !== null) return { read: async () => readPassphraseFd(fd), retry: false };
  // Never prompt from inside the resident daemon (no terminal there).
  if (requests.getStore() === undefined && canPrompt()) {
    return {
      read: (attempt) => promptPassphrase(attempt === 0 ? 'Vault passphrase: ' : 'Vault passphrase (try again): '),
      retry: true,
    };
  }
  return null;
}

function lockedError(): VaultError {
  return new VaultError(
    'The key vault is locked. Run `psc vault unlock` (scripts: pass the passphrase on a file descriptor named by PSC_VAULT_PASSPHRASE_FD).',
    'VAULT_LOCKED',
    3,
  );
}

/**
 * Ask for the passphrase until it unlocks: "That passphrase didn't unlock
 * your vault." and a retry; client backoff after the 3rd failure (1s, 2s,
 * 4s… 30s); the server's lockout (phase 2) is honoured as-is.
 */
export async function unlockInteractively(store: KeyVaultStore, options: UnlockFlowOptions = {}): Promise<void> {
  const source = options.readPassphrase
    ? { read: options.readPassphrase, retry: options.retry ?? true }
    : defaultPassphraseSource();
  if (source === null) throw lockedError();
  const say = options.onMessage ?? ((text: string) => process.stderr.write(`${text}\n`));
  const sleep = options.sleep ?? realSleep;
  for (let attempt = 0; attempt < MAX_TTY_ATTEMPTS; attempt++) {
    const wait = store.backoffRemainingMs();
    if (wait > 0) {
      say(`Wait ${Math.ceil(wait / 1000)}s before the next try...`);
      await sleep(wait);
    }
    const passphrase = await source.read(attempt);
    if (attempt === 0) say('Unlocking (this takes a moment)...');
    const result = await store.unlock(passphrase);
    switch (result.kind) {
      case 'ok':
        return;
      case 'noVault':
        throw new VaultError(
          `Your account has no key vault yet. Create it on the web (${KEYS_URL}), then run \`psc vault unlock\`.`,
          'VAULT_ABSENT',
          1,
        );
      case 'corrupt':
        throw new VaultError('The vault on your account is malformed.', 'VAULT_MALFORMED', 1);
      case 'error':
        throw new VaultError(`Could not unlock the vault: ${result.message}`, 'VAULT_ERROR', 1);
      case 'rateLimited':
        throw new VaultError(
          `Too many wrong passphrases; the vault is locked for ${Math.ceil(result.retryAfterMs / 1000)}s. Try again later. ${FORGOT}`,
          'VAULT_RATE_LIMITED',
          1,
          { retryAfter: Math.ceil(result.retryAfterMs / 1000) },
        );
      case 'backoff':
        continue;
      case 'wrongPassphrase': {
        if (!source.retry) throw new VaultError(`${WRONG_PASSPHRASE} ${FORGOT}`, 'VAULT_WRONG_PASSPHRASE', 1);
        say(`${WRONG_PASSPHRASE}`);
        if (attempt === 1) say(FORGOT);
        break;
      }
    }
  }
  throw new VaultError(`${WRONG_PASSPHRASE} ${FORGOT}`, 'VAULT_WRONG_PASSPHRASE', 1);
}

/** This process's unlocked store: held, remembered, or (with a passphrase source) asked for. */
export async function obtainUnlockedStore(
  account: VaultAccount,
  options: UnlockFlowOptions & { prompt?: boolean } = {},
): Promise<KeyVaultStore> {
  const store = storeFor(account);
  if (store.state === 'unlocked') return store;
  if ((await unlockRemembered(account, store)) !== null) return store;
  if (options.prompt === false) throw lockedError();
  await unlockInteractively(store, options);
  // Later invocations reuse this unlock until the holder's idle timeout.
  try {
    await holdVault(account, store);
  } catch {
    /* the connect still works; the next one asks again */
  }
  // A fresh unlock refreshes which saved hosts are vault-bound.
  try {
    await refreshBindings(account, store, listHosts());
  } catch {
    /* the connect itself still has its binding */
  }
  return store;
}

export interface VaultConnectCredential {
  credential: SshCredential;
  gatewayAuth: GatewayAuth;
  keyId: string;
}

function accountOrNull(): VaultAccount | null {
  try {
    return cliAccount();
  } catch {
    return null;
  }
}

/**
 * The vault credential a connection to `host` uses, or null for the
 * existing key resolution (no binding, policy `host`, local mode). No
 * network I/O unless the host is vault-bound.
 */
export async function vaultCredentialFor(
  host: HostEntry,
  options: { account?: VaultAccount; unlock?: UnlockFlowOptions } = {},
): Promise<VaultConnectCredential | null> {
  if (host.mode === 'local') return null;
  const account = options.account ?? accountOrNull();
  const cached = cachedBinding(account?.id ?? null, host);
  if (cached === null || cached.gatewayAuth === 'host') return null;
  if (account === null) {
    throw new VaultError(`${host.name} uses a key from your PocketShell vault; log in first (\`psc login\`).`, 'NOT_LOGGED_IN', 3);
  }
  const store = await obtainUnlockedStore(account, options.unlock);
  // The index is authoritative over the cache: the binding may have moved.
  const binding = bindingFor(host, store, cached.alias);
  if (binding === null || binding.gatewayAuth === 'host') return null;
  const secret = secretOrThrow(await store.decryptKey(binding.keyId));
  if (secret.kind === 'password' && host.mode === 'gateway') {
    throw new VaultError(
      `${host.name} is bound to a vault password, but gateway connections use SSH keys only; bind a key on the web.`,
      'VAULT_PASSWORD_UNSUPPORTED',
      2,
    );
  }
  return { credential: await startCredential(secret), gatewayAuth: binding.gatewayAuth, keyId: binding.keyId };
}
