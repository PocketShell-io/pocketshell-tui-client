/**
 * The exact password prompt OpenSSH shows for a host:
 * `<user>@<host>'s password: `, where host is the HostKeyAlias if set, else
 * the resolved HostName (sshconnect2.c userauth_passwd). Resolved with
 * `ssh -G`, so ~/.ssh/config aliases, User and HostName apply exactly as
 * they will for the real connection.
 */
import { execFile } from 'node:child_process';
import type { SshHostConfig } from '../hosts/store.js';
import { findSsh, validateArgValue, validateDestination } from '../transport/openssh.js';
import { VaultError } from './format.js';

export function parseSshG(output: string): { user: string | null; hostname: string | null; hostkeyalias: string | null } {
  const out = { user: null as string | null, hostname: null as string | null, hostkeyalias: null as string | null };
  for (const line of output.split('\n')) {
    const [key, ...rest] = line.trim().split(' ');
    const value = rest.join(' ');
    if (key === 'user' || key === 'hostname' || key === 'hostkeyalias') out[key] = value || null;
  }
  return out;
}

export function expectedPasswordPrompt(config: SshHostConfig): Promise<string> {
  const argv = ['-G'];
  if (config.port !== undefined) argv.push('-p', String(config.port));
  if (config.user !== undefined) argv.push('-l', validateArgValue('ssh user', config.user));
  argv.push('--', validateDestination(config.destination));
  return new Promise((resolve, reject) => {
    execFile(findSsh(), argv, { timeout: 10_000, maxBuffer: 1 << 20 }, (error, stdout) => {
      const g = error ? null : parseSshG(stdout);
      const host = g?.hostkeyalias && g.hostkeyalias !== 'none' ? g.hostkeyalias : g?.hostname;
      if (!g?.user || !host) {
        reject(new VaultError('could not resolve the ssh user and host for the vault password prompt', 'VAULT_PASSWORD_UNSUPPORTED', 2));
        return;
      }
      resolve(`${g.user}@${host}'s password: `);
    });
  });
}
