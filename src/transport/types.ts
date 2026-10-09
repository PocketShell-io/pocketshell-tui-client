/**
 * The one seam every connection mode implements: local, ssh, gateway.
 *
 * Everything above it (HostClient, the CLI commands, the TUI) is
 * mode-agnostic. A mode answers two questions: how to run a command and
 * capture its output (`exec`), and how to hand the user's terminal to a
 * remote command (`attachInteractive`).
 */

export interface ExecOptions {
  /** Hard bound on the whole command; expiry kills it and sets `timedOut`. */
  timeoutMs: number;
  /** Bytes written to the command's stdin, then EOF. */
  stdin?: Uint8Array | string;
}

export interface ExecOutcome {
  /** Null means the command never reported an exit status (killed, lost). */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface Connection {
  /** The saved host's name, for messages. */
  readonly hostName: string;
  readonly mode: HostMode;
  /** Run `command` through the host's POSIX shell and capture its output. */
  exec(command: string, options: ExecOptions): Promise<ExecOutcome>;
  /**
   * Run `command` on a PTY wired to this process's own terminal (stdin,
   * stdout, resize) until it exits. Resolves with its exit code. The caller
   * must have released the terminal (no raw mode, no TUI) before calling.
   */
  attachInteractive(command: string): Promise<number | null>;
  /** Release anything held open (multiplexed masters, sockets). Idempotent. */
  close(): Promise<void>;
}

export type HostMode = 'local' | 'ssh' | 'gateway';

/** A typed failure a mode raises when it cannot reach the host at all. */
export class ConnectionError extends Error {
  constructor(
    message: string,
    /** Stable machine code: CONNECT_FAILED, NOT_LOGGED_IN, NOT_PINNED, HOST_OFFLINE, ... */
    readonly code: string,
    /** Suggested process exit status for the CLI. */
    readonly exitCode = 4,
  ) {
    super(message);
    this.name = 'ConnectionError';
  }
}
