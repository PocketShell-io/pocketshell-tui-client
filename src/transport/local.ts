/**
 * Local mode: PocketShell on this very machine, no SSH in between.
 *
 * Commands run through `/bin/sh -c` exactly as sshd would run them on a
 * remote host, so the same command strings (HostCliCore's, aplexer's) work
 * unchanged. Attach runs the attach command on this terminal directly.
 */
import { runCaptured, runInteractive } from './process.js';
import type { Connection, ExecOptions, ExecOutcome } from './types.js';

export class LocalConnection implements Connection {
  readonly mode = 'local' as const;

  constructor(readonly hostName: string) {}

  exec(command: string, options: ExecOptions): Promise<ExecOutcome> {
    return runCaptured('/bin/sh', ['-c', command], options);
  }

  attachInteractive(command: string): Promise<number | null> {
    return runInteractive('/bin/sh', ['-c', command]);
  }

  async close(): Promise<void> {}
}
