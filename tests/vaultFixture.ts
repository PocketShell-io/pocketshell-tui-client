/**
 * Test fixtures for the key vault: a vault created by core's KeyVaultStore
 * (cheap Argon2id: 32 MiB, t=1) over an in-memory slot server, throwaway SSH
 * keys generated per run, and a fake phase-2 verifier. No real secrets.
 */
import { spawnSync } from 'node:child_process';
import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KeyVaultStore,
  parseVaultHeader,
  type GatewayAuthPolicy,
  type VaultKdfParams,
  type VaultServerVerifier,
  type VaultSlotPullResult,
  type VaultSlotTransport,
} from '@pocketshell/core';

/** A fresh unencrypted OpenSSH key from ssh-keygen (into a private temp dir, never ~/.ssh). */
export function sshKeygen(type: 'ed25519' | 'rsa' | 'ecdsa', bits?: number): { pem: string; publicLine: string } {
  const dir = mkdtempSync(join(tmpdir(), 'psc-vault-key-'));
  try {
    const file = join(dir, 'k');
    const args = ['-q', '-t', type, '-N', '', '-C', `throwaway-${type}`, '-f', file];
    if (bits) args.push('-b', String(bits));
    const r = spawnSync('ssh-keygen', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.status !== 0) throw new Error(`ssh-keygen failed: ${r.stderr}`);
    return { pem: readFileSync(file, 'utf8'), publicLine: readFileSync(`${file}.pub`, 'utf8').trim() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const TEST_KDF_COST = { m: 32 * 1024, t: 3, p: 1 };

/** Writable in-memory settings API (the web's side, for building fixtures). */
export class SlotServer implements VaultSlotTransport {
  readonly slots = new Map<string, { version: number; data: string }>();
  async pull(slot: string): Promise<VaultSlotPullResult> {
    const s = this.slots.get(slot);
    return s ? { kind: 'ok', version: s.version, data: s.data } : { kind: 'absent' };
  }
  async push(slot: string, data: string, baseVersion: number) {
    const current = this.slots.get(slot)?.version ?? 0;
    if (baseVersion !== current) return { kind: 'conflict' as const, currentVersion: current };
    this.slots.set(slot, { version: current + 1, data });
    return { kind: 'ok' as const, version: current + 1 };
  }
  async delete(slot: string): Promise<void> {
    this.slots.delete(slot);
  }
  async list() {
    return [...this.slots].map(([slot, { version }]) => ({ slot, version }));
  }
  data(): Map<string, string> {
    return new Map([...this.slots].map(([k, v]) => [k, v.data]));
  }
}

export interface BuiltVault {
  slots: Map<string, string>;
  vaultId: string;
  epoch: number;
  kdf: VaultKdfParams;
  /** AUTH, for the fake verifier. */
  auth: Uint8Array;
  keyIds: Record<string, string>;
}

/** Build a vault the way the web does: create, add keys/passwords, bind hosts. */
export async function buildVault(options: {
  passphrase: string;
  keys?: Array<{ name: string; pem: string }>;
  passwords?: Array<{ name: string; password: string }>;
  hosts?: Record<string, { key: string; gatewayAuth: GatewayAuthPolicy }>;
  syncPassphrase?: string;
}): Promise<BuiltVault> {
  const server = new SlotServer();
  const store = new KeyVaultStore({ transport: server, kdf: TEST_KDF_COST });
  const created = await store.createVault(options.passphrase, { syncPassphrase: options.syncPassphrase ?? null });
  if (created.kind !== 'ok') throw new Error(`createVault: ${JSON.stringify(created)}`);
  const keyIds: Record<string, string> = {};
  for (const k of options.keys ?? []) {
    const added = await store.addKey(k.pem, k.name);
    if (added.kind !== 'ok') throw new Error(`addKey: ${JSON.stringify(added)}`);
    keyIds[k.name] = added.entry.keyId;
  }
  for (const p of options.passwords ?? []) {
    const added = await store.addPassword(p.password, p.name);
    if (added.kind !== 'ok') throw new Error(`addPassword: ${JSON.stringify(added)}`);
    keyIds[p.name] = added.entry.keyId;
  }
  for (const [alias, b] of Object.entries(options.hosts ?? {})) {
    const bound = await store.bindHost(alias, keyIds[b.key]!, b.gatewayAuth);
    if (bound.kind !== 'ok') throw new Error(`bindHost: ${JSON.stringify(bound)}`);
  }
  const record = store.exportRememberRecord()!;
  const header = parseVaultHeader(server.slots.get('vault')!.data)!;
  store.lock();
  return { slots: server.data(), vaultId: record.vaultId, epoch: record.epoch, kdf: header.kdf, auth: record.auth!, keyIds };
}

/** The web/desktop sync envelope (PBKDF2-SHA256 + AES-GCM, standard base64), cheap iterations. */
export function syncEnvelope(plaintext: string, passphrase: string, iter = 1000): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = pbkdf2Sync(passphrase, salt, iter, 32, 'sha256');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return JSON.stringify({ v: 1, kdf: 'pbkdf2-sha256', iter, salt: salt.toString('base64'), iv: iv.toString('base64'), ct: ct.toString('base64') });
}

/** psc's read-only view of `slots`, recording every pull; `gated()` hides vault slots until a verify. */
export function memoryTransport(slots: Map<string, string>, options: { gated?: () => boolean } = {}): VaultSlotTransport & { pulls: string[] } {
  const pulls: string[] = [];
  return {
    pulls,
    async pull(slot) {
      pulls.push(slot);
      if (options.gated?.() && (slot === 'vault' || slot.startsWith('vk-'))) return { kind: 'gated' };
      const data = slots.get(slot);
      return data === undefined ? { kind: 'absent' } : { kind: 'ok', version: 1, data };
    },
    push: async () => ({ kind: 'error', message: 'read-only' }),
    delete: async () => {
      throw new Error('read-only');
    },
    list: async () => {
      throw new Error('read-only');
    },
  };
}

/** A phase-2 verifier comparing AUTH to `expected`, with W2's 5-failure lockout. */
export function fakeVerifier(expected: Uint8Array, kdf?: VaultKdfParams): VaultServerVerifier & { verified: boolean; calls: number } {
  let failures = 0;
  const v = {
    verified: false,
    calls: 0,
    async verify(auth: Uint8Array) {
      v.calls++;
      if (failures >= 5) return { kind: 'locked' as const, retryAfterMs: 900_000 };
      if (Buffer.from(auth).equals(Buffer.from(expected))) {
        failures = 0;
        v.verified = true;
        return { kind: 'ok' as const };
      }
      failures++;
      return { kind: 'wrong' as const, retryAfterMs: 0 };
    },
    async status() {
      return { kind: 'ok' as const, epoch: 1, hasVerifier: true, retryAfterMs: 0, ...(kdf ? { kdf } : {}) };
    },
    async setVerifier() {
      return { kind: 'unavailable' as const };
    },
  };
  return v;
}

export const unavailableVerifier: VaultServerVerifier = {
  verify: async () => ({ kind: 'unavailable' }),
  setVerifier: async () => ({ kind: 'unavailable' }),
};
