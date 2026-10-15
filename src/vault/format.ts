/**
 * psc-side vault error type and small shared shapes. The vault format and
 * crypto live in `@pocketshell/core` (keyVault); nothing here parses or
 * decrypts vault data.
 */
export type { GatewayAuthPolicy as GatewayAuth, VaultSecret } from '@pocketshell/core';

export class VaultError extends Error {
  constructor(
    message: string,
    /** VAULT_ABSENT, VAULT_LOCKED, VAULT_WRONG_PASSPHRASE, VAULT_RESET, VAULT_KEY_MISSING, KEYCHAIN_UNAVAILABLE, ... */
    readonly code: string,
    readonly exitCode = 1,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'VaultError';
  }
}

const KEY_ID_RE = /^[A-Za-z0-9_-]{22}$/;

/** A vault key id: base64url of 16 bytes. */
export function isKeyId(value: unknown): value is string {
  return typeof value === 'string' && KEY_ID_RE.test(value);
}
