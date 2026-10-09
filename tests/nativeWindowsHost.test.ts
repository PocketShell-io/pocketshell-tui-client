import { describe, expect, it } from 'vitest';
import { HostClient, SessionAmbiguous } from '../src/hostClient.js';
import { NativeCreateUncertain, NativeWindowsHost, validateNativeWindowsPolicy } from '../src/nativeWindowsHost.js';
import type { HostEntry } from '../src/hosts/store.js';
import type { Connection, ExecOutcome } from '../src/transport/types.js';

const executable = 'C:/Users/Fixture/Protected Runtime/Scripts/pocketshell.exe';
const id = '12345678-1234-1234-1234-123456789abc';
const second = '87654321-4321-4321-4321-cba987654321';
const policy = { executable, transport: 'openssh-git-bash' as const, deviceId: 'enrolled-fixture' };
const caps = ['workspaces', 'tree', 'sessions.list', 'sessions.attach', 'sessions.create', 'sessions.kill', 'workspaces.add', 'workspaces.remove', 'tree.cas'];
const profile: HostEntry = { name: 'display-alias', mode: 'gateway', gateway: { deviceId: policy.deviceId }, nativeWindowsCli: policy };
const row = (uuid = id, workspace = 'C:/one/project') => ({ name: 'project:main', id: uuid, workspace, tag: 'main', attached: false });
const outcome = (value: unknown, exitCode = 0): ExecOutcome => ({ exitCode, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '', timedOut: false });

function fixture(options: { capabilities?: string[]; version?: string; platform?: unknown; rows?: ReturnType<typeof row>[]; create?: ExecOutcome; rereadFails?: boolean } = {}) {
  const commands: string[] = [];
  const attached: string[] = [];
  const connection: Connection = {
    hostName: profile.name, mode: 'gateway', close: async () => {},
    exec: async (command) => {
      commands.push(command);
      if (command.endsWith('--version')) return outcome(options.version ?? 'pocketshell, version 0.5.8\n');
      if (command.endsWith('platform --json')) return outcome(options.platform ?? { schema: 1, platform: 'win32', os: 'nt', cli_version: '0.5.8', capabilities: options.capabilities ?? caps });
      if (command.includes('sessions list')) return options.rereadFails ? outcome('', 1) : outcome({ schema: 3, sessions: options.rows ?? [row()], errors: [] });
      if (command.includes('sessions create')) return options.create ?? outcome({ schema: 3, name: 'project:main', id, created: true });
      if (command.includes('sessions kill')) return outcome({ schema: 3, id: command.includes(second) ? second : id, killed: true });
      if (command.includes('workspaces')) return outcome({ schema: 1, workspaces: [{ path: 'C:/one/project', display_path: 'project' }] });
      return outcome('literal-user-output');
    },
    attachInteractive: async (command) => { attached.push(command); return 0; },
  };
  return { commands, attached, connection, client: new HostClient(connection, undefined, profile) };
}

describe('explicit native gateway profile', () => {
  it('accepts actual drive colon/spaces only through explicit policy', () => {
    expect(validateNativeWindowsPolicy(policy)).toEqual(policy);
    const { connection } = fixture();
    expect(() => new HostClient(connection, executable)).toThrow(/invalid --binary/);
    expect(() => new HostClient(connection, undefined, { ...profile, nativeWindowsCli: { ...policy, deviceId: 'different-device' } })).toThrow(/device ID/);
    expect(() => new HostClient({ ...connection, hostName: 'other-alias' }, undefined, profile)).toThrow(/does not match/);
    expect(() => new HostClient({ ...connection, mode: 'ssh' }, undefined, profile)).toThrow(/does not match/);
    expect(() => validateNativeWindowsPolicy({ ...policy, transport: 'cmd-git-bash' })).toThrow(/not qualified/);
  });

  it.each(['C:/bad"path/pocketshell.exe', "C:/bad'path/pocketshell.exe", 'C:/bad$path/pocketshell.exe', 'C:/../pocketshell.exe', 'pocketshell.exe', 'C:\\runtime\\pocketshell.exe'])('rejects unqualified path %s', (path) => {
    expect(() => validateNativeWindowsPolicy({ ...policy, executable: path })).toThrow();
  });

  it('probes only provisioned CLI and validates actual capability payload', async () => {
    const f = fixture();
    expect(await f.client.probe()).toEqual({ pocketshell: 'pocketshell, version 0.5.8', aplexer: null });
    expect(f.commands).toEqual([`'${executable}' --version`, `'${executable}' platform --json`]);
    const bad = fixture({ capabilities: ['sessions.list'] });
    await expect(bad.client.listSessions()).rejects.toThrow(/incompatible/);
    expect(bad.commands).toHaveLength(2);
    await expect(bad.client.probe()).rejects.toThrow(/incompatible/);
    expect(bad.commands).toHaveLength(2); // failed qualification never retries via PATH
  });

  it.each([
    { schema: 2, platform: 'win32', os: 'nt', cli_version: '0.5.8', capabilities: caps },
    { schema: 1, platform: 'linux', os: 'posix', cli_version: '0.5.8', capabilities: caps },
    { schema: 1, platform: 'win32', os: 'nt', cli_version: '0.5.8', capabilities: ['sessions.list', 2] },
  ])('refuses malformed or incompatible platform independent of labels', async (platform) => {
    await expect(fixture({ platform }).client.listSessions()).rejects.toThrow();
  });

  it('rejects an incompatible version without issuing platform or session commands', async () => {
    const f = fixture({ version: 'pocketshell, version 0.5.9' });
    await expect(f.client.probe()).rejects.toThrow(/0.5.8/);
    expect(f.commands).toHaveLength(1);
  });
});

