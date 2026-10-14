import { directSessions } from './directAplexer.js';
import { requests } from './daemon/context.js';
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
  BP_END,
  BP_START,
  frameForPaste,
  HostCliCore,
  HostCliError,
  needsBracketedPaste,
  pathAwareCommand,
  shellQuote,
  SUBMIT_KEY,
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

export { BP_END, BP_START, frameForPaste, needsBracketedPaste, SUBMIT_KEY };

export interface EncodedSendPayload {
  /** The text framed for the PTY (wrapped in ESC[200~ … ESC[201~ when multi-line). */
  framed: string;
  /** The full byte stream including trailing CR when `enter` is true. */
  bytes: string;
  /** True when the input contained a line break and was wrapped in bracketed paste. */
  bracketed: boolean;
  /** True when Enter (CR) is sent after the text. */
  enter: boolean;
}

/**
 * Encode a message for PTY delivery: multi-line text is wrapped in bracketed
 * paste (`ESC[200~ … ESC[201~`) so an agent REPL ingests it as one message
 * rather than submitting every line; `enter` appends CR (`\r`) after `ESC[201~`.
 */
export function encodeSendPayload(text: string, options: { enter?: boolean } = {}): EncodedSendPayload {
  const enter = Boolean(options.enter);
  const bracketed = needsBracketedPaste(text);
  const framed = frameForPaste(text);
  const bytes = enter ? `${framed}${SUBMIT_KEY}` : framed;
  return { framed, bytes, bracketed, enter };
}


const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * `systemd-run` (which aplexer may launch through) announces itself on
 * stderr: `Running as unit: run-u12.service; invocation ID: 3f…` (or
 * `Running scope as unit: …`). It is noise, never the answer: drop such
 * lines from the start of host text.
 */
const SYSTEMD_NOISE = /^\s*(?:Running (?:scope )?as unit:? .*|(?:in)?vocation ID: [0-9a-f]{16,64})\s*$/;

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

const sessionBackends = new Map<string, Promise<string | null>>();

