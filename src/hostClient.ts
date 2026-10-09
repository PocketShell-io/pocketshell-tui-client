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
import { HostStoreError, validateBinary, validateHostEntry, type HostEntry } from './hosts/store.js';
import { NativeWindowsHost } from './nativeWindowsHost.js';
import type { Connection, ExecOutcome } from './transport/types.js';

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * `systemd-run` (which aplexer may launch through) announces itself on
 * stderr: `Running as unit: run-u12.service; invocation ID: 3f…` (or
 * `Running scope as unit: …`). It is noise, never the answer: drop such
 * lines from the start of host text.
 */
const SYSTEMD_NOISE = /^\s*Running (?:scope )?as unit:? .*$/;

export function stripSystemdNoise(text: string): string {
  const lines = text.split('\n');
  let skip = 0;
  while (skip < lines.length && SYSTEMD_NOISE.test(lines[skip]!)) skip++;
  return skip === 0 ? text : lines.slice(skip).join('\n');
}

/** A host command (an aplexer verb, `exec`) failed, timed out, or returned no status. */
export class HostCommandError extends Error {
  readonly code: string;
  readonly exitCode: number;
  constructor(
    message: string,
    readonly outcome: ExecOutcome,
  ) {
    super(message);
    this.name = 'HostCommandError';
    this.code = outcome.timedOut ? 'TIMEOUT' : 'HOST_COMMAND_FAILED';
    this.exitCode = outcome.timedOut ? 124 : 1;
  }
}

export class SessionNotFound extends Error {
  readonly code = 'SESSION_NOT_FOUND';
  readonly exitCode = 5;
  constructor(selector: string) {
    super(`no session matches ${JSON.stringify(selector)} (see \`sessions list\`)`);
    this.name = 'SessionNotFound';
  }
}

/** A selector matched more than one session; `details.candidates` lists them. */
export class SessionAmbiguous extends Error {
  readonly code = 'SESSION_AMBIGUOUS';
  readonly exitCode = 5;
  readonly details: { candidates: Array<{ name: string; id: string | null }> };
  constructor(selector: string, rows: SessionRow[]) {
    const candidates = rows.map((row) => ({ name: row.name, id: row.id }));
    super(
      `${JSON.stringify(selector)} matches ${candidates.length} sessions: ` +
        `${candidates.map((c) => c.name).join(', ')} — use the full name or id`,
    );
    this.name = 'SessionAmbiguous';
    this.details = { candidates };
  }
}

/** The shortest id prefix `resolveSession` accepts. */
export const MIN_ID_PREFIX = 4;

const rowKey = (row: SessionRow): string => row.id ?? `name:${row.name}`;

function uniqueRows(rows: SessionRow[]): SessionRow[] {
  const seen = new Map<string, SessionRow>();
  for (const row of rows) if (!seen.has(rowKey(row))) seen.set(rowKey(row), row);
  return [...seen.values()];
}

/**
 * Pick the one session a selector means. Ranking: the exact `name`
 * (`workspace:tag`) or aplexer id wins outright; then a tag exactly one
 * session carries; then a unique id prefix (≥ 4 characters). A tag shared
 * by several sessions, several prefix matches, or a tag match and a prefix
 * match naming different sessions is ambiguous — never a silent guess.
 */
export function pickSession(sessions: SessionRow[], selector: string): SessionRow {
  const exact = sessions.find((row) => row.name === selector || (row.id !== null && row.id === selector));
  if (exact) return exact;
  const byTag = uniqueRows(sessions.filter((row) => row.tag === selector));
  const byPrefix =
    selector.length >= MIN_ID_PREFIX ? uniqueRows(sessions.filter((row) => row.id?.startsWith(selector))) : [];
  const all = uniqueRows([...byTag, ...byPrefix]);
  if (all.length === 1) return all[0]!;
  if (all.length > 1) throw new SessionAmbiguous(selector, all);
  throw new SessionNotFound(selector);
}

/** `exec` argv → one shell command: one word runs as-is, several are each quoted. */
export function execCommandLine(words: readonly string[]): string {
  if (words.length === 1) return words[0]!;
  return words.map((word) => shellQuote(word)).join(' ');
}

export class HostClient {
  readonly cli: HostCliCore;
  readonly native?: NativeWindowsHost;

