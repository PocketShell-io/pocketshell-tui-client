/**
 * Unit and subprocess tests for `psc a` (remote aplexer):
 * - host resolution (exact, deviceId, prefix/substring, ambiguity, friendly names)
 * - argument parsing and usage errors
 * - stdin handling (`send` and `start --prompt`)
 * - multi-line send encoding (bracketed paste ESC[200~ … ESC[201~ + CR)
 * - capture trimming and `--lines N`
 * - `wait` (agentState vs screen-idle fallback + timeout exit 124)
 * - device `presence` parsing and `HOST_OFFLINE` detail enrichment
 * - EPIPE safety (`psc --help | head`)
 * - standalone bundle (`dist-bundle/psc.mjs`) executed outside the repo
 */
import { execFile, execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionRow } from '@pocketshell/core';
import {
  allCandidateHosts,
  confirmPromptDelivery,
  normalizeAArgs,
  remoteAplexerArgs,
  resolveAHost,
  resolvePromptText,
  resolveSendText,
  trimCapture,
  waitForAgentReady,
  waitForSessionIdle,
} from '../src/commands/a.js';
import { parseDevices } from '../src/gateway/devices.js';
import {
  BP_END,
  BP_START,
  encodeSendPayload,
  HostClient,
  stripSystemdNoise,
  SUBMIT_KEY,
} from '../src/hostClient.js';
import {
  friendlyHostName,
  HostAmbiguous,
  HostStoreError,
  localHost,
  pickHost,
  type HostEntry,
} from '../src/hosts/store.js';
import { classify } from '../src/output.js';
import { hostOfflineDetail } from '../src/transport/gateway.js';
import { ConnectionError, type Connection, type ExecOutcome } from '../src/transport/types.js';

const ROOT = resolve(__dirname, '..');
const BUNDLE = join(ROOT, 'dist-bundle', 'psc.mjs');

function makeRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    name: 'proj:work',
    id: 'abcd1234-5678',
    workspace: '/home/alexey/git/proj',
    tag: 'work',
    engine: 'claude',
    profile: null,
    agent: 'claude',
    agentState: 'idle',
    agentStateSource: 'heuristic',
    attached: false,
    createdEpoch: 1700000000,
    activityEpoch: 1700000100,
    phase: 'running',
    ...overrides,
  };
}

function fakeConnection(
  exec: (command: string, stdin?: string | Uint8Array) => Promise<ExecOutcome>,
): Connection {
  return {
    hostName: 'fake',
    mode: 'ssh',
    exec: (command, options) => exec(command, options.stdin),
    attachInteractive: async () => 0,
    close: async () => {},
  };
}

