/**
 * The P0 fast-path contract for the classic (non-daemon) path:
 * - a first-contact `ls` is one connection and its listing is never fetched twice;
 * - the backend verdict persists on disk, so later processes serve `a --json snapshot` in one connection;
 * - failures that suggest the backend changed invalidate the verdict and re-probe;
 * - a wrapper that lacks a verb (tray builds without `sessions create`) falls back to direct `a`.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connection, ExecOutcome } from '../src/transport/types.js';
import { isProbeExec, isRawAplexerExec, probeStdout } from './hostProbeFixture.js';

const raw = { id: 'abcd1234', workspace: '/home/u/proj', tag: 'test', engine: 'shell',
  state: 'running', phase: 'running', created_at_ms: 1000, last_activity_ms: 10000 };
const snapshot = JSON.stringify([raw]);
const wrapperListing = JSON.stringify({ schema: 3, sessions: [], errors: [] });

const outcome = (stdout: string, exitCode = 0, stderr = ''): ExecOutcome => ({ stdout, exitCode, stderr, timedOut: false });

function fakeConnection(handler: (command: string, index: number) => Promise<ExecOutcome> | ExecOutcome): Connection {
  let index = 0;
  return {
    hostName: 'fixture',
    mode: 'gateway',
    exec: async (command) => handler(command, index++),
    attachInteractive: async () => 0,
    close: async () => {},
  };
}

let xdg: string | undefined;
beforeEach(() => {
  xdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'psc-fastpath-'));
});
afterEach(() => {
  vi.resetModules();
  if (xdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = xdg;
});

/** A fresh module graph stands in for a fresh process: empty in-memory cache, shared disk cache. */
async function freshHostClient(connection: Connection) {
  const { HostClient } = await import('../src/hostClient.js');
  const host = { name: 'fastpath', mode: 'gateway' as const, gateway: { deviceId: 'dev-1' } };
  return new HostClient(connection, 'pocketshell', host);
}

describe('classic connection counts', () => {
  it('a first-contact ls on a wrapper+a host is exactly one exec, and its listing is served', async () => {
    const commands: string[] = [];
    const client = await freshHostClient(fakeConnection((command) => {
      commands.push(command);
      if (isProbeExec(command))
        return outcome(probeStdout({ wrapper: { output: wrapperListing }, apath: '/home/u/.local/bin/a', snapshot: { output: snapshot } }));
      throw new Error(`unexpected exec: ${command}`);
    }));
    const listing = await client.listSessions();
    expect(listing.sessions.map((r) => r.id)).toEqual([raw.id]);
    expect(commands).toHaveLength(1);
  });

  it('a wrapper-only host pays the raw a probe once, then lists via the wrapper alone', async () => {
    const commands: string[] = [];
    const client = await freshHostClient(fakeConnection((command) => {
      commands.push(command);
      if (isProbeExec(command)) return outcome(probeStdout({ wrapper: { output: wrapperListing }, apath: '' }));
      if (isRawAplexerExec(command)) return outcome(probeStdout({ apath: '' }));
      return outcome(wrapperListing);
    }));
    await client.listSessions();
    expect(commands).toHaveLength(2); // combined probe, raw a probe
    await client.listSessions();
    expect(commands).toHaveLength(3); // one plain wrapper list
    expect(commands[2]).toContain('pocketshell sessions list --json');
    expect(commands[2]).not.toContain('command -v a');
  });

  it('a later process (fresh module graph) serves the cached direct backend in one snapshot-only exec', async () => {
    const first: string[] = [];
    await (await freshHostClient(fakeConnection((command) => {
      first.push(command);
      if (isProbeExec(command))
        return outcome(probeStdout({ wrapper: { output: wrapperListing }, apath: '/home/u/.local/bin/a', snapshot: { output: snapshot } }));
      throw new Error(`unexpected exec: ${command}`);
    }))).listSessions();
    expect(first).toHaveLength(1);

    const second: string[] = [];
    const client = await freshHostClient(fakeConnection((command) => {
      second.push(command);
      return outcome(snapshot);
    }));
    const listing = await client.listSessions();
    expect(listing.sessions.map((r) => r.id)).toEqual([raw.id]);
    expect(second).toHaveLength(1);
    expect(second[0]).toContain('--json snapshot');
    expect(second[0]).toContain('/home/u/.local/bin/a');
    expect(second[0]).not.toContain('pocketshell sessions list');
  });

  it('a direct a that stops resolving invalidates the verdict and falls back to the wrapper', async () => {
    const commands: string[] = [];
    let gone = false;
    const client = await freshHostClient(fakeConnection((command) => {
      commands.push(command);
      if (isProbeExec(command))
        return outcome(
          probeStdout(
            gone
              ? { wrapper: { output: wrapperListing }, apath: '' }
              : { wrapper: { output: wrapperListing }, apath: '/home/u/.local/bin/a', snapshot: { output: snapshot } },
          ),
        );
      if (isRawAplexerExec(command)) return outcome(probeStdout({ apath: '' }));
      if (command.includes('--json snapshot'))
        return outcome('sh: 1: /home/u/.local/bin/a: not found', 127, 'sh: 1: /home/u/.local/bin/a: not found');
      return outcome(wrapperListing);
    }));
    await client.listSessions(); // probe + cache direct
    gone = true;
    const relisted = await client.listSessions(); // snapshot 127 -> re-probe -> wrapper
    expect(relisted.errors).toEqual([]);
    const snapshots = commands.filter((c) => c.includes('--json snapshot') && c.includes('/home/u/.local/bin/a'));
    expect(snapshots).toHaveLength(1);
    expect(commands.filter(isProbeExec)).toHaveLength(2);
    expect(commands.filter(isRawAplexerExec)).toHaveLength(1); // only the second probe needs the raw PATH
  });

  it('a transport failure during a list neither invalidates nor retries', async () => {
    const commands: string[] = [];
    const client = await freshHostClient(fakeConnection(async () => {
      commands.push('exec');
      const { ConnectionError } = await import('../src/transport/types.js');
      throw new ConnectionError('dropped', 'CONNECT_FAILED');
    }));
    await expect(client.listSessions()).rejects.toMatchObject({ code: 'CONNECT_FAILED' });
    expect(commands).toHaveLength(1); // the probe itself, no retry
  });
});

