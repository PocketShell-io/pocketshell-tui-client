/** SSH mode: OpenSSH with a multiplexed master per host. (Being implemented.) */
import type { SshHostConfig } from '../hosts/store.js';
import { ConnectionError, type Connection } from './types.js';

export async function openSshConnection(hostName: string, _config: SshHostConfig): Promise<Connection> {
  throw new ConnectionError(`ssh mode is not implemented yet (host ${hostName})`, 'UNSUPPORTED', 2);
}
