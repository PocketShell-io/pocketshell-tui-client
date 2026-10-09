/** Open the right Connection for a saved host. */
import type { HostEntry } from '../hosts/store.js';
import { openGatewayConnection } from './gateway.js';
import { LocalConnection } from './local.js';
import { openSshConnection } from './ssh.js';
import { ConnectionError, type Connection } from './types.js';

export async function openConnection(host: HostEntry): Promise<Connection> {
  switch (host.mode) {
    case 'local':
      return new LocalConnection(host.name);
    case 'ssh':
      if (!host.ssh) throw new ConnectionError(`host ${host.name} has no ssh settings`, 'BAD_HOST', 2);
      return openSshConnection(host.name, host.ssh);
    case 'gateway':
      if (!host.gateway) throw new ConnectionError(`host ${host.name} has no gateway settings`, 'BAD_HOST', 2);
      return openGatewayConnection(host.name, host.gateway);
  }
}

export * from './types.js';
