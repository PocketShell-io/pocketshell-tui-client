import { requests, setExitCode } from '../daemon/context.js';
/** `hosts list|add|remove|default|check`: the saved host inventory. */
import { InvalidArgumentError, type Command } from 'commander';
import { mintGatewayToken } from '../account/index.js';
import { fetchDevices } from '../gateway/devices.js';
import { DEFAULT_SERVER, resolveEndpoint } from '../gateway/endpoint.js';
import { addPin, fingerprint, loadPins, type HostKey } from '../gateway/pins.js';
import { HostClient } from '../hostClient.js';
import {
  addHost,
  defaultHostName,
  friendlyHostName,
  getHost,
  listHosts,
  pickHost,
  removeHost,
  setDefaultHost,
  type HostEntry,
} from '../hosts/store.js';
import { emit, EXIT, note, setJsonMode, usageError } from '../output.js';
import { safeLine } from '../sanitize.js';
import { openConnection } from '../transport/index.js';
import { action, jsonOption } from './common.js';

export function describeHost(host: HostEntry): string {
  switch (host.mode) {
    case 'local':
      return 'this machine';
    case 'ssh': {
      const ssh = host.ssh!;
      const user = ssh.user ? `${ssh.user}@` : '';
      return `ssh ${user}${ssh.destination}${ssh.port ? `:${ssh.port}` : ''}`;
    }
    case 'gateway': {
      const gw = host.gateway!;
      return `gateway ${gw.user ? `${gw.user}@` : ''}${gw.deviceId}${gw.server ? ` via ${gw.server}` : ''}`;
    }
  }
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InvalidArgumentError(`expected a port 1-65535, got ${JSON.stringify(value)}`);
  }
  return port;
}

