/**
 * `psc a`: remote aplexer through PocketShell — one short, predictable
 * command family for driving agent sessions across hosts.
 */
import { Command } from 'commander';
import type { CreatedSession, SessionRow } from '@pocketshell/core';
import { mintGatewayToken } from '../account/index.js';
import { fetchDevices, type DevicePresence } from '../gateway/devices.js';
import { resolveEndpoint } from '../gateway/endpoint.js';
import { loadPins } from '../gateway/pins.js';
import { encodeSendPayload, HostClient, SessionNotFound } from '../hostClient.js';
import { defaultHostName, friendlyHostName, listHosts, pickHost, type HostEntry } from '../hosts/store.js';
import { classify, CliError, emit, EXIT, setJsonMode, usageError } from '../output.js';
import { safeLine, safeText } from '../sanitize.js';
import { openConnection } from '../transport/index.js';
import { action, jsonOption, parsePositiveInt, parseSeconds } from './common.js';
import { describeHost } from './hosts.js';
import { table } from './sessions.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const A_HELP = `Usage: psc a [options] <command>

Remote aplexer across your PocketShell hosts.

Commands:
  psc a hosts [--check]                 saved hosts; --check pings each in parallel (online/offline/error + versions)
  psc a <host> ls                       sessions on <host> (name, engine, state, workspace) — plain table
  psc a <host> start <tag> [options]    create (or reuse live) session <basename DIR>:<tag>; optionally send --prompt
  psc a <host> send <session> [TEXT|-]  send and SUBMIT (Enter is default; --no-enter to just type)
  psc a <host> capture <session> [opts] plain-text rendered screen by default (no ANSI), trailing blank lines trimmed
  psc a <host> wait <session> [opts]    block until the session's agent is idle/waiting (exit 124 on timeout)
  psc a <host> stop <session> [opts]    stop a session (--if-exists succeeds when already gone)
  psc a <host> status <session>         one session's row (state, agent state, engine, created)

