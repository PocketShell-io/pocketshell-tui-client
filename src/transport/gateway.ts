/** Gateway mode: OpenSSH through the PocketShell gateway tunnel. (Being implemented.) */
import type { GatewayHostConfig } from '../hosts/store.js';
import { ConnectionError, type Connection } from './types.js';

export async function openGatewayConnection(hostName: string, _config: GatewayHostConfig): Promise<Connection> {
  throw new ConnectionError(`gateway mode is not implemented yet (host ${hostName})`, 'UNSUPPORTED', 2);
}
