/** Explicitly provisioned Windows host contract; never discovered from a host label. */
import { HostCliCore, HostCliFailed, shellQuote, type CreatedSession, type SessionsListing } from '@pocketshell/core';
import type { Connection, ExecOutcome } from './transport/types.js';

export interface NativeWindowsCliPolicy {
  /** Actual protected console path supplied by trusted endpoint provisioning. */
  executable: string;
  transport: 'openssh-git-bash';
  /** Canonical enrolled gateway ID, not the saved display alias. */
  deviceId: string;
}

export class NativeWindowsError extends Error {
  readonly code = 'NATIVE_HOST_CONTRACT';
  readonly exitCode = 6;
}

export class NativeCreateUncertain extends Error {
  readonly code = 'CREATE_UNCERTAIN';
  readonly exitCode = 124;
  constructor(readonly details: { listing: SessionsListing | null; rereadFailed: boolean }) {
    super('Native session creation may have completed. Check the authoritative session list before deliberately creating another session; no automatic retry was made.');
  }
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const WINDOWS_WORKSPACE = /^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+(?:\\|$))/;
const DEVICE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$/;
const REQUIRED = ['workspaces', 'tree', 'sessions.list', 'sessions.attach'];

export function validateNativeWindowsPolicy(value: unknown): NativeWindowsCliPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NativeWindowsError('An explicit provisioned native Windows CLI policy is required.');
  const policy = value as Record<string, unknown>;
  if (typeof policy.executable !== 'string'
    || !/^[A-Za-z]:\/(?:[^"'\\$`]+\/)*pocketshell\.exe$/i.test(policy.executable)
    || [...policy.executable].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    || policy.executable.split('/').some((part) => part === '.' || part === '..')
    || policy.transport !== 'openssh-git-bash'
    || typeof policy.deviceId !== 'string' || !DEVICE.test(policy.deviceId)) {
    throw new NativeWindowsError('Native Windows policy needs a provisioned drive-absolute pocketshell.exe path, explicit openssh-git-bash transport and enrolled device ID. CMD transports are not qualified.');
  }
  return { executable: policy.executable, transport: policy.transport, deviceId: policy.deviceId };
}

function success(outcome: ExecOutcome, label: string): string {
  if (outcome.timedOut || outcome.exitCode !== 0) throw new NativeWindowsError(`The provisioned native ${label} failed${outcome.timedOut ? ' or timed out' : ''}.`);
  return outcome.stdout;
}

function nonPtyCommand(command: string): string {
  return `exec ${command.replace(/^(?:exec[ \t]+)+/, '')}`;
}

/** One instance per pinned gateway connection. Installation hashes remain provisioning authority. */
export class NativeWindowsHost {
  readonly policy: NativeWindowsCliPolicy;
  readonly cli: HostCliCore;
  private qualification?: Promise<void>;
  private qualified = false;
  private capabilities = new Set<string>();
  private createNeedsReread = false;
  private createEpoch = 0;
  private createInFlight = false;

  constructor(readonly connection: Connection, policy: NativeWindowsCliPolicy) {
    this.policy = Object.freeze(validateNativeWindowsPolicy(policy));
    if (connection.mode !== 'gateway') throw new NativeWindowsError('Native Windows policy is enabled only for an explicitly provisioned gateway host.');
    this.cli = new HostCliCore({ exec: (command, timeoutMs) => this.run(command, timeoutMs) }, shellQuote(this.policy.executable));
  }

  ready(): Promise<void> {
    return this.qualification ??= this.qualify();
  }

  private async qualify(): Promise<void> {
    const version = success(await this.connection.exec(nonPtyCommand(`${shellQuote(this.policy.executable)} --version`), { timeoutMs: 15_000 }), 'version probe');
    if (!/^pocketshell, version 0\.5\.8\s*$/.test(version.trim())) throw new NativeWindowsError('The provisioned native PocketShell CLI must report version 0.5.8.');
    const raw = success(await this.connection.exec(nonPtyCommand(`${shellQuote(this.policy.executable)} platform --json`), { timeoutMs: 15_000 }), 'platform probe');
    let platform: unknown;
    try { platform = JSON.parse(raw); } catch { throw new NativeWindowsError('Malformed native platform JSON.'); }
    if (!platform || typeof platform !== 'object' || Array.isArray(platform)) throw new NativeWindowsError('Malformed native platform contract.');
    const p = platform as Record<string, unknown>;
    if (p.schema !== 1 || p.platform !== 'win32' || p.os !== 'nt' || p.cli_version !== '0.5.8'
      || !Array.isArray(p.capabilities) || !p.capabilities.every((item) => typeof item === 'string')
      || !REQUIRED.every((item) => (p.capabilities as string[]).includes(item))) {
      throw new NativeWindowsError('The provisioned native platform/capability contract is incompatible.');
    }
    this.capabilities = new Set(p.capabilities as string[]);
    this.qualified = true;
  }

  async requireCapability(capability: string): Promise<void> {
    await this.ready();
    if (!this.capabilities.has(capability)) throw new NativeWindowsError(`This provisioned native host does not advertise ${capability}.`);
  }

  async run(command: string, timeoutMs: number, stdin?: string | Uint8Array): Promise<ExecOutcome> {
    await this.ready();
    // Native NONPTY Git Bash commands require exactly one leading exec.
    return this.connection.exec(nonPtyCommand(command), { timeoutMs, stdin });
  }

  async listSessions(): Promise<SessionsListing> {
    const readEpoch = this.createEpoch;
    await this.requireCapability('sessions.list');
    const listing = await this.cli.listSessions();
    if (listing.errors.length) throw new NativeWindowsError('The native session listing is incomplete; do not select or mutate a session from it.');
    const ids = new Set<string>();
    for (const row of listing.sessions) {
      if (!row.id || !UUID.test(row.id) || ids.has(row.id.toLowerCase()) || !row.workspace || !WINDOWS_WORKSPACE.test(row.workspace)) throw new NativeWindowsError('Native session rows must carry unique immutable UUIDs and full workspace paths.');
      ids.add(row.id.toLowerCase());
    }
    if (readEpoch === this.createEpoch && !this.createInFlight) this.createNeedsReread = false;
    return listing;
  }

  async createSession(name: string, options: { cwd?: string | null; engine?: string | null; profile?: string | null }): Promise<CreatedSession> {
    await this.requireCapability('sessions.create');
    if (this.createNeedsReread) throw new NativeWindowsError('Reread the authoritative native session list before another create request.');
    if (this.createInFlight) throw new NativeWindowsError('A native create request is already in flight; wait for its result.');
    const attemptEpoch = ++this.createEpoch;
    this.createInFlight = true;
    try {
      const created = await this.cli.createSession(name, options);
      if (!created.id || !UUID.test(created.id)) throw new NativeWindowsError('Native create did not return an immutable UUID.');
      return created;
    } catch (error) {
      this.createInFlight = false;
      if (error instanceof HostCliFailed && !error.timedOut && error.exitCode !== null && error.exitCode >= 0 && error.exitCode !== 124) throw error;
      // Timeout/lost/malformed output can occur after worker handoff. Never retry or adopt a guessed ID.
      // A read begun while create was in flight cannot establish post-handoff authority.
      ++this.createEpoch;
      this.createNeedsReread = true;
      let listing: SessionsListing | null = null;
      try { listing = await this.listSessions(); } catch { /* keep the reread requirement */ }
      throw new NativeCreateUncertain({ listing, rereadFailed: listing === null });
    } finally {
      if (this.createEpoch === attemptEpoch) this.createInFlight = false;
    }
  }

  async killSession(id: string): Promise<void> {
    await this.requireCapability('sessions.kill');
    if (!UUID.test(id)) throw new NativeWindowsError('Native kill requires a full immutable session UUID.');
    const result = await this.run(`${this.cli.binary} sessions kill --json -- ${shellQuote(id)}`, 20_000);
    let payload: unknown;
    try { payload = JSON.parse(success(result, 'kill')); } catch { throw new NativeWindowsError('Native kill failed or returned malformed JSON.'); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || (payload as Record<string, unknown>).schema !== 3 || (payload as Record<string, unknown>).id !== id
      || (payload as Record<string, unknown>).killed !== true) throw new NativeWindowsError('Native kill returned an incompatible UUID receipt.');
  }

  attachCommand(id: string | null): string {
    if (!this.qualified) throw new NativeWindowsError('Native attach requires successful qualification on this connection.');
    if (!id || !UUID.test(id)) throw new NativeWindowsError('Native attach requires a full immutable UUID from the authoritative listing.');
    // Accepted Windows OpenSSH/Git Bash PTY spelling, distinct from NONPTY exec.
    return `"${this.cli.buildAttachCommand(id)}"`;
  }

  unsupported(operation: string): never {
    throw new NativeWindowsError(`The reviewed native CLI profile does not implement ${operation}; no raw Aplexer or PATH fallback is allowed.`);
  }
}