  constructor(
    readonly connection: Connection,
    binary = 'pocketshell',
    host?: HostEntry,
  ) {
    if (host?.nativeWindowsCli !== undefined) {
      validateHostEntry(host);
      if (host.name !== connection.hostName || host.mode !== connection.mode || binary !== 'pocketshell') {
        throw new HostStoreError('Native policy does not match this connection or conflicts with a legacy binary override.');
      }
      this.native = new NativeWindowsHost(connection, host.nativeWindowsCli);
      this.cli = this.native.cli;
      return;
    }
    // The binary is spliced into host command lines unquoted (a leading `~`
    // must still expand), so a hand-edited hosts.json is checked here too.
    try {
      validateBinary(binary);
    } catch (error) {
      throw new HostStoreError(`host ${connection.hostName}: ${(error as Error).message}`);
    }
    this.cli = new HostCliCore(
      {
        exec: (command, timeoutMs) => this.run(command, timeoutMs),
      },
      binary,
    );
  }

  /** Run a raw command under the user's full PATH. */
  run(command: string, timeoutMs = DEFAULT_TIMEOUT_MS, stdin?: string | Uint8Array): Promise<ExecOutcome> {
    if (this.native) return this.native.run(command, timeoutMs, stdin);
    return this.connection.exec(pathAwareCommand(command), { timeoutMs, stdin });
  }

  /** Like `run`, but a non-zero exit (or a timeout) is an error. */
  async runChecked(command: string, timeoutMs = DEFAULT_TIMEOUT_MS, stdin?: string | Uint8Array): Promise<string> {
    const outcome = await this.run(command, timeoutMs, stdin);
    if (outcome.timedOut) {
      throw new HostCommandError(
        `\`${command}\` timed out after ${timeoutMs / 1000}s (it may still complete on the host)`,
        outcome,
      );
    }
    if (outcome.exitCode !== 0) {
      const detail = stripSystemdNoise(outcome.stderr).trim().split('\n').slice(-3).join(' ') || `exit ${outcome.exitCode}`;
      throw new HostCommandError(`\`${command}\` failed: ${detail}`, outcome);
    }
    return outcome.stdout;
  }

  /**
   * Which host CLI and aplexer versions are installed (null = missing).
   * One round trip; a connection failure or timeout throws (an unreachable
   * host is never reported as reachable).
   */
  async probe(): Promise<{ pocketshell: string | null; aplexer: string | null }> {
    if (this.native) {
      await this.native.ready();
      // Bundle identity is provisioning authority; no raw PATH a probe is performed.
      return { pocketshell: 'pocketshell, version 0.5.8', aplexer: null };
    }
    const line = (label: string, command: string) =>
      `printf '%s=%s\\n' ${label} "$(${command} --version 2>/dev/null | tail -n 1)"`;
    const outcome = await this.run(`${line('pocketshell', this.cli.binary)}; ${line('aplexer', 'a')}`, 15_000);
    if (outcome.timedOut) throw new HostCommandError('the version probe timed out after 15s', outcome);
    const values: Record<string, string | null> = { pocketshell: null, aplexer: null };
    for (const raw of outcome.stdout.split('\n')) {
      const match = /^(pocketshell|aplexer)=(.*)$/.exec(raw.trim());
      if (match) values[match[1]!] = match[2]!.trim() || null;
    }
    if (outcome.exitCode !== 0 && values.pocketshell === null && values.aplexer === null) {
      throw new HostCommandError(
        `the version probe failed (exit ${outcome.exitCode}): ${stripSystemdNoise(outcome.stderr).trim().split('\n').pop() ?? ''}`,
        outcome,
      );
    }
    return { pocketshell: values.pocketshell ?? null, aplexer: values.aplexer ?? null };
  }

  listSessions(): Promise<SessionsListing> {
    if (this.native) return this.native.listSessions();
    return this.cli.listSessions();
  }

  /**
   * Resolve what a user or agent typed to one session row (see
   * {@link pickSession} for the ranking). Throws SessionNotFound or
   * SessionAmbiguous.
   */
  async resolveSession(selector: string): Promise<SessionRow> {
    const { sessions } = await this.listSessions();
    if (this.native) {
      const exact = uniqueRows(sessions.filter((row) => row.id === selector || row.name === selector
        || (row.workspace !== null && row.tag !== null && `${row.workspace}:${row.tag}` === selector)));
      if (exact.length > 1) throw new SessionAmbiguous(selector, exact);
      if (exact.length === 1) return exact[0]!;
    }
    return pickSession(sessions, selector);
  }

