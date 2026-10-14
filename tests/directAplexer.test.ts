import { describe, expect, it } from 'vitest';
import { directSessions } from '../src/directAplexer.js';
import { HostClient } from '../src/hostClient.js';
import { ConnectionError, type Connection, type ExecOutcome } from '../src/transport/types.js';

const raw = { id: 'abcd1234', workspace: 'C:/Users/Alexey/my project', tag: 'test', engine: 'shell',
  state: 'running', phase: 'running', created_at_ms: 1000, last_activity_ms: 10000,
  reported_state: 'idle', reported_state_at_ms: 15000, attached_clients: 2, agent: ' codex ' };
const outcome = (stdout: string, exitCode = 0): ExecOutcome => ({ stdout, exitCode, stderr: '', timedOut: false });
function connection(exec: Connection['exec']): Connection {
  return { hostName: 'direct', mode: 'ssh', exec, attachInteractive: async () => 0, close: async () => {} };
}

describe('direct snapshot mapping', () => {
  it('matches the wrapper naming, epochs, attachment and reported-state contract', () => {
    expect(directSessions([raw], 20000)).toEqual({ errors: [], sessions: [{ name: 'my project:test', id: 'abcd1234',
      workspace: raw.workspace, tag: 'test', engine: null, profile: null, agent: 'codex', agentState: 'idle',
      agentStateSource: 'reported', attached: true, createdEpoch: 1, activityEpoch: 10, phase: 'running' }] });
  });
  it('uses tag alone at a Windows drive/share root and preserves literal POSIX backslashes', () => {
    expect(directSessions([{ ...raw, workspace: 'C:/' }]).sessions[0]?.name).toBe('test');
    expect(directSessions([{ ...raw, workspace: '\\\\server\\share\\' }]).sessions[0]?.name).toBe('test');
    expect(directSessions([{ ...raw, workspace: '/tmp/a\\b' }]).sessions[0]?.name).toBe('a\\b:test');
  });
  it('filters dead, unknown and duplicate records and applies heuristic state expiry', () => {
    const rows = directSessions([raw, raw, { ...raw, id: 'dead', state: 'exited' },
      { ...raw, id: 'unknown', state: 'unknown' }, { ...raw, id: 'starting', state: 'starting', phase: 'starting' }], 24000).sessions;
    expect(rows.map((r) => [r.id, r.agentState, r.agentStateSource])).toEqual([
      ['abcd1234', 'waiting', 'heuristic'], ['starting', 'working', 'heuristic']]);
    expect(() => directSessions({ sessions: [] })).toThrow(/array/);
  });
});

describe('host session backend', () => {
  it.each([127, 1])('falls back on wrapper exit %i and resolves a from the initial endpoint PATH once', async (code) => {
    const seen: string[] = [];
    const client = new HostClient(connection(async (cmd) => {
      seen.push(cmd);
      if (cmd.includes('pocketshell sessions list')) return { ...outcome('', code), stderr: 'sessions is not supported on Windows by this CLI' };
      if (cmd === 'command -v a') return outcome('/managed runtime/python/a\n');
      return outcome(JSON.stringify([raw]));
    }));
    await client.listSessions();
    await client.captureSelected('test', { mode: 'screen' });
    await client.sendSelected('test', 'echo safe', { enter: true });
    await client.killSession('test', raw.id);
    expect(seen.filter((c) => c.includes('pocketshell sessions list'))).toHaveLength(1);
    expect(seen.filter((c) => c === 'command -v a')).toHaveLength(1);
    for (const verb of ['snapshot', 'capture', 'send', 'kill']) {
      expect(seen.some((c) => c.includes(verb) && c.includes('/managed runtime/python/a'))).toBe(true);
    }
  });
  it('does not downgrade transport failures or timeouts to an alternate backend', async () => {
    const seen: string[] = [];
    const client = new HostClient(connection(async (cmd) => {
      seen.push(cmd);
      throw new ConnectionError('offline', 'CONNECT_FAILED');
    }));
    await expect(client.listSessions()).rejects.toThrow('offline');
    expect(seen).toHaveLength(1);
    const timeout = new HostClient(connection(async () => ({ ...outcome(''), timedOut: true, exitCode: null })));
    await expect(timeout.listSessions()).rejects.toMatchObject({ timedOut: true });
  });
  it('caches a successful fallback across client instances for the same saved host', async () => {
    const seen: string[] = [];
    const host = { name: 'cache-direct-fixture', mode: 'ssh' as const, ssh: { destination: 'fixture' } };
    const conn = () => ({ ...connection(async (cmd) => {
      seen.push(cmd);
      if (cmd.includes('pocketshell sessions list')) return outcome('', 127);
      if (cmd === 'command -v a') return outcome('/managed/a');
      return outcome(JSON.stringify([raw]));
    }), hostName: host.name });
    await new HostClient(conn(), 'pocketshell', host).listSessions();
    await new HostClient(conn(), 'pocketshell', host).listSessions();
    expect(seen.filter((c) => c.includes('pocketshell sessions list'))).toHaveLength(1);
    expect(seen.filter((c) => c === 'command -v a')).toHaveLength(1);
  });
  it('starts a new session with quoted arguments and returns the wrapper create shape', async () => {
    const seen: string[] = [];
    const client = new HostClient(connection(async (cmd) => {
      seen.push(cmd);
      if (cmd.includes('pocketshell sessions list')) return outcome('', 127);
      if (cmd === 'command -v a') return outcome('/managed/a');
      if (cmd.includes('pwd -P')) return outcome('/c/Users/Alexey/my project\n');
      if (cmd.includes('--json start')) return outcome(JSON.stringify(raw));
      return outcome('[]');
    }));
    expect(await client.createSession('test', { cwd: raw.workspace, engine: 'shell' })).toEqual({
      name: 'my project:test', id: raw.id, created: true });
    expect(seen.filter((c) => c.includes('--json start'))).toHaveLength(1);
    expect(seen.find((c) => c.includes('--json start'))).toContain('--engine');
  });
  it('creates directly and reuses an existing workspace/tag without starting again', async () => {
    const seen: string[] = [];
    const client = new HostClient(connection(async (cmd) => {
      seen.push(cmd);
      if (cmd.includes('pocketshell sessions list')) return outcome('', 127);
      if (cmd === 'command -v a') return outcome('/managed/a');
      if (cmd.includes('pwd -P')) return outcome('/c/Users/Alexey/my project\n');
      return outcome(JSON.stringify([raw]));
    }));
    expect(await client.createSession('test', { cwd: raw.workspace })).toEqual({ name: 'my project:test', id: raw.id, created: false });
    expect(seen.some((c) => c.includes('--json start'))).toBe(false);
  });
});
