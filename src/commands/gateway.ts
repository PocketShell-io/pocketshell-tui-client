/**
 * `gateway devices|pin|unpin|proxy`: the gateway client side.
 *
 * Flow: `pocketshell-client login` → `gateway devices` → `gateway pin <id>`
 * (key from the host, out of band: `pocketshell gateway show --host-key`)
 * → `hosts add <name> --gateway <id> -l <user>`. Pins live in the file the
 * Python CLI uses, so a pin made by either client is honoured by both.
 */
import { createInterface } from 'node:readline';
import type { Command } from 'commander';
import { mintGatewayToken } from '../account/index.js';
import { fetchDevices, type DeviceInfo } from '../gateway/devices.js';
import { DEFAULT_SERVER, EndpointError, resolveEndpoint, validateDeviceId, type GatewayEndpoint } from '../gateway/endpoint.js';
import {
  addPin,
  fingerprint,
  keyLabel,
  loadPins,
  parseHostKey,
  PinError,
  pinFilePath,
  removePin,
  type HostKey,
} from '../gateway/pins.js';
import { markerLine, recordStatus, runProxy } from '../gateway/proxy.js';
import { emit, note, setJsonMode } from '../output.js';
import { action, jsonOption } from './common.js';

const MAX_PIN_INPUT_BYTES = 16384;

function endpointFrom(opts: { server?: string; insecureDev?: boolean }): GatewayEndpoint {
  const endpoint = resolveEndpoint(opts.server, Boolean(opts.insecureDev));
  if (endpoint.warning) process.stderr.write(`${endpoint.warning}\n`);
  return endpoint;
}

function serverOptions(command: Command): Command {
  return command
    .option('--server <origin>', `gateway origin, wss://host[:port] (default: ${DEFAULT_SERVER})`)
    .option('--insecure-dev', 'DEV ONLY: allow plain ws:// to a loopback or single-label docker host');
}

async function readStdin(limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buf.length;
    if (total > limit) throw new PinError('host key input is too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** One host-key line from an interactive prompt (TTY) or from stdin. */
async function readHostKeyInput(): Promise<string> {
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      return await new Promise<string>((resolve) =>
        rl.question('Paste the host key line printed by `pocketshell gateway show --host-key` ON THE HOST:\n', resolve),
      );
    } finally {
      rl.close();
    }
  }
  let data = await readStdin(MAX_PIN_INPUT_BYTES);
  if (data.endsWith('\r\n')) data = data.slice(0, -2);
  else if (data.endsWith('\n')) data = data.slice(0, -1);
  return data;
}

function describeKey(key: HostKey): { fingerprint: string; type: string } {
  return { fingerprint: fingerprint(key), type: keyLabel(key) };
}

