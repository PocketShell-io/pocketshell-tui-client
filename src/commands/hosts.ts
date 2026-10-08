/** `hosts list|add|remove|default|check`: the saved host inventory. */
import { InvalidArgumentError, type Command } from 'commander';
import { HostClient } from '../hostClient.js';
import {
  addHost,
  defaultHostName,
  getHost,
  listHosts,
  removeHost,
  setDefaultHost,
  type HostEntry,
} from '../hosts/store.js';
import { emit, EXIT, setJsonMode, usageError } from '../output.js';
import { safeLine } from '../sanitize.js';
import { openConnection } from '../transport/index.js';
import { action, jsonOption } from './common.js';

function describe(host: HostEntry): string {
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
        rows.map((row) => `${row.default ? '*' : ' '} ${row.name.padEnd(20)} ${describe(row)}`).join('\n'),
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
        addHost(entry, { replace: opts.replace });
        if (opts.default) setDefaultHost(name);
        emit({ ok: true, host: entry }, () => `saved ${name}: ${describe(entry)}`);
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
      const connection = await openConnection(host);
      try {
        const versions = await new HostClient(connection, host.binary).probe();
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
            `${name} (${describe(host)}) reachable in ${ms} ms`,
            `pocketshell: ${versions.pocketshell === null ? 'MISSING — install with `uv tool install pocketshell`' : safeLine(versions.pocketshell)}`,
            `aplexer:     ${versions.aplexer === null ? 'missing' : safeLine(versions.aplexer)}`,
          ].join('\n'),
        );
        if (missing) process.exitCode = EXIT.HOST_CLI;
      } finally {
        await connection.close();
      }
    }),
  );
}
