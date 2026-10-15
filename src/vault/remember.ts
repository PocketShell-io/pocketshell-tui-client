/**
 * "Remember on this device" for psc: the vault DEK and AUTH (never the
 * passphrase), stored with its vaultId and epoch so a reset vault discards it.
 *
 * Backends, in order:
 * - `keychain`: the OS secret store. Linux: libsecret's `secret-tool`
 *   (Secret Service over D-Bus). macOS: the login keychain via `security`,
 *   fed on stdin so the secret is never in argv. Windows: the current-user
 *   DPAPI store of the psc-security helper (kind `vault`).
 * - `file`: a 0600 file in the 0700 client config dir, ONLY when the user
 *   opts in with `--remember-file`. Anyone who can read the file (root, a
 *   backup, malware running as you) can decrypt every vault key without the
 *   passphrase.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { clientConfigDir } from '../paths.js';
import { nativeRead, nativeWrite, callNative } from '../platform/windows.js';
import { VaultError } from './format.js';

export interface RememberRecord {
  v: 1;
  vaultId: string;
  epoch: number;
  /** base64url DEK. */
  dek: string;
  /** base64url AUTH (decision #6: passes the phase-2 verify gate silently). */
  auth?: string;
}

export type RememberBackend = 'keychain' | 'file';

const SERVICE = 'pocketshell-vault';

/** One remembered DEK per account: the broker URL + email, hashed. */
export function accountKey(brokerUrl: string, email: string): string {
  return createHash('sha256').update(`${brokerUrl}\n${email.toLowerCase()}`).digest('hex').slice(0, 32);
}

export function rememberFile(): string {
  return join(clientConfigDir(), 'vault-remember.json');
}

function onPath(binary: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir.startsWith('/')) continue;
    const candidate = join(dir, binary);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function encodeRecord(record: RememberRecord): string {
  return Buffer.from(JSON.stringify(record), 'utf8').toString('base64url');
}

function decodeRecord(text: string): RememberRecord | null {
  try {
    const raw = JSON.parse(Buffer.from(text.trim(), 'base64url').toString('utf8')) as Record<string, unknown>;
    if (
      raw.v !== 1 ||
      typeof raw.vaultId !== 'string' ||
      typeof raw.dek !== 'string' ||
      (raw.auth !== undefined && (typeof raw.auth !== 'string' || Buffer.from(raw.auth, 'base64url').length !== 32)) ||
      typeof raw.epoch !== 'number' ||
      !Number.isSafeInteger(raw.epoch) ||
      Buffer.from(raw.dek, 'base64url').length !== 32
    ) {
      return null;
    }
    return { v: 1, vaultId: raw.vaultId, epoch: raw.epoch, dek: raw.dek, ...(typeof raw.auth === 'string' ? { auth: raw.auth } : {}) };
  } catch {
    return null;
  }
}

/** The OS keychain, when this machine has one psc can drive. */
export interface Keychain {
  readonly name: string;
  get(account: string): string | null;
  set(account: string, secret: string): void;
  remove(account: string): void;
}

const RUN = { encoding: 'utf8' as const, timeout: 15_000, maxBuffer: 64 * 1024, shell: false };