describe('friendlyHostName and pickHost (host resolution)', () => {
  it('derives friendly names from gateway device ids and falls back on collision', () => {
    expect(friendlyHostName('hetzner-rmthz')).toBe('hetzner');
    expect(friendlyHostName('host-laptop-pha6tcnc-75fu')).toBe('laptop');
    expect(friendlyHostName('host-desktop-fp4op26-venv')).toBe('desktop');
    expect(friendlyHostName('host-my-box-abcd1234-ef56')).toBe('my-box');
    expect(friendlyHostName('hetzner-rmthz', new Set(['hetzner']))).toBe('hetzner-rmthz');
    expect(friendlyHostName('local-rmthz')).toBe('local-rmthz');
  });

  const hosts: HostEntry[] = [
    localHost(),
    { name: 'hetzner', mode: 'gateway', gateway: { deviceId: 'hetzner-rmthz', user: 'alexey' } },
    { name: 'laptop', mode: 'gateway', gateway: { deviceId: 'host-laptop-pha6tcnc-75fu', user: 'alexey' } },
    { name: 'desktop', mode: 'gateway', gateway: { deviceId: 'host-desktop-fp4op26-venv', user: 'alexey' } },
    { name: 'win35', mode: 'gateway', gateway: { deviceId: 'host-desktop-fp4op26-venv', user: 'alexey' } },
  ];

  it('resolves exact host names including local and aliases', () => {
    expect(pickHost(hosts, 'local').name).toBe('local');
    expect(pickHost(hosts, 'hetzner').name).toBe('hetzner');
    expect(pickHost(hosts, 'desktop').name).toBe('desktop');
    expect(pickHost(hosts, 'win35').name).toBe('win35');
  });

  it('resolves exact gateway device ids even when aliased', () => {
    expect(pickHost(hosts, 'hetzner-rmthz').name).toBe('hetzner');
    expect(pickHost(hosts, 'host-laptop-pha6tcnc-75fu').name).toBe('laptop');
    expect(pickHost(hosts, 'host-desktop-fp4op26-venv').gateway?.deviceId).toBe('host-desktop-fp4op26-venv');
  });

  it('resolves case-insensitive prefixes and substrings of host names or device ids', () => {
    expect(pickHost(hosts, 'HETZ').name).toBe('hetzner');
    expect(pickHost(hosts, 'rmthz').name).toBe('hetzner');
    expect(pickHost(hosts, 'pha6tcnc').name).toBe('laptop');
    expect(pickHost(hosts, 'fp4op26').gateway?.deviceId).toBe('host-desktop-fp4op26-venv');
  });

  it('synthesizes candidate hosts from pinned device ids not yet in hosts.json', () => {
    const onlyHetzner: HostEntry[] = [
      localHost(),
      { name: 'hetzner', mode: 'gateway', gateway: { deviceId: 'hetzner-rmthz', user: 'alexey' } },
    ];
    const pins = ['hetzner-rmthz', 'host-laptop-pha6tcnc-75fu', 'host-desktop-fp4op26-venv'];
    const candidates = allCandidateHosts(onlyHetzner, pins);
    expect(candidates.map((h) => h.name)).toEqual(['local', 'hetzner', 'laptop', 'desktop']);
    expect(resolveAHost('laptop', onlyHetzner, pins).gateway).toEqual({
      deviceId: 'host-laptop-pha6tcnc-75fu',
      user: 'alexey',
    });
  });

  it('throws HostAmbiguous with candidates when a prefix or substring matches multiple distinct hosts', () => {
    let caught: unknown;
    try {
      pickHost(hosts, 'host-');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HostAmbiguous);
    const amb = caught as HostAmbiguous;
    expect(amb.code).toBe('HOST_AMBIGUOUS');
    expect(amb.details.candidates.map((c) => c.name)).toEqual(['laptop', 'desktop']);
    expect(classify(amb)).toMatchObject({
      code: 'HOST_AMBIGUOUS',
      exit: 2,
      details: {
        candidates: [
          { name: 'laptop', id: 'host-laptop-pha6tcnc-75fu', deviceId: 'host-laptop-pha6tcnc-75fu' },
          { name: 'desktop', id: 'host-desktop-fp4op26-venv', deviceId: 'host-desktop-fp4op26-venv' },
        ],
      },
    });
  });

  it('throws HostStoreError when no host matches', () => {
    expect(() => pickHost(hosts, 'nonexistent')).toThrow(HostStoreError);
  });
});

