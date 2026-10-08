/**
 * Shared OpenSSH plumbing for the ssh and gateway modes.
 *
 * Both modes run the system `ssh` client (so ~/.ssh/config, the agent,
 * ProxyJump, certificates and known_hosts just work in ssh mode, and the
 * gateway mode gets OpenSSH's host-key verification against the pin file).
 * This module owns what they share:
 *
 * - locating `ssh` once, as an absolute path;
 * - the private control-socket directory for connection multiplexing;
 * - a captured runner that copes with ControlPersist (see runSshCaptured);
 * - classifying ssh's exit 255 into "could not connect" ConnectionErrors,
 *   including the gateway proxy's stable stderr marker line.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants as fsConstants, lstatSync, mkdirSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { runtimeDir } from '../paths.js';
import { ConnectionError, type ExecOptions, type ExecOutcome } from './types.js';

/** ssh's exit status for its own failures (connect, auth, host key, proxy). */
export const SSH_FAILURE_EXIT = 255;

/** How long a multiplexed master outlives its last client, in seconds. */
export const CONTROL_PERSIST_SECONDS = 60;

/**
 * Marker the gateway proxy prints on stderr for a classified failure:
 * `pocketshell-client-proxy: <CODE>: <message>`. ssh relays the
 * ProxyCommand's stderr, so the client can tell "not logged in" from
 * "host offline" even though ssh itself only says 255.
 */
export const PROXY_MARKER = 'pocketshell-client-proxy';

const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
/** After ssh exits, how long to wait for stragglers holding its stderr pipe. */
const STDERR_GRACE_MS = 150;
/**
 * Unix socket paths are capped at 104 bytes (macOS) / 108 (Linux),
 * including the NUL, and OpenSSH binds the master at `<ControlPath>.<16
 * random chars>` before renaming it. Keep the final path at or under this.
 */
const MAX_CONTROL_PATH = 103 - 17;

let sshPathCache: string | undefined;

/** The absolute path of the OpenSSH client on PATH. */
export function findSsh(): string {
  if (sshPathCache) return sshPathCache;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, 'ssh');
    try {
      accessSync(candidate, fsConstants.X_OK);
      sshPathCache = candidate;
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  throw new ConnectionError('the OpenSSH client `ssh` was not found on PATH', 'SSH_MISSING', 4);
}

// --- control sockets --------------------------------------------------------

/** Characters ssh would expand or split in a ControlPath (`%`, `~`, `$`, whitespace, quotes). */
const UNSAFE_CONTROL_DIR = /[\s%$~'"\\`]|[^\x21-\x7e]/;

function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory()) throw new Error(`${dir} is not a directory`);
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) throw new Error(`${dir} is not owned by you`);
  if (st.mode & 0o022) throw new Error(`${dir} is writable by group/others`);
}

let controlDirCache: string | undefined;

/**
 * A private (ours, not group/world-writable) directory for control
 * sockets, short enough for a unix socket path. Prefers the runtime dir
 * from paths.ts; falls back to `/tmp/psc-<uid>`. Throws a ConnectionError
 * when neither is safe — multiplexing over a socket others could replace
 * is not worth the speed.
 */
