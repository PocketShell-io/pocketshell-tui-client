import { spawnSync } from 'node:child_process';
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

function fixture(options: { capabilities?: string[]; version?: string; platform?: unknown; rows?: ReturnType<typeof row>[]; create?: ExecOutcome; rereadFails?: boolean; requireExec?: boolean } = {}) {
  const commands: string[] = [];
  const attached: string[] = [];
  const connection: Connection = {
    hostName: profile.name, mode: 'gateway', close: async () => {},
    exec: async (command) => {
      commands.push(command);
      if (options.requireExec && !command.startsWith('exec ')) return outcome('', 2);
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
    expect(f.commands).toEqual([`exec '${executable}' --version`, `exec '${executable}' platform --json`]);
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
    expect(f.commands.at(-1)).toBe(`exec '${executable}' sessions list --json`);
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
    expect(f.commands.at(-1)).toBe(`exec '${executable}' sessions kill --json -- '${second}'`);
  });

  it.each([{ rows: [row(null as unknown as string)] }, { rows: [row(id), row(id)] }])('refuses missing or duplicate native UUID authority', async ({ rows }) => {
    await expect(fixture({ rows }).client.listSessions()).rejects.toThrow(/UUID/);
  });

  it('uses canonical enrolled ID for roots, never the display alias', async () => {
    const f = fixture();
    await f.client.addWorkspace('C:/spaces and unicode/☃');
    expect(f.commands.at(-1)).toBe(`exec '${executable}' workspaces add 'C:/spaces and unicode/☃' --host 'enrolled-fixture' --json`);
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


describe('actual native NONPTY exec boundary', () => {
  it('exec-prefixed qualification succeeds on the observed bare-command exit2 fixture', async () => {
    const f=fixture({requireExec:true});
    await expect(f.client.probe()).resolves.toEqual({pocketshell:'pocketshell, version 0.5.8',aplexer:null});
    expect(f.commands).toEqual([`exec '${executable}' --version`,`exec '${executable}' platform --json`]);
  });
  it('all internal native CLI NONPTY paths retain exactly one exec while PTY spelling remains unchanged', async () => {
    const f=fixture({requireExec:true});
    const sessions=await f.client.listSessions();
    await f.client.addWorkspace('C:/one/project');
    await f.client.createSession('main',{cwd:'C:/one/project'});
    await f.client.killSession('project:main',id);
    expect(f.commands.every(c=>c.startsWith('exec ')&&!c.startsWith('exec exec '))).toBe(true);
    expect(f.commands.every(c=>!c.includes('/bin/sh')&&!c.includes('export PATH'))).toBe(true);
    await f.client.attach(sessions.sessions[0]!);
    expect(f.attached).toEqual([`"exec '${executable}' sessions attach -- '${id}'"`]);
  });
  it('native generic run preserves timeout and stdin through the harmless builtin boundary', async () => {
    const f=fixture();const native=new NativeWindowsHost(f.connection,policy);await native.ready();
    const seen:any[]=[];const original=f.connection.exec;f.connection.exec=async(c,o)=>{seen.push({c,o});return original(c,o);};
    const input=new Uint8Array([1,2,3]);await native.run(`'${executable}' fixture`,901,input);
    expect(seen).toEqual([{c:`:; '${executable}' fixture`,o:{timeoutMs:901,stdin:input}}]);
  });
});


describe('generic native scripts preserve shell semantics', () => {
  function realShellFixture() {
    const f = fixture();
    const qualifiedExec = f.connection.exec;
    const scripts: { command: string; options: { timeoutMs: number; stdin?: string | Uint8Array } }[] = [];
    f.connection.exec = async (command, options) => {
      if (command.endsWith('--version') || command.endsWith('platform --json')) return qualifiedExec(command, options);
      scripts.push({ command, options });
      // Actual local POSIX shell exercises the production HostClient boundary;
      // native CLI qualification stays mocked, and no Windows endpoint is used.
      const result = spawnSync('/bin/sh', ['-c', command], {
        input: options.stdin, timeout: options.timeoutMs, encoding: 'utf8',
      });
      return { exitCode: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' };
    };
    return { ...f, scripts };
  }

  it('executes the complete nonce, hostname, uname and final exit through production HostClient.run', async () => {
    const f = realShellFixture();
    const script = "printf 'fleet-script-fixture\\n'; hostname; uname -s; exit 17";
    const result = await f.client.run(script, 4_000);
    const lines = result.stdout.trimEnd().split('\n');
    expect(lines[0]).toBe('fleet-script-fixture');
    expect(lines).toHaveLength(3);
    expect(lines[1]).not.toBe('');
    expect(lines[2]).toBe('Linux');
    expect(result.exitCode).toBe(17);
    expect(result.timedOut).toBe(false);
    expect(f.scripts).toEqual([{ command: `:; ${script}`, options: { timeoutMs: 4_000, stdin: undefined } }]);
    expect(f.commands).toEqual([`exec '${executable}' --version`, `exec '${executable}' platform --json`]);
  });

  it('retains pipeline, stdin bytes and explicit exit with the original options', async () => {
    const f = realShellFixture();
    const input = new Uint8Array([97, 98, 99, 0, 10]);
    const script = "printf 'prefix\\n'; cat | tr 'a-z' 'A-Z'; printf 'done\\n'; exit 23";
    const result = await f.client.run(script, 4_321, input);
    expect(result.stdout).toBe('prefix\nABC\0\ndone\n');
    expect(result.exitCode).toBe(23);
    expect(result.timedOut).toBe(false);
    expect(f.scripts).toEqual([{ command: `:; ${script}`, options: { timeoutMs: 4_321, stdin: input } }]);
    expect(f.scripts[0]!.options.stdin).toBe(input);
  });
});


describe('V46 explicit CMD host policy', () => {
  const cmdPolicy = { executable, deviceId: policy.deviceId, transport: 'openssh-cmd-git-bash',
    trustedBashExecutable: 'C:/Program Files/Git/bin/bash.exe',
    trustedBashSha256: 'fb991beb09c6c77f343a05a09842867688609df062a7bb00c719c90371c9348d' } as const;
  function decode(command: string, pty = false): string {
    const prefix = `${pty ? 'call ' : ''}"C:\\Program Files\\Git\\bin\\bash.exe" --noprofile --norc -c "eval $'`;
    expect(command.startsWith(prefix)).toBe(true);
    expect(command.endsWith("'\"")).toBe(true);
    const bytes = command.slice(prefix.length, -2);
    expect(bytes).toMatch(/^(?:\\x[0-9a-f]{2})*$/);
    return Buffer.from(bytes.replaceAll('\\x', ''), 'hex').toString('utf8');
  }
  function cmdFixture(version = 'pocketshell, version 0.5.8\n') {
    const commands: string[] = [], options: unknown[] = [], attached: string[] = [];
    const connection: Connection = { hostName: profile.name, mode: 'gateway', close: async () => {},
      exec: async (command, opts) => {
        commands.push(command); options.push(opts);
        const script = decode(command);
        if (script.endsWith('--version')) return outcome(version);
        if (script.endsWith('platform --json')) return outcome({ schema: 1, platform: 'win32', os: 'nt', cli_version: '0.5.8', capabilities: caps });
        if (script.includes('sessions list')) return outcome({ schema: 3, sessions: [row()], errors: [] });
        return outcome('script-result', 23);
      }, attachInteractive: async command => { attached.push(command); return 0; } };
    const entry = { ...profile, nativeWindowsCli: cmdPolicy as never };
    return { client: new HostClient(connection, undefined, entry), commands, options, attached };
  }
  it('accepts explicit device-bound policy and wraps qualification/list NONPTY without call', async () => {
    const f = cmdFixture(); await f.client.listSessions();
    expect(f.commands.map(command => decode(command))).toEqual([
      `exec '${executable}' --version`, `exec '${executable}' platform --json`, `exec '${executable}' sessions list --json`]);
  });
  it('keeps complete public compound script/stdin/options and PTY-only call', async () => {
    const f = cmdFixture(); const stdin = new Uint8Array([97, 0, 10]);
    const script = `printf 'unicode ☃ % ! & | \"'; cat | tr a-z A-Z; exit 23`;
    expect((await f.client.run(script, 4321, stdin)).exitCode).toBe(23);
    expect(decode(f.commands.at(-1)!)).toBe(script);
    expect(f.options.at(-1)).toEqual({ timeoutMs: 4321, stdin });
    expect((f.options.at(-1) as { stdin: unknown }).stdin).toBe(stdin);
    await f.client.attach(row());
    expect(decode(f.attached[0]!, true)).toBe(`exec '${executable}' sessions attach -- '${id}'`);
  });
  it.each(['C:/bad%PATH%/bash.exe', 'C:/bad!x!/bash.exe', 'C:/bad&x/bash.exe', 'C:/bad^x/bash.exe',
    'C:/bad|x/bash.exe', 'C:/../bash.exe', 'bash.exe', 'C:\\Git\\bash.exe', 'C:/bad\n/bash.exe'])('refuses CMD expansion or untrusted path %s', trustedBashExecutable => {
    expect(() => validateNativeWindowsPolicy({ ...cmdPolicy, trustedBashExecutable })).toThrow();
  });
  it.each([undefined, '', 'f'.repeat(63), 'g'.repeat(64)])('refuses absent or malformed digest %s', trustedBashSha256 => {
    expect(() => validateNativeWindowsPolicy({ ...cmdPolicy, trustedBashSha256 })).toThrow();
  });
  it('refuses ambiguous policy authority and preserves canonical digest/device binding', () => {
    expect(validateNativeWindowsPolicy({ ...cmdPolicy, trustedBashSha256: cmdPolicy.trustedBashSha256.toUpperCase() })).toEqual(cmdPolicy);
    expect(() => validateNativeWindowsPolicy({ ...cmdPolicy, guessedPlatform: 'win32' })).toThrow();
    expect(() => validateNativeWindowsPolicy({ ...policy, trustedBashExecutable: cmdPolicy.trustedBashExecutable })).toThrow();
    const f = fixture();
    expect(() => new HostClient(f.connection, undefined, { ...profile, nativeWindowsCli: { ...cmdPolicy, deviceId: 'different-device' } })).toThrow(/device ID/);
    expect(() => new HostClient(f.connection, undefined, { ...profile, binary: 'pocketshell', nativeWindowsCli: cmdPolicy })).toThrow(/cannot coexist/);
    expect(() => new HostClient({ ...f.connection, mode: 'ssh' }, undefined, { ...profile, nativeWindowsCli: cmdPolicy })).toThrow();
    expect(f.commands).toHaveLength(0);
  });
  it('refuses NUL/over-bound scripts before execution; failed qualification never retries', async () => {
    const f = cmdFixture(); await f.client.probe();
    await expect(f.client.run('printf \0bad', 1000)).rejects.toThrow(/NUL/);
    await expect(f.client.run('x'.repeat(2000), 1000)).rejects.toThrow(/8000/);
    expect(f.commands).toHaveLength(2);
    const bad = cmdFixture('pocketshell, version 0.5.9');
    await expect(bad.client.probe()).rejects.toThrow(/0.5.8/);
    await expect(bad.client.probe()).rejects.toThrow(/0.5.8/);
    expect(bad.commands).toHaveLength(1);
  });

});
