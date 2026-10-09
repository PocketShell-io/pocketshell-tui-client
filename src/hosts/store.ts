/**
 * The client's saved hosts: `~/.config/pocketshell-client/hosts.json`.
 *
 * One entry per host, each with exactly one connection mode. The built-in
 * `local` host (this machine, local mode) always exists and is never
 * stored, so a fresh install can be used before anything is configured.
 */
import { nativeRead, nativeWrite } from '../platform/windows.js';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { hostsFile } from '../paths.js';
import type { HostMode } from '../transport/types.js';
import { validateNativeWindowsPolicy, type NativeWindowsCliPolicy } from '../nativeWindowsHost.js';

export const LOCAL_HOST_NAME = 'local';

export interface SshHostConfig {
  /** Anything `ssh` accepts as a destination: an ~/.ssh/config alias, `host`, `user@host`. */
  destination: string;
  port?: number;
  user?: string;
  identityFile?: string;
}

export interface GatewayHostConfig {
  /** The enrolled device id (`pocketshell gateway enroll` on the host). */
  deviceId: string;
  /** SSH login name on the host. */
  user?: string;
  identityFile?: string;
  /** Gateway origin, `wss://host[:port]`; default is production. */
  server?: string;
}

export interface HostEntry {
  name: string;
  mode: HostMode;
  ssh?: SshHostConfig;
  gateway?: GatewayHostConfig;
  /** Path of the `pocketshell` binary on the host; default `pocketshell` on PATH. */
  binary?: string;
  /** Trusted local provisioning, bound to the gateway ID and accepted SSH shell transport. */
  nativeWindowsCli?: NativeWindowsCliPolicy;
}

interface HostsFileShape {
  version: 1;
  default?: string;
  hosts: HostEntry[];
}

