/**
 * SSH mode: the system OpenSSH client, multiplexed per saved host.
 *
 * The user's ~/.ssh/config, agent, ProxyJump, certificates and known_hosts
 * apply unchanged. We add a private ControlMaster (ControlPersist keeps it
 * for a minute after the last call, so the next CLI invocation skips the
 * TCP + key exchange + auth round trips) and, for captured commands,
 * BatchMode: an agent-driven exec must fail with a typed error, never hang
 * on a password or host-key prompt. Interactive attach allows prompts.
 */
import type { SshHostConfig } from '../hosts/store.js';
import {
  controlPathFor,
  explainSshExit,
  findSsh,
  multiplexOptions,
  runSshCaptured,
  validateArgValue,
  validateDestination,
} from './openssh.js';
import { runInteractive } from './process.js';
import { ConnectionError, type Connection, type ExecOptions, type ExecOutcome } from './types.js';

export interface SshArgvInput {
  config: SshHostConfig;
  controlPath: string | null;
  /** `exec`: captured, -T, BatchMode. `attach`: -t on this terminal. */
  kind: 'exec' | 'attach';
  command: string;
}

function validatePort(port: number | undefined): void {
  if (port === undefined) return;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConnectionError(`invalid ssh port ${String(port)}`, 'BAD_HOST', 2);
  }
}

/** The ssh argv (without argv[0]) for one call. Pure; exported for tests. */
export function buildSshArgv({ config, controlPath, kind, command }: SshArgvInput): string[] {
  const destination = validateDestination(config.destination);
  validatePort(config.port);
  const argv: string[] = [];
  if (kind === 'exec') argv.push('-o', 'BatchMode=yes');
  argv.push(
    '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    // A LocalForward in the user's config would otherwise be set up (or
    // fail to bind) on every call; this client never needs forwards.
    '-o', 'ClearAllForwardings=yes',
  );
  if (controlPath) argv.push(...multiplexOptions(controlPath));
  if (config.port !== undefined) argv.push('-p', String(config.port));
  if (config.user !== undefined) argv.push('-l', validateArgValue('ssh user', config.user));
  if (config.identityFile !== undefined) {
    argv.push('-i', validateArgValue('identity file', config.identityFile), '-o', 'IdentitiesOnly=yes');
  }
  argv.push(kind === 'exec' ? '-T' : '-t');
  // The command is one complete shell command string: ssh joins remote
  // words with spaces and the remote login shell parses the result, so it
  // goes as a single argv element, never re-quoted.
  argv.push('--', destination, command);
  return argv;
}

export class OpenSshConnection implements Connection {
  readonly mode = 'ssh' as const;
  private readonly controlPath: string | null;

  constructor(
    readonly hostName: string,
    private readonly config: SshHostConfig,
    private readonly sshPath: string,
    controlPath: string | null,
  ) {
    this.controlPath = controlPath;
  }

  argv(kind: 'exec' | 'attach', command: string): string[] {
    return buildSshArgv({ config: this.config, controlPath: this.controlPath, kind, command });
  }

  async exec(command: string, options: ExecOptions): Promise<ExecOutcome> {
    const outcome = await runSshCaptured(this.sshPath, this.argv('exec', command), options);
    const failure = await explainSshExit(
      outcome,
      {
        hostName: this.hostName,
        how: `over ssh (${this.config.destination})`,
        hint: {
          HOST_KEY_FAILED: `connect once with \`ssh ${this.config.destination}\` to verify and accept the host key`,
          AUTH_FAILED: 'key-based login is required for non-interactive use (load the key into ssh-agent or set --identity)',
        },
      },
      { sshPath: this.sshPath, controlPath: this.controlPath },
    );
    if (failure) throw failure;
    return outcome;
  }

  attachInteractive(command: string): Promise<number | null> {
    return runInteractive(this.sshPath, this.argv('attach', command));
  }

  async close(): Promise<void> {
    // The master is deliberately left to expire via ControlPersist: the
    // next CLI call (an agent's next command) reuses it and is fast.
  }
}

export async function openSshConnection(hostName: string, config: SshHostConfig): Promise<Connection> {
  validateDestination(config.destination);
  validatePort(config.port);
  const sshPath = findSsh();
  let controlPath: string | null = null;
  try {
    controlPath = controlPathFor('s', [config.destination, config.port ?? null, config.user ?? null, config.identityFile ?? null]);
  } catch {
    controlPath = null; // no safe socket dir: work without multiplexing
  }
  return new OpenSshConnection(hostName, config, sshPath, controlPath);
}
