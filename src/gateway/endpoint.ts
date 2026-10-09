/**
 * Gateway endpoint rules (port of pocketshell/gateway/endpoint.py).
 *
 * - the device-id grammar the gateway enforces;
 * - the known_hosts alias a pin is stored under (identical to the Python
 *   CLI, so both clients share one pin file);
 * - strict resolution of a gateway origin: `wss://` by default, plain
 *   `ws://` only with insecure-dev to a loopback host, bare origin only.
 *
 * Deviation from Python: there is no `--trust-gateway HOST`. A
 * non-production gateway is only ever used when the user configured it
 * explicitly (a saved host's `server`, or `--server` on the command line),
 * which is the trust decision.
 */
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';

export const DEFAULT_SERVER = 'wss://gateway.pocketshell.io';
export const PRODUCTION_GATEWAY_HOSTS: ReadonlySet<string> = new Set(['gateway.pocketshell.io', 'relay.pocketshell.io']);
export const DEVICE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$/;
export const HOST_KEY_ALIAS_PREFIX = 'pocketshell-gateway.';

export class EndpointError extends Error {
  readonly code = 'USAGE';
  readonly exitCode = 2;
  constructor(message: string) {
    super(message);
    this.name = 'EndpointError';
  }
}

function asciiRepr(value: string, max = 80): string {
  return JSON.stringify(value).replace(/[^\x20-\x7e]/g, '?').slice(0, max);
}

export function validateDeviceId(deviceId: string): string {
  if (typeof deviceId !== 'string' || !DEVICE_ID_RE.test(deviceId)) {
    throw new EndpointError(
      `invalid device id ${asciiRepr(String(deviceId))}: expected 3-64 characters, letters/digits first, ` +
        "then letters, digits, '.', '_', ':' or '-'",
    );
  }
  return deviceId;
}

/** `pocketshell-gateway.<id lower-cased>-<sha256(id)[:12]>` (hex). */
export function hostKeyAlias(deviceId: string): string {
  validateDeviceId(deviceId);
  const digest = createHash('sha256').update(deviceId, 'ascii').digest('hex').slice(0, 12);
  return `${HOST_KEY_ALIAS_PREFIX}${deviceId.toLowerCase()}-${digest}`;
}

/** The pre-hash alias `pocketshell-gateway.<id>` (read-only migration). */
export function legacyHostKeyAlias(deviceId: string): string {
  return HOST_KEY_ALIAS_PREFIX + validateDeviceId(deviceId);
}

export function isProductionHost(host: string): boolean {
  return PRODUCTION_GATEWAY_HOSTS.has(host.trim().toLowerCase().replace(/\.+$/, ''));
}

const DNS_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const DNS_NAME_RE = new RegExp(`^${DNS_LABEL}(?:\\.${DNS_LABEL})*$`);

function canonicalIp(host: string): string | null {
  const kind = isIP(host);
  if (kind === 4) return /^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(host) ? host : null;
  if (kind === 6) {
    try {
      return new URL(`http://[${host}]/`).hostname.slice(1, -1);
    } catch {
      return null;
    }
  }
  return null;
}

/** Strict canonical host: an IP literal, or an IDNA-encoded DNS name. */
export function normalizeHost(raw: string): string {
  let host = raw.trim().replace(/\.+$/, '').toLowerCase();
  if (!host) throw new EndpointError('gateway host is empty');
  const ip = canonicalIp(host);
  if (ip) return ip;
  if (!/^[\x00-\x7f]*$/.test(host)) {
    const ascii = domainToASCII(host);
    if (!ascii) throw new EndpointError('gateway host is not a valid internationalized name');
    host = ascii.toLowerCase();
  }
  if (host.length > 253 || !DNS_NAME_RE.test(host)) {
    throw new EndpointError(`gateway host ${asciiRepr(host)} is not a valid DNS name or IP literal`);
  }
  return host;
}

function isLoopback(host: string): boolean {
  if (host === 'localhost') return true;
  if (isIP(host) === 4) return host.startsWith('127.');
  return host === '::1';
}

/** null = refused; '' = allowed silently; otherwise a warning to print. */
function devHostStatus(host: string): string | null {
  if (isProductionHost(host)) return null;
  if (isIP(host)) return isLoopback(host) ? '' : null;
  if (host === 'localhost') return '';
  if (!host.includes('.')) {
    return `warning: sending a gateway token in CLEARTEXT to docker host ${asciiRepr(host)} (--insecure-dev)`;
  }
  return null;
}