describe('wrapper that lacks a verb (tray builds)', () => {
  it('create falls back to direct a on a wrapper usage error and updates the verdict', async () => {
    const commands: string[] = [];
    let aAppeared = false;
    const usage = 'Usage: pocketshell sessions [OPTIONS] COMMAND';
    const client = await freshHostClient(fakeConnection((command) => {
      commands.push(command);
      if (isProbeExec(command))
        return outcome(
          probeStdout(
            aAppeared
              ? { wrapper: { output: wrapperListing }, apath: '/tray/a', snapshot: { output: '[]' } }
              : { wrapper: { output: wrapperListing }, apath: '' },
          ),
        );
      if (isRawAplexerExec(command)) return outcome(probeStdout({ apath: '' }));
      if (command.includes('sessions create')) {
        aAppeared = true; // the host gained a between the probe and this verb
        return outcome('', 2, usage);
      }
      if (command.includes('pwd -P')) return outcome('/home/u/proj\n');
      if (command.includes('--json start')) return outcome(JSON.stringify(raw));
      return outcome(snapshot);
    }));
    const created = await client.createSession('test', { cwd: '/home/u/proj', engine: 'shell' });
    expect(created).toEqual({ name: 'proj:test', id: raw.id, created: true });
    expect(commands.some((c) => c.includes('--json start') && c.includes('/tray/a'))).toBe(true);
    // The re-probe (second combined exec) discovered a and stuck to it.
    expect(commands.filter(isProbeExec)).toHaveLength(2);
  });

  it('kill falls back to direct a the same way', async () => {
    const commands: string[] = [];
    let aAppeared = false;
    const client = await freshHostClient(fakeConnection((command) => {
      commands.push(command);
      if (isProbeExec(command))
        return outcome(
          probeStdout(
            aAppeared
              ? { wrapper: { output: wrapperListing }, apath: '/tray/a', snapshot: { output: snapshot } }
              : { wrapper: { output: wrapperListing }, apath: '' },
          ),
        );
      if (isRawAplexerExec(command)) return outcome(probeStdout({ apath: '' }));
      if (command.includes('sessions kill')) {
        aAppeared = true;
        return outcome('', 2, 'Usage: pocketshell sessions [OPTIONS] COMMAND');
      }
      if (command.includes('--json kill')) return outcome('[]');
      return outcome(snapshot);
    }));
    await client.killSession('proj:test', raw.id);
    expect(commands.some((c) => c.includes('--json kill') && c.includes('/tray/a') && c.includes(raw.id))).toBe(true);
  });

  it('start -C ~ expands the host profile directory instead of splicing a literal ~', async () => {
    const commands: string[] = [];
    const windowsProfile = 'C:\\Users\\alexey';
    const client = await freshHostClient(fakeConnection((command) => {
      commands.push(command);
      if (isProbeExec(command))
        return outcome(probeStdout({ wrapper: { exit: 127 }, apath: '/tray/a', snapshot: { output: '[]' } }));
      if (command.includes('USERPROFILE')) return outcome(windowsProfile);
      if (command.includes('pwd -P')) return outcome('/c/Users/alexey\n');
      if (command.includes('--json start')) return outcome(JSON.stringify({ ...raw, tag: 'probe', workspace: windowsProfile }));
      return outcome('[]');
    }));
    const created = await client.createSession('probe', { cwd: '~' });
    expect(created).toEqual({ name: 'alexey:probe', id: raw.id, created: true });
    const start = commands.find((c) => c.includes('--json start'))!;
    expect(start).toContain('--workspace');
    expect(start).toContain(windowsProfile);
    expect(commands.some((c) => c.includes("cd '~'") || c.includes('--workspace ~'))).toBe(false);
  });
});
