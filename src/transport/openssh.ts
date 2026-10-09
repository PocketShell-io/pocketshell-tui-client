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
 *   from the gateway proxy's status file, its stderr marker line, or ssh's
 *   own diagnostics, without swallowing a remote command's own exit 255.
 */
import { bindings, callNative, nativeRead, nativeWrite } from '../platform/windows.js';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, normalize } from 'node:path';
import { runtimeDir } from '../paths.js';
import { ConnectionError, type ExecOptions, type ExecOutcome } from './types.js';

/** ssh's exit status for its own failures (connect, auth, host key, proxy). */
export const SSH_FAILURE_EXIT = 255;

/** How long a multiplexed master outlives its last client, in seconds. */
export const CONTROL_PERSIST_SECONDS = 60;

/**
 * Marker the gateway proxy prints on stderr for a classified failure:
 * `pocketshell-tui-client-proxy: <CODE>: <message>`. ssh relays the
 * ProxyCommand's stderr, so the client can tell "not logged in" from
 * "host offline" even though ssh itself only says 255.
 */
export const PROXY_MARKER = 'pocketshell-tui-client-proxy';

const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
/** After ssh exits (and stdout ended), how long to wait for stragglers holding its stderr pipe. */
const STDERR_GRACE_MS = 150;
/**
 * After ssh exits, how long to wait for stdout to end. ssh's stdout is
 * written by ssh alone, so whatever is left is at most one pipe buffer and
 * drains at once; the bound only matters if a forked helper kept the fd.
 */
const STDOUT_GRACE_MS = 1_000;
/** On timeout: SIGTERM, then SIGKILL after this... */
const KILL_GRACE_MS = 2_000;
/** ...then settle after this even if no exit event ever arrives. */
const HARD_SETTLE_MS = 1_000;
/**
 * Unix socket paths are capped at 104 bytes (macOS) / 108 (Linux),
 * including the NUL, and OpenSSH binds the master at `<ControlPath>.<16
 * random chars>` before renaming it. Keep the final path at or under this.
 */
const MAX_CONTROL_PATH = 103 - 17;

let sshPathCache: string | undefined;

