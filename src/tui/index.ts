/**
 * The full-screen terminal UI: wiring and lifecycle.
 *
 * Pure parts live next door (state.ts reducer, render.ts, keys.ts). This
 * file owns the I/O: the host connection, refresh/preview timers, running
 * effects, and the terminal hand-off for attach. Whatever happens — quit,
 * SIGTERM, an uncaught exception — the terminal is restored. The one
 * exception is a SIGTERM/SIGHUP while an attached session owns the tty: the
 * TUI writes nothing and quits once the attach returns (see `terminate`).
 */
import { homedir } from 'node:os';
import { resolveHost } from '../commands/common.js';
import { HostClient } from '../hostClient.js';
import { safeLine } from '../sanitize.js';
import { getHost, listHosts, type HostEntry } from '../hosts/store.js';
import { openConnection, type Connection } from '../transport/index.js';
import { keyToAction, parseKeys } from './keys.js';
import { render } from './render.js';
import {
  describeError,
  hostRow,
  initialState,
  reduce,
  sessionKey,
  type Action,
  type Effect,
  type TuiState,
} from './state.js';
import { colorModeFromEnv, Terminal } from './terminal.js';
import type { SessionRow } from '@pocketshell/core';

const REFRESH_MS = 3_000;
const PREVIEW_MS = 2_000;
const TICK_MS = 150;

/** `isLoggedIn()` from the account module, when it exists; null when unknown. Never throws. */
async function loginState(): Promise<boolean | null> {
  try {
    const mod = (await import('../account/index.js')) as Record<string, unknown>;
    const fn = mod.isLoggedIn;
    if (typeof fn !== 'function') return null;
    const value: unknown = await (fn as () => unknown)();
    return typeof value === 'boolean' ? value : null;
  } catch {
    return null;
  }
}

function homeFor(host: HostEntry): string | null {
  return host.mode === 'local' ? homedir() : null;
}


/** Exported for tests; `runTui` is the entry point. */
export class App {
  state: TuiState;
  private readonly term: Terminal;
  private readonly color = colorModeFromEnv();
  private connection: Connection | null = null;
  private client: HostClient | null = null;
  private connectError: string | null = null;

  private suspended = false;
  private finished = false;
  /** A SIGTERM/SIGHUP that arrived while an attached session owned the terminal: quit when it returns. */
  private quitAfterAttach: number | null = null;
  /** True exactly while the attach child runs on the terminal. */
  private childRunning = false;
  /** Ends a pending `waitForKey` early (a signal arrived while it waited). */
  private cancelWait: (() => void) | null = null;
  private resolveDone!: (code: number) => void;
  readonly done: Promise<number>;

  private renderQueued = false;
  private refreshPromise: Promise<void> | null = null;
  private refreshQueued: Promise<void> | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private previewTimer: NodeJS.Timeout | null = null;
  private captureInFlight = false;
  private tickTimer: NodeJS.Timeout | null = null;
  private statusTimer: NodeJS.Timeout | null = null;
  private lastStatusSeq = 0;
  private lastSecond = 0;

  private readonly onData = (chunk: Buffer | string) => {
    if (this.suspended || this.finished) return;
    for (const key of parseKeys(chunk.toString())) {
      if (this.suspended || this.finished) return;
      const action = keyToAction(this.state, key);
      if (action) this.dispatch(action);
    }
  };

  private readonly onResize = () => {
    if (this.suspended || this.finished) return;
    const { width, height } = this.term.size();
    this.term.invalidate();
    this.dispatch({ type: 'resize', width, height });
  };

  constructor(
    private host: HostEntry,
    input: NodeJS.ReadStream,
    output: NodeJS.WriteStream,
  ) {
    this.term = new Terminal(input, output);
    const { width, height } = this.term.size();
    this.state = initialState({
      hostName: host.name,
      hostMode: host.mode,
      width,
      height,
      now: Date.now() / 1000,
      home: homeFor(host),
    });
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.attachTerminal();
    this.scheduleRender();
    try {
      const startingHost = this.host;
      this.connection = await openConnection(startingHost);
      this.client = new HostClient(this.connection, startingHost.binary, startingHost);
    } catch (error) {
      this.connectError = describeError(error);
    }
    void loginState().then((value) => {
      if (value !== null) this.dispatch({ type: 'loggedIn', value });
    });
    void this.refresh();
  }

  /** Take the terminal: alternate screen, raw mode, our key listener, timers. */
  private attachTerminal(): void {
    this.term.enter();
    this.term.input.on('data', this.onData);
    this.term.input.resume();
    this.term.output.on('resize', this.onResize);
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    const { width, height } = this.term.size();
    if (width !== this.state.width || height !== this.state.height) this.dispatch({ type: 'resize', width, height });
  }

