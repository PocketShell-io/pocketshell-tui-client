/**
 * Gateway mode: OpenSSH through the PocketShell gateway WebSocket tunnel.
 *
 * Mirrors the Python CLI's `pocketshell gateway ssh` (docs/gateway.md §9.4):
 * OpenSSH does user auth, encryption and — the point — host-key
 * verification against the client's own pin file; the gateway is only the
 * ProxyCommand transport (`pocketshell-client gateway proxy <id>`) and is
 * never trusted with the session. The argv is fully explicit: `-F none`
 * (the user's ~/.ssh/config is not read), every hardening `-o` first (for
 * ssh the first value wins), the destination after `--`.
 *
 * Gateway invocations never reuse an SSH master. Every command opens a new
 * proxy, gets current broker authorization and verifies the current full pin.
 * Direct SSH mode retains its separate explicit multiplexing behavior.
 */
import { bindings, callNative, closedWindowsEnvironment, nativeWrite, windowsAbsolute, windowsProxyCommand, quoteWindowsArg } from '../platform/windows.js';
import { configHome, runtimeDir, sharedConfigDir } from '../paths.js';
import { brokerUrl } from '../account/index.js';
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireLogin } from '../account/index.js';
import { DEFAULT_SERVER, EndpointError, hostKeyAlias, legacyHostKeyAlias, resolveEndpoint, validateDeviceId, type GatewayEndpoint } from '../gateway/endpoint.js';
import { PinError, pinFilePath, requirePinEntry } from '../gateway/pins.js';
import type { GatewayHostConfig } from '../hosts/store.js';
import {
  controlDir,
  explainSshExit,
  findSsh,
  newStatusFilePath,
  proxyFailure,
  readStatusFile,
  runSshCaptured,
  shQuote,
  SSH_FAILURE_EXIT,
} from './openssh.js';
import { runInteractive } from './process.js';
import { ConnectionError, type Connection, type ExecOptions, type ExecOutcome } from './types.js';

/** Hardening options, including an unconditional gateway no-reuse policy. */
export const HARDENING_OPTIONS: readonly string[] = [
  'ControlMaster=no',
  'ControlPath=none',
  'ControlPersist=no',
  'IgnoreUnknown=EnableEscapeCommandline',
  'EnableEscapeCommandline=no',
  'StrictHostKeyChecking=yes',
  'GlobalKnownHostsFile=/dev/null',
  'CheckHostIP=no',
  'UpdateHostKeys=no',
  'VerifyHostKeyDNS=no',
  'ForwardAgent=no',
  'ForwardX11=no',
  'ForwardX11Trusted=no',
  'PermitLocalCommand=no',
  'ProxyUseFdpass=no',
  'Tunnel=no',
  'CanonicalizeHostname=no',
  'PubkeyAuthentication=yes',
  'PasswordAuthentication=no',
  'KbdInteractiveAuthentication=no',
  'GSSAPIAuthentication=no',
  'HostbasedAuthentication=no',
  'PreferredAuthentications=publickey',
  'IdentitiesOnly=yes',
  'Compression=no',
  'ConnectTimeout=30',
  'ServerAliveInterval=30',
  'ServerAliveCountMax=3',
  'ExitOnForwardFailure=yes',
  'ClearAllForwardings=yes',
];

