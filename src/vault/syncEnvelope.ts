/**
 * Read-only decryption of the `main` settings-sync slot (the account host
 * list), same envelope as the web/desktop SyncCrypto:
 * `{v:1, kdf:"pbkdf2-sha256", iter, salt, iv, ct}` with standard base64 and
 * AES-256-GCM. psc only reads it, to match its own saved hosts to account
 * aliases (the vault index keys bindings by alias).
 */
import { pbkdf2, webcrypto } from 'node:crypto';
import { promisify } from 'node:util';
import { VaultError } from './format.js';

const pbkdf2Async = promisify(pbkdf2);

function b64(value: unknown): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw bad();
  return Buffer.from(value, 'base64');
}

function bad(): VaultError {
  return new VaultError('The account host list could not be read with the vault-held sync passphrase.', 'SYNC_UNREADABLE');
}

export async function decryptSyncEnvelope(envelope: string, passphrase: string): Promise<string> {
  let f: Record<string, unknown>;
  try {
    f = JSON.parse(envelope) as Record<string, unknown>;
  } catch {
    throw bad();
  }
  if (f.v !== 1 || f.kdf !== 'pbkdf2-sha256' || typeof f.iter !== 'number' || !Number.isInteger(f.iter) || f.iter < 1 || f.iter > 10_000_000) {
    throw bad();
  }
  const key = await pbkdf2Async(Buffer.from(passphrase, 'utf8'), b64(f.salt), f.iter, 32, 'sha256');
  try {
    const k = await webcrypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
    const pt = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(f.iv) }, k, b64(f.ct));
    return new TextDecoder().decode(pt);
  } catch {
    throw bad();
  } finally {
    key.fill(0);
  }
}

/** The bits of an account host psc can match on. */
export interface AccountHost {
  name: string;
  hostname?: string;
  user?: string;
  port?: number;
  deviceId?: string;
}

export function parseAccountHosts(plaintext: string): AccountHost[] {
  let doc: unknown;
  try {
    doc = JSON.parse(plaintext);
  } catch {
    throw bad();
  }
  const hosts = (doc as { hosts?: unknown })?.hosts;
  if (!Array.isArray(hosts)) throw bad();
  const out: AccountHost[] = [];
  for (const h of hosts) {
    if (typeof h !== 'object' || h === null) continue;
    const o = h as Record<string, unknown>;
    if (typeof o.name !== 'string' || o.name.length === 0) continue;
    const entry: AccountHost = { name: o.name };
    if (typeof o.hostname === 'string') entry.hostname = o.hostname;
    if (typeof o.user === 'string') entry.user = o.user;
    if (typeof o.port === 'number') entry.port = o.port;
    const gw = o.gateway as Record<string, unknown> | undefined;
    if (gw && typeof gw === 'object' && typeof gw.deviceId === 'string') entry.deviceId = gw.deviceId;
    out.push(entry);
  }
  return out;
}