  createSession(
    name: string,
    options: { cwd?: string | null; engine?: string | null; profile?: string | null } = {},
  ): Promise<CreatedSession> {
    if (this.native) return this.native.createSession(name, options);
    return this.cli.createSession(name, options);
  }

  async killSession(name: string, immutableId?: string | null): Promise<void> {
    if (this.native) {
      const row = await this.resolveSession(immutableId ?? name);
      return this.native.killSession(row.id!);
    }
    return this.cli.killSession(name);
  }

  async listWarnings(): Promise<WarningRow[]> {
    if (this.native) this.native.unsupported('session warnings');
    return this.cli.listWarnings();
  }

  async ackWarnings(selector?: string | null): Promise<void> {
    if (this.native) this.native.unsupported('session warning acknowledgement');
    return this.cli.ackWarnings(selector);
  }

  async listEngines(): Promise<HostEngineInfo[]> {
    if (this.native) this.native.unsupported('engine catalogs');
    return this.cli.listEngines();
  }

  async listProfiles(): Promise<HostProfileInfo[]> {
    if (this.native) this.native.unsupported('profile catalogs');
    return this.cli.listProfiles();
  }

  /** The workspace registry is partitioned per client host identity: the saved host name. */
  async listWorkspaces(): Promise<WorkspacesListing> {
    if (this.native) {
      await this.native.requireCapability('workspaces');
      return this.cli.listWorkspaces(this.native.policy.deviceId);
    }
    return this.cli.listWorkspaces(this.connection.hostName);
  }

  async addWorkspace(path: string): Promise<WorkspacesListing> {
    if (this.native) {
      await this.native.requireCapability('workspaces.add');
      return this.cli.addWorkspace(this.native.policy.deviceId, path);
    }
    return this.cli.addWorkspace(this.connection.hostName, path);
  }

  async removeWorkspace(path: string): Promise<WorkspacesListing> {
    if (this.native) {
      await this.native.requireCapability('workspaces.remove');
      return this.cli.removeWorkspace(this.native.policy.deviceId, path);
    }
    return this.cli.removeWorkspace(this.connection.hostName, path);
  }

  /** Type into a session without attaching: `a send <id> --stdin [--enter]`. */
  async send(session: SessionRow, text: string, options: { enter?: boolean } = {}): Promise<void> {
    if (this.native) this.native.unsupported('session send (not advertised by the reviewed native CLI)');
    const target = shellQuote(session.id ?? session.name);
    await this.runChecked(`a send ${target} --stdin${options.enter ? ' --enter' : ''}`, DEFAULT_TIMEOUT_MS, text);
  }

  /** What the session shows right now (`--screen --plain`) or its recent raw output. */
  async capture(session: SessionRow, options: { mode: 'screen' | 'raw'; bytes?: number }): Promise<string> {
    if (this.native) this.native.unsupported('session capture (not advertised by the reviewed native CLI)');
    const target = shellQuote(session.id ?? session.name);
    const flags = options.mode === 'screen' ? '--screen --plain' : options.bytes ? `--bytes ${Math.floor(options.bytes)}` : '';
    return stripSystemdNoise(await this.runChecked(`a capture ${target} ${flags}`.trim()));
  }

  /**
   * The attach command for a PTY. Prefer aplexer's own client (`a attach
   * <id>`): it draws the status row and honours Ctrl-b d to detach.
   * `pocketshell sessions attach` execs `a attach --no-status`, a bare relay
   * made for Android's own chrome with no detach chord, so it is only the
   * fallback for a row without an aplexer id.
   */
  attachCommand(session: SessionRow): string {
    if (this.native) return this.native.attachCommand(session.id);
    if (session.id) return pathAwareCommand(`exec a attach ${shellQuote(session.id)}`);
    return pathAwareCommand(this.cli.buildAttachCommand(session.name));
  }

  async attach(session: SessionRow): Promise<number | null> {
    if (this.native) await this.native.ready();
    return this.connection.attachInteractive(this.attachCommand(session), { sessionDetach: true });
  }
}
