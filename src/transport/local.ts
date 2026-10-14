/**
 * Local mode: PocketShell on this very machine, no SSH in between.
 *
 * Commands run through `/bin/sh -c` exactly as sshd would run them on a
 * remote host, so the same command strings (HostCliCore's, aplexer's) work
 * unchanged. Attach runs the attach command on this terminal directly.
 */
import { runCaptured, runInteractive } from './process.js';
import type { AttachOptions, Connection, ExecOptions, ExecOutcome } from './types.js';

export class LocalConnection implements Connection {
  readonly mode = 'local' as const;

  constructor(readonly hostName: string) {}

  exec(command: string, options: ExecOptions): Promise<ExecOutcome> {
    return runCaptured('/bin/sh', ['-c', command], options);
  }

  attachInteractive(command: string, options: AttachOptions = {}): Promise<number | null> {
    // Empty command: this machine's interactive shell.
    if (command === '') {
      const shell =
        process.platform === 'win32' ? (process.env.COMSPEC ?? 'cmd.exe') : (process.env.SHELL ?? '/bin/sh');
      return runInteractive(shell, process.platform === 'win32' ? [] : ['-l'], process.env, options);
    }
    return runInteractive('/bin/sh', ['-c', command], process.env, options);
  }

  async close(): Promise<void> {}
}
