/** Glue every command shares: pick the host, open it, always close it. */
import type { Command } from 'commander';
import { HostClient } from '../hostClient.js';
import { defaultHostName, getHost, LOCAL_HOST_NAME, type HostEntry } from '../hosts/store.js';
import { fail, setJsonMode } from '../output.js';
import { openConnection } from '../transport/index.js';

/** `-H/--host` and `--json`, the two options nearly every command takes. */
export function hostOptions(command: Command): Command {
  return command
    .option('-H, --host <name>', 'saved host to use (default: the default host, else `local`)')
    .option('--json', 'machine-readable output: one JSON document on stdout');
}

export function jsonOption(command: Command): Command {
  return command.option('--json', 'machine-readable output: one JSON document on stdout');
}

export function resolveHost(name: string | undefined): HostEntry {
  return getHost(name ?? process.env.PSC_HOST ?? defaultHostName() ?? LOCAL_HOST_NAME);
}

/** Open the host, run `body`, close it — and turn any failure into an exit code. */
export async function withHost(
  options: { host?: string; json?: boolean },
  body: (client: HostClient, host: HostEntry) => Promise<void>,
): Promise<void> {
  if (options.json) setJsonMode(true);
  const host = resolveHost(options.host);
  const connection = await openConnection(host);
  try {
    await body(new HostClient(connection, host.binary), host);
  } finally {
    await connection.close();
  }
}

/** Wrap a command action so thrown errors become the documented exit codes. */
export function action<A extends unknown[]>(fn: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (error) {
      process.exitCode = fail(error);
    }
  };
}