describe('stdin handling and argument normalization', () => {
  it('resolveSendText uses explicit text, reads stdin for `-` or non-TTY, and errors on TTY without text', async () => {
    expect(await resolveSendText('hello', async () => 'ignored', true)).toBe('hello');
    expect(await resolveSendText('-', async () => 'from stdin\n', true)).toBe('from stdin');
    expect(await resolveSendText(undefined, async () => 'piped line 1\npiped line 2\r\n', false)).toBe(
      'piped line 1\npiped line 2',
    );
    await expect(resolveSendText(undefined, async () => '', true)).rejects.toMatchObject({
      code: 'USAGE',
      exitCode: 2,
    });
  });

  it('resolvePromptText handles undefined, literal text, and `-` stdin', async () => {
    expect(await resolvePromptText(undefined, async () => 'ignored')).toBeNull();
    expect(await resolvePromptText('reply PONG', async () => 'ignored')).toBe('reply PONG');
    expect(await resolvePromptText('-', async () => 'line1\nline2\n')).toBe('line1\nline2');
  });

  it('remoteAplexerArgs routes `psc <host> <verb>`, bare `psc hosts`, `psc help <verb>`, and legacy `psc a`', () => {
    const top = new Set(['hosts', 'sessions', 's', 'exec', 'gateway', 'login', 'a', 'tui']);
    expect(remoteAplexerArgs(['hetzner', 'ls'], top)).toEqual(['hetzner', 'ls']);
    expect(remoteAplexerArgs(['--json', 'lap', 'capture', 'x'], top)).toEqual(['--json', 'lap', 'capture', 'x']);
    expect(remoteAplexerArgs(['win35', 'connect'], top)).toEqual(['win35', 'connect']);
    expect(remoteAplexerArgs(['hetzner', '--help'], top)).toEqual(['hetzner', '--help']);
    expect(remoteAplexerArgs(['a', 'hetzner', 'ls'], top)).toEqual(['hetzner', 'ls']);
    expect(remoteAplexerArgs(['--json', 'a', 'hosts'], top)).toEqual(['--json', 'hosts']);
    expect(remoteAplexerArgs(['hosts'], top)).toEqual(['hosts']);
    expect(remoteAplexerArgs(['hosts', '--check'], top)).toEqual(['hosts', '--check']);
    expect(remoteAplexerArgs(['help', 'send'], top)).toEqual(['--help', 'send']);
    // normal subcommands stay commander's
    expect(remoteAplexerArgs(['hosts', 'sync'], top)).toBeNull();
    expect(remoteAplexerArgs(['sessions', 'ls'], top)).toBeNull();
    expect(remoteAplexerArgs(['s', 'ls'], top)).toBeNull();
    expect(remoteAplexerArgs(['exec', 'ls'], top)).toBeNull();
    expect(remoteAplexerArgs(['-H', 'box', 'sessions', 'ls'], top)).toBeNull();
    expect(remoteAplexerArgs(['sesions'], top)).toBeNull();
    expect(remoteAplexerArgs(['typo', 'bogus'], top)).toBeNull();
    expect(remoteAplexerArgs(['help'], top)).toBeNull();
    expect(remoteAplexerArgs([], top)).toBeNull();
  });

  it('normalizeAArgs turns a bare `--prompt` flag into `--prompt -`', () => {
    expect(normalizeAArgs(['hetzner', 'start', 'tag', '--prompt'])).toEqual(['hetzner', 'start', 'tag', '--prompt', '-']);
    expect(normalizeAArgs(['hetzner', 'start', 'tag', '--prompt', '--json'])).toEqual([
      'hetzner',
      'start',
      'tag',
      '--prompt',
      '-',
      '--json',
    ]);
    expect(normalizeAArgs(['hetzner', 'start', 'tag', '--prompt', 'hello'])).toEqual([
      'hetzner',
      'start',
      'tag',
      '--prompt',
      'hello',
    ]);
  });
});