describe('native session routing', () => {
  it('retains full workspace and UUID; accepted NONPTY and PTY spellings are distinct', async () => {
    const f = fixture();
    const listing = await f.client.listSessions();
    expect(listing.sessions[0]).toMatchObject({ id, workspace: 'C:/one/project' });
    expect(f.commands.at(-1)).toBe(`'${executable}' sessions list --json`);
    await f.client.attach(listing.sessions[0]!);
    expect(f.attached).toEqual([`"exec '${executable}' sessions attach -- '${id}'"`]);
    expect(f.commands.every((command) => !command.includes('/bin/sh') && !command.includes(' a ') && !command.includes('export PATH'))).toBe(true);
  });

  it('never builds native PTY commands before qualification or falls back to a name', async () => {
    const f = fixture();
    const direct = new NativeWindowsHost(f.connection, policy);
    expect(() => direct.attachCommand(id)).toThrow(/qualification/);
    await direct.ready();
    expect(() => direct.attachCommand(null)).toThrow(/UUID/);
    expect(() => direct.attachCommand('project:main')).toThrow(/UUID/);
    expect(() => direct.attachCommand('1234')).toThrow(/UUID/);
  });

  it('refuses duplicate display names, while full workspace and explicit UUID select independently', async () => {
    const f = fixture({ rows: [row(), row(second, 'C:/two/project')] });
    await expect(f.client.resolveSession('project:main')).rejects.toBeInstanceOf(SessionAmbiguous);
    await expect(f.client.resolveSession('main')).rejects.toBeInstanceOf(SessionAmbiguous);
    expect((await f.client.resolveSession('C:/two/project:main')).id).toBe(second);
    await expect(f.client.killSession('project:main')).rejects.toBeInstanceOf(SessionAmbiguous);
    await f.client.killSession('project:main', second);
    expect(f.commands.at(-1)).toBe(`'${executable}' sessions kill --json -- '${second}'`);
  });

  it.each([{ rows: [row(null as unknown as string)] }, { rows: [row(id), row(id)] }])('refuses missing or duplicate native UUID authority', async ({ rows }) => {
    await expect(fixture({ rows }).client.listSessions()).rejects.toThrow(/UUID/);
  });

  it('uses canonical enrolled ID for roots, never the display alias', async () => {
    const f = fixture();
    await f.client.addWorkspace('C:/spaces and unicode/☃');
    expect(f.commands.at(-1)).toBe(`'${executable}' workspaces add 'C:/spaces and unicode/☃' --host 'enrolled-fixture' --json`);
    expect(f.commands.at(-1)).not.toContain(profile.name);
    const readonly = fixture({ capabilities: ['workspaces', 'tree', 'sessions.list', 'sessions.attach'] });
    await expect(readonly.client.addWorkspace('C:/one')).rejects.toThrow(/workspaces.add/);
    expect(readonly.commands).toHaveLength(2);
  });

  it('refuses unsupported capture/send without issuing raw a commands', async () => {
    const f = fixture();
    const session = (await f.client.listSessions()).sessions[0]!;
    const before = f.commands.length;
    await expect(f.client.capture(session, { mode: 'screen' })).rejects.toThrow(/no raw Aplexer/);
    await expect(f.client.send(session, 'secret fixture')).rejects.toThrow(/no raw Aplexer/);
    expect(f.commands).toHaveLength(before);
  });

  it('returns valid create UUID and never retries uncertain handoff', async () => {
    const valid = fixture();
    expect(await valid.client.createSession('main', { cwd: 'C:/one/project' })).toMatchObject({ id, created: true });
    const failed = fixture({ create: { ...outcome('', 124), timedOut: true } });
    await expect(failed.client.createSession('main')).rejects.toBeInstanceOf(NativeCreateUncertain);
    expect(failed.commands.filter((command) => command.includes('sessions create'))).toHaveLength(1);
    expect(failed.commands.at(-1)).toContain('sessions list --json');
    const noRead = fixture({ create: outcome('', 124), rereadFails: true });
    await expect(noRead.client.createSession('main')).rejects.toBeInstanceOf(NativeCreateUncertain);
    await expect(noRead.client.createSession('main')).rejects.toThrow(/Reread/);
    expect(noRead.commands.filter((command) => command.includes('sessions create'))).toHaveLength(1);
  });

  it('keeps definite backend refusal separate from uncertain handoff', async () => {
    const f = fixture({ create: outcome({ schema: 3, error: 'Unsupported engine' }, 2) });
    await expect(f.client.createSession('main', { engine: 'unsupported' })).rejects.toThrow('Unsupported engine');
    expect(f.commands.filter((command) => command.includes('sessions list'))).toHaveLength(0);
  });

  it('treats a negative lost-status sentinel as uncertain and rereads without retry', async () => {
    const f = fixture({ create: outcome('', -1) });
    await expect(f.client.createSession('main')).rejects.toBeInstanceOf(NativeCreateUncertain);
    expect(f.commands.filter((command) => command.includes('sessions create'))).toHaveLength(1);
    expect(f.commands.at(-1)).toContain('sessions list --json');
  });

  it('a pre-handoff listing cannot clear a failed post-handoff reread guard', async () => {
    const f = fixture({ create: outcome('', 124) });
    let finishA!: (value: ExecOutcome) => void;
    let finishB!: (value: ExecOutcome) => void;
    let beginA!: () => void;
    let beginB!: () => void;
    const startedA = new Promise<void>((resolve) => { beginA = resolve; });
    const startedB = new Promise<void>((resolve) => { beginB = resolve; });
    const a = new Promise<ExecOutcome>((resolve) => { finishA = resolve; });
    const b = new Promise<ExecOutcome>((resolve) => { finishB = resolve; });
    let reads = 0;
    const execute = f.connection.exec;
    f.connection.exec = async (command, options) => {
      if (!command.includes('sessions list')) return execute(command, options);
      f.commands.push(command);
      if (++reads === 1) { beginA(); return a; }
      beginB(); return b;
    };
    await f.client.probe();
    const staleListing = f.client.listSessions();
    await startedA;
    const createResult = f.client.createSession('main').catch((error: unknown) => error);
    await startedB;
    finishA(outcome({ schema: 3, sessions: [row()], errors: [] }));
    await staleListing;
    finishB(outcome('', 1));
    expect(await createResult).toBeInstanceOf(NativeCreateUncertain);
    await expect(f.client.createSession('main')).rejects.toThrow(/Reread/);
    expect(f.commands.filter((command) => command.includes('sessions create'))).toHaveLength(1);
  });

  it('a listing begun during create cannot clear a failed post-handoff reread guard', async () => {
    const f = fixture();
    let finishCreate!: (value: ExecOutcome) => void;
    let finishA!: (value: ExecOutcome) => void;
    let finishB!: (value: ExecOutcome) => void;
    let beginCreate!: () => void;
    let beginA!: () => void;
    let beginB!: () => void;
    const startedCreate = new Promise<void>((resolve) => { beginCreate = resolve; });
    const startedA = new Promise<void>((resolve) => { beginA = resolve; });
    const startedB = new Promise<void>((resolve) => { beginB = resolve; });
    const pendingCreate = new Promise<ExecOutcome>((resolve) => { finishCreate = resolve; });
    const a = new Promise<ExecOutcome>((resolve) => { finishA = resolve; });
    const b = new Promise<ExecOutcome>((resolve) => { finishB = resolve; });
    const execute = f.connection.exec;
    let reads = 0;
    f.connection.exec = async (command, options) => {
      if (command.includes('sessions create')) { f.commands.push(command); beginCreate(); return pendingCreate; }
      if (!command.includes('sessions list')) return execute(command, options);
      f.commands.push(command);
      if (++reads === 1) { beginA(); return a; }
      beginB(); return b;
    };
    await f.client.probe();
    const createResult = f.client.createSession('main').catch((error: unknown) => error);
    await startedCreate;
    const staleListing = f.client.listSessions();
    await startedA;
    finishCreate(outcome('', 124));
    await startedB;
    finishA(outcome({ schema: 3, sessions: [row()], errors: [] }));
    await staleListing;
    finishB(outcome('', 1));
    expect(await createResult).toBeInstanceOf(NativeCreateUncertain);
    await expect(f.client.createSession('main')).rejects.toThrow(/Reread/);
    expect(f.commands.filter((command) => command.includes('sessions create'))).toHaveLength(1);
  });
});