const UNSAFE_PATH_RE = /[\s%$~'"\\`]|[^\x21-\x7e]/;
const USER_RE = /^[A-Za-z0-9_][A-Za-z0-9._@-]{0,63}$/;

function usage(message: string): ConnectionError {
  return new ConnectionError(message, 'BAD_HOST', 2);
}

export function checkSshPath(path: string, what: string): string {
  if (process.platform === 'win32') {
    const p=windowsAbsolute(path).replace(/\\/g,'/');
    if (/[\x00-\x20\x7f%$~'\"`]|[^\x21-\x7e]/.test(p)) throw usage(`${what} contains unsupported OpenSSH option characters`);
    return p;
  }
  if (!isAbsolute(path)) throw usage(`${what} path must be absolute`);
  if (UNSAFE_PATH_RE.test(path)) {
    throw usage(
      `${what} path ${JSON.stringify(path).slice(0, 120)} contains whitespace, '%', '$', '~', quotes, backslashes or ` +
        'non-ASCII characters, which OpenSSH would expand or split; move it (or set XDG_CONFIG_HOME) to a plain path',
    );
  }
  return path;
}

function checkProxyElement(value: string): string {
  if (/[\x00-\x1f\x7f\\]/.test(value)) {
    throw usage(`refusing to put ${JSON.stringify(value).slice(0, 120)} in a ProxyCommand (control characters or backslash)`);
  }
  return value;
}

/**
 * How to start this very CLI again: `[node, (--import tsx-loader,) cli]`.
 * Built: dist/transport/gateway.js → dist/cli.js. Dev (tsx): src/transport/
 * gateway.ts → src/cli.ts, run through tsx's loader by absolute path.
 */
export function cliInvocation(): string[] {
  if(process.platform==='win32') { const b=bindings();
    if(windowsAbsolute(b.node).toLowerCase()!==windowsAbsolute(process.execPath).toLowerCase()) throw usage('Windows interpreter binding mismatch');
    return [b.node,b.entry];
  }
  const node = process.execPath;
  const candidates: string[] = [];
  try {
    const here = fileURLToPath(import.meta.url);
    const root = dirname(dirname(here));
    candidates.push(join(root, 'cli.js'), join(root, 'cli.ts'));
  } catch {
    /* not a file: URL */
  }
  if (process.argv[1]) {
    try {
      candidates.push(realpathSync(process.argv[1]));
    } catch {
      /* gone */
    }
  }
  for (const script of candidates) {
    if (!/\/cli\.(js|ts)$/.test(script) || !existsSync(script)) continue;
    if (script.endsWith('.js')) return [node, script];
    try {
      const loader = createRequire(script).resolve('tsx');
      return [node, '--import', loader, script];
    } catch {
      continue;
    }
  }
  throw new ConnectionError('cannot locate the pocketshell-client entry point for the gateway ProxyCommand', 'INTERNAL', 1);
}

/**
 * The ProxyCommand string: each element shell-quoted, `%` doubled for ssh.
 * `statusFile` (see openssh.ts) is where the proxy also records its final
 * pre-session failure marker for consistent captured and interactive errors.
 */
export function proxyCommand(
  deviceId: string,
  endpoint: GatewayEndpoint,
  invocation: readonly string[],
  statusFile?: string | null,
): string {
  if(process.platform==='win32') {
    const b=bindings(); if(invocation.length!==2 || invocation[0]!==b.node || invocation[1]!==b.entry || !endpoint.secure) throw usage('Windows proxy binding refused');
    const args=[...invocation,'gateway','proxy',validateDeviceId(deviceId),'--server',endpoint.wsBase];
    if(statusFile)args.push('--status-file',checkSshPath(statusFile,'status file'));
    return windowsProxyCommand(args);
  }
  if (!invocation[0] || !isAbsolute(invocation[0])) throw usage('cannot locate an absolute node interpreter path');
  const argv = [...invocation, 'gateway', 'proxy', validateDeviceId(deviceId)];
  if (endpoint.wsBase !== DEFAULT_SERVER) argv.push('--server', endpoint.wsBase);
  if (!endpoint.secure) argv.push('--insecure-dev');
  if (statusFile) argv.push('--status-file', checkSshPath(statusFile, 'status file'));
  return argv.map((word) => shQuote(checkProxyElement(word)).replace(/%/g, '%%')).join(' ');
}

export interface GatewayArgvInput {
  deviceId: string;
  endpoint: GatewayEndpoint;
  pinFile: string;
  /** The known_hosts name the pin is stored under (current or legacy alias). */
  alias: string;
  user?: string;
  identityFile?: string;
  /** Private per-invocation error receipts only; never an SSH control socket. */
  statusDir?: string | null;
  invocation: readonly string[];
  kind: 'exec' | 'attach';
  command: string;
  /** Fresh per ssh invocation; omitted → the proxy reports on stderr only. */
  statusFile?: string | null;
}

/** The hardened ssh argv (without argv[0]). Pure apart from the identity-file existence check. */
export function buildGatewaySshArgv(input: GatewayArgvInput): string[] {
  const { deviceId, endpoint, kind, command } = input;
  validateDeviceId(deviceId);
  if (input.alias !== hostKeyAlias(deviceId) && input.alias !== legacyHostKeyAlias(deviceId)) {
    throw usage(`host key alias does not belong to device ${deviceId}`);
  }
  const argv = ['-F', 'none'];
  let empty: string | null=null;
  if(process.platform==='win32') { nativeWrite(sharedConfigDir(),'empty',Buffer.alloc(0)); empty=checkSshPath(join(sharedConfigDir(),'known_hosts_empty'),'empty global pins'); }
  for (const opt of HARDENING_OPTIONS) argv.push('-o', empty && opt==='GlobalKnownHostsFile=/dev/null' ? `GlobalKnownHostsFile=${empty}` : opt);
  if (kind === 'exec') argv.push('-o', 'BatchMode=yes');
  argv.push(
    '-o', `UserKnownHostsFile=${checkSshPath(input.pinFile, 'pin file')}`,
    '-o', `HostKeyAlias=${input.alias}`,
    '-o', `ProxyCommand=${proxyCommand(deviceId, endpoint, input.invocation, input.statusFile)}`,
  );
  if (input.user !== undefined) {
    if (!USER_RE.test(input.user)) throw usage(`invalid login name ${JSON.stringify(input.user).slice(0, 80)}`);
    argv.push('-l', input.user);
  }
  if (input.identityFile !== undefined) {
    const raw = input.identityFile.startsWith('~/') ? join(homedir(), input.identityFile.slice(2)) : input.identityFile;
    const ident = checkSshPath(resolvePath(raw), 'identity file');
    if(process.platform==='win32') callNative({op:'check-identity',root:runtimeDir(),path:ident});
    if (!existsSync(ident)) throw usage(`identity file ${ident} does not exist`);
    argv.push('-i', ident);
  }
  argv.push(kind === 'exec' ? '-T' : '-t');
  argv.push('--', input.alias, command);
  return argv;
}

/** ssh's environment: the ProxyCommand always runs under /bin/sh. */
export function sshEnvironment(): NodeJS.ProcessEnv {
  if(process.platform==='win32') return closedWindowsEnvironment({config:configHome(),runtime:runtimeDir(),home:homedir()},brokerUrl());
  return { ...process.env, SHELL: '/bin/sh' };
}

const HINTS: Partial<Record<string, string>> = {
  NOT_LOGGED_IN: 'run `pocketshell-client login`',
  HOST_OFFLINE: 'is `pocketshell gateway run` active on the host?',
  DEVICE_NOT_FOUND: 'check the id with `pocketshell-client gateway devices`',
  HOST_KEY_FAILED:
    'the host key does not match your pin; verify with `pocketshell gateway show --host-key` on the host, then `pocketshell-client gateway pin <id> --replace`',
  AUTH_FAILED: 'the host did not accept your SSH key (-i / the default ~/.ssh/id_* files; agent-only keys are not offered)',
};

export class GatewayConnection implements Connection {
  readonly mode = 'gateway' as const;

  constructor(
    readonly hostName: string,
    private readonly sshPath: string,
    private readonly argvInput: Omit<GatewayArgvInput, 'kind' | 'command' | 'statusFile'>,
  ) {}

  argv(kind: 'exec' | 'attach', command: string, statusFile?: string | null): string[] {
    return buildGatewaySshArgv({ ...this.argvInput, kind, command, statusFile });
  }

  /** A fresh pre-session failure receipt, consumed after each SSH run. */
  private statusFile(): string | null {
    const { statusDir } = this.argvInput;
    return statusDir ? newStatusFilePath(statusDir) : null;
  }

  private context() {
    return {
      hostName: this.hostName,
      how: `through the gateway (device ${this.argvInput.deviceId})`,
      hint: HINTS,
    };
  }

  async exec(command: string, options: ExecOptions): Promise<ExecOutcome> {
    const statusFile = this.statusFile();
    const outcome = await runSshCaptured(this.sshPath, this.argv('exec', command, statusFile), {
      ...options,
      env: sshEnvironment(),
    });
    const failure = await explainSshExit(outcome, this.context(), {
      sshPath: this.sshPath,
      controlPath: null,
      statusFile,
    });
    if (failure) throw failure;
    return outcome;
  }

  /**
   * Interactive attach. ssh owns the terminal, so a proxy failure prints
   * (when stderr is not silenced) the proxy's friendly TTY line; and when
   * ssh exits 255 and the status file shows the tunnel never came up — no
   * session ever started — it is raised as a typed ConnectionError
   * (NOT_LOGGED_IN → exit 3, HOST_OFFLINE, ...) for the CLI/TUI to report.
   */
  async attachInteractive(command: string): Promise<number | null> {
    const statusFile = this.statusFile();
    const code = await runInteractive(this.sshPath, this.argv('attach', command, statusFile), sshEnvironment());
    const status = readStatusFile(statusFile);
    if (code === SSH_FAILURE_EXIT && status) throw proxyFailure(status, this.context());
    return code;
  }

  async close(): Promise<void> {
    // No persistent SSH master or reusable control socket is created.
  }
}

/**
 * Fail fast, without network I/O, when there is no login session — the
 * proxy subprocess mints the token, but its exit status would be hidden
 * behind ssh's 255.
 */
function checkLogin(): void {
  try {
    requireLogin();
  } catch (error) {
    if ((error as { code?: unknown })?.code === 'NOT_LOGGED_IN') {
      throw new ConnectionError((error as Error).message, 'NOT_LOGGED_IN', 3);
    }
    throw error;
  }
}

export async function openGatewayConnection(hostName: string, config: GatewayHostConfig): Promise<Connection> {
  let endpoint: GatewayEndpoint;
  try {
    validateDeviceId(config.deviceId);
    // A saved plain ws:// server is the explicit dev opt-in; resolveEndpoint
    // still only allows it to loopback / a single-label docker host.
    endpoint = resolveEndpoint(config.server, config.server?.toLowerCase().startsWith('ws://') ?? false);
  } catch (error) {
    if (error instanceof EndpointError) throw usage(`host ${hostName}: ${error.message}`);
    throw error;
  }
  let alias: string;
  try {
    alias = requirePinEntry(config.deviceId).alias;
  } catch (error) {
    if (error instanceof PinError) throw new ConnectionError(error.message, error.code === 'NOT_PINNED' ? 'NOT_PINNED' : 'PIN_FILE_UNSAFE', 4);
    throw error;
  }
  const sshPath = findSsh();
  checkLogin();
  let statusDir: string | null = null;
  try {
    statusDir = controlDir();
  } catch (error) {
    if(process.platform==='win32') throw error;
    statusDir = null;
  }
  const input = {
    deviceId: config.deviceId,
    endpoint,
    pinFile: pinFilePath(),
    alias,
    ...(config.user !== undefined ? { user: config.user } : {}),
    ...(config.identityFile !== undefined ? { identityFile: config.identityFile } : {}),
    statusDir,
    invocation: cliInvocation(),
  };
  // Validate the whole argv now so a bad config fails before the first exec.
  buildGatewaySshArgv({ ...input, kind: 'exec', command: 'true' });
  return new GatewayConnection(hostName, sshPath, input);
}