describe('multi-line send encoding and HostClient.send', () => {
  it('single-line text is not wrapped in bracketed paste', () => {
    expect(encodeSendPayload('hello world', { enter: true })).toEqual({
      framed: 'hello world',
      bytes: `hello world${SUBMIT_KEY}`,
      bracketed: false,
      enter: true,
    });
    expect(encodeSendPayload('hello world', { enter: false })).toEqual({
      framed: 'hello world',
      bytes: 'hello world',
      bracketed: false,
      enter: false,
    });
  });

  it('multi-line text is wrapped in ESC[200~ … ESC[201~ followed by CR when enter is true', () => {
    const text = 'line1\nline2: reply LINES-OK';
    const encoded = encodeSendPayload(text, { enter: true });
    expect(encoded).toEqual({
      framed: `${BP_START}${text}${BP_END}`,
      bytes: `\x1b[200~line1\nline2: reply LINES-OK\x1b[201~\r`,
      bracketed: true,
      enter: true,
    });
    expect(encodeSendPayload(text, { enter: false })).toEqual({
      framed: `\x1b[200~line1\nline2: reply LINES-OK\x1b[201~`,
      bytes: `\x1b[200~line1\nline2: reply LINES-OK\x1b[201~`,
      bracketed: true,
      enter: false,
    });
  });

  it('HostClient.send sends multi-line text with bracketed paste and delayed CR', async () => {
    const calls: Array<{ command: string; stdin?: string | Uint8Array }> = [];
    const client = new HostClient(
      fakeConnection(async (command, stdin) => {
        calls.push({ command, stdin });
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
      }),
    );
    const session = makeRow({ id: 'sess-1234' });

    await client.send(session, 'single line', { enter: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toContain('--stdin --enter');
    expect(calls[0]!.command).toContain('sess-1234');
    expect(calls[0]!.stdin).toBe('single line');

    calls.length = 0;
    await client.send(session, 'line1\nline2', { enter: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toContain("--stdin && sleep 0.15 && '\\''a'\\'' send");
    expect(calls[0]!.command).toContain('--hex 0d');
    expect(calls[0]!.stdin).toBe('\x1b[200~line1\nline2\x1b[201~');

    calls.length = 0;
    await client.send(session, 'line1\nline2', { enter: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toContain('--stdin');
    expect(calls[0]!.command).not.toContain('--enter');
    expect(calls[0]!.command).not.toContain('--hex 0d');
    expect(calls[0]!.stdin).toBe('\x1b[200~line1\nline2\x1b[201~');
  });
});

describe('capture trimming and systemd noise stripping', () => {
  it('strips ANSI escapes and trims trailing blank lines by default', () => {
    const raw = '\x1b[32mheader\x1b[0m\n\nbody line\n   \n\n\n';
    expect(trimCapture(raw)).toBe('header\n\nbody line');
    expect(trimCapture('   \n  \n')).toBe('');
  });

  it('--lines N returns the last N non-empty lines', () => {
    const sample = 'one\n\ntwo\n   \nthree\nfour\n\n';
    expect(trimCapture(sample, { lines: 2 })).toBe('three\nfour');
    expect(trimCapture(sample, { lines: 10 })).toBe('one\ntwo\nthree\nfour');
  });

  it('strips truncated systemd invocation ID noise lines at the top of a capture', () => {
    expect(stripSystemdNoise('vocation ID: 68acea72bc744047b6854a1b590546cb\nPONG\n')).toBe('PONG\n');
    expect(stripSystemdNoise('invocation ID: 68acea72bc744047b6854a1b590546cb\nPONG\n')).toBe('PONG\n');
  });
});

describe('waitForAgentReady and waitForSessionIdle', () => {
  it('waitForAgentReady waits until an engine session renders a stable non-empty screen and is not working', async () => {
    const screens = ['', 'loading...', '❯ ', '❯ '];
    const states: Array<'working' | 'waiting'> = ['working', 'working', 'waiting', 'waiting'];
    let i = 0;
    const row = await waitForAgentReady(
      {
        listSessions: async () => ({
          sessions: [makeRow({ id: 's1', name: 'proj:e2e', agentState: states[Math.min(i, states.length - 1)]! })],
          errors: [],
        }),
        capture: async () => screens[Math.min(i++, screens.length - 1)]!,
      },
      { name: 'proj:e2e', id: 's1', created: true },
      { engine: 'claude', timeoutS: 5, pollMs: 1, sleepFn: async () => {} },
    );
    expect(row.name).toBe('proj:e2e');
    expect(i).toBeGreaterThanOrEqual(4);
  });

  it('waitForSessionIdle resolves when agentState becomes idle or waiting', async () => {
    const seq: Array<'working' | 'waiting'> = ['working', 'working', 'waiting'];
    let idx = 0;
    const res = await waitForSessionIdle(
      {
        resolveSession: async () => makeRow({ agentState: seq[Math.min(idx++, seq.length - 1)]! }),
        capture: async () => 'screen',
      },
      'proj:work',
      { timeoutS: 5, pollMs: 1, sleepFn: async () => {} },
    );
    expect(res).toMatchObject({ state: 'waiting', reason: 'agent_state' });
    expect(idx).toBe(3);
  });

  it('waitForSessionIdle ignores an idle state seen before the agent picked the prompt up', async () => {
    const seq: Array<'idle' | 'working'> = ['idle', 'idle', 'working', 'idle'];
    let idx = 0;
    const res = await waitForSessionIdle(
      {
        resolveSession: async () => makeRow({ agentState: seq[Math.min(idx++, seq.length - 1)]! }),
        capture: async () => 'screen',
      },
      'proj:work',
      { timeoutS: 5, pollMs: 1, sleepFn: async () => {} },
    );
    expect(res).toMatchObject({ state: 'idle', reason: 'agent_state' });
    expect(idx).toBe(4);
  });

  it('waitForSessionIdle accepts a steady idle state once the settle window has passed', async () => {
    let idx = 0;
    const res = await waitForSessionIdle(
      {
        resolveSession: async () => (idx++, makeRow({ agentState: 'idle' })),
        capture: async () => 'screen',
      },
      'proj:work',
      { settleS: 0, timeoutS: 5, pollMs: 1, sleepFn: async () => {} },
    );
    expect(res).toMatchObject({ state: 'idle', reason: 'agent_state' });
    expect(idx).toBe(1);
  });

  it('waitForSessionIdle falls back to screen stability when agentState is null, and exits 124 on timeout', async () => {
    await expect(
      waitForSessionIdle(
        {
          resolveSession: async () => makeRow({ agentState: 'working' }),
          capture: async () => 'busy',
        },
        'proj:work',
        { timeoutS: 0.01, pollMs: 5 },
      ),
    ).rejects.toMatchObject({ code: 'TIMEOUT', exitCode: 124 });
  });
});

describe('device presence and HOST_OFFLINE detail enrichment', () => {
  it('parses presence from /identity/v1/devices', () => {
    const body = Buffer.from(
      JSON.stringify({
        devices: [
          {
            id: 'hetzner-rmthz',
            account_id: 'acc_1',
            public_key: 'pk',
            ssh_host_key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKtcCuruWy5XRjBBYu1q1J62Gb9L3I5JTRMReZ9YQN0/',
            revoked: false,
            presence: {
              online: true,
              observed_at: '2026-10-13T20:00:00Z',
              connected_since: '2026-10-13T19:00:00Z',
              session_generation: 5,
            },
          },
          {
            id: 'host-desktop-fp4op26-venv',
            account_id: 'acc_1',
            public_key: 'pk2',
            ssh_host_key: '',
            revoked: false,
            presence: {
              online: false,
              observed_at: '2026-10-13T20:00:00Z',
            },
          },
        ],
      }),
    );
    const parsed = parseDevices(body);
    expect(parsed[0]!.presence).toEqual({
      online: true,
      observed_at: '2026-10-13T20:00:00Z',
      connected_since: '2026-10-13T19:00:00Z',
      session_generation: 5,
    });
    expect(parsed[1]!.presence).toEqual({
      online: false,
      observed_at: '2026-10-13T20:00:00Z',
      connected_since: null,
      session_generation: null,
    });
  });

  it('produces distinct HOST_OFFLINE details for presence offline vs online and preserves error.detail in classify', () => {
    const offlineDetail = hostOfflineDetail(false);
    const onlineDetail = hostOfflineDetail(true);
    expect(offlineDetail).toBe(
      'host agent not connected (pocketshell gateway run / pocketshell-link not running on the host)',
    );
    expect(onlineDetail).toBe(
      'host agent is connected but its private SSH endpoint did not answer (check the PocketShell gateway tray or `pocketshell gateway status` on the host; no system sshd is used)',
    );

    const err = new ConnectionError(`laptop: ${onlineDetail}`, 'HOST_OFFLINE', 4, { detail: onlineDetail });
    expect(classify(err)).toEqual({
      code: 'HOST_OFFLINE',
      message: `laptop: ${onlineDetail}`,
      exit: 4,
      details: { detail: onlineDetail },
    });
  });
});

describe('CLI subprocess, EPIPE handling, and standalone bundle', () => {
  let tmpRoot = '';
  let xdg = '';
  let externalBundle = '';

  beforeAll(() => {
    execFileSync('npm', ['run', 'bundle'], { cwd: ROOT, stdio: 'ignore' });
    tmpRoot = mkdtempSync(join(tmpdir(), 'psc-remote-a-'));
    xdg = join(tmpRoot, 'xdg');
    mkdirSync(xdg, { recursive: true });
    const standaloneDir = join(tmpRoot, 'standalone');
    mkdirSync(standaloneDir, { recursive: true });
    externalBundle = join(standaloneDir, 'psc.mjs');
    copyFileSync(BUNDLE, externalBundle);
  }, 120_000);

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function runScript(
    script: string,
    args: string[],
    cwd = ROOT,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((done) => {
      execFile(
        process.execPath,
        [script, ...args],
        { cwd, env: { ...process.env, XDG_CONFIG_HOME: xdg, PSC_JSON: '', PSC_HOST: '' }, timeout: 30_000 },
        (error, stdout, stderr) => {
          const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
          done({ code, stdout, stderr });
        },
      );
    });
  }

  it('does not crash with EPIPE when stdout closes early (`psc --help | head`)', async () => {
    const res = await new Promise<{ code: number | null; stderr: string }>((done) => {
      const child = spawn(process.execPath, [BUNDLE, '--help'], {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => (stderr += String(chunk)));
      // Destroy stdout immediately before/as the child writes to trigger EPIPE.
      child.stdout.destroy();
      child.on('close', (code) => done({ code, stderr }));
    });
    expect(res.stderr).not.toContain('EPIPE');
    expect(res.code).toBe(0);
  });

  it('prints help with examples for `psc a --help`', async () => {
    const r = await runScript(BUNDLE, ['a', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('psc hosts [--check]');
    expect(r.stdout).toContain('psc <host> start <tag>');
    expect(r.stdout).toContain('psc <host> connect');
    expect(r.stdout).toContain('Examples:');
  });

  it('top-level `psc --help` lists the host verbs and hides the legacy `a` alias', async () => {
    const r = await runScript(BUNDLE, ['--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('psc <host> connect');
    expect(r.stdout).toContain('psc <host> ls');
    expect(r.stdout).not.toMatch(/^\s+a \[args\.\.\.\]/m);
  });

  it('top-level host verbs give the same USAGE errors as `psc a` (exit 2)', async () => {
    for (const args of [
      ['hetzner', 'start', '--json'],
      ['--json', 'hetzner', 'send'],
      ['hetzner', 'connect', '--json'],
    ]) {
      const r = await runScript(BUNDLE, args);
      expect(r.code).toBe(2);
      expect(JSON.parse(r.stdout.trim())).toMatchObject({ ok: false, error: { code: 'USAGE' } });
    }
  });

  it('`psc help start` prints the verb help', async () => {
    const r = await runScript(BUNDLE, ['help', 'start']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('--prompt');
  });

  it('returns USAGE (exit 2) for invalid `psc a` invocations in JSON mode', async () => {
    for (const args of [
      ['a', '--json'],
      ['a', 'hetzner', '--json'],
      ['a', 'hetzner', 'bogus', '--json'],
      ['a', 'hetzner', 'start', '--json'],
      ['a', 'hosts', '--bogus', '--json'],
    ]) {
      const r = await runScript(BUNDLE, args);
      expect(r.code).toBe(2);
      expect(JSON.parse(r.stdout.trim())).toMatchObject({ ok: false, error: { code: 'USAGE' } });
    }
  });

  it('runs standalone `dist-bundle/psc.mjs` from a temp dir outside the repo (`--help` and `a hosts`)', async () => {
    const standaloneCwd = join(tmpRoot, 'standalone');
    const help = await runScript(externalBundle, ['--help'], standaloneCwd);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('pocketshell-tui-client');

    const aHelp = await runScript(externalBundle, ['a', '--help'], standaloneCwd);
    expect(aHelp.code).toBe(0);
    expect(aHelp.stdout).toContain('Remote aplexer');

    const hostsPlain = await runScript(externalBundle, ['a', 'hosts'], standaloneCwd);
    expect(hostsPlain.code).toBe(0);
    expect(hostsPlain.stdout).toContain('local');

    const hostsJson = await runScript(externalBundle, ['a', 'hosts', '--json'], standaloneCwd);
    expect(hostsJson.code).toBe(0);
    expect(JSON.parse(hostsJson.stdout.trim())).toMatchObject({
      ok: true,
      hosts: [{ name: 'local', mode: 'local', online: true, status: 'online' }],
    });
  });
});

describe('confirmPromptDelivery', () => {
  const row = { name: 'p:t', id: 'id1' } as SessionRow;
  function fake(script: { state?: string; screen: string }[]) {
    let i = 0;
    const sent: string[] = [];
    const client = {
      listSessions: async () => ({ sessions: [{ ...row, agentState: script[Math.min(i, script.length - 1)]!.state ?? 'waiting' }] }),
      capture: async () => script[Math.min(i++, script.length - 1)]!.screen,
      send: async (_r: SessionRow, text: string) => {
        sent.push(text);
      },
    };
    return { client: client as never, sent };
  }
  const opts = { windowS: 3, pollMs: 1000, sleepFn: async () => {} };

  it('returns at once when the agent is working', async () => {
    const { client, sent } = fake([{ state: 'working', screen: '' }]);
    expect(await confirmPromptDelivery(client, row, 'hello', opts)).toBe('working');
    expect(sent).toEqual([]);
  });

  it('resends a swallowed prompt once', async () => {
    const { client, sent } = fake([{ screen: '› Ask Codex to do anything' }]);
    expect(await confirmPromptDelivery(client, row, 'line one\nline two', opts)).toBe('resent');
    expect(sent).toEqual(['line one\nline two']);
  });

  it('presses Enter when the prompt is typed but not submitted', async () => {
    const { client, sent } = fake([{ screen: '› line   one' }]);
    expect(await confirmPromptDelivery(client, row, 'line one', opts)).toBe('entered');
    expect(sent).toEqual(['']);
  });

  it('treats a paste placeholder as delivered (never a double prompt)', async () => {
    const { client, sent } = fake([{ screen: '› [Pasted Content 812 chars]' }]);
    expect(await confirmPromptDelivery(client, row, 'a\nb\nc', opts)).toBe('entered');
    expect(sent).toEqual(['']);
  });
});
