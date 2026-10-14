import { directSessions } from './directAplexer.js';
import { requests } from './daemon/context.js';
import {
  forgetBackendCapability,
  loadBackendCapability,
  storeBackendCapability,
  type BackendCapability,
} from './hostCapability.js';
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
  HostCliFailed,
  needsBracketedPaste,
  parseHostSessionsList,
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

/**
 * Which host side serves the session verbs: the `pocketshell` wrapper, a
 * direct `a`, or both. Direct `a` is preferred whenever it is known to work
 * (it answers in about 80 ms where the wrapper costs about 260 ms).
 */
interface SessionBackend {
  /** The `pocketshell` wrapper answered a schema-valid, error-free listing. */
  wrapper: boolean;
  /** A validated `a` executable word (unquoted), or null when there is none. */
  direct: string | null;
}

/** A resolved backend plus, when its probe just fetched one, that listing. */
interface BackendResolution {
  backend: SessionBackend;
  listing: SessionsListing | null;
}

const PROBE_LINE = /^__PSC_BACKEND__(wrapper|wexit|apath|snapshot|sexit)(?: (.*))?$/;

interface ProbeSection {
  text: string;
  exit: number;
}

interface ProbeSections {
  wrapper?: ProbeSection;
  apath?: string;
  snapshot?: ProbeSection;
}

/** Marker-delimited probe output (see {@link detectSessionBackend}); null when no marker survived. */
function parseProbeSections(stdout: string): ProbeSections | null {
  const sections: ProbeSections = {};
  let open: 'wrapper' | 'snapshot' | null = null;
  let lines: string[] = [];
  const close = (exit: number): void => {
    if (open) sections[open] = { text: lines.join('\n'), exit };
    open = null;
    lines = [];
  };
  let sawMarker = false;
  for (const line of stripSystemdNoise(stdout.replace(/\r\n/g, '\n')).split('\n')) {
    const match = PROBE_LINE.exec(line);
    if (!match) {
      if (open) lines.push(line);
      continue;
    }
    sawMarker = true;
    const [, tag, value = ''] = match;
    if (tag === 'wrapper' || tag === 'snapshot') {
      close(-1);
      open = tag;
    } else if (tag === 'wexit' || tag === 'sexit') close(Number(value));
    else sections.apath = value.trim();
  }
  return sawMarker ? sections : null;
}

/** The wrapper works when it exits 0 with a schema-valid, error-free listing. */
function evaluateWrapperListing(section: ProbeSection | undefined): SessionsListing | null {
  if (!section || section.exit !== 0) return null;
  try {
    const listing = parseHostSessionsList(section.text);
    return listing.errors.length === 0 ? listing : null;
  } catch {
    return null;
  }
}

function evaluateSnapshotListing(section: ProbeSection | undefined): SessionsListing | null {
  if (!section || section.exit !== 0) return null;
  try {
    return directSessions(JSON.parse(stripSystemdNoise(section.text)));
  } catch {
    return null;
  }
}

/** A `command -v a` answer usable as a host command word, or null. Every use site single-quotes it, so only word-splitting and control characters disqualify. */
function usableAPath(path: string | undefined): string | null {
  if (!path || path.length > 4096 || /[\r\n\0]/.test(path)) return null;
  return path;
}

function probeAplexerLines(): string[] {
  return [
    `a_path=$(command -v a 2>/dev/null) || a_path=''`,
    `printf '__PSC_BACKEND__apath %s\\n' "$a_path"`,
    'if [ -n "$a_path" ]; then',
    `printf '__PSC_BACKEND__snapshot\\n'`,
    '"$a_path" --json snapshot',
    `printf '__PSC_BACKEND__sexit %s\\n' "$?"`,
    'fi',
  ];
}

/** One exec that answers every probe question at once: does the wrapper list, where is `a`, does `a` snapshot. */
function probeScript(binary: string): string {
  return [
    `printf '__PSC_BACKEND__wrapper\\n'`,
    `${binary} sessions list --json`,
    `printf '__PSC_BACKEND__wexit %s\\n' "$?"`,
    ...probeAplexerLines(),
  ].join('\n');
}

/** The same `a` questions under the endpoint's raw PATH: a managed helper may live there while the login shell misses it (or hits an unusable shim). */
function rawAplexerScript(): string {
  return probeAplexerLines().join('\n');
}

const sessionBackends = new Map<string, Promise<SessionBackend>>();

function cachedBackend(capability: BackendCapability): SessionBackend {
  return { wrapper: capability.wrapper, direct: capability.direct };
}

export class HostClient {
  private backend?: Promise<SessionBackend>;
  private backendKey?: string;
  private pendingListing?: SessionsListing;
  private hostHomePromise?: Promise<string>;
  readonly cli: HostCliCore;
  readonly native?: NativeWindowsHost;

