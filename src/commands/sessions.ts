/**
 * The session verbs — what an agent drives a host with:
 * `sessions list|create|kill|send|capture|attach|warnings|ack`,
 * `workspaces list|add|remove`, `engines`, `profiles`, and `exec`.
 */
import type { Command } from 'commander';
import type { SessionRow } from '@pocketshell/core';
import { execCommandLine, SessionNotFound, type HostClient } from '../hostClient.js';
import { CliError, emit, EXIT, isJsonMode, note, setJsonMode, usageError } from '../output.js';
import { safeLine, safeText } from '../sanitize.js';
import { action, hostOptions, parsePositiveInt, parseSeconds, withHost } from './common.js';

type HostOpts = { host?: string; json?: boolean };

const SESSION_HELP = `
Session names and selectors:
  A session is named <workspace>:<tag>, where <workspace> is the basename of
  its working directory (-C) on the host and <tag> is the NAME you create it
  with: \`sessions create review -C '~/git/project'\` makes \`project:review\`.

  A SESSION argument accepts, in this order of precedence:
    1. the full name (\`project:review\`) or the aplexer id (exact),
    2. a tag (\`review\`) that exactly one session has,
    3. a unique prefix (4+ characters) of the aplexer id.
  A selector matching more than one session fails with SESSION_AMBIGUOUS
  (exit 5) and lists the candidates (JSON: error.candidates[{name,id}]);
  no match fails with SESSION_NOT_FOUND (exit 5).`;

function ago(epoch: number | null): string {
  if (!epoch) return '-';
  const secs = Math.max(0, Math.floor(Date.now() / 1000 - epoch));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

export function sessionLine(row: SessionRow): string {
  const state = row.agentState ?? row.phase ?? '';
  const agent = row.agent ?? row.engine ?? '';
  return [
    row.attached ? '●' : ' ',
    safeLine(row.name).padEnd(40),
    safeLine(agent).padEnd(8),
    safeLine(state).padEnd(9),
    ago(row.activityEpoch).padStart(4),
  ].join(' ');
}

/** Rows of cells → aligned columns (cells are already safe text). */
export function table(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!)))
      .join('  ')
      .trimEnd();
  return [line(header), ...rows.map(line)].join('\n');
}

/** The `{name, id}` every session-verb JSON document carries. */
function ref(row: SessionRow): { name: string; id: string | null } {
  return { name: row.name, id: row.id };
}

/** Read everything from stdin (for `send -` / piped input). */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Capture text for a human terminal: escapes stripped unless raw bytes go to a pipe. */
function humanCapture(text: string, raw: boolean): string {
  return raw && !process.stdout.isTTY ? text : safeText(text);
}