  /** Give the terminal back: no listener, no raw mode, no timers, normal screen. */
  private detachTerminal(): void {
    this.term.input.off('data', this.onData);
    this.term.output.off('resize', this.onResize);
    this.term.input.pause();
    this.clearTimers();
    this.term.leave();
  }

  private clearTimers(): void {
    for (const timer of [this.refreshTimer, this.previewTimer, this.statusTimer]) if (timer) clearTimeout(timer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.refreshTimer = this.previewTimer = this.statusTimer = this.tickTimer = null;
  }

  /** Synchronous terminal restore for exit/crash paths. */
  emergencyRestore(): void {
    this.term.input.off('data', this.onData);
    this.clearTimers();
    this.term.leaveSync();
  }

  /** An external SIGINT quits — unless an attached session owns the terminal right now. */
  interrupt(): void {
    if (!this.suspended) void this.finish(130);
  }

  /**
   * SIGTERM/SIGHUP. Outside an attach: restore and exit right away. During
   * one the child owns the tty, so writing a restore sequence or exiting
   * would scribble over its screen and orphan it. Instead quit as soon as
   * the attach returns: on a hangup the child (same foreground process
   * group) gets SIGHUP from the tty itself and exits; a SIGTERM aimed only
   * at us leaves the session attached until the user detaches.
   * Returns true when the caller should exit now.
   */
  terminate(code: number): boolean {
    if (this.suspended && !this.finished) {
      this.quitAfterAttach ??= code;
      // Child already gone, waiting on "press any key": stop waiting (on a hangup no key will ever come).
      if (!this.childRunning) this.cancelWait?.();
      return false;
    }
    return true;
  }

  async finish(code: number): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.detachTerminal();
    try {
      await this.connection?.close();
    } catch {
      /* closing is best effort */
    }
    this.resolveDone(code);
  }

  // ── state + rendering ────────────────────────────────────────────────────

  dispatch(action: Action): void {
    if (this.finished) return;
    const { state, effects } = reduce(this.state, action);
    this.state = state;
    this.watchStatus();
    this.scheduleRender();
    for (const effect of effects) this.run(effect);
  }

  private watchStatus(): void {
    const status = this.state.status;
    if (!status || status.seq === this.lastStatusSeq) return;
    this.lastStatusSeq = status.seq;
    if (this.statusTimer) clearTimeout(this.statusTimer);
    const seq = status.seq;
    this.statusTimer = setTimeout(() => this.dispatch({ type: 'clearStatus', seq }), status.kind === 'error' ? 15_000 : 5_000);
  }