  constructor(
    readonly connection: Connection,
    binary = 'pocketshell',
    readonly host?: HostEntry,
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

  private sessionBackend(): Promise<SessionBackend> {
    if (!this.backend) {
      if (this.backendKey && sessionBackends.has(this.backendKey)) {
        this.backend = sessionBackends.get(this.backendKey)!;
      } else {
        const stored = this.host ? loadBackendCapability(this.host) : null;
        if (stored) {
          this.backend = Promise.resolve(cachedBackend(stored));
          if (this.backendKey) sessionBackends.set(this.backendKey, this.backend);
        } else {
          const probe = this.detectSessionBackend().then((found) => {
            // The probe's own listing is handed to its first caller only.
            this.pendingListing = found.listing ?? undefined;
            if (this.host)
              storeBackendCapability(this.host, { wrapper: found.backend.wrapper, direct: found.backend.direct, rpc: null });
            return found.backend;
          });
          this.backend = probe;
          if (this.backendKey) sessionBackends.set(this.backendKey, probe);
          // Connectivity failures must not poison a host's capability cache.
          probe.catch(() => {
            if (this.backendKey && sessionBackends.get(this.backendKey) === probe) {
              sessionBackends.delete(this.backendKey);
            }
            this.backend = undefined;
          });
        }
      }
    }
    return this.backend;
  }

  /** Resolve the backend; the first caller after a probe also receives that probe's listing. */
  private async sessionsBackend(): Promise<BackendResolution> {
    const backend = await this.sessionBackend();
    const listing = this.pendingListing ?? null;
    this.pendingListing = undefined;
    return { backend, listing };
  }

  /** Drop every cached verdict for this host and probe again from scratch. */
  private async refreshedBackend(): Promise<BackendResolution> {
    if (this.backendKey) sessionBackends.delete(this.backendKey);
    this.backend = undefined;
    if (this.host) forgetBackendCapability(this.host);
    return this.sessionsBackend();
  }

  /**
   * Whether a failure suggests the session backend changed under us — the
   * wrapper erroring host-side (an unsupported verb, a too-old schema) or
   * the direct `a` no longer resolving — as opposed to a transport failure
   * or timeout, which change nothing.
   */
  static backendMayHaveChanged(error: unknown): boolean {
    if (error instanceof HostCliError) {
      const failed = error as HostCliFailed;
      return !failed.timedOut && failed.exitCode !== null;
    }
    if (error instanceof SyntaxError) return true;
    if (error instanceof HostCommandError) {
      const { timedOut, exitCode, stderr } = error.outcome;
      if (timedOut || exitCode === null) return false;
      return exitCode === 127 || /command not found|no such file|not found/i.test(stderr);
    }
    return error instanceof Error && error.message === 'aplexer snapshot must be an array';
  }

  /**
   * Learn, in as few execs as possible, which backend serves this host. One
   * combined exec runs the wrapper listing, resolves `a` under the user-bin
   * PATH, and validates `a` with a snapshot — every answer it can give is
   * reused, so a first-contact `ls` is exactly one connection. Only when no
   * usable `a` emerges does a second, raw-PATH exec run (a managed helper
   * may live there while the login shell misses it, or an unusable user-bin
   * shim shadows it).
   */
  private async detectSessionBackend(): Promise<BackendResolution> {
    const outcome = await this.run(probeScript(this.cli.binary), 35_000);
    if (outcome.timedOut)
      throw new HostCommandError('the session backend probe timed out after 35s (it may still complete on the host)', outcome);
    const sections = parseProbeSections(outcome.stdout);
    if (!sections)
      throw new HostCommandError(
        `the session backend probe failed (exit ${outcome.exitCode}): ${stripSystemdNoise(outcome.stderr).trim().split('\n').slice(-3).join(' ') || 'no probe markers'}`,
        outcome,
      );
    const wrapperListing = evaluateWrapperListing(sections.wrapper);
    let direct = usableAPath(sections.apath);
    let listing = direct ? evaluateSnapshotListing(sections.snapshot) : null;
    if (!listing) direct = null;
    let rawError: unknown;
    if (!direct) {
      try {
        const raw = await this.connection.exec(rawAplexerScript(), {
          timeoutMs: 25_000, signal: requests.getStore()?.signal,
        });
        if (!raw.timedOut) {
          const rawSections = parseProbeSections(raw.stdout);
          const rawPath = usableAPath(rawSections?.apath);
          if (rawPath) {
            const rawListing = evaluateSnapshotListing(rawSections?.snapshot);
            if (rawListing) {
              direct = rawPath;
              listing = rawListing;
            }
          }
        }
      } catch (error) {
        rawError = error;
      }
    }
    if (direct && listing) return { backend: { wrapper: wrapperListing !== null, direct }, listing };
    if (wrapperListing) return { backend: { wrapper: true, direct: null }, listing: wrapperListing };
    if (rawError) throw rawError;
    throw new HostCommandError(
      'no usable session backend: the pocketshell wrapper failed and no aplexer `a` could be resolved',
      outcome,
    );
  }

  private async fetchListing(backend: SessionBackend): Promise<SessionsListing> {
    if (backend.direct) return this.snapshotListing(backend.direct);
    return this.cli.listSessions();
  }

  private async snapshotListing(direct: string): Promise<SessionsListing> {
    return directSessions(
      JSON.parse(stripSystemdNoise(await this.runChecked(`${shellQuote(direct)} --json snapshot`, 20_000))),
    );
  }

  /** The resolved direct `a` word, without probing; null when not yet known. */
  private async resolvedDirect(): Promise<string | null> {
    return this.backend ? (await this.backend).direct : null;
  }

  async listSessions(): Promise<SessionsListing> {
    if (this.native) return this.native.listSessions();
    const first = await this.sessionsBackend();
    if (first.listing) return first.listing;
    try {
      return await this.fetchListing(first.backend);
    } catch (error) {
      if (!HostClient.backendMayHaveChanged(error)) throw error;
      const retry = await this.refreshedBackend();
      return retry.listing ?? this.fetchListing(retry.backend);
    }
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
    const { backend, listing } = await this.sessionsBackend();
    if (backend.direct) return this.directCreateSession(name, options, backend.direct, listing);
    try {
      return await this.cli.createSession(name, options);
    } catch (error) {
      if (!HostClient.backendMayHaveChanged(error)) throw error;
      // The wrapper's answer for this verb changed under us (e.g. a tray
      // build without `sessions create`): re-probe and let a direct `a` serve it.
      const retry = await this.refreshedBackend();
      if (retry.backend.direct) return this.directCreateSession(name, options, retry.backend.direct, retry.listing);
      throw error;
    }
  }

  /**
   * `--cwd` as one quoted host command word. A leading `~` is expanded on
   * the host itself (one exec, cached per client): a Windows host must get
   * its Windows profile directory (`USERPROFILE`), not whatever an MSYS
   * login shell calls home, or `a start --workspace` lands in the wrong place.
   */
  private async workspaceArgument(cwd?: string | null): Promise<string> {
    if (cwd == null || cwd === '.') return '.';
    if (cwd === '~') return shellQuote(await this.hostHome());
    if (cwd.startsWith('~/')) return `${shellQuote(await this.hostHome())}/${shellQuote(cwd.slice(2))}`;
    return shellQuote(cwd);
  }

  private hostHome(): Promise<string> {
    if (!this.hostHomePromise) {
      this.hostHomePromise = this.runChecked(
        'home=${USERPROFILE:-$HOME}; [ -n "$home" ] || { printf \'no home directory on the host\\n\' >&2; exit 1; }; printf \'%s\' "$home"',
        15_000,
      ).then((out) => out.trim());
      this.hostHomePromise.catch(() => {
        this.hostHomePromise = undefined;
      });
    }
    return this.hostHomePromise;
  }

  private async directCreateSession(
    name: string,
    options: { cwd?: string | null; engine?: string | null; profile?: string | null },
    direct: string,
    probeListing?: SessionsListing | null,
  ): Promise<CreatedSession> {
    const binary = shellQuote(direct);
    const workspace = await this.workspaceArgument(options.cwd);
    const resolvedWorkspace = (await this.runChecked(`cd ${workspace} && pwd -P`)).trim();
    const normalize = (path: string) => path.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`).replace(/\/+$/, '');
    const listing = probeListing ?? (await this.listSessions());
    const existing = listing.sessions.find((r) => r.tag === name && r.workspace !== null
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
    const { backend } = await this.sessionsBackend();
    if (backend.direct) return this.directKillSession(name, immutableId, backend.direct);
    try {
      return await this.cli.killSession(name);
    } catch (error) {
      if (!HostClient.backendMayHaveChanged(error)) throw error;
      const retry = await this.refreshedBackend();
      if (retry.backend.direct) return this.directKillSession(name, immutableId, retry.backend.direct);
      throw error;
    }
  }

  private async directKillSession(name: string, immutableId: string | null | undefined, direct: string): Promise<void> {
    const row = await this.resolveSession(immutableId ?? name);
    if (!row.id) throw new Error('cannot stop a session without an aplexer id');
    await this.runChecked(`${shellQuote(direct)} --json kill ${shellQuote(row.id)}`, 20_000);
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
    const a = shellQuote((await this.resolvedDirect()) ?? 'a');
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
    const a = shellQuote((await this.resolvedDirect()) ?? 'a');
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