export function registerGateway(program: Command): void {
  const gateway = program
    .command('gateway')
    .description('gateway devices, host-key pins, and the ssh proxy (pins are shared with the `pocketshell` CLI)');

  jsonOption(serverOptions(gateway.command('devices').description('list the hosts enrolled under your account'))).action(
    action(async (opts: { json?: boolean; server?: string; insecureDev?: boolean }) => {
      if (opts.json) setJsonMode(true);
      const endpoint = endpointFrom(opts);
      const token = await mintGatewayToken();
      const listed = await fetchDevices(endpoint, token);
      let pins = new Map<string, HostKey>();
      try {
        pins = loadPins();
      } catch (error) {
        note(`warning: ignoring pin file: ${(error as Error).message}`);
      }
      const pinState = (dev: DeviceInfo): { fp: string | null; state: string } => {
        const pinned = dev.idValid ? pins.get(dev.id) : undefined;
        if (!pinned) return { fp: null, state: 'not pinned' };
        const same =
          !dev.advertisedKey ||
          (dev.advertisedKey.keyType === pinned.keyType && dev.advertisedKey.blobB64 === pinned.blobB64);
        return { fp: fingerprint(pinned), state: same ? 'pinned' : 'pinned (DIFFERS from advertised)' };
      };
      // Fingerprints only, never the advertised key line: piping `devices
      // --json` into `gateway pin` must not turn the gateway's claim into trust.
      const rows = listed.map((dev) => ({
        id: dev.idValid ? dev.id : dev.displayId,
        id_valid: dev.idValid,
        revoked: dev.revoked,
        advertised_fingerprint: dev.advertisedKey ? fingerprint(dev.advertisedKey) : null,
        pinned_fingerprint: pinState(dev).fp,
        pin_state: pinState(dev).state,
      }));
      emit({ ok: true, gateway: endpoint.host, devices: rows }, () => {
        if (!listed.length) return 'no devices enrolled under this account';
        const table: string[][] = [['DEVICE', 'STATE', 'ADVERTISED HOST KEY (UNTRUSTED)', 'LOCAL PIN']];
        listed.forEach((dev, i) => {
          const advertised = dev.advertisedKey ? `${fingerprint(dev.advertisedKey)} (${keyLabel(dev.advertisedKey)})` : '-';
          let state = dev.revoked ? 'revoked' : 'active';
          if (!dev.idValid) state += ', invalid id';
          table.push([dev.displayId, state, advertised, rows[i]!.pin_state]);
        });
        const widths = [0, 1, 2].map((c) => Math.max(...table.map((r) => r[c]!.length)));
        return [
          ...table.map((r) => `${[0, 1, 2].map((c) => r[c]!.padEnd(widths[c]!)).join('  ')}  ${r[3]}`),
          '',
          'Advertised keys come from the gateway and are never trusted. Pin the key printed by',
          '`pocketshell gateway show --host-key` on the host: `pocketshell-client gateway pin <id>`.',
        ].join('\n');
      });
    }),
  );

  jsonOption(
    gateway
      .command('pin <device-id> [key-line]')
      .description(
        "trust a host key for a device: the '<keytype> <base64>' line from `pocketshell gateway show --host-key` " +
          'run ON THE HOST (argument, stdin, or pasted at the prompt)',
      )
      .option('--replace', 'replace a DIFFERENT key already pinned for this device (host re-keyed)'),
  ).action(
    action(async (deviceId: string, keyArg: string | undefined, opts: { json?: boolean; replace?: boolean }) => {
      if (opts.json) setJsonMode(true);
      validateDeviceId(deviceId);
      const key = parseHostKey(keyArg ?? (await readHostKeyInput()));
      const changed = addPin(deviceId, key, { replace: opts.replace });
      const info = describeKey(key);
      emit({ ok: true, device_id: deviceId, changed, ...info, pin_file: pinFilePath() }, () =>
        [`${changed ? 'pinned' : 'already pinned'} ${deviceId}: ${info.fingerprint} (${info.type})`, `pin file: ${pinFilePath()}`].join(
          '\n',
        ),
      );
    }),
  );

  jsonOption(gateway.command('unpin <device-id>').description("forget a device's pinned host key")).action(
    action(async (deviceId: string, opts: { json?: boolean }) => {
      if (opts.json) setJsonMode(true);
      const key = removePin(deviceId);
      const info = describeKey(key);
      emit({ ok: true, device_id: deviceId, ...info }, () => `unpinned ${deviceId}: ${info.fingerprint} (${info.type})`);
    }),
  );

  serverOptions(
    gateway
      .command('proxy <device-id>')
      .description(
        'OpenSSH ProxyCommand used by gateway hosts: bridges stdin/stdout to the device through the gateway ' +
          '(stdout carries SSH bytes only; not for interactive use)',
      )
      .option(
        '--status-file <path>',
        'also record a pre-tunnel failure in this file (set by the client; must be inside its private runtime dir)',
      ),
  ).action(async (deviceId: string, opts: { server?: string; insecureDev?: boolean; statusFile?: string }) => {
    let endpoint: GatewayEndpoint;
    try {
      validateDeviceId(deviceId);
      endpoint = endpointFrom(opts);
    } catch (error) {
      const line = markerLine('USAGE', error instanceof EndpointError ? error.message : 'invalid arguments');
      recordStatus(opts.statusFile, line);
      process.stderr.write(`${line}\n`);
      process.exit(2);
    }
    const code = await runProxy({
      deviceId,
      endpoint,
      tokenProvider: mintGatewayToken,
      stdin: process.stdin,
      stdout: process.stdout,
      ...(opts.statusFile !== undefined ? { statusFile: opts.statusFile } : {}),
    });
    process.exit(code);
  });
}
