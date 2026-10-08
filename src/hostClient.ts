/**
 * Everything the client asks of a PocketShell host, over any Connection.
 *
 * The versioned contract lives in core: `HostCliCore` builds the
 * `pocketshell …` commands and parses their schema-checked JSON. This class
 * adds the PATH wrapper (sshd exec channels rarely have ~/.local/bin) and
 * the few aplexer verbs the host CLI doesn't carry yet — `send` and
 * `capture` — which agents need to drive a session without attaching.
 */
import {
  HostCliCore,
  pathAwareCommand,
  shellQuote,
  type CreatedSession,
  type HostEngineInfo,
  type HostProfileInfo,
  type SessionRow,
  type SessionsListing,
  type WarningRow,
  type WorkspacesListing,
} from '@pocketshell/core';
import type { Connection, ExecOutcome } from './transport/types.js';

const DEFAULT_TIMEOUT_MS = 30_000;

export class HostCommandError extends Error {
  readonly code = 'HOST_COMMAND_FAILED';
  constructor(
    message: string,
    readonly outcome: ExecOutcome,
  ) {
    super(message);
    this.name = 'HostCommandError';
  }
}

export class SessionNotFound extends Error {
  readonly code = 'SESSION_NOT_FOUND';
  constructor(selector: string) {
    super(`no session matches ${JSON.stringify(selector)} (see \`sessions list\`)`);
    this.name = 'SessionNotFound';
  }
}

export class HostClient {
  readonly cli: HostCliCore;

  constructor(
    readonly connection: Connection,
    binary = 'pocketshell',
  ) {
    this.cli = new HostCliCore(
      {
        exec: (command, timeoutMs) => this.run(command, timeoutMs),
      },
      binary,
    );
  }

  /** Run a raw command under the user's full PATH. */
  run(command: string, timeoutMs = DEFAULT_TIMEOUT_MS, stdin?: string | Uint8Array): Promise<ExecOutcome> {
    return this.connection.exec(pathAwareCommand(command), { timeoutMs, stdin });
  }

  /** Like `run`, but a non-zero exit is an error. */
  async runChecked(command: string, timeoutMs = DEFAULT_TIMEOUT_MS, stdin?: string | Uint8Array): Promise<string> {
    const outcome = await this.run(command, timeoutMs, stdin);
    if (outcome.timedOut) throw new HostCommandError(`\`${command}\` timed out after ${timeoutMs} ms`, outcome);
    if (outcome.exitCode !== 0) {
      const detail = outcome.stderr.trim().split('\n').slice(-3).join(' ') || `exit ${outcome.exitCode}`;
      throw new HostCommandError(`\`${command}\` failed: ${detail}`, outcome);
    }
    return outcome.stdout;
  }

  /** Is the host CLI there at all, and which version? Never throws. */
  async probe(): Promise<{ pocketshell: string | null; aplexer: string | null }> {
    const version = async (command: string) => {
      try {
        const outcome = await this.run(command, 15_000);
        return outcome.exitCode === 0 ? outcome.stdout.trim().split('\n').pop() ?? null : null;
      } catch {
        return null;
      }
    };
    const [pocketshell, aplexer] = await Promise.all([
      version(`${this.cli.binary} --version`),
      version('a --version'),
    ]);
    return { pocketshell, aplexer };
  }

  listSessions(): Promise<SessionsListing> {
    return this.cli.listSessions();
  }

  /**
   * Resolve what a user or agent typed to one session row: the exact
   * `name` (`workspace:tag`), the aplexer id or a unique id prefix, or a
   * bare tag when exactly one session carries it.
   */
  async resolveSession(selector: string): Promise<SessionRow> {
    const { sessions } = await this.listSessions();
    const exact = sessions.find((row) => row.name === selector || row.id === selector);
    if (exact) return exact;
    const byPrefix = selector.length >= 4 ? sessions.filter((row) => row.id?.startsWith(selector)) : [];
    if (byPrefix.length === 1) return byPrefix[0]!;
    const byTag = sessions.filter((row) => row.tag === selector);
    if (byTag.length === 1) return byTag[0]!;
    if (byPrefix.length > 1 || byTag.length > 1) {
      const names = [...byPrefix, ...byTag].map((row) => row.name).join(', ');
      throw new Error(`${JSON.stringify(selector)} is ambiguous: ${names}`);
    }
    throw new SessionNotFound(selector);
  }

  createSession(
    name: string,
    options: { cwd?: string | null; engine?: string | null; profile?: string | null } = {},
  ): Promise<CreatedSession> {
    return this.cli.createSession(name, options);
  }

  killSession(name: string): Promise<void> {
    return this.cli.killSession(name);
  }

  listWarnings(): Promise<WarningRow[]> {
    return this.cli.listWarnings();
  }

  ackWarnings(selector?: string | null): Promise<void> {
    return this.cli.ackWarnings(selector);
  }

  listEngines(): Promise<HostEngineInfo[]> {
    return this.cli.listEngines();
  }

  listProfiles(): Promise<HostProfileInfo[]> {
    return this.cli.listProfiles();
  }

  /** The workspace registry is partitioned per client host identity: the saved host name. */
  listWorkspaces(): Promise<WorkspacesListing> {
    return this.cli.listWorkspaces(this.connection.hostName);
  }

  addWorkspace(path: string): Promise<WorkspacesListing> {
    return this.cli.addWorkspace(this.connection.hostName, path);
  }

  removeWorkspace(path: string): Promise<WorkspacesListing> {
    return this.cli.removeWorkspace(this.connection.hostName, path);
  }

  /** Type into a session without attaching: `a send <id> --stdin [--enter]`. */
  async send(session: SessionRow, text: string, options: { enter?: boolean } = {}): Promise<void> {
    const target = shellQuote(session.id ?? session.name);
    await this.runChecked(`a send ${target} --stdin${options.enter ? ' --enter' : ''}`, DEFAULT_TIMEOUT_MS, text);
  }

  /** What the session shows right now (`--screen --plain`) or its recent raw output. */
  capture(session: SessionRow, options: { mode: 'screen' | 'raw'; bytes?: number }): Promise<string> {
    const target = shellQuote(session.id ?? session.name);
    const flags = options.mode === 'screen' ? '--screen --plain' : options.bytes ? `--bytes ${Math.floor(options.bytes)}` : '';
    return this.runChecked(`a capture ${target} ${flags}`.trim());
  }

  /**
   * The attach command for a PTY. Prefer aplexer's own client (`a attach
   * <id>`): it draws the status row and honours Ctrl-b d to detach.
   * `pocketshell sessions attach` execs `a attach --no-status`, a bare relay
   * made for Android's own chrome with no detach chord, so it is only the
   * fallback for a row without an aplexer id.
   */
  attachCommand(session: SessionRow): string {
    if (session.id) return pathAwareCommand(`exec a attach ${shellQuote(session.id)}`);
    return pathAwareCommand(this.cli.buildAttachCommand(session.name));
  }

  attach(session: SessionRow): Promise<number | null> {
    return this.connection.attachInteractive(this.attachCommand(session));
  }
}
