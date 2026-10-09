/**
 * Child-process helpers shared by the modes that shell out (local runs the
 * command itself, ssh and gateway run OpenSSH).
 */
import { spawn } from 'node:child_process';
import { runSessionInteractive, type SessionInteractiveOptions } from './sessionInteractive.js';
import type { ExecOptions, ExecOutcome } from './types.js';

/** Hard cap on captured output per stream, so a runaway command can't OOM us. */
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
/** SIGTERM → SIGKILL escalation for a timed-out command's process group. */
const KILL_GRACE_MS = 2_000;
/** After the child exits, how long stdout/stderr may keep draining before we stop waiting. */
const DRAIN_GRACE_MS = 250;

/**
 * Process groups of captured commands still running. Each captured command
 * runs in its own group (detached), so a timeout can kill the whole tree —
 * `sh -c 'sleep 15; true'` leaves `sleep` behind if only `sh` is killed.
 * The flip side: a terminal Ctrl+C no longer reaches them, so we forward
 * SIGINT/SIGTERM/SIGHUP and kill them on exit ourselves.
 */
const liveGroups = new Set<number>();
const FORWARDED = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    /* already gone */
  }
}

function onExit(): void {
  for (const pid of liveGroups) killGroup(pid, 'SIGTERM');
}

function onSignal(signal: NodeJS.Signals): void {
  for (const pid of liveGroups) killGroup(pid, signal === 'SIGINT' ? 'SIGINT' : 'SIGTERM');
  // Only stand in for the default action when nobody else handles the signal.
  if (process.listenerCount(signal) === 1) {
    liveGroups.clear();
    detachHandlers();
    process.kill(process.pid, signal);
  }
}

function detachHandlers(): void {
  process.off('exit', onExit);
  for (const signal of FORWARDED) process.off(signal, onSignal);
}

function watch(pid: number): void {
  if (liveGroups.size === 0) {
    process.on('exit', onExit);
    for (const signal of FORWARDED) process.on(signal, onSignal);
  }
  liveGroups.add(pid);
}

function unwatch(pid: number): void {
  if (liveGroups.delete(pid) && liveGroups.size === 0) detachHandlers();
}

/**
 * Spawn `file argv`, feed stdin, capture both streams, enforce the timeout.
 *
 * The child leads its own process group; on timeout the whole group gets
 * SIGTERM, then SIGKILL after 2 s. We settle on the child's `exit` (plus a
 * short drain), not on `close`: a grandchild that inherited the pipes and
 * outlives the child must not hold the result hostage.
 */
export function runCaptured(
  file: string,
  argv: readonly string[],
  options: ExecOptions & { env?: NodeJS.ProcessEnv },
): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    const child = spawn(file, argv, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: options.env ?? process.env,
      detached: true,
      windowsHide: true,
    });
    const pid = child.pid;
    if (pid !== undefined) watch(pid);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let settled = false;
    const timers: NodeJS.Timeout[] = [];

    timers.push(
      setTimeout(() => {
        timedOut = true;
        if (pid !== undefined) killGroup(pid, 'SIGTERM');
        else child.kill('SIGTERM');
        timers.push(
          setTimeout(() => {
            if (pid !== undefined) killGroup(pid, 'SIGKILL');
            else child.kill('SIGKILL');
            // Even an unkillable (D-state) child must not hang the caller.
            timers.push(setTimeout(() => finish(null), 1_000));
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
    const finish = (exitCode: number | null, extraErr = '') => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      if (pid !== undefined) {
        // A timed-out tree is killed whole; stragglers of a clean exit are left alone.
        if (timedOut) killGroup(pid, 'SIGKILL');
        unwatch(pid);
      }
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({
        exitCode: timedOut ? null : exitCode,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8') + extraErr,
        timedOut,
      });
    };
    child.on('error', (error) => finish(null, `${error.message}\n`));
    child.on('exit', (code) => {
      timers.push(setTimeout(() => finish(code), DRAIN_GRACE_MS));
    });
    child.on('close', (code) => finish(code));

    child.stdin.on('error', () => {
      /* the command may exit without reading stdin: EPIPE is not our failure */
    });
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}

/**
 * Spawn `file argv` on this process's terminal (inherited stdio) and wait.
 * The child owns the tty while it runs: resize, Ctrl+C and friends reach it
 * directly, and we ignore SIGINT so a Ctrl+C meant for the child doesn't
 * kill the client underneath it.
 */
export function runInteractive(
  file: string,
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  options: SessionInteractiveOptions = {},
): Promise<number | null> {
  if (options.sessionDetach) return runSessionInteractive(file, argv, env, options);
  return new Promise((resolve) => {
    const ignore = () => {};
    process.on('SIGINT', ignore);
    const child = spawn(file, argv, { stdio: 'inherit', env });
    const done = (code: number | null) => {
      process.off('SIGINT', ignore);
      resolve(code);
    };
    child.on('error', () => done(null));
    child.on('close', (code) => done(code));
  });
}
