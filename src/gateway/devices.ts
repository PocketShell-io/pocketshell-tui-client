/**
 * `gateway devices`: list the account's enrolled hosts (port of devices.py).
 *
 * `GET <https base>/identity/v1/devices` with the broker JWT as a Bearer
 * header (never in the URL). Redirects are never followed (that would
 * re-send the header), no environment proxy, TLS verification on, the body
 * is capped and strictly parsed. Everything in the answer is untrusted
 * display data: ids are re-validated, the advertised host key is shown only
 * as an *advertised* fingerprint and never becomes a pin.
 */
import { request as httpRequest, Agent as HttpAgent } from 'node:http';
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import { DEVICE_ID_RE, devicesUrl, type GatewayEndpoint } from './endpoint.js';
import { parseHostKey, type HostKey } from './pins.js';
import { isPlainObject, parseStrictJson, sanitizeRemoteText } from './text.js';

export const HTTP_TIMEOUT_MS = 15_000;
export const MAX_RESPONSE_BYTES = 64 * 1024;
export const MAX_DEVICES = 1000;

export class DevicesError extends Error {
  readonly code = 'GATEWAY_DEVICES';
  readonly exitCode = 4;
  constructor(message: string) {
    super(message);
    this.name = 'DevicesError';
  }
}

export interface DeviceInfo {
  /** Raw from the gateway; print `displayId`. */
  id: string;
  idValid: boolean;
  displayId: string;
  revoked: boolean;
  advertisedKey: HostKey | null;
}

export function parseDevices(body: Buffer): DeviceInfo[] {
  let doc;
  try {
    doc = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    throw new DevicesError('gateway returned a malformed device list');
  }
  const devices = isPlainObject(doc) ? doc.devices : undefined;
  if (!Array.isArray(devices)) throw new DevicesError('gateway returned a malformed device list');
  if (devices.length > MAX_DEVICES) throw new DevicesError('gateway returned too many devices');
  return devices.map((item) => {
    if (!isPlainObject(item)) throw new DevicesError('gateway returned a malformed device entry');
    for (const [name, kind] of [
      ['id', 'string'],
      ['account_id', 'string'],
      ['public_key', 'string'],
      ['ssh_host_key', 'string'],
      ['revoked', 'boolean'],
    ] as const) {
      if (typeof item[name] !== kind) {
        throw new DevicesError(`gateway returned a device entry with a missing or mistyped '${name}'`);
      }
    }
    const id = item.id as string;
    const idValid = DEVICE_ID_RE.test(id);
    let advertisedKey: HostKey | null = null;
    try {
      advertisedKey = item.ssh_host_key ? parseHostKey(item.ssh_host_key as string) : null;
    } catch {
      advertisedKey = null;
    }
    return { id, idValid, displayId: idValid ? id : sanitizeRemoteText(id, 64), revoked: item.revoked as boolean, advertisedKey };
  });
}

const STATUS_REASON: Record<number, string> = {
  401: 'the gateway rejected the token (try `pocketshell-tui-client login` again)',
  403: 'the gateway refused the request',
  404: 'this gateway does not serve the device listing',
  429: 'the gateway is rate limiting requests; retry later',
};

/** GET the device list with `token`; strictly parsed. */
export function fetchDevices(endpoint: GatewayEndpoint, token: string, timeoutMs = HTTP_TIMEOUT_MS): Promise<DeviceInfo[]> {
  const url = new URL(devicesUrl(endpoint));
  const request = endpoint.secure ? httpsRequest : httpRequest;
  const agent = endpoint.secure ? new HttpsAgent({ keepAlive: false }) : new HttpAgent({ keepAlive: false });
  return new Promise<DeviceInfo[]>((resolve, reject) => {
    let settled = false;
    const done = (error: Error | null, value?: DeviceInfo[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      agent.destroy();
      if (error) reject(error);
      else resolve(value!);
    };
    const req = request(
      url,
      {
        method: 'GET',
        agent,
        rejectUnauthorized: true,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'pocketshell-tui-client' },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          done(new DevicesError('the gateway answered with a redirect, which is not followed'));
          return;
        }
        if (status !== 200) {
          res.resume();
          done(new DevicesError(STATUS_REASON[status] ?? `the gateway answered HTTP ${status}`));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_RESPONSE_BYTES) {
            done(new DevicesError('gateway device list is too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          try {
            done(null, parseDevices(Buffer.concat(chunks)));
          } catch (error) {
            done(error as Error);
          }
        });
        res.on('error', () => done(new DevicesError('malformed HTTP response from the gateway')));
      },
    );
    const timer = setTimeout(() => done(new DevicesError(`timed out talking to ${endpoint.httpBase}`)), timeoutMs);
    req.on('error', (error: Error & { code?: string }) => {
      const detail = sanitizeRemoteText(error.code && /CERT|TLS|SSL/.test(error.code) ? `TLS failure (${error.code})` : error.message);
      done(new DevicesError(`cannot reach ${endpoint.httpBase}: ${detail}`));
    });
    req.end();
  });
}
