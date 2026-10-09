/** hostClient.ts: session selection, exec quoting, systemd noise, the one-shot probe. */
import { pathAwareCommand, type SessionRow } from '@pocketshell/core';
import { describe, expect, it } from 'vitest';
import {
  execCommandLine,
  HostClient,
  HostCommandError,
  pickSession,
  SessionAmbiguous,
  SessionNotFound,
  stripSystemdNoise,
} from '../src/hostClient.js';
import { runCaptured } from '../src/transport/process.js';
import { ConnectionError, type Connection, type ExecOutcome } from '../src/transport/types.js';

function row(name: string, id: string | null, tag = name.split(':')[1] ?? null): SessionRow {
  return {
    name, id, workspace: null, tag, engine: null, profile: null, agent: null,
    agentState: null, agentStateSource: null, attached: false, createdEpoch: null, activityEpoch: null,
  };
}

describe('pickSession', () => {
  const rows = [
    row('proj:review', 'abcd1111-0000'),
    row('other:review', 'abce2222-0000'),
    row('proj:build', 'beef3333-0000'),
    row('x:beef', 'cafe4444-0000'),
    row('y:abcd', 'dddd5555-0000'),
  ];

  it('exact name or id wins outright', () => {
    expect(pickSession(rows, 'proj:build').id).toBe('beef3333-0000');
    expect(pickSession(rows, 'cafe4444-0000').name).toBe('x:beef');
  });

  it('a unique tag', () => {
    expect(pickSession(rows, 'build').name).toBe('proj:build');
  });

  it('a unique id prefix (4+ chars)', () => {
    expect(pickSession(rows, 'cafe4').name).toBe('x:beef');
    expect(() => pickSession(rows, 'caf')).toThrow(SessionNotFound);
  });

  it('a shared tag is ambiguous, with candidates', () => {
    let caught: unknown;
    try {
      pickSession(rows, 'review');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SessionAmbiguous);
    expect((caught as SessionAmbiguous).code).toBe('SESSION_AMBIGUOUS');
    expect((caught as SessionAmbiguous).details.candidates.map((c) => c.name)).toEqual(['proj:review', 'other:review']);
  });

  it('a tag match and a prefix match naming different sessions is ambiguous', () => {
    // tag `beef` → x:beef; id prefix `beef` → proj:build
    expect(() => pickSession(rows, 'beef')).toThrow(SessionAmbiguous);
    // tag `abcd` → y:abcd; id prefix `abcd` → proj:review
    expect(() => pickSession(rows, 'abcd')).toThrow(SessionAmbiguous);
  });

  it('a tag and a prefix naming the same session is fine', () => {
    expect(pickSession([row('w:dddd', 'dddd9999')], 'dddd').name).toBe('w:dddd');
  });

  it('several prefix matches are ambiguous; no match is not found', () => {
    expect(() => pickSession(rows, 'abc')).toThrow(SessionNotFound);
    expect(() => pickSession([row('a:x', 'f00d1'), row('b:y', 'f00d2')], 'f00d')).toThrow(SessionAmbiguous);
    expect(() => pickSession(rows, 'nope')).toThrow(SessionNotFound);
  });
});

describe('execCommandLine', () => {
  it('one word is a shell command line, as-is', () => {
    expect(execCommandLine(['cd /x && make'])).toBe('cd /x && make');
  });

  it('several words are quoted one by one', () => {
    expect(execCommandLine(['ls', '-la', '/tmp'])).toBe("'ls' '-la' '/tmp'");
    expect(execCommandLine(['echo', 'a b', "it's", '$HOME;x'])).toBe("'echo' 'a b' 'it'\\''s' '$HOME;x'");
  });

  it('round-trips through a real sh', async () => {
    const words = ['printf', '%s|', 'a b', '$HOME', '*', "q'q", ';x'];
    const outcome = await runCaptured('/bin/sh', ['-c', execCommandLine(words)], { timeoutMs: 5_000 });
    expect(outcome.stdout).toBe("a b|$HOME|*|q'q|;x|");
  });
});

describe('stripSystemdNoise', () => {
  it('drops leading systemd-run banners only', () => {
    expect(stripSystemdNoise('Running as unit: run-u1.service; invocation ID: 9f\nhello\n')).toBe('hello\n');
    expect(stripSystemdNoise('Running scope as unit: run-r2.scope\nRunning as unit: x\nok')).toBe('ok');
    expect(stripSystemdNoise('hello\nRunning as unit: x\n')).toBe('hello\nRunning as unit: x\n');
    expect(stripSystemdNoise('plain')).toBe('plain');
  });
});

function fakeConnection(exec: (command: string) => Promise<ExecOutcome>): Connection {
  return {
    hostName: 'fake',
    mode: 'ssh',
    exec: (command) => exec(command),
    attachInteractive: async () => 0,
    close: async () => {},
  };
}

const okOutcome = (): ExecOutcome => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false });

describe('probe', () => {
  it('reads both versions from one exec', async () => {
    const seen: string[] = [];
    const client = new HostClient(
      fakeConnection(async (command) => {
        seen.push(command);
        return { exitCode: 0, stdout: 'pocketshell=pocketshell, version 0.5.8\naplexer=\n', stderr: '', timedOut: false };
      }),
    );
    expect(await client.probe()).toEqual({ pocketshell: 'pocketshell, version 0.5.8', aplexer: null });
    expect(seen).toHaveLength(1);
  });

  it('lets a connection failure through (never "reachable")', async () => {
    const client = new HostClient(
      fakeConnection(async () => {
        throw new ConnectionError('cannot reach', 'CONNECT_FAILED');
      }),
    );
    await expect(client.probe()).rejects.toBeInstanceOf(ConnectionError);
  });

  it('a timeout is a TIMEOUT error', async () => {
    const client = new HostClient(fakeConnection(async () => ({ exitCode: null, stdout: '', stderr: '', timedOut: true })));
    await expect(client.probe()).rejects.toBeInstanceOf(HostCommandError);
    await expect(client.probe()).rejects.toMatchObject({ code: 'TIMEOUT', exitCode: 124 });
  });

  it('the real probe script runs under sh and reports a missing binary as null', async () => {
    const client = new HostClient(
      fakeConnection((command) => runCaptured('/bin/sh', ['-c', command], { timeoutMs: 10_000 })),
      'no-such-pocketshell-binary',
    );
    expect((await client.probe()).pocketshell).toBeNull();
  });
});

describe('HostClient binary', () => {
  it('refuses a binary with shell syntax', () => {
    expect(() => new HostClient(fakeConnection(async () => okOutcome()), 'ps; echo pwned')).toThrow(/invalid --binary/);
    expect(() => new HostClient(fakeConnection(async () => okOutcome()), '~/.local/bin/pocketshell')).not.toThrow();
  });
  it('retains POSIX UUID attachment and legacy kill name despite optional row UUID', async () => {
    const seen: string[] = [];
    const client = new HostClient(fakeConnection(async (command) => { seen.push(command); return okOutcome(); }));
    expect(client.attachCommand(row('project:main', 'aplexer-fixture-id'))).toBe(pathAwareCommand("exec a attach 'aplexer-fixture-id'"));
    await client.killSession('project:main', 'aplexer-fixture-id');
    expect(seen).toEqual([pathAwareCommand("pocketshell sessions kill -- 'project:main'")]);
  });
});