export function controlDir(): string {
  if (controlDirCache) return controlDirCache;
  const candidates = [runtimeDir(), join('/tmp', `psc-${process.getuid?.() ?? 'u'}`)];
  const problems: string[] = [];
  for (const dir of candidates) {
    // `<dir>/x-<16 hex>` is the longest name we put in it.
    if (dir.length + 1 + 2 + 16 > MAX_CONTROL_PATH) {
      problems.push(`${dir}: too long for a unix socket path`);
      continue;
    }
    if (UNSAFE_CONTROL_DIR.test(dir)) {
      problems.push(`${dir}: contains characters ssh would expand`);
      continue;
    }
    try {
      ensurePrivateDir(dir);
      controlDirCache = dir;
      return dir;
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new ConnectionError(`no private directory for ssh control sockets (${problems.join('; ')})`, 'CONTROL_DIR', 4);
}

/** Test hook: forget the cached control dir / ssh path. */
export function resetOpenSshCaches(): void {
  controlDirCache = undefined;
  sshPathCache = undefined;
}

/**
 * The ControlPath for one saved host configuration. We hash the config
 * ourselves instead of using `%C`: it keeps the path short, and two host
 * entries that differ in user/port/identity/server never share a master.
 */
export function controlPathFor(kind: 's' | 'g', identity: unknown, dir = controlDir()): string {
  const digest = createHash('sha256').update(JSON.stringify([kind, identity])).digest('hex').slice(0, 16);
  return join(dir, `${kind}-${digest}`);
}

export function multiplexOptions(controlPath: string): string[] {
  return [
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=${controlPath}`,
    '-o', `ControlPersist=${CONTROL_PERSIST_SECONDS}`,
  ];
}

// --- validation -------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const CONTROL_OR_SPACE = /[\s\x00-\x1f\x7f-\x9f]/;

/** Refuse an ssh destination that could be read as an option or split. */
export function validateDestination(destination: string): string {
  if (!destination) throw new ConnectionError('ssh destination is empty', 'BAD_HOST', 2);
  if (destination.startsWith('-')) {
    throw new ConnectionError(`ssh destination ${JSON.stringify(destination)} must not start with '-'`, 'BAD_HOST', 2);
  }
  if (CONTROL_OR_SPACE.test(destination)) {
    throw new ConnectionError(
      `ssh destination ${JSON.stringify(destination)} contains whitespace or control characters`,
      'BAD_HOST',
      2,
    );
  }
  return destination;
}

/** Same rules for any other value handed to ssh as a separate argument (user, key path). */
export function validateArgValue(what: string, value: string): string {
  if (!value || value.startsWith('-') || /[\x00-\x1f\x7f]/.test(value)) {
    throw new ConnectionError(`invalid ${what} ${JSON.stringify(value)}`, 'BAD_HOST', 2);
  }
  return value;
}

// --- running ssh ------------------------------------------------------------

/**
 * Like process.ts's runCaptured, with one difference that matters for
 * ControlPersist: when ssh creates a master it forks it into the
 * background, and any ProxyCommand (the gateway proxy, a ProxyJump `ssh
 * -W`) started by that master keeps the stderr pipe we gave the first ssh
 * open for as long as the master lives. Waiting for every pipe to close
 * would hang the first call for ControlPersist seconds, so we finish once
 * ssh has exited and stdout has ended, giving stderr a short grace.
 */
export function runSshCaptured(
  file: string,
  argv: readonly string[],
  options: ExecOptions & { env?: NodeJS.ProcessEnv },
): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    const child = spawn(file, argv, { stdio: ['pipe', 'pipe', 'pipe'], env: options.env ?? process.env });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let settled = false;
    let exitCode: number | null | undefined;
    let stdoutEnded = false;
    let stderrEnded = false;
    let graceTimer: NodeJS.Timeout | undefined;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    }, options.timeoutMs);

    const finish = (extraErr = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({
        exitCode: timedOut ? null : (exitCode ?? null),
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8') + extraErr,
        timedOut,
      });
    };
    const maybeFinish = () => {
      if (exitCode === undefined || !stdoutEnded) return;
      if (stderrEnded) finish();
      else if (!graceTimer) graceTimer = setTimeout(() => finish(), STDERR_GRACE_MS);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      if (outBytes < MAX_CAPTURE_BYTES) out.push(chunk);
      outBytes += chunk.length;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (errBytes < MAX_CAPTURE_BYTES) err.push(chunk);
      errBytes += chunk.length;
    });
    child.stdout.on('close', () => {
      stdoutEnded = true;
      maybeFinish();
    });
    child.stderr.on('close', () => {
      stderrEnded = true;
      maybeFinish();
    });
    child.on('error', (error) => {
      exitCode = null;
      finish(`${error.message}\n`);
    });
    child.on('exit', (code) => {
      exitCode = code;
      maybeFinish();
    });

    child.stdin.on('error', () => {
      /* the command may exit without reading stdin: EPIPE is not our failure */
    });
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}

// --- classifying failures ---------------------------------------------------

interface Pattern {
  re: RegExp;
  code: string;
}

const PATTERNS: Pattern[] = [
  { re: /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|host key .* has changed|No \S+ host key is known for/i, code: 'HOST_KEY_FAILED' },
  { re: /Permission denied \(|Too many authentication failures|Authentication failed|no supported authentication methods/i, code: 'AUTH_FAILED' },
  {
    re: /Could not resolve hostname|Name or service not known|nodename nor servname|Temporary failure in name resolution|Connection refused|Connection timed out|Operation timed out|No route to host|Network is unreachable|Connection reset|Connection closed by|kex_exchange_identification|banner exchange|ssh: connect to host|Unable to negotiate|proxy dialog|ProxyCommand|Bad owner or permissions|Bad configuration option|Can't open user config file|no address associated/i,
    code: 'CONNECT_FAILED',
  },
];

const PROXY_MARKER_RE = new RegExp(`^${PROXY_MARKER}: ([A-Z][A-Z_]{1,40}): (.*)$`);

/** Exit status the CLI uses for a proxy-classified failure code. */
function exitForCode(code: string): number {
  if (code === 'NOT_LOGGED_IN') return 3;
  if (code === 'USAGE') return 2;
  return 4;
}

function lines(stderr: string): string[] {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.replace(/[\x00-\x1f\x7f]/g, '').trim())
    .filter(Boolean);
}

/**
 * Turn an ssh failure into a typed ConnectionError, or null when the
 * outcome looks like the remote command's own result. Only exit 255
 * qualifies, and only with recognisably ssh-made stderr (a remote command
 * may legitimately exit 255 too).
 */
export function classifySshFailure(
  outcome: Pick<ExecOutcome, 'exitCode' | 'stderr' | 'timedOut'>,
  context: { hostName: string; how: string; hint?: Partial<Record<string, string>> },
): ConnectionError | null {
  if (outcome.timedOut || outcome.exitCode !== SSH_FAILURE_EXIT) return null;
  const all = lines(outcome.stderr);
  for (const line of all) {
    const marker = PROXY_MARKER_RE.exec(line);
    if (marker) {
      const [, code, message] = marker as unknown as [string, string, string];
      const hint = context.hint?.[code];
      return new ConnectionError(
        `${context.hostName}: ${message.slice(0, 300)}${hint ? ` (${hint})` : ''}`,
        code,
        exitForCode(code),
      );
    }
  }
  for (const { re, code } of PATTERNS) {
    const hit = all.find((line) => re.test(line));
    if (hit) {
      const last = all[all.length - 1] ?? hit;
      const detail = last === hit ? hit : `${hit}; ${last}`;
      const hint = context.hint?.[code];
      return new ConnectionError(
        `cannot reach ${context.hostName} ${context.how}: ${detail.slice(0, 400)}${hint ? ` (${hint})` : ''}`,
        code,
        4,
      );
    }
  }
  const last = all[all.length - 1];
  if (last && /^(ssh|mux_client|muxclient|control_|channel \d+:)/i.test(last)) {
    return new ConnectionError(`cannot reach ${context.hostName} ${context.how}: ${last.slice(0, 400)}`, 'CONNECT_FAILED', 4);
  }
  return null;
}

/** Shell-quote one word for /bin/sh (single quotes; `'` as `'\''`). */
export function shQuote(word: string): string {
  if (word !== '' && /^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}
