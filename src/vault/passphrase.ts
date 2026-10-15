/**
 * Where the vault passphrase comes from: an inherited file descriptor named
 * by PSC_VAULT_PASSPHRASE_FD (the variable holds only the fd NUMBER, never
 * the secret), or a no-echo prompt on the terminal. Never argv, never an
 * environment variable holding the passphrase.
 */
import { closeSync, readFileSync } from 'node:fs';
import { VaultError } from './format.js';

export const PASSPHRASE_FD_ENV = 'PSC_VAULT_PASSPHRASE_FD';
const MAX_PASSPHRASE = 4096;

/** The fd number from PSC_VAULT_PASSPHRASE_FD, or null when unset. */
export function passphraseFd(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env[PASSPHRASE_FD_ENV];
  if (raw === undefined || raw === '') return null;
  if (!/^\d{1,4}$/.test(raw) || raw === '1' || raw === '2') {
    throw new VaultError(`${PASSPHRASE_FD_ENV} must name an open file descriptor (not 1 or 2), got ${JSON.stringify(raw.slice(0, 16))}`, 'USAGE', 2);
  }
  return Number(raw);
}

/** Read the passphrase from `fd` once (to EOF), dropping one trailing newline. */
export function readPassphraseFd(fd: number): string {
  let bytes: Buffer;
  try {
    bytes = readFileSync(fd);
  } catch {
    throw new VaultError(`could not read the passphrase from fd ${fd} (${PASSPHRASE_FD_ENV})`, 'USAGE', 2);
  } finally {
    if (fd > 2) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
  if (bytes.length > MAX_PASSPHRASE) throw new VaultError('the passphrase is too long', 'USAGE', 2);
  const text = bytes.toString('utf8').replace(/\r?\n$/, '');
  bytes.fill(0);
  if (text.length === 0) throw new VaultError(`fd ${fd} (${PASSPHRASE_FD_ENV}) gave an empty passphrase`, 'USAGE', 2);
  return text;
}

export function canPrompt(): boolean {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

/** No-echo terminal prompt. Ctrl+C / Ctrl+D cancel (VAULT_CANCELLED, exit 130). */
export function promptPassphrase(prompt = 'Vault passphrase: '): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) return Promise.reject(new VaultError('no terminal to ask for the vault passphrase', 'VAULT_LOCKED', 3));
  return new Promise((resolve, reject) => {
    process.stderr.write(prompt);
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();
    let value = '';
    const finish = (error: VaultError | null): void => {
      input.off('data', onData);
      input.setRawMode(wasRaw);
      input.pause();
      process.stderr.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer): void => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') return finish(null);
        if (ch === '\u0003' || ch === '\u0004') return finish(new VaultError('Unlock cancelled.', 'CANCELLED', 130));
        if (ch === '\u007f' || ch === '\b') value = [...value].slice(0, -1).join('');
        else if (ch === '\u0015') value = '';
        else if (ch >= ' ' && value.length < MAX_PASSPHRASE) value += ch;
      }
    };
    input.on('data', onData);
  });
}