export class HostClient {
  private backend?: Promise<string | null>;
  private backendKey?: string;
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
    if (host) this.backendKey = JSON.stringify([connection.mode, host, binary]);
    this.cli = new HostCliCore(
      {
        exec: (command, timeoutMs) => {
          const expanded = command
            .replace(/--cwd '~'/, '--cwd "$HOME"')
            .replace(/--cwd '~\//, '--cwd "$HOME"/\'');
          return this.run(expanded, timeoutMs);
        },
      },
      binary,
    );
  }

  /** Run a raw command under the user's full PATH. */
  run(command: string, timeoutMs = DEFAULT_TIMEOUT_MS, stdin?: string | Uint8Array): Promise<ExecOutcome> {
    if (this.native) return this.native.run(command, timeoutMs, stdin);
    return this.connection.exec(pathAwareCommand(command), { timeoutMs, stdin, signal: requests.getStore()?.signal });
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

  private async sessionBackend(): Promise<string | null> {
    if (!this.backend) {
      this.backend = this.backendKey ? sessionBackends.get(this.backendKey) : undefined;
      if (!this.backend) {
        this.backend = this.detectSessionBackend();
        if (this.backendKey) sessionBackends.set(this.backendKey, this.backend);
        // Connectivity failures must not poison a host's capability cache.
        this.backend.catch(() => {
          if (this.backendKey) sessionBackends.delete(this.backendKey);
          this.backend = undefined;
        });
      }
    }
    return this.backend;
  }

  private async detectSessionBackend(): Promise<string | null> {
    try {
      const listing = await this.cli.listSessions();
      if (listing.errors.length === 0) return null;
    } catch (error) {
      // A transport failure or timeout is not a missing host CLI.
      if (!(error instanceof HostCliError)) throw error;
      if ((error as Error & { timedOut?: boolean }).timedOut
        || (error.kind === 'failed' && (error.cause || (error as Error & { exitCode?: number | null }).exitCode === null))) throw error;
    }
    // The endpoint's initial PATH prefers its managed tools. The login-shell
    // wrapper prepends user bins, which may contain unusable Windows uv shims.
    let outcome = await this.connection.exec('command -v a', {
      timeoutMs: 15_000, signal: requests.getStore()?.signal,
    });
    if (!outcome.timedOut && outcome.exitCode !== null && (outcome.exitCode !== 0 || !outcome.stdout.trim())) {
      outcome = await this.run('command -v a', 15_000);
    }
    if (outcome.timedOut || outcome.exitCode !== 0) throw new HostCommandError('cannot resolve aplexer on the host', outcome);
    const binary = outcome.stdout.trim();
    if (!binary || /[\r\n\0]/.test(binary)) throw new HostCommandError('invalid aplexer executable path', outcome);
    const command = shellQuote(binary);
    directSessions(JSON.parse(stripSystemdNoise(await this.runChecked(`${command} --json snapshot`, 20_000))));
    return command;
  }

  async listSessions(): Promise<SessionsListing> {
    if (this.native) return this.native.listSessions();
    const binary = await this.sessionBackend();
    return binary === null ? this.cli.listSessions()
      : directSessions(JSON.parse(stripSystemdNoise(await this.runChecked(`${binary} --json snapshot`, 20_000))));
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

  /** Resolve and execute atomically when the transport supports a resident helper. */
  async sendSelected(selector: string, text: string, options: { enter: boolean }): Promise<SessionRow> {
    const row = await this.resolveSession(selector);
    await this.send(row, text, options);
    return row;
  }

  async captureSelected(selector: string, options: { mode: 'screen' | 'raw'; bytes?: number }): Promise<{ row: SessionRow; text: string }> {
    const row = await this.resolveSession(selector);
    return { row, text: await this.capture(row, options) };
  }

  async createSession(
    name: string,
    options: { cwd?: string | null; engine?: string | null; profile?: string | null } = {},
  ): Promise<CreatedSession> {
    if (this.native) return this.native.createSession(name, options);
    const binary = await this.sessionBackend();
    if (binary === null) return this.cli.createSession(name, options);
    const workspace = options.cwd == null ? '.' : options.cwd === '~' ? '"$HOME"'
      : options.cwd.startsWith('~/') ? `"$HOME"/${shellQuote(options.cwd.slice(2))}` : shellQuote(options.cwd);
    const resolvedWorkspace = (await this.runChecked(`cd ${workspace} && pwd -P`)).trim();
    const normalize = (path: string) => path.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`).replace(/\/+$/, '');
    const existing = (await this.listSessions()).sessions.find((r) => r.tag === name && r.workspace !== null
      && normalize(r.workspace) === normalize(resolvedWorkspace));
    if (existing) return { name: existing.name, id: existing.id, created: false };
    let command = `${binary} --json start --workspace ${workspace} --tag ${shellQuote(name)}`;
    if (options.engine) command += ` --engine ${shellQuote(options.engine)}`;
    if (options.profile) command += ` --profile ${shellQuote(options.profile)}`;
    const record = JSON.parse(stripSystemdNoise(await this.runChecked(command, 60_000)));
    if (typeof record.id !== 'string') throw new Error('aplexer start returned no session id');
    const row = directSessions([{ ...record, state: 'starting' }]).sessions[0];
    if (!row) throw new Error('aplexer start returned an invalid session record');
    return { name: row.name, id: row.id, created: true };
  }

  async killSession(name: string, immutableId?: string | null): Promise<void> {
    if (this.native) {
      const row = await this.resolveSession(immutableId ?? name);
      return this.native.killSession(row.id!);
    }
    const binary = await this.sessionBackend();
    if (binary === null) return this.cli.killSession(name);
    const row = await this.resolveSession(immutableId ?? name);
    if (!row.id) throw new Error('cannot stop a session without an aplexer id');
    await this.runChecked(`${binary} --json kill ${shellQuote(row.id)}`, 20_000);
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

  /**
   * Type into a session without attaching: `a send <id> --stdin [--enter]`.
   * Multi-line payloads are wrapped in bracketed paste (`ESC[200~ … ESC[201~`)
   * and when `enter` is true, CR is sent after a brief pause so TUI agents
   * (Claude, Codex) ingest the paste before submitting.
   */
  async send(session: SessionRow, text: string, options: { enter?: boolean } = {}): Promise<void> {
    if (this.native) this.native.unsupported('session send (not advertised by the reviewed native CLI)');
    const binary = this.backend ? await this.backend : null;
    const a = binary ?? 'a';
    const target = shellQuote(session.id ?? session.name);
    const encoded = encodeSendPayload(text, options);
    if (encoded.bracketed && encoded.enter) {
      await this.runChecked(`${a} send ${target} --stdin && sleep 0.15 && ${a} send ${target} --hex 0d`, DEFAULT_TIMEOUT_MS, encoded.framed);
      return;
    }
    await this.runChecked(`${a} send ${target} --stdin${encoded.enter ? ' --enter' : ''}`, DEFAULT_TIMEOUT_MS, encoded.framed);
  }

  /** What the session shows right now (`--screen --plain`) or its recent raw output. */
  async capture(session: SessionRow, options: { mode: 'screen' | 'raw'; bytes?: number }): Promise<string> {
    if (this.native) this.native.unsupported('session capture (not advertised by the reviewed native CLI)');
    const binary = this.backend ? await this.backend : null;
    const a = binary ?? 'a';
    const target = shellQuote(session.id ?? session.name);
    const flags = options.mode === 'screen' ? '--screen --plain' : options.bytes ? `--bytes ${Math.floor(options.bytes)}` : '';
    return stripSystemdNoise(await this.runChecked(`${a} capture ${target} ${flags}`.trim()));
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
