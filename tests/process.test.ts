/** process.ts runCaptured: timeouts kill the whole process tree; stragglers don't block. */
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { runCaptured } from '../src/transport/process.js';

function alive(pattern: string): boolean {
  try {
    return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).trim().length > 0;
  } catch {
    return false;
  }
}

/** A `sleep N.NNN` duration unique to this run, so pgrep finds only ours. */
const unique = (base: number): string => (base + Math.floor(Math.random() * 1000) / 1000 + 0.0001).toFixed(4);

describe('runCaptured', () => {
  it('a timeout kills grandchildren and returns promptly', async () => {
    const secs = unique(17);
    const started = Date.now();
    const outcome = await runCaptured('/bin/sh', ['-c', `sleep ${secs}; true`], { timeoutMs: 1_000 });
    expect(outcome).toMatchObject({ timedOut: true, exitCode: null });
    expect(Date.now() - started).toBeLessThan(3_500);
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(`sleep ${secs}`)).toBe(false);
  });

  it('a tree that ignores SIGTERM is SIGKILLed after the grace period', async () => {
    const secs = unique(23);
    const started = Date.now();
    const outcome = await runCaptured('/bin/sh', ['-c', `trap '' TERM; sleep ${secs}; true`], { timeoutMs: 500 });
    expect(outcome.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(`sleep ${secs}`)).toBe(false);
  });

  it('a backgrounded grandchild holding the pipes does not block the result', async () => {
    const secs = unique(29);
    const started = Date.now();
    const outcome = await runCaptured('/bin/sh', ['-c', `echo hi; sleep ${secs} & echo bg`], { timeoutMs: 10_000 });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(outcome).toMatchObject({ exitCode: 0, timedOut: false, stdout: 'hi\nbg\n' });
    execFileSync('pkill', ['-f', `sleep ${secs}`]);
  });

  it('captures output, exit codes and stdin', async () => {
    const outcome = await runCaptured('/bin/sh', ['-c', 'cat; echo err >&2; exit 3'], { timeoutMs: 5_000, stdin: 'in\n' });
    expect(outcome).toEqual({ exitCode: 3, stdout: 'in\n', stderr: 'err\n', timedOut: false });
  });

  it('leaves no signal or exit handlers behind', async () => {
    const before = [process.listenerCount('SIGINT'), process.listenerCount('exit')];
    await Promise.all([
      runCaptured('/bin/sh', ['-c', 'true'], { timeoutMs: 5_000 }),
      runCaptured('/bin/sh', ['-c', 'sleep 0.2'], { timeoutMs: 5_000 }),
    ]);
    expect([process.listenerCount('SIGINT'), process.listenerCount('exit')]).toEqual(before);
  });
});