export interface GatewayEndpoint {
  /** e.g. wss://gateway.pocketshell.io (no trailing slash) */
  wsBase: string;
  /** e.g. https://gateway.pocketshell.io */
  httpBase: string;
  host: string;
  secure: boolean;
  isProduction: boolean;
  /** One-line notice for stderr, if any (cleartext to a docker host). */
  warning: string;
}

export function clientSshUrl(endpoint: GatewayEndpoint, deviceId: string): string {
  return `${endpoint.wsBase}/api/v1/hosts/${validateDeviceId(deviceId)}/ssh`;
}

export function devicesUrl(endpoint: GatewayEndpoint): string {
  return `${endpoint.httpBase}/identity/v1/devices`;
}

// Whitespace/controls, quotes, backslash, `%`, `?`, `#` and shell
// metacharacters: the origin is later embedded in a ProxyCommand.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_URL_CHARS = /[\x00-\x20\x7f-\x9f\\'"`$!%;|&<>(){}*?#^~,]/;
const URL_RE = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/]*)(.*)$/s;

/**
 * Resolve a gateway origin strictly. `server` undefined → production.
 * `ws://` / `http://` need `insecureDev` and a loopback literal or
 * `localhost`, or (with a cleartext warning) a single-label docker-compose
 * service name such as `gateway`, exactly as the Python CLI.
 */
export function resolveEndpoint(server: string | undefined, insecureDev = false): GatewayEndpoint {
  const value = server ?? DEFAULT_SERVER;
  if (!value.trim()) throw new EndpointError('--server must not be blank');
  if (FORBIDDEN_URL_CHARS.test(value)) {
    throw new EndpointError("--server contains whitespace, control, quote, '%', '?', '#', backslash or shell characters");
  }
  const m = URL_RE.exec(value);
  if (!m) throw new EndpointError(`--server ${asciiRepr(value)} is not a valid URL (expected wss://host[:port])`);
  const [, rawScheme, authority, path] = m as unknown as [string, string, string, string];
  const scheme = rawScheme.toLowerCase();
  if (authority.includes('@')) throw new EndpointError('--server must not contain credentials');
  if (path !== '' && path !== '/') {
    throw new EndpointError('--server must be a bare origin like wss://gateway.example (no path, query or fragment)');
  }
  let hostPart: string;
  let portPart: string | undefined;
  const v6 = /^\[([^\]]*)\](?::(.*))?$/.exec(authority);
  if (v6) {
    hostPart = v6[1]!;
    portPart = v6[2];
    if (isIP(hostPart) !== 6) throw new EndpointError(`--server ${asciiRepr(value)} has a malformed IPv6 literal`);
  } else {
    if (authority.includes('[') || authority.includes(']')) {
      throw new EndpointError(`--server ${asciiRepr(value)} is not a valid URL`);
    }
    const idx = authority.lastIndexOf(':');
    hostPart = idx >= 0 ? authority.slice(0, idx) : authority;
    portPart = idx >= 0 ? authority.slice(idx + 1) : undefined;
  }
  if (!hostPart) throw new EndpointError(`--server ${asciiRepr(value)} has no host`);
  let port: number | undefined;
  if (portPart !== undefined && portPart !== '') {
    if (!/^[0-9]{1,5}$/.test(portPart) || Number(portPart) > 65535) {
      throw new EndpointError(`--server ${asciiRepr(value)} has an invalid port`);
    }
    port = Number(portPart);
  }
  const host = normalizeHost(hostPart);
  let secure: boolean;
  let warning = '';
  if (scheme === 'wss' || scheme === 'https') secure = true;
  else if (scheme === 'ws' || scheme === 'http') {
    secure = false;
    if (!insecureDev) {
      throw new EndpointError('plain ws:// / http:// gateway URLs require --insecure-dev (local development only)');
    }
    const status = devHostStatus(host);
    if (status === null) {
      throw new EndpointError(
        `--insecure-dev only allows plain ws:// to a loopback address, localhost or a single-label docker host, ` +
          `not ${asciiRepr(host)}: the gateway token must never cross a network in cleartext`,
      );
    }
    warning = status;
  } else {
    throw new EndpointError(`--server scheme ${asciiRepr(rawScheme)} is not supported (use wss://)`);
  }
  const netlocHost = host.includes(':') ? `[${host}]` : host;
  const netloc = port === undefined ? netlocHost : `${netlocHost}:${port}`;
  return {
    wsBase: `${secure ? 'wss' : 'ws'}://${netloc}`,
    httpBase: `${secure ? 'https' : 'http'}://${netloc}`,
    host,
    secure,
    isProduction: secure && isProductionHost(host),
    warning,
  };
}