  private scheduleRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    setImmediate(() => {
      this.renderQueued = false;
      if (this.suspended || this.finished) return;
      this.term.draw(render(this.state, this.color));
    });
  }

  private tick(): void {
    const now = Date.now() / 1000;
    const second = Math.floor(now);
    if (this.state.refreshing || this.state.busy || second !== this.lastSecond) {
      this.lastSecond = second;
      this.dispatch({ type: 'tick', now });
    }
  }

  // ── effects ──────────────────────────────────────────────────────────────

  private run(effect: Effect): void {
    switch (effect.type) {
      case 'refresh':
        void this.refresh();
        return;
      case 'redraw':
        this.term.invalidate();
        this.scheduleRender();
        return;
      case 'quit':
        void this.finish(0);
        return;
      case 'loadHosts':
        try {
          const hosts = listHosts().map((host) => ({ name: host.name, mode: host.mode }));
          this.dispatch({ type: 'hostsLoaded', hosts });
        } catch (error) {
          this.dispatch({ type: 'hostsFailed', message: describeError(error) });
        }
        return;
      case 'loadEngines':
        void this.withClient(async (client) => {
          try {
            this.dispatch({ type: 'enginesLoaded', engines: await client.listEngines() });
          } catch (error) {
            this.dispatch({ type: 'enginesFailed', message: describeError(error) });
          }
        });
        return;
      case 'capture':
        void this.capture(effect.row);
        return;
      case 'attach':
        void this.attach(effect.row);
        return;
      case 'send':
        void this.operation(`sending to ${effect.row.name}`, async (client) => {
          await client.send(hostRow(effect.row), effect.text, { enter: true });
          this.dispatch({ type: 'opDone', text: `sent to ${effect.row.name}` });
          if (this.state.preview) this.schedulePreview(400);
        });
        return;
      case 'kill':
        void this.operation(`killing ${effect.row.name}`, async (client) => {
          await client.killSession(hostRow(effect.row).name, hostRow(effect.row).id);
          this.dispatch({ type: 'opDone', text: `killed ${effect.row.name}` });
          await this.refresh();
        });
        return;
      case 'create':
        void this.operation(`creating ${effect.name}`, async (client) => {
          const created = await client.createSession(effect.name, { cwd: effect.cwd, engine: effect.engine });
          const key = created.id ? `id:${created.id}` : `name:${safeLine(created.name)}`;
          const verb = created.created ? 'created' : 'reused';
          this.dispatch({ type: 'opDone', text: `${verb} ${created.name}${effect.attach ? '' : ' — ↵ attaches'}`, selectKey: key });
          await this.refresh();
          if (!effect.attach) return;
          const row =
            this.state.sessions.find((entry) => sessionKey(entry) === key) ??
            (await client.resolveSession(created.id ?? created.name));
          await this.attach(row);
        });
        return;
      case 'switchHost':
        void this.switchHost(effect.name);
        return;
    }
  }

  private async withClient(body: (client: HostClient) => Promise<void>): Promise<void> {
    if (!this.client) {
      this.dispatch({ type: 'opFailed', text: this.connectError ?? `not connected to ${this.state.hostName}` });
      return;
    }
    await body(this.client);
  }

  /** A host operation with a busy indicator; failures land on the status line. */
  private async operation(label: string, body: (client: HostClient) => Promise<void>): Promise<void> {
    await this.withClient(async (client) => {
      this.dispatch({ type: 'busy', text: `${label}…` });
      try {
        await body(client);
      } catch (error) {
        this.dispatch({ type: 'opFailed', text: describeError(error) });
      } finally {
        if (this.state.busy) this.dispatch({ type: 'busy', text: null });
      }
    });
  }

  /** Non-overlapping refresh; a request during one runs once more after it. Re-arms the auto-refresh. */
  refresh(): Promise<void> {
    if (this.refreshPromise) {
      this.refreshQueued ??= this.refreshPromise.then(() => {
        this.refreshQueued = null;
        return this.refresh();
      });
      return this.refreshQueued;
    }
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.refreshPromise = this.doRefresh().finally(() => {
      this.refreshPromise = null;
      if (!this.refreshQueued) this.scheduleRefresh();
    });
    return this.refreshPromise;
  }

  private scheduleRefresh(): void {
    if (this.suspended || this.finished) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh(), REFRESH_MS);
  }

  private async doRefresh(): Promise<void> {
    const generation = this.state.generation;
    const client = this.client;
    if (!client) {
      this.dispatch({ type: 'refreshFailed', generation, message: this.connectError ?? 'not connected' });
      return;
    }
    this.dispatch({ type: 'refreshStarted', generation });
    try {
      const [listing, workspaces] = await Promise.all([
        client.listSessions(),
        this.state.showEmpty ? client.listWorkspaces().then((w) => w.workspaces).catch(() => null) : Promise.resolve(null),
      ]);
      this.dispatch({
        type: 'refreshDone',
        generation,
        sessions: listing.sessions,
        errors: listing.errors.map((error) => error.message),
        workspaces,
        now: Date.now() / 1000,
      });
    } catch (error) {
      this.dispatch({ type: 'refreshFailed', generation, message: describeError(error) });
    }
  }

  private schedulePreview(delay = PREVIEW_MS): void {
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = null;
    if (!this.state.preview || this.suspended || this.finished) return;
    this.previewTimer = setTimeout(() => {
      const preview = this.state.preview;
      if (!preview) return;
      const row = this.state.sessions.find((entry) => sessionKey(entry) === preview.key);
      if (row) void this.capture(row);
    }, delay);
  }

  private async capture(row: SessionRow): Promise<void> {
    const client = this.client;
    if (!client || this.captureInFlight) {
      // The running capture reschedules; the preview catches up within one period.
      if (!client) this.dispatch({ type: 'captureFailed', key: sessionKey(row), message: this.connectError ?? 'not connected' });
      return;
    }
    this.captureInFlight = true;
    const key = sessionKey(row);
    try {
      const text = await client.capture(hostRow(row), { mode: 'screen' });
      this.dispatch({ type: 'captured', key, text });
    } catch (error) {
      this.dispatch({ type: 'captureFailed', key, message: describeError(error) });
    } finally {
      this.captureInFlight = false;
      // If the selection moved while this ran, capture the new one right away.
      const preview = this.state.preview;
      this.schedulePreview(preview && preview.key !== key ? 0 : PREVIEW_MS);
    }
  }

  /**
   * Hand the terminal to `attach` and take it back afterwards. While the
   * child runs we hold no raw mode, no stdin reader, no timers; keystrokes
   * typed after it exits wait in the tty buffer until we resume reading.
   */
  private async attach(row: SessionRow): Promise<void> {
    const client = this.client;
    if (!client || this.suspended || this.finished) return;
    // The row may come straight from the host (create → resolveSession): label it safely, target it exactly.
    const label = safeLine(row.name);
    this.suspended = true;
    this.detachTerminal();
    this.term.output.write(`attaching to ${label} — Ctrl-b d detaches back to PocketShell\r\n`);
    let outcome: Action;
    this.childRunning = true;
    try {
      const code = await client.attach(hostRow(row));
      outcome =
        code === 0
          ? { type: 'opDone', text: `back from ${label}` }
          : { type: 'opFailed', text: `attach to ${label} ended with ${code === null ? 'an error' : `exit ${code}`}` };
    } catch (error) {
      outcome = { type: 'opFailed', text: describeError(error) };
    } finally {
      this.childRunning = false;
    }
    if (this.finished) return;
    if (outcome.type === 'opFailed' && this.quitAfterAttach === null) {
      await this.waitForKey('press any key to return to PocketShell');
    }
    if (this.quitAfterAttach !== null) {
      // Signalled while attached: the screen is the normal one already and cooked; just finish.
      this.suspended = false;
      await this.finish(this.quitAfterAttach);
      return;
    }
    this.suspended = false;
    this.attachTerminal();
    this.dispatch(outcome);
    void this.refresh();
    if (this.state.preview) this.schedulePreview(0);
  }

  /** On the normal screen: show `message`, wait for one keypress (so an error printed by a child stays readable). */
  private waitForKey(message: string): Promise<void> {
    const input = this.term.input;
    return new Promise((resolve) => {
      this.term.output.write(`\r\n${message}`);
      try {
        if (input.isTTY) input.setRawMode(true);
      } catch {
        /* ignore */
      }
      const done = () => {
        input.off('data', done);
        this.cancelWait = null;
        input.pause();
        try {
          if (input.isTTY) input.setRawMode(false);
        } catch {
          /* ignore */
        }
        try {
          this.term.output.write('\r\n');
        } catch {
          /* the tty may be gone (SIGHUP) */
        }
        resolve();
      };
      this.cancelWait = done;
      input.once('data', done);
      input.resume();
    });
  }

  private async switchHost(name: string): Promise<void> {
    this.dispatch({ type: 'busy', text: `connecting to ${name}…` });
    let entry: HostEntry;
    try {
      entry = getHost(name);
    } catch (error) {
      this.dispatch({ type: 'opFailed', text: describeError(error) });
      return;
    }
    // Switch even when the connection cannot open: the body then says why
    // (not logged in, not pinned, …) and h / r stay available.
    let connection: Connection | null = null;
    let connectError: string | null = null;
    try {
      connection = await openConnection(entry);
    } catch (error) {
      connectError = describeError(error);
    }
    const old = this.connection;
    this.host = entry;
    this.connection = connection;
    this.client = connection ? new HostClient(connection, entry.binary, entry) : null;
    this.connectError = connectError;
    void old?.close().catch(() => {});
    const loggedIn = await loginState();
    this.dispatch({ type: 'hostSwitched', name: entry.name, mode: entry.mode, loggedIn, home: homeFor(entry) });
  }
}

