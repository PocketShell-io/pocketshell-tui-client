/** Open the right Connection for a saved host. */
import type { HostEntry } from '../hosts/store.js';
import { openGatewayConnection } from './gateway.js';
import { LocalConnection } from './local.js';
import { openSshConnection } from './ssh.js';
import { ConnectionError, type Connection } from './types.js';
import { vaultCredentialFor } from '../vault/session.js';

/**
 * A host bound to a key-vault key connects with that key, held in memory
 * (src/vault); everything else keeps the user's own key resolution.
 */
export async function openConnection(host: HostEntry): Promise<Connection> {
  if (host.mode === 'local') return new LocalConnection(host.name);
  if (host.mode === 'ssh' && !host.ssh) throw new ConnectionError(`host ${host.name} has no ssh settings`, 'BAD_HOST', 2);
  if (host.mode === 'gateway' && !host.gateway) throw new ConnectionError(`host ${host.name} has no gateway settings`, 'BAD_HOST', 2);
  const vault = (await vaultCredentialFor(host)) ?? undefined;
  try {
    return host.mode === 'ssh' ? await openSshConnection(host.name, host.ssh!, vault) : await openGatewayConnection(host.name, host.gateway!, vault);
  } catch (error) {
    await vault?.credential.close();
    throw error;
  }
}

export * from './types.js';