export class HostStoreError extends Error {
  readonly code = 'HOST_STORE';
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function validateHostName(name: string): string {
  if (!NAME_RE.test(name)) {
    throw new HostStoreError(
      `invalid host name ${JSON.stringify(name)}: use 1-64 of [A-Za-z0-9._-], starting with a letter or digit`,
    );
  }
  return name;
}

const BINARY_RE = /^[A-Za-z0-9_./~+-]+$/;
// Same rule as the gateway endpoint's DEVICE_ID_RE (kept local: hosts/ must not import the gateway stack).
const DEVICE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$/;
const CONTROL_OR_SPACE = /[\s\x00-\x1f\x7f]/;

/**
 * The host-side `pocketshell` path is spliced into shell command lines as
 * one bare word (so `~/.local/bin/pocketshell` still expands): only path
 * characters, never whitespace or shell syntax, never a leading `-`.
 */
export function validateBinary(binary: string): string {
  if (!BINARY_RE.test(binary) || binary.startsWith('-')) {
    throw new HostStoreError(
      `invalid --binary ${JSON.stringify(binary)}: use a plain path of [A-Za-z0-9_./~+-] (no spaces or shell syntax)`,
    );
  }
  return binary;
}

/** An ssh destination: no leading `-` (option injection), no whitespace or controls. */
export function validateSshDestination(destination: string): string {
  if (!destination || destination.startsWith('-') || CONTROL_OR_SPACE.test(destination)) {
    throw new HostStoreError(
      `invalid ssh destination ${JSON.stringify(destination)}: it must not be empty, start with '-', or contain whitespace/control characters`,
    );
  }
  return destination;
}

export function validateGatewayDeviceId(deviceId: string): string {
  if (!DEVICE_ID_RE.test(deviceId)) {
    throw new HostStoreError(
      `invalid gateway device id ${JSON.stringify(deviceId)}: 3-64 of [A-Za-z0-9._:-], starting with a letter or digit`,
    );
  }
  return deviceId;
}

/** Everything `addHost` checks about an entry before saving it. */
export function validateHostEntry(entry: HostEntry): HostEntry {
  validateHostName(entry.name);
  if (entry.nativeWindowsCli !== undefined) {
    let policy: NativeWindowsCliPolicy;
    try { policy = validateNativeWindowsPolicy(entry.nativeWindowsCli); }
    catch (error) { throw new HostStoreError(`host ${entry.name}: ${(error as Error).message}`); }
    if (entry.mode !== 'gateway' || !entry.gateway || policy.deviceId !== entry.gateway.deviceId
      || entry.binary !== undefined) {
      throw new HostStoreError(`host ${entry.name}: native policy must match its gateway device ID, and cannot coexist with --binary or a direct/local host`);
    }
  }
  if (entry.binary !== undefined) validateBinary(entry.binary);
  if (entry.mode === 'ssh') {
    if (!entry.ssh) throw new HostStoreError(`host ${entry.name}: ssh mode needs ssh settings`);
    validateSshDestination(entry.ssh.destination);
    if (entry.ssh.user !== undefined && (entry.ssh.user.startsWith('-') || CONTROL_OR_SPACE.test(entry.ssh.user) || !entry.ssh.user)) {
      throw new HostStoreError(`invalid ssh user ${JSON.stringify(entry.ssh.user)}`);
    }
  } else if (entry.mode === 'gateway') {
    if (!entry.gateway) throw new HostStoreError(`host ${entry.name}: gateway mode needs gateway settings`);
    validateGatewayDeviceId(entry.gateway.deviceId);
  }
  return entry;
}

export function localHost(): HostEntry {
  return { name: LOCAL_HOST_NAME, mode: 'local' };
}

function read(): HostsFileShape {
  let raw: string;
  try {
    if (process.platform === 'win32') {
      const b=nativeRead(dirname(hostsFile()), 'hosts'); if (b===null) return {version:1,hosts:[]}; raw=b.toString('utf8');
    } else raw = readFileSync(hostsFile(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, hosts: [] };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HostStoreError(`${hostsFile()} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as HostsFileShape).hosts)) {
    throw new HostStoreError(`${hostsFile()} has an unexpected shape`);
  }
  return parsed as HostsFileShape;
}

function write(data: HostsFileShape): void {
  const file = hostsFile();
  if (process.platform === 'win32') { nativeWrite(dirname(file),'hosts',Buffer.from(`${JSON.stringify(data,null,2)}\n`)); return; }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** Every host, the built-in `local` first. */
export function listHosts(): HostEntry[] {
  return [localHost(), ...read().hosts];
}

export function defaultHostName(): string | null {
  return read().default ?? null;
}

export function getHost(name: string): HostEntry {
  if (name === LOCAL_HOST_NAME) return localHost();
  const host = read().hosts.find((entry) => entry.name === name);
  if (!host) throw new HostStoreError(`no saved host named ${JSON.stringify(name)} (see \`hosts list\`)`);
  if (host.nativeWindowsCli !== undefined) validateHostEntry(host);
  return host;
}

export function addHost(entry: HostEntry, options: { replace?: boolean } = {}): HostEntry {
  validateHostEntry(entry);
  if (entry.name === LOCAL_HOST_NAME) throw new HostStoreError('`local` is built in and cannot be replaced');
  const data = read();
  const index = data.hosts.findIndex((host) => host.name === entry.name);
  if (index >= 0 && !options.replace) {
    throw new HostStoreError(`host ${JSON.stringify(entry.name)} already exists (pass --replace to overwrite)`);
  }
  if (index >= 0) data.hosts[index] = entry;
  else data.hosts.push(entry);
  write(data);
  return entry;
}

export function removeHost(name: string): boolean {
  const data = read();
  const before = data.hosts.length;
  data.hosts = data.hosts.filter((host) => host.name !== name);
  if (data.default === name) delete data.default;
  write(data);
  return data.hosts.length !== before;
}

export function setDefaultHost(name: string | null): void {
  if (name !== null) getHost(name);
  const data = read();
  if (name === null) delete data.default;
  else data.default = name;
  write(data);
}