Host resolution (<host>):
  1. exact saved host name (or \`local\`),
  2. exact gateway device id,
  3. unique case-insensitive prefix or substring of a saved host name or gateway device id
     (e.g. \`laptop\` → \`host-laptop-…\`, \`hetzner\` → \`hetzner-rmthz\`).
  Ambiguous matches fail with HOST_AMBIGUOUS (exit 2) and list candidates.

Options:
  --json                                machine-readable output (one JSON document on stdout)
  -h, --help                            display help for command

Examples:
  psc a hosts
  psc a hosts --check --json
  psc a hetzner ls
  psc a hetzner start e2e-test -C '~/git/project' -e claude --prompt 'reply with just the word PONG'
  psc a hetzner wait e2e-test --timeout 120
  psc a hetzner capture e2e-test --lines 20 --wait-for PONG
  echo -e 'line1\\nline2: reply LINES-OK' | psc a hetzner send e2e-test
  psc a hetzner status e2e-test
  psc a hetzner stop e2e-test --if-exists
`;

function ref(row: SessionRow): { name: string; id: string | null } {
  return { name: row.name, id: row.id };
}

/** Read everything from stdin. */
export async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Resolve text for `psc a <host> send <session> [TEXT|-]`:
 * - explicit `TEXT` (not `'-'`) is used verbatim;
 * - `'-'`, or omitted `TEXT` when stdin is not a TTY, reads stdin and strips
 *   at most one trailing line break;
 * - omitted `TEXT` on a TTY is a USAGE error.
 */
export async function resolveSendText(
  text: string | undefined,
  readStdin: () => Promise<string> = readAllStdin,
  stdinIsTty = Boolean(process.stdin.isTTY),
): Promise<string> {
  if (text !== undefined && text !== '-') return text;
  if (text === '-' || !stdinIsTty) {
    return (await readStdin()).replace(/\r?\n$/, '');
  }
  throw usageError("missing message text (pass TEXT, '-' or pipe stdin)");
}

/**
 * Resolve `--prompt <text|->` for `psc a <host> start`:
 * - `undefined` → null (no prompt to send);
 * - `'-'` → read stdin and strip one trailing line break;
 * - any other string → verbatim.
 */
export async function resolvePromptText(
  promptOpt: string | undefined,
  readStdin: () => Promise<string> = readAllStdin,
): Promise<string | null> {
  if (promptOpt === undefined) return null;
  if (promptOpt === '-') return (await readStdin()).replace(/\r?\n$/, '');
  return promptOpt;
}

/**
 * Trim a captured screen or raw buffer for `psc a <host> capture`:
 * - in screen mode (default), strip ANSI/control sequences via `safeText`;
 * - always trim trailing blank (empty or whitespace-only) lines;
 * - with `lines: N`, return the last N non-empty lines.
 */
export function trimCapture(text: string, options: { raw?: boolean; lines?: number } = {}): string {
  const cleaned = options.raw ? text.replace(/\r\n/g, '\n') : safeText(text);
  const allLines = cleaned.split('\n');
  let end = allLines.length;
  while (end > 0 && allLines[end - 1]!.trim() === '') {
    end--;
  }
  const trimmedLines = allLines.slice(0, end);
  if (options.lines !== undefined) {
    const nonEmpty = trimmedLines.filter((line) => line.trim().length > 0);
    return nonEmpty.slice(-options.lines).join('\n');
  }
  return trimmedLines.join('\n');
}

/**
 * Saved hosts plus any pinned gateway devices not yet in `hosts.json`, so a
 * pinned device can be addressed by device id or friendly substring even
 * before `psc hosts sync` is run.
 */
export function allCandidateHosts(
  savedHosts?: readonly HostEntry[],
  pinnedDeviceIds?: Iterable<string>,
): HostEntry[] {
  const saved = [...(savedHosts ?? listHosts())];
  const takenNames = new Set(saved.map((h) => h.name));
  const configuredDevices = new Set(
    saved.filter((h) => h.mode === 'gateway' && h.gateway?.deviceId).map((h) => h.gateway!.deviceId),
  );
  let pins: Iterable<string>;
  if (pinnedDeviceIds !== undefined) {
    pins = pinnedDeviceIds;
  } else {
    try {
      pins = loadPins().keys();
    } catch {
      pins = [];
    }
  }
  // Inherit default gateway user from an existing gateway host when synthesizing a pinned entry.
  const defaultGatewayUser = saved.find((h) => h.mode === 'gateway' && h.gateway?.user)?.gateway?.user;
  for (const deviceId of pins) {
    if (configuredDevices.has(deviceId)) continue;
    const name = friendlyHostName(deviceId, takenNames);
    takenNames.add(name);
    configuredDevices.add(deviceId);
    saved.push({
      name,
      mode: 'gateway',
      gateway: {
        deviceId,
        ...(defaultGatewayUser ? { user: defaultGatewayUser } : {}),
      },
    });
  }
  return saved;
}

/** Resolve `<host>` using saved hosts and pinned gateway devices. */
export function resolveAHost(
  selector: string,
  savedHosts?: readonly HostEntry[],
  pinnedDeviceIds?: Iterable<string>,
): HostEntry {
  return pickHost(allCandidateHosts(savedHosts, pinnedDeviceIds), selector);
}

async function withResolvedHost(
  selector: string,
  body: (client: HostClient, host: HostEntry) => Promise<void>,
): Promise<void> {
  const host = resolveAHost(selector);
  const connection = await openConnection(host);
  try {
    await body(new HostClient(connection, host.binary), host);
  } finally {
    await connection.close();
  }
}

function compileRegex(source: string): RegExp {
  try {
    return new RegExp(source, 'm');
  } catch (error) {
    throw usageError(`invalid --wait-for regex: ${(error as Error).message}`);
  }
}

/**
 * Wait until a newly started (or reused) session is ready to accept input:
 * - for a reused session (`created: false`), waits until `agentState !== 'working'`;
 * - for a freshly created session (`created: true`), waits until the screen
 *   has rendered non-empty content (when an engine is launched) and remained
 *   stable across two polls while `agentState !== 'working'`.
 */
export async function waitForAgentReady(
  client: Pick<HostClient, 'listSessions' | 'capture'>,
  created: CreatedSession,
  options: { engine?: string; timeoutS?: number; pollMs?: number; sleepFn?: (ms: number) => Promise<void> } = {},
): Promise<SessionRow> {
  const timeoutS = options.timeoutS ?? 30;
  const pollMs = options.pollMs ?? 500;
  const pause = options.sleepFn ?? sleep;
  const deadline = Date.now() + timeoutS * 1000;
  const selector = created.id ?? created.name;
  let lastScreen: string | null = null;
  let lastRow: SessionRow | null = null;

  for (;;) {
    const { sessions } = await client.listSessions();
    const row =
      sessions.find((s) => (created.id && s.id === created.id) || s.name === created.name) ??
      ({
        name: created.name,
        id: created.id,
        workspace: null,
        tag: created.name.split(':')[1] ?? created.name,
        engine: options.engine ?? null,
        profile: null,
        agent: options.engine ?? null,
        agentState: null,
        agentStateSource: null,
        attached: false,
        createdEpoch: null,
        activityEpoch: null,
      } satisfies SessionRow);
    lastRow = row;

    if (!created.created) {
      if (row.agentState !== 'working') return row;
    } else {
      const screen = trimCapture(await client.capture(row, { mode: 'screen' }));
      const wantsEngine = Boolean(options.engine || row.engine || row.agent);
      const hasContent = screen.length > 0;
      const notWorking = row.agentState !== 'working';
      if (wantsEngine) {
        if (hasContent && notWorking && lastScreen !== null && screen === lastScreen) {
          return row;
        }
      } else if ((hasContent || lastScreen !== null) && notWorking) {
        return row;
      }
      lastScreen = screen;
    }

    if (Date.now() >= deadline) {
      throw new CliError(
        'TIMEOUT',
        `session ${created.name} did not become ready within ${timeoutS}s`,
        EXIT.TIMEOUT,
        { session: { name: lastRow.name, id: lastRow.id } },
      );
    }
    await pause(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}

export interface WaitIdleResult {
  row: SessionRow;
  state: string;
  reason: 'agent_state' | 'screen_idle' | 'phase';
  elapsedMs: number;
}

/**
 * Block until `selector`'s agent is idle/waiting:
 * - uses `row.agentState` (`idle` or `waiting`) when the host exposes it via
 *   `sessions list` JSON;
 * - otherwise falls back to waiting until the rendered screen is unchanged for
 *   `idleS` seconds (default 5).
 * Throws CliError('TIMEOUT', ..., 124) on timeout.
 */
export async function waitForSessionIdle(
  client: Pick<HostClient, 'resolveSession' | 'capture'>,
  selector: string,
  options: { idleS?: number; timeoutS?: number; pollMs?: number; sleepFn?: (ms: number) => Promise<void> } = {},
): Promise<WaitIdleResult> {
  const idleS = options.idleS ?? 5;
  const timeoutS = options.timeoutS ?? 300;
  const pollMs = options.pollMs ?? 1000;
  const pause = options.sleepFn ?? sleep;
  const started = Date.now();
  const deadline = started + timeoutS * 1000;

  let lastScreen: string | null = null;
  let unchangedSince = started;
  let lastRow: SessionRow | null = null;

  for (;;) {
    const row = await client.resolveSession(selector);
    lastRow = row;
    const now = Date.now();

    if (row.phase && row.phase !== 'running') {
      return { row, state: row.phase, reason: 'phase', elapsedMs: now - started };
    }

    if (row.agentState !== null) {
      if (row.agentState === 'idle' || row.agentState === 'waiting') {
        return { row, state: row.agentState, reason: 'agent_state', elapsedMs: now - started };
      }
      // agentState === 'working': reset screen idle timer and keep polling.
      lastScreen = null;
      unchangedSince = now;
    } else {
      const screen = trimCapture(await client.capture(row, { mode: 'screen' }));
      if (lastScreen === null || screen !== lastScreen) {
        lastScreen = screen;
        unchangedSince = now;
      } else if (now - unchangedSince >= idleS * 1000) {
        return { row, state: 'idle', reason: 'screen_idle', elapsedMs: now - started };
      }
    }

    if (Date.now() >= deadline) {
      throw new CliError(
        'TIMEOUT',
        `session ${lastRow.name} did not become idle within ${timeoutS}s`,
        EXIT.TIMEOUT,
        {
          session: ref(lastRow),
          agentState: lastRow.agentState,
        },
      );
    }
    await pause(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}

/** Fetch broker presence map (deviceId -> DevicePresence) for all gateway hosts; never throws. */
async function fetchPresenceMap(hosts: readonly HostEntry[]): Promise<Map<string, DevicePresence | null>> {
  const map = new Map<string, DevicePresence | null>();
  const servers = new Set<string | undefined>();
  for (const h of hosts) {
    if (h.mode === 'gateway' && h.gateway) servers.add(h.gateway.server);
  }
  if (servers.size === 0) return map;
  let token: string;
  try {
    token = await mintGatewayToken();
  } catch {
    return map;
  }
  await Promise.all(
    [...servers].map(async (server) => {
      try {
        const endpoint = resolveEndpoint(server, server?.toLowerCase().startsWith('ws://') ?? false);
        const devices = await fetchDevices(endpoint, token, 5_000);
        for (const dev of devices) {
          map.set(dev.id, dev.presence);
        }
      } catch {
        /* ignore broker errors during non-fatal presence lookup */
      }
    }),
  );
  return map;
}

async function runAHosts(opts: { check?: boolean; json?: boolean }): Promise<void> {
  if (opts.json) setJsonMode(true);
  const def = defaultHostName() ?? 'local';
  const hosts = allCandidateHosts();
  const presenceByDevice = await fetchPresenceMap(hosts);

  if (!opts.check) {
    const rows = hosts.map((host) => {
      const isDefault = host.name === def;
      const presence = host.mode === 'gateway' && host.gateway ? (presenceByDevice.get(host.gateway.deviceId) ?? null) : null;
      const online = host.mode === 'local' ? true : presence ? presence.online : null;
      const status = online === true ? 'online' : online === false ? 'offline' : 'unknown';
      return {
        ...host,
        default: isDefault,
        online,
        status,
        ...(host.mode === 'gateway' ? { presence } : {}),
      };
    });
    emit({ ok: true, hosts: rows }, () =>
      table(
        ['NAME', 'MODE', 'STATUS', 'TARGET'],
        rows.map((r) => [
          `${r.default ? '*' : ' '} ${safeLine(r.name)}`,
          safeLine(r.mode),
          r.status === 'unknown' ? '-' : r.status,
          safeLine(describeHost(r)),
        ]),
      ),
    );
    return;
  }

  const checked = await Promise.all(
    hosts.map(async (host) => {
      const isDefault = host.name === def;
      const presence = host.mode === 'gateway' && host.gateway ? (presenceByDevice.get(host.gateway.deviceId) ?? null) : null;
      const started = Date.now();
      let connection;
      try {
        connection = await openConnection(host);
        const versions = await new HostClient(connection, host.binary).probe();
        const ms = Date.now() - started;
        const missing = versions.pocketshell === null;
        return {
          ...host,
          default: isDefault,
          online: !missing,
          status: (missing ? 'error' : 'online') as 'online' | 'offline' | 'error',
          ms,
          pocketshell: versions.pocketshell,
          aplexer: versions.aplexer,
          ...(host.mode === 'gateway' ? { presence } : {}),
          ...(missing
            ? {
                error: {
                  code: 'HOST_CLI_MISSING',
                  message: `no working \`${host.binary ?? 'pocketshell'}\` CLI on ${host.name}`,
                },
              }
            : {}),
        };
      } catch (error) {
        const ms = Date.now() - started;
        const c = classify(error);
        const status: 'offline' | 'error' = c.code === 'HOST_OFFLINE' ? 'offline' : 'error';
        return {
          ...host,
          default: isDefault,
          online: false,
          status,
          ms,
          pocketshell: null,
          aplexer: null,
          ...(host.mode === 'gateway' ? { presence } : {}),
          error: { code: c.code, message: c.message, ...(c.details ?? {}) },
        };
      } finally {
        await connection?.close();
      }
    }),
  );

  emit({ ok: true, hosts: checked }, () =>
    table(
      ['NAME', 'MODE', 'STATUS', 'POCKETSHELL', 'APLEXER', 'DETAIL'],
      checked.map((r) => [
        `${r.default ? '*' : ' '} ${safeLine(r.name)}`,
        safeLine(r.mode),
        r.status,
        safeLine(r.pocketshell ?? '-'),
        safeLine(r.aplexer ?? '-'),
        r.error
          ? safeLine((r.error as { detail?: string }).detail ?? r.error.message)
          : `${r.ms}ms`,
      ]),
    ),
  );
}

function configureSubcommandErrorHandling(command: Command): void {
  command.exitOverride();
  command.configureOutput({ outputError: () => {} });
  command.showHelpAfterError(false);
  for (const sub of command.commands) configureSubcommandErrorHandling(sub);
}

/** Build the Commander parser for `psc a <host> <verb> ...`. */
export function buildHostVerbProgram(hostSelector: string): Command {
  const hostCmd = new Command(`psc a ${hostSelector}`).description(`drive aplexer sessions on ${hostSelector}`);

  jsonOption(
    hostCmd
      .command('ls')
      .alias('list')
      .description('sessions on <host> (name, engine, state, workspace) — plain table'),
  ).action(
    action(async (opts: { json?: boolean }) => {
      if (opts.json) setJsonMode(true);
      await withResolvedHost(hostSelector, async (client, host) => {
        const listing = await client.listSessions();
        emit({ ok: true, host: host.name, ...listing }, () => {
          const lines: string[] = [];
          if (listing.sessions.length === 0) {
            lines.push(`no sessions on ${host.name}`);
          } else {
            lines.push(
              table(
                ['NAME', 'ENGINE', 'STATE', 'WORKSPACE'],
                listing.sessions.map((row) => [
                  safeLine(row.name),
                  safeLine(row.engine ?? row.agent ?? '-'),
                  safeLine(row.agentState ?? row.phase ?? '-'),
                  safeLine(row.workspace ?? '-'),
                ]),
              ),
            );
          }
          for (const err of listing.errors) lines.push(`warning: ${safeLine(err.message)}`);
          return lines.join('\n');
        });
      });
    }),
  );

  jsonOption(
    hostCmd
      .command('start <tag>')
      .alias('create')
      .description(
        'create (or reuse live) session <basename DIR>:<tag>; if --prompt is given, wait until ready and send it as one message',
      )
      .option('-C, --cwd <dir>', "working directory on the host (quote a leading ~: -C '~/git/x')")
      .option('-e, --engine <engine>', 'agent engine to launch (claude, codex, opencode, grok, ...)')
      .option('--profile <profile>', 'aplexer profile')
      .option('-p, --prompt <text>', 'initial prompt to send once ready (`-` reads stdin)')
      .option('--ready-timeout <seconds>', 'seconds to wait for the agent to be ready for --prompt', parseSeconds, 30),
  ).action(
    action(
      async (
        tag: string,
        opts: {
          cwd?: string;
          engine?: string;
          profile?: string;
          prompt?: string;
          readyTimeout: number;
          json?: boolean;
        },
      ) => {
        if (opts.json) setJsonMode(true);
        const promptText = await resolvePromptText(opts.prompt);
        await withResolvedHost(hostSelector, async (client, host) => {
          const shortTag = tag.includes(':') ? tag.split(':').pop()! : tag;
          const created = await client.createSession(shortTag, {
            cwd: opts.cwd,
            engine: opts.engine,
            profile: opts.profile,
          });
          if (promptText !== null) {
            const row = await waitForAgentReady(client, created, {
              engine: opts.engine,
              timeoutS: opts.readyTimeout,
            });
            await client.send(row, promptText, { enter: true });
            // Give the agent a moment to register the prompt transition before returning.
            await sleep(250);
          }
          emit(
            {
              ok: true,
              host: host.name,
              name: created.name,
              id: created.id,
              created: created.created,
              prompted: promptText !== null,
              session: created,
            },
            () => safeLine(created.name),
          );
        });
      },
    ),
  );

  jsonOption(
    hostCmd
      .command('send <session> [text]')
      .description(
        'send and SUBMIT (Enter is default; --no-enter to just type). Multi-line text is sent via bracketed paste as one message.',
      )
      .option('--enter', 'press Enter after the text (default)')
      .option('--no-enter', 'type the text without pressing Enter'),
  ).action(
    action(async (selector: string, text: string | undefined, opts: { enter?: boolean; json?: boolean }) => {
      if (opts.json) setJsonMode(true);
      const payload = await resolveSendText(text);
      const enter = opts.enter ?? true;
      const encoded = encodeSendPayload(payload, { enter });
      await withResolvedHost(hostSelector, async (client, host) => {
        const row = await client.resolveSession(selector);
        await client.send(row, payload, { enter });
        emit(
          {
            ok: true,
            host: host.name,
            session: ref(row),
            bytes: Buffer.byteLength(payload),
            enter,
            bracketed: encoded.bracketed,
          },
          () => '',
        );
      });
    }),
  );

  jsonOption(
    hostCmd
      .command('capture <session>')
      .description('plain-text rendered screen by default (no ANSI), trailing blank lines trimmed')
      .option('-n, --lines <n>', 'return the last N non-empty lines', parsePositiveInt)
      .option('--wait-for <regex>', 'poll (~every 500 ms) until the capture matches this regex (multiline)')
      .option('--timeout <seconds>', 'with --wait-for: give up after this long (exit 124)', parseSeconds, 30)
      .option('--raw', 'recent raw output bytes instead of the rendered screen')
      .option('--bytes <n>', 'with --raw: how many history bytes', parsePositiveInt),
  ).action(
    action(
      async (
        selector: string,
        opts: { lines?: number; waitFor?: string; timeout: number; raw?: boolean; bytes?: number; json?: boolean },
      ) => {
        if (opts.json) setJsonMode(true);
        if (opts.bytes !== undefined && !opts.raw) throw usageError('--bytes only applies with --raw');
        const pattern = opts.waitFor === undefined ? null : compileRegex(opts.waitFor);
        await withResolvedHost(hostSelector, async (client, host) => {
          const row = await client.resolveSession(selector);
          const mode = opts.raw ? 'raw' : 'screen';
          const captureOptions = { mode, bytes: opts.bytes } as const;
          if (pattern) {
            const deadline = Date.now() + opts.timeout * 1000;
            for (;;) {
              const rawText = await client.capture(row, captureOptions);
              const match = pattern.exec(rawText);
              if (match) {
                const text = trimCapture(rawText, { raw: opts.raw, lines: opts.lines });
                emit(
                  {
                    ok: true,
                    host: host.name,
                    session: ref(row),
                    mode,
                    text,
                    ...(opts.lines !== undefined ? { lines: opts.lines } : {}),
                    matched: true,
                    match: match[0],
                  },
                  () => text,
                );
                return;
              }
              if (Date.now() >= deadline) {
                const text = trimCapture(rawText, { raw: opts.raw, lines: opts.lines });
                throw new CliError(
                  'TIMEOUT',
                  `${JSON.stringify(pattern.source)} did not appear in ${row.name} within ${opts.timeout}s`,
                  EXIT.TIMEOUT,
                  { session: ref(row), text },
                );
              }
              await sleep(Math.min(500, Math.max(0, deadline - Date.now())));
            }
          }
          const rawText = await client.capture(row, captureOptions);
          const text = trimCapture(rawText, { raw: opts.raw, lines: opts.lines });
          emit(
            {
              ok: true,
              host: host.name,
              session: ref(row),
              mode,
              text,
              ...(opts.lines !== undefined ? { lines: opts.lines } : {}),
            },
            () => text,
          );
        });
      },
    ),
  );

  jsonOption(
    hostCmd
      .command('wait <session>')
      .description("block until the session's agent is idle/waiting (exit 124 on timeout)")
      .option('--idle <seconds>', 'fallback screen-unchanged duration when agent state is not reported', parseSeconds, 5)
      .option('--timeout <seconds>', 'give up after this many seconds (exit 124)', parseSeconds, 300),
  ).action(
    action(async (selector: string, opts: { idle: number; timeout: number; json?: boolean }) => {
      if (opts.json) setJsonMode(true);
      await withResolvedHost(hostSelector, async (client, host) => {
        const result = await waitForSessionIdle(client, selector, {
          idleS: opts.idle,
          timeoutS: opts.timeout,
        });
        emit(
          {
            ok: true,
            host: host.name,
            session: ref(result.row),
            state: result.state,
            agentState: result.row.agentState,
            reason: result.reason,
            elapsedMs: result.elapsedMs,
          },
          () => `${safeLine(result.row.name)} ${safeLine(result.state)}`,
        );
      });
    }),
  );

  jsonOption(
    hostCmd
      .command('stop <session>')
      .alias('kill')
      .description('stop a session and reap its records')
      .option('--if-exists', 'succeed (alreadyGone:true) when no session matches, instead of exit 5'),
  ).action(
    action(async (selector: string, opts: { ifExists?: boolean; json?: boolean }) => {
      if (opts.json) setJsonMode(true);
      await withResolvedHost(hostSelector, async (client, host) => {
        let row: SessionRow;
        try {
          row = await client.resolveSession(selector);
        } catch (error) {
          if (!(opts.ifExists && error instanceof SessionNotFound)) throw error;
          emit(
            {
              ok: true,
              host: host.name,
              session: { name: selector, id: null },
              stopped: false,
              killed: false,
              alreadyGone: true,
            },
            () => `no session matches ${safeLine(selector)}; nothing to stop`,
          );
          return;
        }
        await client.killSession(row.name);
        emit(
          {
            ok: true,
            host: host.name,
            session: ref(row),
            stopped: true,
            killed: true,
            alreadyGone: false,
          },
          () => `stopped ${safeLine(row.name)}`,
        );
      });
    }),
  );

  jsonOption(
    hostCmd
      .command('status <session>')
      .alias('show')
      .description("one session's row (state, agent state, engine, created)"),
  ).action(
    action(async (selector: string, opts: { json?: boolean }) => {
      if (opts.json) setJsonMode(true);
      await withResolvedHost(hostSelector, async (client, host) => {
        const row = await client.resolveSession(selector);
        const createdIso = row.createdEpoch ? new Date(row.createdEpoch * 1000).toISOString() : '-';
        emit({ ok: true, host: host.name, session: row }, () =>
          table(
            ['NAME', 'STATE', 'AGENT STATE', 'ENGINE', 'CREATED', 'WORKSPACE'],
            [
              [
                safeLine(row.name),
                safeLine(row.phase ?? 'running'),
                safeLine(row.agentState ?? '-'),
                safeLine(row.engine ?? row.agent ?? '-'),
                createdIso,
                safeLine(row.workspace ?? '-'),
              ],
            ],
          ),
        );
      });
    }),
  );

  configureSubcommandErrorHandling(hostCmd);
  return hostCmd;
}

/** Build the Commander parser for `psc a hosts [--check] [--json]`. */
export function buildAHostsCommand(): Command {
  const cmd = jsonOption(
    new Command('psc a hosts')
      .description('saved hosts; --check pings each in parallel (online/offline/error + versions)')
      .option('--check', 'ping each host in parallel over SSH/gateway and report versions'),
  ).action(action(runAHosts));
  configureSubcommandErrorHandling(cmd);
  return cmd;
}

const HOST_VERB_NAMES = new Set(['ls', 'list', 'start', 'create', 'send', 'capture', 'wait', 'stop', 'kill', 'status', 'show']);

/**
 * Normalize `psc a` arguments before Commander parsing:
 * - trailing `--prompt` (with no argument) becomes `--prompt -` so piped stdin works.
 */
export function normalizeAArgs(args: readonly string[]): string[] {
  const out = [...args];
  for (let i = 0; i < out.length; i++) {
    if (out[i] === '--') break;
    if ((out[i] === '--prompt' || out[i] === '-p') && (i === out.length - 1 || out[i + 1]?.startsWith('-'))) {
      if (out[i + 1] !== '-') {
        out.splice(i + 1, 0, '-');
      }
    }
  }
  return out;
}

/** Run `psc a ...` given the arguments after `a`. */
export async function dispatchA(rawArgs: readonly string[]): Promise<void> {
  const args = normalizeAArgs(rawArgs);
  const filtered = args.filter((a) => a !== '--json');
  if (args.includes('--json')) setJsonMode(true);

  if (filtered.length === 0) {
    throw usageError('a subcommand is required (see --help)');
  }

  const first = filtered[0]!;
  if (first === '-h' || first === '--help' || first === 'help') {
    if (filtered.length === 1) {
      process.stdout.write(A_HELP);
      return;
    }
    const topic = filtered[1]!;
    if (topic === 'hosts') {
      buildAHostsCommand().outputHelp();
      return;
    }
    if (HOST_VERB_NAMES.has(topic)) {
      const sub = buildHostVerbProgram('<host>').commands.find((c) => c.name() === topic || c.aliases().includes(topic));
      if (sub) {
        sub.outputHelp();
        return;
      }
    }
    process.stdout.write(A_HELP);
    return;
  }

  if (first === 'hosts') {
    const hostsCmd = buildAHostsCommand();
    await hostsCmd.parseAsync(args.slice(args.indexOf('hosts') + 1), { from: 'user' });
    return;
  }

  // `psc a start --help` (verb help without a host argument)
  if (HOST_VERB_NAMES.has(first) && (filtered.includes('--help') || filtered.includes('-h'))) {
    const sub = buildHostVerbProgram('<host>').commands.find((c) => c.name() === first || c.aliases().includes(first));
    if (sub) {
      sub.outputHelp();
      return;
    }
  }

  if (first.startsWith('-')) {
    throw usageError(`unknown option '${first}' (see --help)`);
  }

  // First argument is `<host>`, remaining arguments are `<verb> [args...]`.
  const hostIndex = args.indexOf(first);
  const rest = [...args.slice(0, hostIndex), ...args.slice(hostIndex + 1)];
  const restWithoutJson = rest.filter((a) => a !== '--json');
  if (restWithoutJson.length === 0) {
    throw usageError(`missing command for host ${JSON.stringify(first)} (expected ls, start, send, capture, wait, stop, or status)`);
  }
  if (restWithoutJson.length === 1 && (restWithoutJson[0] === '--help' || restWithoutJson[0] === '-h')) {
    buildHostVerbProgram(first).outputHelp();
    return;
  }
  const hostProg = buildHostVerbProgram(first);
  await hostProg.parseAsync(rest, { from: 'user' });
}

export function registerA(program: Command): void {
  program
    .command('a [args...]')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .helpOption(false)
    .description('remote aplexer: hosts, ls, start, send, capture, wait, stop, status (see `psc a --help`)')
    .action(async (args: string[]) => {
      await dispatchA(args);
    });
}
