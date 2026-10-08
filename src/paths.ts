/**
 * Where the client keeps its state.
 *
 * - `~/.config/pocketshell-client/` — this client's own files (hosts.json).
 * - `~/.config/pocketshell/` — SHARED with the `pocketshell` Python CLI:
 *   `credentials.json` (the device-login session) and `gateway_known_hosts`
 *   (gateway host-key pins). Same formats, so `pocketshell login` and
 *   `pocketshell-client login` are one login, and a pin made by either is
 *   honoured by both.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

export function configHome(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg && xdg.startsWith('/') ? xdg : join(homedir(), '.config');
}

export function clientConfigDir(): string {
  return join(configHome(), 'pocketshell-client');
}

export function sharedConfigDir(): string {
  return join(configHome(), 'pocketshell');
}

export function hostsFile(): string {
  return join(clientConfigDir(), 'hosts.json');
}

export function credentialsFile(): string {
  return join(sharedConfigDir(), 'credentials.json');
}

export function gatewayPinsFile(): string {
  return join(sharedConfigDir(), 'gateway_known_hosts');
}

/** Private per-user runtime dir for OpenSSH control sockets. */
export function runtimeDir(): string {
  const xdg = process.env.XDG_RUNTIME_DIR;
  const base = xdg && xdg.startsWith('/') ? xdg : join('/tmp', `pocketshell-client-${process.getuid?.() ?? 'u'}`);
  return xdg && xdg.startsWith('/') ? join(base, 'pocketshell-client') : base;
}