function secretTool(path: string): Keychain {
  const attrs = (account: string): string[] => ['service', SERVICE, 'account', account];
  return {
    name: 'Secret Service (secret-tool)',
    get(account) {
      const r = spawnSync(path, ['lookup', ...attrs(account)], { ...RUN, stdio: ['ignore', 'pipe', 'ignore'] });
      return r.status === 0 && r.stdout ? r.stdout : null;
    },
    set(account, secret) {
      const r = spawnSync(path, ['store', '--label=PocketShell vault (psc)', ...attrs(account)], {
        ...RUN,
        input: secret,
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      if (r.status !== 0) throw new VaultError('The Secret Service refused to store the vault key (is a keyring unlocked?).', 'KEYCHAIN_UNAVAILABLE');
    },
    remove(account) {
      spawnSync(path, ['clear', ...attrs(account)], { ...RUN, stdio: 'ignore' });
    },
  };
}

function macKeychain(path: string): Keychain {
  return {
    name: 'macOS login keychain',
    get(account) {
      const r = spawnSync(path, ['find-generic-password', '-s', SERVICE, '-a', account, '-w'], {
        ...RUN,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return r.status === 0 && r.stdout ? r.stdout : null;
    },
    set(account, secret) {
      // `security -i` reads commands from stdin: the secret never reaches argv.
      if (!/^[A-Za-z0-9_-]+$/.test(secret) || !/^[a-f0-9]+$/.test(account)) throw new VaultError('bad keychain item', 'KEYCHAIN_UNAVAILABLE');
      const r = spawnSync(path, ['-i'], {
        ...RUN,
        input: `add-generic-password -U -s ${SERVICE} -a ${account} -l "PocketShell vault (psc)" -w ${secret}\n`,
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      if (r.status !== 0) throw new VaultError('The macOS keychain refused to store the vault key.', 'KEYCHAIN_UNAVAILABLE');
    },
    remove(account) {
      spawnSync(path, ['delete-generic-password', '-s', SERVICE, '-a', account], { ...RUN, stdio: 'ignore' });
    },
  };
}

function windowsDpapi(): Keychain {
  const root = clientConfigDir();
  return {
    name: 'Windows DPAPI (current user)',
    get(account) {
      const data = nativeRead(root, 'vault', account);
      return data === null ? null : data.toString('utf8');
    },
    set(account, secret) {
      nativeWrite(root, 'vault', Buffer.from(secret, 'utf8'), account);
    },
    remove(account) {
      try {
        callNative({ op: 'remove', root, kind: 'vault', name: account });
      } catch {
        /* already gone */
      }
    },
  };
}

let keychainOverride: Keychain | null | undefined;

/** Test seam: replace (or with null, disable) the OS keychain. */
export function setKeychainForTests(keychain: Keychain | null | undefined): void {
  keychainOverride = keychain;
}

export function keychain(): Keychain | null {
  if (keychainOverride !== undefined) return keychainOverride;
  if (process.platform === 'win32') return windowsDpapi();
  if (process.platform === 'darwin') {
    const path = existsSync('/usr/bin/security') ? '/usr/bin/security' : null;
    return path ? macKeychain(path) : null;
  }
  // libsecret needs a D-Bus session; without one secret-tool hangs or fails.
  const path = onPath('secret-tool');
  if (path === null || !process.env.DBUS_SESSION_BUS_ADDRESS) return null;
  return secretTool(path);
}

function writePrivateFile(path: string, body: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(dir, 0o700);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, body, { mode: 0o600, flag: 'wx' });
  renameSync(tmp, path);
}

function readPrivateFile(path: string): string | null {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  if (process.platform !== 'win32' && ((st.mode & 0o077) !== 0 || st.uid !== process.getuid?.())) {
    // Readable by others or not ours: never trust (or keep) it.
    rmSync(path, { force: true });
    return null;
  }
  return readFileSync(path, 'utf8');
}

export interface Remembered {
  record: RememberRecord;
  backend: RememberBackend;
}

/** The remembered DEK for this account, from the keychain first, then the opt-in file. */
export function loadRemembered(account: string): Remembered | null {
  const kc = keychain();
  if (kc !== null) {
    let text: string | null = null;
    try {
      text = kc.get(account);
    } catch {
      text = null;
    }
    const record = text === null ? null : decodeRecord(text);
    if (record !== null) return { record, backend: 'keychain' };
  }
  const body = readPrivateFile(rememberFile());
  if (body === null) return null;
  try {
    const doc = JSON.parse(body) as Record<string, unknown>;
    const text = doc.v === 1 && doc.account === account && typeof doc.record === 'string' ? doc.record : null;
    const record = text === null ? null : decodeRecord(text);
    return record === null ? null : { record, backend: 'file' };
  } catch {
    return null;
  }
}

/**
 * Store the DEK. `keychain` refuses (KEYCHAIN_UNAVAILABLE) when there is no
 * OS keychain; `file` is the explicit opt-in.
 */
export function saveRemembered(account: string, record: RememberRecord, backend: RememberBackend): void {
  const secret = encodeRecord(record);
  if (backend === 'keychain') {
    const kc = keychain();
    if (kc === null) {
      throw new VaultError(
        'No OS keychain is available here (Linux needs secret-tool and a D-Bus session). ' +
          'Type the passphrase each time, or pass --remember-file to keep the vault key in a 0600 file (anyone who can read that file can decrypt your keys).',
        'KEYCHAIN_UNAVAILABLE',
        2,
      );
    }
    kc.set(account, secret);
    return;
  }
  writePrivateFile(rememberFile(), `${JSON.stringify({ v: 1, account, record: secret })}\n`);
}

/** Forget on this device: every backend, best effort. */
export function forgetRemembered(account: string): void {
  try {
    keychain()?.remove(account);
  } catch {
    /* nothing stored */
  }
  rmSync(rememberFile(), { force: true });
}
