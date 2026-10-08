/**
 * The session verbs — what an agent drives a host with:
 * `sessions list|create|kill|send|capture|attach|warnings|ack`,
 * `workspaces list|add|remove`, `engines`, `profiles`, and `exec`.
 */
import type { Command } from 'commander';
import type { SessionRow } from '@pocketshell/core';
import { emit, note } from '../output.js';
import { action, hostOptions, withHost } from './common.js';

type HostOpts = { host?: string; json?: boolean };

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
    row.name.padEnd(40),
    agent.padEnd(8),
    state.padEnd(9),
    ago(row.activityEpoch).padStart(4),
  ].join(' ');
}

/** Read everything from stdin (for `send -` / piped input). */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export function registerSessions(program: Command): void {
  const sessions = program.command('sessions').alias('s').description('list, create, drive and attach to sessions');

  hostOptions(sessions.command('list').alias('ls').description('list sessions on the host')).action(
    action(async (opts: HostOpts) =>
      withHost(opts, async (client, host) => {
        const listing = await client.listSessions();
        emit({ ok: true, host: host.name, ...listing }, () => {
          if (listing.sessions.length === 0) return `no sessions on ${host.name}`;
          const lines = listing.sessions.map(sessionLine);
          for (const error of listing.errors) lines.push(`warning: ${error.message}`);
          return lines.join('\n');
        });
      }),
    ),
  );

  hostOptions(
    sessions
      .command('create <name>')
      .description('create a session (or reuse the live one with the same name)')
      .option('-C, --cwd <dir>', 'working directory on the host')
      .option('-e, --engine <engine>', 'agent engine (see `engines`)')
      .option('--profile <profile>', 'aplexer profile (see `profiles`)')
      .option('-a, --attach', 'attach right after creating'),
  ).action(
    action(async (name: string, opts: HostOpts & { cwd?: string; engine?: string; profile?: string; attach?: boolean }) =>
      withHost(opts, async (client, host) => {
        const created = await client.createSession(name, { cwd: opts.cwd, engine: opts.engine, profile: opts.profile });
        if (opts.attach) {
          const row = await client.resolveSession(created.id ?? created.name);
          process.exitCode = (await client.attach(row)) ?? 1;
          return;
        }
        emit({ ok: true, host: host.name, session: created }, () =>
          `${created.created ? 'created' : 'reused'} ${created.name}${created.id ? ` (${created.id})` : ''}`,
        );
      }),
    ),
  );

  hostOptions(sessions.command('kill <session>').description('stop a session and reap its records')).action(
    action(async (selector: string, opts: HostOpts) =>
      withHost(opts, async (client, host) => {
        const row = await client.resolveSession(selector);
        await client.killSession(row.name);
        emit({ ok: true, host: host.name, killed: row.name, id: row.id }, () => `killed ${row.name}`);
      }),
    ),
  );

  hostOptions(
    sessions
      .command('send <session> [text]')
      .description('type into a session without attaching (text `-` or omitted reads stdin)')
      .option('--enter', 'press Enter after the text (submit a prompt)')
      .option('--no-enter', 'do not press Enter (default when text is omitted)'),
  ).action(
    action(async (selector: string, text: string | undefined, opts: HostOpts & { enter?: boolean }) =>
      withHost(opts, async (client, host) => {
        const payload = text === undefined || text === '-' ? await readStdin() : text;
        const row = await client.resolveSession(selector);
        await client.send(row, payload, { enter: opts.enter });
        emit({ ok: true, host: host.name, session: row.name, bytes: Buffer.byteLength(payload), enter: Boolean(opts.enter) }, () => '');
      }),
    ),
  );

  hostOptions(
    sessions
      .command('capture <session>')
      .description('print what a session shows now (default: the rendered screen as plain text)')
      .option('--raw', 'recent raw output bytes instead of the rendered screen')
      .option('--bytes <n>', 'with --raw: how many history bytes', (v) => Number(v)),
  ).action(
    action(async (selector: string, opts: HostOpts & { raw?: boolean; bytes?: number }) =>
      withHost(opts, async (client, host) => {
        const row = await client.resolveSession(selector);
        const text = await client.capture(row, { mode: opts.raw ? 'raw' : 'screen', bytes: opts.bytes });
        emit({ ok: true, host: host.name, session: row.name, mode: opts.raw ? 'raw' : 'screen', text }, () => text);
      }),
    ),
  );

  hostOptions(sessions.command('attach <session>').description('attach this terminal to a session (Ctrl-b d detaches)')).action(
    action(async (selector: string, opts: HostOpts) =>
      withHost(opts, async (client) => {
        const row = await client.resolveSession(selector);
        note(`attaching to ${row.name} — Ctrl-b d to detach`);
        process.exitCode = (await client.attach(row)) ?? 1;
      }),
    ),
  );

  hostOptions(sessions.command('warnings').description('unacknowledged crash/OOM warnings')).action(
    action(async (opts: HostOpts) =>
      withHost(opts, async (client, host) => {
        const warnings = await client.listWarnings();
        emit({ ok: true, host: host.name, warnings }, () =>
          warnings.length === 0
            ? 'no warnings'
            : warnings.map((w) => `${w.kind ?? '?'} ${w.session ?? w.tag ?? '?'}: ${w.detail ?? ''}`).join('\n'),
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

  // Top-level shortcuts: the verbs people and agents reach for most.
  hostOptions(program.command('attach <session>').description('shortcut for `sessions attach`')).action(
    action(async (selector: string, opts: HostOpts) =>
      withHost(opts, async (client) => {
        const row = await client.resolveSession(selector);
        note(`attaching to ${row.name} — Ctrl-b d to detach`);
        process.exitCode = (await client.attach(row)) ?? 1;
      }),
    ),
  );
}

export function registerWorkspaces(program: Command): void {
  const ws = program.command('workspaces').alias('ws').description("the host's durable workspace list");
  const show = (opts: HostOpts, fn: 'list' | 'add' | 'remove', path?: string) =>
    withHost(opts, async (client, host) => {
      const listing =
        fn === 'list' ? await client.listWorkspaces() : fn === 'add' ? await client.addWorkspace(path!) : await client.removeWorkspace(path!);
      emit({ ok: true, host: host.name, ...listing }, () =>
        listing.workspaces.length === 0 ? 'no workspaces' : listing.workspaces.map((w) => w.displayPath).join('\n'),
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
        emit({ ok: true, host: host.name, engines }, () => engines.map((e) => JSON.stringify(e)).join('\n'));
      }),
    ),
  );
  hostOptions(program.command('profiles').description('aplexer profiles on the host')).action(
    action(async (opts: HostOpts) =>
      withHost(opts, async (client, host) => {
        const profiles = await client.listProfiles();
        emit({ ok: true, host: host.name, profiles }, () => profiles.map((p) => JSON.stringify(p)).join('\n'));
      }),
    ),
  );
}

export function registerExec(program: Command): void {
  hostOptions(
    program
      .command('exec <command...>')
      .description('run a shell command on the host and print its output (use -- before the command)')
      .option('-t, --timeout <seconds>', 'kill it after this long', (v) => Number(v), 60),
  ).action(
    action(async (words: string[], opts: HostOpts & { timeout: number }) =>
      withHost(opts, async (client, host) => {
        const outcome = await client.run(words.join(' '), opts.timeout * 1000);
        emit({ ok: outcome.exitCode === 0, host: host.name, ...outcome }, () => {
          process.stderr.write(outcome.stderr);
          return outcome.stdout;
        });
        process.exitCode = outcome.exitCode ?? 124;
      }),
    ),
  );
}