export function registerHosts(program: Command): void {
  const hosts = program.command('hosts').description('manage saved hosts (local, ssh, gateway)');

  jsonOption(hosts.command('list').description('list saved hosts')).action(
    action(async (opts: { json?: boolean }) => {
      if (opts.json) setJsonMode(true);
      const def = defaultHostName();
      const rows = listHosts().map((host) => ({ ...host, default: host.name === (def ?? 'local') }));
      emit({ ok: true, hosts: rows }, () =>
        rows.map((row) => `${row.default ? '*' : ' '} ${row.name.padEnd(20)} ${describeHost(row)}`).join('\n'),
      );
    }),
  );

  jsonOption(
    hosts
      .command('add <name>')
      .description('save a host; pick exactly one of --ssh or --gateway')
      .option('--ssh <destination>', 'ssh mode: an ~/.ssh/config alias, host, or user@host')
      .option('--gateway <device-id>', 'gateway mode: the enrolled device id')
      .option('-l, --user <user>', 'login name on the host')
      .option('-p, --port <port>', 'ssh port (ssh mode)', parsePort)
      .option('-i, --identity <file>', 'private key file')
      .option('--server <origin>', 'gateway origin, wss://host[:port] (gateway mode; default production)')
      .option('--binary <path>', 'pocketshell binary on the host, a plain path of [A-Za-z0-9_./~+-] (default: pocketshell on PATH)')
      .option('--native-windows-cli <path>', 'trusted provisioned absolute native Windows CLI console (gateway only; no --binary)')
      .option('--native-transport <transport>', 'explicit provisioned native transport: openssh-git-bash or openssh-cmd-git-bash')
      .option('--native-bash <path>', 'CMD transport only: trusted provisioned absolute Bash interpreter')
      .option('--native-bash-sha256 <digest>', 'CMD transport only: operator-verified Bash SHA256 for this device')
      .option('--default', 'make it the default host')
      .option('--replace', 'overwrite an existing host of the same name'),
  ).action(
    action(
      async (
        name: string,
        opts: {
          ssh?: string;
          gateway?: string;
          user?: string;
          port?: number;
          identity?: string;
          server?: string;
          binary?: string;
          nativeWindowsCli?: string;
          nativeTransport?: string;
          nativeBash?: string;
          nativeBashSha256?: string;
          default?: boolean;
          replace?: boolean;
          json?: boolean;
        },
      ) => {
        if (opts.json) setJsonMode(true);
        if (Boolean(opts.ssh) === Boolean(opts.gateway)) {
          throw usageError('pass exactly one of --ssh <destination> or --gateway <device-id>');
        }
        const entry: HostEntry = opts.ssh
          ? {
              name,
              mode: 'ssh',
              ssh: {
                destination: opts.ssh,
                ...(opts.port ? { port: opts.port } : {}),
                ...(opts.user ? { user: opts.user } : {}),
                ...(opts.identity ? { identityFile: opts.identity } : {}),
              },
            }
          : {
              name,
              mode: 'gateway',
              gateway: {
                deviceId: opts.gateway!,
                ...(opts.user ? { user: opts.user } : {}),
                ...(opts.identity ? { identityFile: opts.identity } : {}),
                ...(opts.server ? { server: opts.server } : {}),
              },
            };
        if (opts.binary) entry.binary = opts.binary;
        if (opts.nativeWindowsCli !== undefined || opts.nativeTransport !== undefined || opts.nativeBash !== undefined || opts.nativeBashSha256 !== undefined) {
          if (!opts.gateway || !opts.nativeWindowsCli || !['openssh-git-bash', 'openssh-cmd-git-bash'].includes(opts.nativeTransport ?? '')) {
            throw usageError('native Windows provisioning needs --gateway, --native-windows-cli and an explicit reviewed --native-transport');
          }
          if (opts.nativeTransport === 'openssh-cmd-git-bash') {
            if (!opts.nativeBash || !opts.nativeBashSha256) throw usageError('CMD provisioning requires --native-bash and --native-bash-sha256 from a verified per-device receipt');
            entry.nativeWindowsCli = { executable: opts.nativeWindowsCli, transport: 'openssh-cmd-git-bash', deviceId: opts.gateway,
              trustedBashExecutable: opts.nativeBash, trustedBashSha256: opts.nativeBashSha256 };
          } else {
            if (opts.nativeBash !== undefined || opts.nativeBashSha256 !== undefined) throw usageError('Bash bindings require openssh-cmd-git-bash');
            entry.nativeWindowsCli = { executable: opts.nativeWindowsCli, transport: 'openssh-git-bash', deviceId: opts.gateway };
          }
        }
        addHost(entry, { replace: opts.replace });
        if (opts.default) setDefaultHost(name);
        emit({ ok: true, host: entry }, () => `saved ${name}: ${describeHost(entry)}`);
      },
    ),
  );

  jsonOption(
    hosts
      .command('alias <alias> <host>')
      .description('save <alias> pointing to the same target as <host> (e.g. `psc hosts alias win35 desktop`)')
      .option('--replace', 'overwrite an existing host of the same name'),
  ).action(
    action(async (alias: string, targetSelector: string, opts: { replace?: boolean; json?: boolean }) => {
      if (opts.json) setJsonMode(true);
      const target = pickHost(listHosts(), targetSelector);
      const entry: HostEntry = {
        ...target,
        name: alias,
        ...(target.ssh ? { ssh: { ...target.ssh } } : {}),
        ...(target.gateway ? { gateway: { ...target.gateway } } : {}),
      };
      addHost(entry, { replace: opts.replace });
      emit({ ok: true, host: entry, target: target.name }, () => `saved ${alias} -> ${target.name} (${describeHost(entry)})`);
    }),
  );

  jsonOption(
    hosts
      .command('sync')
      .description('add saved gateway hosts for enrolled account devices (`hetzner-rmthz` → `hetzner`, `host-laptop-…` → `laptop`)')
      .option(
        '--trust-advertised',
        'pin the broker-advertised SSH host key for unpinned devices (TOFU through the broker; otherwise use `gateway pin` with `pocketshell gateway show --host-key`)',
      )
      .option('-l, --user <user>', 'SSH login name to set on newly added gateway hosts')
      .option('--server <origin>', `gateway origin, wss://host[:port] (default: ${DEFAULT_SERVER})`)
      .option('--insecure-dev', 'DEV ONLY: allow plain ws:// to a loopback or single-label docker host')
      .addHelpText(
        'after',
        '\nNote on --trust-advertised: pins the full SSH host key advertised through the broker\n' +
          '(Trust On First Use via the broker). Without --trust-advertised, unpinned devices are\n' +
          'listed so you can verify and pin them out of band with `psc gateway pin <device-id>`.',
      ),
  ).action(
    action(
      async (opts: {
        trustAdvertised?: boolean;
        user?: string;
        server?: string;
        insecureDev?: boolean;
        json?: boolean;
      }) => {
        if (opts.json) setJsonMode(true);
        const endpoint = resolveEndpoint(opts.server, Boolean(opts.insecureDev));
        if (endpoint.warning) process.stderr.write(`${endpoint.warning}\n`);
        const token = await mintGatewayToken();
        const devices = await fetchDevices(endpoint, token);
        let pins = new Map<string, HostKey>();
        try {
          pins = loadPins();
        } catch (error) {
          note(`warning: ignoring pin file: ${(error as Error).message}`);
        }
        const current = listHosts();
        const takenNames = new Set(current.map((h) => h.name));
        const byDeviceId = new Map<string, HostEntry>();
        for (const h of current) {
          if (h.mode === 'gateway' && h.gateway?.deviceId && !byDeviceId.has(h.gateway.deviceId)) {
            byDeviceId.set(h.gateway.deviceId, h);
          }
        }
        const added: HostEntry[] = [];
        const existing: HostEntry[] = [];
        const pinned: Array<{ deviceId: string; fingerprint: string }> = [];
        const unpinned: Array<{ deviceId: string; host: string; advertisedFingerprint: string | null }> = [];

        for (const dev of devices) {
          if (!dev.idValid || dev.revoked) continue;
          let hostEntry = byDeviceId.get(dev.id);
          if (hostEntry) {
            existing.push(hostEntry);
          } else {
            const name = friendlyHostName(dev.id, takenNames);
            takenNames.add(name);
            hostEntry = addHost({
              name,
              mode: 'gateway',
              gateway: {
                deviceId: dev.id,
                ...(opts.user ? { user: opts.user } : {}),
                ...(opts.server ? { server: opts.server } : {}),
              },
            });
            byDeviceId.set(dev.id, hostEntry);
            added.push(hostEntry);
          }
          const hasPin = pins.has(dev.id);
          if (!hasPin) {
            if (opts.trustAdvertised && dev.advertisedKey) {
              addPin(dev.id, dev.advertisedKey);
              pins.set(dev.id, dev.advertisedKey);
              pinned.push({ deviceId: dev.id, fingerprint: fingerprint(dev.advertisedKey) });
            } else {
              unpinned.push({
                deviceId: dev.id,
                host: hostEntry.name,
                advertisedFingerprint: dev.advertisedKey ? fingerprint(dev.advertisedKey) : null,
              });
            }
          }
        }

        emit({ ok: true, added, existing, pinned, unpinned }, () => {
          const lines: string[] = [];
          for (const h of added) lines.push(`added ${h.name} (${describeHost(h)})`);
          for (const h of existing) lines.push(`kept  ${h.name} (${describeHost(h)})`);
          for (const p of pinned) lines.push(`pinned (TOFU) ${p.deviceId}: ${p.fingerprint}`);
          if (unpinned.length > 0) {
            lines.push(
              `unpinned devices (run \`psc gateway pin <device-id>\` or \`psc hosts sync --trust-advertised\`): ` +
                unpinned.map((u) => `${u.host} (${u.deviceId})`).join(', '),
            );
          }
          return lines.length > 0 ? lines.join('\n') : 'no active gateway devices found';
        });
      },
    ),
  );

  jsonOption(hosts.command('remove <name>').description('forget a saved host')).action(
    action(async (name: string, opts: { json?: boolean }) => {
      if (opts.json) setJsonMode(true);
      const removed = removeHost(name);
      emit({ ok: true, removed }, () => (removed ? `removed ${name}` : `no host named ${name}`));
    }),
  );

  jsonOption(hosts.command('default [name]').description('show or set the default host').option('--clear', 'unset it')).action(
    action(async (name: string | undefined, opts: { json?: boolean; clear?: boolean }) => {
      if (opts.json) setJsonMode(true);
      if (opts.clear) setDefaultHost(null);
      else if (name) setDefaultHost(name);
      const current = defaultHostName() ?? 'local';
      emit({ ok: true, default: current }, () => current);
    }),
  );

  jsonOption(
    hosts
      .command('check <name>')
      .description('connect and report the host CLI and aplexer versions')
      .addHelpText(
        'after',
        '\n--json: {"ok":true,"host":...,"mode":...,"ms":N,"pocketshell":"<version>"|null,"aplexer":"<version>"|null}\n' +
          'Cannot connect: the connection error (exit 4). Connected but no pocketshell CLI:\n' +
          'ok:false, error {"code":"HOST_CLI_MISSING"}, exit 6 (the version fields are still included).',
      ),
  ).action(
    action(async (name: string, opts: { json?: boolean }) => {
      if (opts.json) setJsonMode(true);
      const host = getHost(name);
      const started = Date.now();
      const client = requests.getStore()
        ? await (await import('../daemon/services.js')).daemonClient(host)
        : new HostClient(await openConnection(host), host.binary, host);
      try {
        const versions = await client.probe();
        const ms = Date.now() - started;
        const missing = versions.pocketshell === null;
        const result = {
          ok: !missing,
          host: name,
          mode: host.mode,
          ms,
          ...versions,
          ...(missing
            ? { error: { code: 'HOST_CLI_MISSING', message: `no working \`${host.binary ?? 'pocketshell'}\` CLI on ${name}` } }
            : {}),
        };
        emit(result, () =>
          [
            `${name} (${describeHost(host)}) reachable in ${ms} ms`,
            `pocketshell: ${versions.pocketshell === null ? 'MISSING — install with `uv tool install pocketshell`' : safeLine(versions.pocketshell)}`,
            `aplexer:     ${versions.aplexer === null ? 'missing' : safeLine(versions.aplexer)}`,
          ].join('\n'),
        );
        if (missing) setExitCode(EXIT.HOST_CLI);
      } finally {
        await client.connection.close();
      }
    }),
  );
}