function compileRegex(source: string): RegExp {
  try {
    return new RegExp(source, 'm');
  } catch (error) {
    throw usageError(`invalid --wait-for regex: ${(error as Error).message}`);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll the capture every ~500 ms until `pattern` matches or `timeoutS` passes. */
async function waitForCapture(
  client: HostClient,
  row: SessionRow,
  options: { mode: 'screen' | 'raw'; bytes?: number },
  pattern: RegExp,
  timeoutS: number,
): Promise<{ text: string; match: string }> {
  const deadline = Date.now() + timeoutS * 1000;
  for (;;) {
    const text = await client.capture(row, options);
    const match = pattern.exec(text);
    if (match) return { text, match: match[0] };
    if (Date.now() >= deadline) {
      throw new CliError(
        'TIMEOUT',
        `${JSON.stringify(pattern.source)} did not appear in ${row.name} within ${timeoutS}s`,
        EXIT.TIMEOUT,
        { session: ref(row), text },
      );
    }
    await sleep(Math.min(500, Math.max(0, deadline - Date.now())));
  }
}

export function registerSessions(program: Command): void {
  const sessions = program
    .command('sessions')
    .alias('s')
    .description('list, create, drive and attach to sessions')
    .addHelpText('after', SESSION_HELP);

  hostOptions(sessions.command('list').alias('ls').description('list sessions on the host')).action(
    action(async (opts: HostOpts) =>
      withHost(opts, async (client, host) => {
        const listing = await client.listSessions();
        emit({ ok: true, host: host.name, ...listing }, () => {
          const lines = listing.sessions.length === 0 ? [`no sessions on ${host.name}`] : listing.sessions.map(sessionLine);
          for (const error of listing.errors) lines.push(`warning: ${safeLine(error.message)}`);
          return lines.join('\n');
        });
      }),
    ),
  );

  hostOptions(
    sessions
      .command('create <name>')
      .description('create a session named <basename of cwd>:<name> (or reuse the live one with that name)')
      .option('-C, --cwd <dir>', "working directory on the host (quote a leading ~ so it reaches the host: -C '~/git/x')")
      .option('-e, --engine <engine>', 'agent engine to launch (see `engines`); omit it for a plain shell')
      .option('--profile <profile>', 'aplexer profile (see `profiles`)')
      .option('-a, --attach', 'attach right after creating (not with --json)')
      .addHelpText(
        'after',
        '\n--json: {"ok":true,"host":...,"name":"project:review","id":"<aplexer id>","created":true|false,\n' +
          '        "session":{"name","id","created"}}   (created:false = an existing live session was reused)' +
          `\n${SESSION_HELP}`,
      ),
  ).action(
    action(async (name: string, opts: HostOpts & { cwd?: string; engine?: string; profile?: string; attach?: boolean }) => {
      if (opts.json) setJsonMode(true);
      if (opts.attach && isJsonMode()) throw usageError('--attach takes over the terminal and cannot be combined with --json');
      await withHost(opts, async (client, host) => {
        const created = await client.createSession(name, { cwd: opts.cwd, engine: opts.engine, profile: opts.profile });
        if (opts.attach) {
          const row = await client.resolveSession(created.id ?? created.name);
          process.exitCode = (await client.attach(row)) ?? 1;
          return;
        }
        emit(
          { ok: true, host: host.name, name: created.name, id: created.id, created: created.created, session: created },
          () => `${created.created ? 'created' : 'reused'} ${safeLine(created.name)}${created.id ? ` (${safeLine(created.id)})` : ''}`,
        );
      });
    }),
  );

  hostOptions(
    sessions
      .command('kill <session>')
      .description('stop a session and reap its records')
      .option('--if-exists', 'succeed (alreadyGone:true) when no session matches, instead of exit 5')
      .addHelpText('after', '\n--json: {"ok":true,"host":...,"session":{"name","id"},"killed":true,"alreadyGone":false}'),
  ).action(
    action(async (selector: string, opts: HostOpts & { ifExists?: boolean }) =>
      withHost(opts, async (client, host) => {
        let row: SessionRow;
        try {
          row = await client.resolveSession(selector);
        } catch (error) {
          if (!(opts.ifExists && error instanceof SessionNotFound)) throw error;
          emit(
            { ok: true, host: host.name, session: { name: selector, id: null }, killed: false, alreadyGone: true },
            () => `no session matches ${safeLine(selector)}; nothing to kill`,
          );
          return;
        }
        await client.killSession(row.name);
        emit({ ok: true, host: host.name, session: ref(row), killed: true, alreadyGone: false }, () => `killed ${safeLine(row.name)}`);
      }),
    ),
  );

  hostOptions(
    sessions
      .command('send <session> [text]')
      .description('type TEXT into a session without attaching; it is NOT submitted unless --enter is given')
      .option('--enter', 'press Enter after the text (submits a prompt / runs a command line)')
      .addHelpText(
        'after',
        '\nTEXT `-` or omitted reads stdin; ONE trailing newline is stripped from stdin input\n' +
          '(so `echo hi | psc sessions send x --enter` types "hi" and presses Enter once).\n' +
          'Without --enter the text sits typed but unsubmitted.\n' +
          '--json: {"ok":true,"host":...,"session":{"name","id"},"bytes":N,"enter":true|false}' +
          `\n${SESSION_HELP}`,
      ),
  ).action(
    action(async (selector: string, text: string | undefined, opts: HostOpts & { enter?: boolean }) =>
      withHost(opts, async (client, host) => {
        const payload = text === undefined || text === '-' ? (await readStdin()).replace(/\r?\n$/, '') : text;
        const row = await client.resolveSession(selector);
        const enter = Boolean(opts.enter);
        await client.send(row, payload, { enter });
        emit({ ok: true, host: host.name, session: ref(row), bytes: Buffer.byteLength(payload), enter }, () => '');
      }),
    ),
  );

  hostOptions(
    sessions
      .command('capture <session>')
      .description('print what a session shows now (default: the rendered screen as plain text)')
      .option('--raw', 'recent raw output bytes instead of the rendered screen')
      .option('--bytes <n>', 'with --raw: how many history bytes', parsePositiveInt)
      .option('--wait-for <regex>', 'poll (~every 500 ms) until the capture matches this JavaScript regex (multiline: ^/$ match per line)')
      .option('--timeout <seconds>', 'with --wait-for: give up after this long (exit 124, error TIMEOUT)', parseSeconds, 30)
      .addHelpText(
        'after',
        '\n--json: {"ok":true,"host":...,"session":{"name","id"},"mode":"screen"|"raw","text":...}\n' +
          '        with --wait-for also "matched":true,"match":"<matched text>"; on timeout\n' +
          '        {"ok":false,"error":{"code":"TIMEOUT","message",...,"text":"<last capture>"}}' +
          `\n${SESSION_HELP}`,
      ),
  ).action(
    action(async (selector: string, opts: HostOpts & { raw?: boolean; bytes?: number; waitFor?: string; timeout: number }) => {
      if (opts.json) setJsonMode(true);
      if (opts.bytes !== undefined && !opts.raw) throw usageError('--bytes only applies with --raw');
      const pattern = opts.waitFor === undefined ? null : compileRegex(opts.waitFor);
      await withHost(opts, async (client, host) => {
        const row = await client.resolveSession(selector);
        const mode = opts.raw ? 'raw' : 'screen';
        const captureOptions = { mode, bytes: opts.bytes } as const;
        if (pattern) {
          const { text, match } = await waitForCapture(client, row, captureOptions, pattern, opts.timeout);
          emit({ ok: true, host: host.name, session: ref(row), mode, text, matched: true, match }, () =>
            humanCapture(text, Boolean(opts.raw)),
          );
          return;
        }
        const text = await client.capture(row, captureOptions);
        emit({ ok: true, host: host.name, session: ref(row), mode, text }, () => humanCapture(text, Boolean(opts.raw)));
      });
    }),
  );

  const attachAction = action(async (selector: string, opts: HostOpts) => {
    if (opts.json) setJsonMode(true);
    if (isJsonMode()) throw usageError('attach takes over the terminal and has no --json output');
    await withHost(opts, async (client) => {
      const row = await client.resolveSession(selector);
      note(`attaching to ${safeLine(row.name)} — Ctrl-b d to detach`);
      process.exitCode = (await client.attach(row)) ?? 1;
    });
  });

  hostOptions(
    sessions
      .command('attach <session>')
      .description('attach this terminal to a session (Ctrl-b d detaches)')
      .addHelpText('after', SESSION_HELP),
  ).action(attachAction);

  hostOptions(sessions.command('warnings').description('unacknowledged crash/OOM warnings')).action(
    action(async (opts: HostOpts) =>
      withHost(opts, async (client, host) => {
        const warnings = await client.listWarnings();
        emit({ ok: true, host: host.name, warnings }, () =>
          warnings.length === 0
            ? 'no warnings'
            : warnings
                .map((w) => `${safeLine(w.kind ?? '?')} ${safeLine(w.session ?? w.tag ?? '?')}: ${safeLine(w.detail ?? '')}`)
                .join('\n'),
        );
      }),
    ),
  );

  hostOptions(sessions.command('ack [selector]').description('acknowledge crash/OOM warnings (all when omitted)')).action(
    action(async (selector: string | undefined, opts: HostOpts) =>
      withHost(opts, async (client, host) => {
        await client.ackWarnings(selector ?? null);
        emit({ ok: true, host: host.name }, () => 'acknowledged');
      }),
    ),
  );

  // Top-level shortcut: the verb people reach for most.
  hostOptions(program.command('attach <session>').description('shortcut for `sessions attach`')).action(attachAction);
}

export function registerWorkspaces(program: Command): void {
  const ws = program.command('workspaces').alias('ws').description("the host's durable workspace list");
  const show = (opts: HostOpts, fn: 'list' | 'add' | 'remove', path?: string) =>
    withHost(opts, async (client, host) => {
      const listing =
        fn === 'list' ? await client.listWorkspaces() : fn === 'add' ? await client.addWorkspace(path!) : await client.removeWorkspace(path!);
      emit({ ok: true, host: host.name, ...listing }, () =>
        listing.workspaces.length === 0 ? 'no workspaces' : listing.workspaces.map((w) => safeLine(w.displayPath)).join('\n'),
      );
    });
  hostOptions(ws.command('list').description('list workspaces')).action(action(async (opts: HostOpts) => show(opts, 'list')));
  hostOptions(ws.command('add <path>').description('add a workspace')).action(
    action(async (path: string, opts: HostOpts) => show(opts, 'add', path)),
  );
  hostOptions(ws.command('remove <path>').description('remove a workspace')).action(
    action(async (path: string, opts: HostOpts) => show(opts, 'remove', path)),
  );
}

export function registerCatalog(program: Command): void {
  hostOptions(program.command('engines').description('agent engines the host can launch')).action(
    action(async (opts: HostOpts) =>
      withHost(opts, async (client, host) => {
        const engines = await client.listEngines();
        emit({ ok: true, host: host.name, engines }, () =>
          engines.length === 0
            ? 'no engines'
            : table(
                ['ID', 'LABEL', 'CREATE', 'NOTE'],
                engines.map((e) => [
                  safeLine(e.id),
                  safeLine(e.label),
                  e.availableForCreate ? 'yes' : 'no',
                  safeLine(e.unavailableReason ?? (e.enabled ? '' : 'disabled')),
                ]),
              ),
        );
      }),
    ),
  );
  hostOptions(program.command('profiles').description('aplexer profiles on the host')).action(
    action(async (opts: HostOpts) =>
      withHost(opts, async (client, host) => {
        const profiles = await client.listProfiles();
        emit({ ok: true, host: host.name, profiles }, () =>
          profiles.length === 0
            ? 'no profiles'
            : table(
                ['NAME', 'ENGINE', 'DEFAULT', 'CONFIG DIR'],
                profiles.map((p) => [safeLine(p.name), safeLine(p.engine), p.isDefault ? 'yes' : '', safeLine(p.configDir ?? '')]),
              ),
        );
      }),
    ),
  );
}

const EXEC_HELP = `
One word is a shell command line, run as-is by the host's sh:
  psc exec 'cd ~/git/x && make test'
Several words are an argv: each is quoted, so nothing is re-interpreted:
  psc exec -- ls -la /tmp          (runs: 'ls' '-la' '/tmp')
Put -- before the command so its own flags aren't read as psc options.

Exit status: the command's own exit code. --json:
  {"ok":true,"host":...,"command":...,"exitCode":0,"stdout":...,"stderr":...,"timedOut":false}
  non-zero exit N: ok:false, error {"code":"COMMAND_FAILED","message":"exit N"}, exit N
  timeout:         ok:false, error {"code":"TIMEOUT"}, exit 124 (over ssh/gateway
                   the command may still be running on the host)
  no exit status:  ok:false, error {"code":"CONNECTION_LOST"}, exit 4`;

export function registerExec(program: Command): void {
  hostOptions(
    program
      .command('exec <command...>')
      .description('run a command on the host and print its output')
      .option('-t, --timeout <seconds>', 'stop waiting (and kill it) after this long', parseSeconds, 60)
      .addHelpText('after', EXEC_HELP),
  ).action(
    action(async (words: string[], opts: HostOpts & { timeout: number }) =>
      withHost(opts, async (client, host) => {
        const command = execCommandLine(words);
        const outcome = await client.run(command, opts.timeout * 1000);
        let error: { code: string; message: string } | null = null;
        let exit = outcome.exitCode ?? EXIT.CONNECT;
        if (outcome.timedOut) {
          error = {
            code: 'TIMEOUT',
            message: `timed out after ${opts.timeout}s${host.mode === 'local' ? '' : '; the command may still be running on the host'}`,
          };
          exit = EXIT.TIMEOUT;
        } else if (outcome.exitCode === null) {
          error = {
            code: 'CONNECTION_LOST',
            message: 'the command ended without an exit status (killed by a signal, or the connection dropped)',
          };
        } else if (outcome.exitCode !== 0) {
          error = { code: 'COMMAND_FAILED', message: `exit ${outcome.exitCode}` };
        }
        emit({ ok: error === null, host: host.name, command, ...outcome, ...(error ? { error } : {}) }, () => {
          process.stderr.write(outcome.stderr);
          process.stdout.write(outcome.stdout);
          if (error && error.code !== 'COMMAND_FAILED') process.stderr.write(`error: ${error.message}\n`);
          return '';
        });
        process.exitCode = exit;
      }),
    ),
  );
}
