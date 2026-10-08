/**
 * Child-process helpers shared by the modes that shell out (local runs the
 * command itself, ssh and gateway run OpenSSH).
 */
import { spawn } from 'node:child_process';
import type { ExecOptions, ExecOutcome } from './types.js';

/** Hard cap on captured output per stream, so a runaway command can't OOM us. */
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;

/** Spawn `file argv`, feed stdin, capture both streams, enforce the timeout. */
export function runCaptured(
  file: string,
  argv: readonly string[],
  options: ExecOptions & { env?: NodeJS.ProcessEnv },
): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    const child = spawn(file, argv, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: options.env ?? process.env,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    }, options.timeoutMs);

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
      clearTimeout(timer);
      resolve({
        exitCode: timedOut ? null : exitCode,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8') + extraErr,
        timedOut,
      });
    };
    child.on('error', (error) => finish(null, `${error.message}\n`));
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
): Promise<number | null> {
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