/** Run the TUI until the user quits. Returns the process exit code. */
export async function runTui(options: { host?: string }): Promise<number> {
  const input = process.stdin;
  const output = process.stdout;
  if (!input.isTTY || !output.isTTY) {
    process.stderr.write('error: the TUI needs an interactive terminal (use the subcommands, e.g. `sessions list`)\n');
    return 2;
  }
  let host: HostEntry;
  try {
    host = resolveHost(options.host);
  } catch (error) {
    process.stderr.write(`error: ${describeError(error)}\n`);
    return 2;
  }

  const app = new App(host, input, output);
  const crash = (error: unknown) => {
    app.emergencyRestore();
    process.stderr.write(`pocketshell-tui-client: TUI crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  };
  const onSignal = (signal: NodeJS.Signals) => {
    const code = signal === 'SIGTERM' ? 143 : signal === 'SIGHUP' ? 129 : 130;
    // Mid-attach the child owns the tty: no restore, no exit; the app quits when attach returns.
    if (!app.terminate(code)) return;
    app.emergencyRestore();
    process.exit(code);
  };
  const onExit = () => app.emergencyRestore();
  // SIGINT only arrives from outside (raw mode turns Ctrl+C into a key); it quits like q.
  const onInt = () => app.interrupt();
  process.on('uncaughtException', crash);
  process.on('unhandledRejection', crash);
  process.on('SIGTERM', onSignal);
  process.on('SIGHUP', onSignal);
  process.on('SIGINT', onInt);
  process.on('exit', onExit);
  try {
    await app.start();
    return await app.done;
  } catch (error) {
    app.emergencyRestore();
    process.stderr.write(`error: ${describeError(error)}\n`);
    return 1;
  } finally {
    app.emergencyRestore();
    process.off('uncaughtException', crash);
    process.off('unhandledRejection', crash);
    process.off('SIGTERM', onSignal);
    process.off('SIGHUP', onSignal);
    process.off('SIGINT', onInt);
    process.off('exit', onExit);
  }
}