/** The absolute path of the OpenSSH client on PATH. */
export function findSsh(): string {
  if (process.platform === 'win32') { const b=bindings(); callNative({op:'check-executable',root:runtimeDir(),path:b.ssh}); return b.ssh; }
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
  if (process.platform === 'win32') { const dir=runtimeDir(); callNative({op:'preflight',root:dir}); return dir; }
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
 * background, and a ProxyCommand started before the fork (the gateway
 * proxy, a ProxyJump `ssh -W`) can keep the pipes we gave the first ssh
 * open for as long as the master lives. Waiting for every pipe to close
 * would hang the first call for ControlPersist seconds, so we settle once
 * ssh has exited: stdout gets STDOUT_GRACE_MS to drain, stderr a further
 * STDERR_GRACE_MS.
 *
 * Timeout: SIGTERM to ssh (its own handler tears down a non-multiplexed
 * ProxyCommand; a mux client just disconnects from the master, which keeps
 * serving others), SIGKILL after KILL_GRACE_MS, and the promise settles
 * HARD_SETTLE_MS later no matter what — never on held-open pipes. We
 * deliberately do not kill the process group: the background master's
 * ProxyCommand is in it, and killing that would tear down a master other
 * calls share. Resolves `{exitCode: null, timedOut: true}` like runCaptured.
 */
export function runSshCaptured(
  file: string,
  argv: readonly string[],
  options: ExecOptions & { env?: NodeJS.ProcessEnv },
): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    const child = spawn(file, argv, { stdio: ['pipe', 'pipe', 'pipe'], env: options.env ?? process.env, windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let settled = false;
    let exitCode: number | null | undefined;
    let stdoutEnded = false;
    let stderrEnded = false;
    const timers: NodeJS.Timeout[] = [];
    let stdoutTimer: NodeJS.Timeout | undefined;
    let stderrTimer: NodeJS.Timeout | undefined;

    const finish = (extraErr = '') => {
      if (settled) return;
      settled = true;
      for (const t of [...timers, stdoutTimer, stderrTimer]) if (t) clearTimeout(t);
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
      if (exitCode === undefined) return;
      if (!stdoutEnded) {
        stdoutTimer ??= setTimeout(() => finish(), STDOUT_GRACE_MS);
        return;
      }
      if (stderrEnded) finish();
      else stderrTimer ??= setTimeout(() => finish(), STDERR_GRACE_MS);
    };

    timers.push(
      setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        timers.push(
          setTimeout(() => {
            if (exitCode === undefined) child.kill('SIGKILL');
            timers.push(setTimeout(() => finish(), HARD_SETTLE_MS));
          }, KILL_GRACE_MS),
        );
      }, options.timeoutMs),
    );

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

// --- the gateway proxy's status file ----------------------------------------

/*
 * With ControlPersist, OpenSSH points a ProxyCommand's stderr at /dev/null
 * (the master it may become outlives the terminal), so the proxy's stderr
 * marker never reaches us exactly when multiplexing is on. The proxy
 * therefore ALSO writes its final marker line to a status file whose path
 * we pass in its argv: fresh per ssh invocation (ProxyCommand argv is fixed
 * per ssh run, and only the run that creates the master starts it), inside
 * the private control dir, read and deleted after ssh exits.
 */

/** Basename of a status file: `st-` + 24 hex digits. */
export const STATUS_FILE_RE = /^st-[0-9a-f]{24}$/;
const MAX_STATUS_BYTES = 4096;
/** Status files older than this are leftovers (a proxy that outlived its ssh). */
const STALE_STATUS_MS = 10 * 60_000;

/** A fresh status-file path in `dir` (our private control dir); sweeps stale ones. */
export function newStatusFilePath(dir: string): string {
  if (process.platform === 'win32') { if(dir!==runtimeDir()) throw new Error('Windows status root refused'); callNative({op:'preflight',root:dir}); return join(dir, `st-${randomBytes(12).toString('hex')}`); }
  try {
    const now = Date.now();
    for (const name of readdirSync(dir)) {
      if (!STATUS_FILE_RE.test(name.replace(/\.tmp$/, ''))) continue;
      const path = join(dir, name);
      try {
        if (now - lstatSync(path).mtimeMs > STALE_STATUS_MS) unlinkSync(path);
      } catch {
        /* raced with another sweep */
      }
    }
  } catch {
    /* unreadable dir: the write side will refuse it too */
  }
  return join(dir, `st-${randomBytes(12).toString('hex')}`);
}

function checkStatusPath(path: string): void {
  if (!isAbsolute(path) || normalize(path) !== path || !STATUS_FILE_RE.test(basename(path))) {
    throw new Error('not a status-file path');
  }
  const dir = lstatSync(dirname(path));
  const uid = process.getuid?.();
  if (!dir.isDirectory()) throw new Error('status-file directory is not a directory');
  if (uid !== undefined && dir.uid !== uid) throw new Error('status-file directory is not owned by you');
  if (dir.mode & 0o022) throw new Error('status-file directory is writable by group/others');
}

/**
 * Atomically write `line` to the status file: refuse a path outside a
 * private directory of ours, create `<path>.tmp` exclusively (O_EXCL,
 * O_NOFOLLOW, 0600), then rename it into place. Throws on any refusal.
 */
export function writeStatusFile(path: string, line: string): void {
  if (process.platform === 'win32') {
    if(dirname(path)!==runtimeDir() || !STATUS_FILE_RE.test(basename(path))) throw new Error('Windows status path refused');
    nativeWrite(dirname(path),'status',Buffer.from(`${line.slice(0,MAX_STATUS_BYTES-2)}\n`),basename(path)); return;
  }
  checkStatusPath(path);
  const tmp = `${path}.tmp`;
  const fd = openSync(
    tmp,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    writeSync(fd, Buffer.from(`${line.slice(0, MAX_STATUS_BYTES - 2)}\n`, 'utf8'));
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export interface ProxyStatus {
  code: string;
  message: string;
}

/** Read, delete and parse a status file. Null when absent, unsafe or not a marker. */
export function readStatusFile(path: string | null | undefined): ProxyStatus | null {
  if(process.platform==='win32') {
    if(!path) return null;
    if(dirname(path)!==runtimeDir() || !STATUS_FILE_RE.test(basename(path))) return null;
    const b=nativeRead(dirname(path),'status',basename(path)); if(b===null) return null;
    callNative({op:'remove',root:dirname(path),kind:'status',name:basename(path)});
    for(const line of lines(b.toString('utf8'))) {const m=PROXY_MARKER_RE.exec(line);if(m)return {code:m[1]!,message:m[2]!};}
    return null;
  }
  if (!path) return null;
  let text = '';
  try {
    const fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const st = fstatSync(fd);
      const uid = process.getuid?.();
      if (!st.isFile() || (uid !== undefined && st.uid !== uid) || st.size > MAX_STATUS_BYTES) return null;
      const buf = Buffer.alloc(st.size);
      const n = readSync(fd, buf, 0, st.size, 0);
      text = buf.subarray(0, n).toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  } finally {
    for (const p of [path, `${path}.tmp`]) {
      try {
        unlinkSync(p);
      } catch {
        /* absent */
      }
    }
  }
  for (const line of lines(text)) {
    const marker = PROXY_MARKER_RE.exec(line);
    if (marker) return { code: marker[1]!, message: marker[2]! };
  }
  return null;
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

export interface FailureContext {
  hostName: string;
  how: string;
  hint?: Partial<Record<string, string>>;
}

/** The ConnectionError for a proxy-classified failure (status file or stderr marker). */
export function proxyFailure(status: ProxyStatus, context: FailureContext): ConnectionError {
  const hint = context.hint?.[status.code];
  return new ConnectionError(
    `${context.hostName}: ${status.message.slice(0, 300)}${hint ? ` (${hint})` : ''}`,
    status.code,
    exitForCode(status.code),
  );
}

/** A last stderr line that is the mux client / channel layer's own complaint. */
const MUX_LINE_RE = /^(mux_client|muxclient|control_|channel \d+:)/i;

/**
 * Turn an ssh failure into a typed ConnectionError, or null when the
 * outcome looks like the remote command's own result. Pure; looks at the
 * captured output only (see explainSshExit for the full decision).
 *
 * Only exit 255 qualifies, only with empty stdout (ssh failing before the
 * session prints nothing there, so any stdout means the remote command ran
 * and its 255 is its own), and only with recognisably ssh-made stderr.
 */
export function classifySshFailure(
  outcome: Pick<ExecOutcome, 'exitCode' | 'stderr' | 'timedOut'> & { stdout?: string },
  context: FailureContext,
): ConnectionError | null {
  if (outcome.timedOut || outcome.exitCode !== SSH_FAILURE_EXIT) return null;
  if (outcome.stdout) return null;
  const all = lines(outcome.stderr);
  for (const line of all) {
    const marker = PROXY_MARKER_RE.exec(line);
    if (marker) return proxyFailure({ code: marker[1]!, message: marker[2]! }, context);
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
  if (last && (/^ssh/i.test(last) || MUX_LINE_RE.test(last))) {
    return new ConnectionError(`cannot reach ${context.hostName} ${context.how}: ${last.slice(0, 400)}`, 'CONNECT_FAILED', 4);
  }
  return null;
}

/** Is a multiplexing master answering on `controlPath`? (`ssh -O check`, local socket only.) */
export async function masterRunning(sshPath: string, controlPath: string): Promise<boolean> {
  const probe = await runSshCaptured(
    sshPath,
    ['-F', 'none', '-o', `ControlPath=${controlPath}`, '-O', 'check', 'pocketshell-tui-client-check'],
    { timeoutMs: 3_000 },
  );
  return probe.exitCode === 0;
}

export interface ExitProbe {
  sshPath: string;
  /** The ControlPath the call used, or null without multiplexing. */
  controlPath: string | null;
  /** The status file handed to the gateway proxy for this ssh run, if any. Always consumed. */
  statusFile?: string | null;
}

/**
 * Decide whether a finished captured ssh run failed to connect. Precedence:
 *
 * 1. the proxy's status file (gateway mode; the only channel that works
 *    when ControlPersist has silenced the ProxyCommand's stderr). The proxy
 *    writes it only for failures BEFORE the tunnel was up, so its presence
 *    proves no session ran;
 * 2. the proxy's stderr marker line (no multiplexing), then ssh's own
 *    diagnostics — both via classifySshFailure, which already refuses when
 *    stdout is non-empty;
 * 3. disambiguation for a remote command that itself exits 255 with
 *    ssh-looking stderr (a nested ssh failing): with multiplexing, if
 *    `ssh -O check` finds a live master after the run, our own connection
 *    and authentication demonstrably worked, so the 255 belongs to the
 *    remote command — unless the last stderr line is the mux client's own
 *    complaint (session/channel refused by the master).
 *
 * Known limit: without multiplexing, a remote command that exits 255 with
 * empty stdout and an ssh-shaped last stderr line is still read as ours.
 */
export async function explainSshExit(
  outcome: ExecOutcome,
  context: FailureContext,
  probe: ExitProbe,
): Promise<ConnectionError | null> {
  const status = readStatusFile(probe.statusFile);
  if (outcome.timedOut || outcome.exitCode !== SSH_FAILURE_EXIT) return null;
  if (status) return proxyFailure(status, context);
  const candidate = classifySshFailure(outcome, context);
  if (!candidate || !probe.controlPath) return candidate;
  const last = lines(outcome.stderr).pop() ?? '';
  if (MUX_LINE_RE.test(last)) return candidate;
  return (await masterRunning(probe.sshPath, probe.controlPath)) ? null : candidate;
}

/** Shell-quote one word for /bin/sh (single quotes; `'` as `'\''`). */
export function shQuote(word: string): string {
  if (word !== '' && /^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}
