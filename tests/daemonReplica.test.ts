/**
 * The P2 daemon replica: protocol-2 channels subscribe `sessions`, reads
 * answer from the local replica while it is live (last frame < 6 s),
 * captures mirror subscribed screens, `--fresh` forces a round trip, and
 * staleness or an auth close never serves stale data silently.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  now: 1_700_000_000_000,
  protocol: 2,
  channels: [] as any[],
  calls: [] as Array<{ method: string; params: any }>,
}));

vi.mock('../src/daemon/policy.js', () => ({
  gatewayPolicy: () => ({ generation: 'A', accountExpires: Date.now() + 300_000 }),
}));

vi.mock('../src/transport/index.js', () => ({
  openConnection: vi.fn(async (host: any) => ({
    hostName: host.name,
    mode: 'gateway',
    exec: vi.fn(),
    attachInteractive: vi.fn(),
    close: vi.fn(),
  })),
}));

vi.mock('../src/daemon/channel.js', async (original) => {
  const actual = await original<typeof import('../src/daemon/channel.js')>();
  return {
    ...actual,
    HostChannel: class {
      negotiated = { protocol: state.protocol, pscSchema: 3, selectorModes: ['psc'] };
      onEvent: ((frame: unknown) => void) | undefined;
      closed = false;
      ready = Promise.resolve(this.negotiated);
      constructor(_host: any, _expiry: any, public retire: (e: unknown, established: boolean) => void) {
        state.channels.push(this);
      }
      async call(method: string, params: any) {
        state.calls.push({ method, params });
        if (method === 'capabilities') return this.negotiated;
        if (method === 'subscribe') return { subscription: `sub-${state.calls.filter((c) => c.method === 'subscribe').length}`, seq: 1 };
        if (method === 'unsubscribe') return { unsubscribed: params.subscription };
        if (method === 'list') return { schema: 3, sessions: [], errors: [] };
        if (method === 'ping') return { ok: true };
        if (method === 'capture') return { session: row(params.selector), text: `live:${params.selector}` };
        if (method === 'status') return { session: row(params.selector) };
        return {};
      }
      /** Test seam: deliver one push event as the helper would. */
      emit(frame: Record<string, unknown>): void {
        this.onEvent?.({ protocol: 2, subscription: 'sub-1', seq: 1, ...frame });
      }
      close(reason?: unknown) {
        if (this.closed) return;
        this.closed = true;
        this.retire(reason ?? { code: 'CONNECTION_LOST' }, true);
      }
    },
  };
});

function row(id: string) {
  return {
    name: `proj:${id}`, id, workspace: '/tmp/proj', tag: id, engine: null, profile: null, agent: null,
    agent_state: null, agent_state_source: null, attached: false, created_epoch: 1, activity_epoch: 1,
  };
}

import { requests } from '../src/daemon/context.js';
import { closeChannels, daemonClient, REPLICA_LIVE_WINDOW_MS } from '../src/daemon/services.js';

const host = { name: 'replica-fixture', mode: 'gateway' as const, gateway: { deviceId: 'dev-1' } };
let xdg: string | undefined;

beforeEach(() => {
  xdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'psc-replica-'));
  closeChannels();
  state.channels = [];
  state.calls = [];
  state.protocol = 2;
  vi.spyOn(Date, 'now').mockImplementation(() => state.now);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (xdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = xdg;
});

const snapshot = (sessions: unknown[], seq = 1) => ({
  event: 'snapshot',
  topic: 'sessions',
  subscription: 'sub-1',
  seq,
  data: { schema: 3, sessions, errors: [] },
});

function context() {
  return {
    json: true,
    stdin: '',
    tty: false,
    exitCode: 0,
    signal: new AbortController().signal,
    write: () => {},
  };
}

async function residentClient() {
  return requests.run(context(), async () => daemonClient(host)) as Promise<
    import('../src/daemon/services.js').daemonClient extends (...args: any) => infer R ? never : any
  > & {
    listSessions(options?: { fresh?: boolean }): Promise<{ sessions: Array<{ id: string | null }>; errors: unknown[] }>;
    resolveSession(selector: string, options?: { fresh?: boolean }): Promise<{ id: string | null; name: string }>;
    captureSelected(selector: string, options: { mode: 'screen' | 'raw'; bytes?: number; fresh?: boolean }): Promise<{ row: { id: string | null }; text: string }>;
  };
}

describe('daemon sessions replica', () => {
  it('subscribes sessions after the channel is ready and serves ls from the replica', async () => {
    const client = await residentClient();
    const channel = state.channels.at(-1)!;
    expect(state.calls.filter((c) => c.method === 'subscribe')).toEqual([
      { method: 'subscribe', params: { topics: ['sessions'], format: 'psc' } },
    ]);
    channel.emit(snapshot([row('uuid-1'), row('uuid-2')], 7));
    const listing = await client.listSessions();
    expect(listing.sessions.map((r) => r.id)).toEqual(['uuid-1', 'uuid-2']);
    expect(state.calls.some((c) => c.method === 'list')).toBe(false);
    expect(requests.getStore()?.replicaMeta).toMatchObject({ source: 'replica', seq: 7 });
  });

  it('status resolves from the replica with pickSession semantics', async () => {
    const client = await residentClient();
    state.channels.at(-1)!.emit(snapshot([row('uuid-1')]));
    expect((await client.resolveSession('uuid-1')).id).toBe('uuid-1');
    expect((await client.resolveSession('proj:uuid-1')).id).toBe('uuid-1');
    await expect(client.resolveSession('missing')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    expect(state.calls.some((c) => c.method === 'status')).toBe(false);
  });

  it('falls back to a live round trip once the last frame is older than the window', async () => {
    const client = await residentClient();
    state.channels.at(-1)!.emit(snapshot([row('uuid-1')]));
    state.now += REPLICA_LIVE_WINDOW_MS + 1;
    await client.listSessions();
    expect(state.calls.some((c) => c.method === 'list')).toBe(true);
    expect(requests.getStore()?.replicaMeta).toMatchObject({ source: 'live' });
  });

  it('a heartbeat keeps the replica live past the window', async () => {
    const client = await residentClient();
    const channel = state.channels.at(-1)!;
    channel.emit(snapshot([row('uuid-1')]));
    state.now += REPLICA_LIVE_WINDOW_MS + 1;
    channel.emit({ event: 'heartbeat', topic: 'sessions', seq: 9, generation: 'gen-1' });
    const listing = await client.listSessions();
    expect(listing.sessions.map((r) => r.id)).toEqual(['uuid-1']);
    expect(requests.getStore()?.replicaMeta).toMatchObject({ source: 'replica', seq: 9 });
  });

  it('--fresh forces a live round trip even while the replica is live', async () => {
    const client = await residentClient();
    state.channels.at(-1)!.emit(snapshot([row('uuid-1')]));
    await client.listSessions({ fresh: true });
    expect(state.calls.some((c) => c.method === 'list')).toBe(true);
    expect(requests.getStore()?.replicaMeta).toMatchObject({ source: 'live' });
  });

  it('a generation change on a heartbeat retires the replica', async () => {
    const client = await residentClient();
    const channel = state.channels.at(-1)!;
    channel.emit({ ...snapshot([row('uuid-1')]), generation: 'gen-1' });
    channel.emit({ event: 'heartbeat', topic: 'sessions', seq: 2, generation: 'gen-2' });
    await client.listSessions();
    expect(state.calls.some((c) => c.method === 'list')).toBe(true);
  });

  it('a closed channel never serves the replica again', async () => {
    const client = await residentClient();
    const channel = state.channels.at(-1)!;
    channel.emit(snapshot([row('uuid-1')]));
    channel.close({ code: 'AUTH_LEASE_EXPIRED' });
    await client.listSessions();
    // The re-established channel re-subscribes; before its snapshot lands,
    // reads round-trip instead of serving the dropped replica.
    expect(state.calls.some((c) => c.method === 'list')).toBe(true);
  });

  it('a protocol-1 channel never subscribes and always round-trips', async () => {
    state.protocol = 1;
    const client = await residentClient();
    await client.listSessions();
    expect(state.calls.some((c) => c.method === 'subscribe')).toBe(false);
    expect(state.calls.some((c) => c.method === 'list')).toBe(true);
    expect(requests.getStore()?.replicaMeta).toMatchObject({ source: 'live' });
  });
});

describe('daemon screen mirror', () => {
  it('first capture round-trips and subscribes; later captures serve the mirror', async () => {
    const client = await residentClient();
    const channel = state.channels.at(-1)!;
    channel.emit(snapshot([row('uuid-1')]));
    const first = await client.captureSelected('uuid-1', { mode: 'screen' });
    expect(first.text).toBe('live:uuid-1');
    expect(state.calls.filter((c) => c.method === 'capture')).toHaveLength(1);
    expect(state.calls.some((c) => c.method === 'subscribe' && c.params.topics.includes('screen:uuid-1'))).toBe(true);
    expect(requests.getStore()?.replicaMeta).toMatchObject({ source: 'live' });

    channel.emit({ event: 'screen', topic: 'screen:uuid-1', subscription: 'sub-2', seq: 4, data: { session: row('uuid-1'), text: 'mirror text' } });
    const second = await client.captureSelected('uuid-1', { mode: 'screen' });
    expect(second.text).toBe('mirror text');
    expect(state.calls.filter((c) => c.method === 'capture')).toHaveLength(1);
    expect(requests.getStore()?.replicaMeta).toMatchObject({ source: 'replica', seq: 4 });

    // A gap frame is full state: replace, never merge.
    channel.emit({ event: 'screen', topic: 'screen:uuid-1', subscription: 'sub-2', seq: 5, gap: true, data: { session: row('uuid-1'), text: 'replaced wholesale' } });
    expect((await client.captureSelected('uuid-1', { mode: 'screen' })).text).toBe('replaced wholesale');
  });

  it('ended drops the mirror and the next capture round-trips', async () => {
    const client = await residentClient();
    const channel = state.channels.at(-1)!;
    channel.emit(snapshot([row('uuid-1')]));
    await client.captureSelected('uuid-1', { mode: 'screen' });
    channel.emit({ event: 'screen', topic: 'screen:uuid-1', subscription: 'sub-2', seq: 3, data: { session: row('uuid-1'), text: 'x' } });
    channel.emit({ event: 'ended', topic: 'screen:uuid-1', subscription: 'sub-2', seq: 4 });
    const after = await client.captureSelected('uuid-1', { mode: 'screen' });
    expect(after.text).toBe('live:uuid-1');
    expect(state.calls.filter((c) => c.method === 'capture')).toHaveLength(2);
  });

  it('--fresh and raw mode bypass the mirror', async () => {
    const client = await residentClient();
    const channel = state.channels.at(-1)!;
    channel.emit(snapshot([row('uuid-1')]));
    await client.captureSelected('uuid-1', { mode: 'screen' });
    channel.emit({ event: 'screen', topic: 'screen:uuid-1', subscription: 'sub-2', seq: 3, data: { session: row('uuid-1'), text: 'mirror' } });
    expect((await client.captureSelected('uuid-1', { mode: 'screen', fresh: true })).text).toBe('live:uuid-1');
    expect((await client.captureSelected('uuid-1', { mode: 'raw' })).text).toBe('live:uuid-1');
  });

  it('a mirror older than the window is not served', async () => {
    const client = await residentClient();
    const channel = state.channels.at(-1)!;
    channel.emit(snapshot([row('uuid-1')]));
    await client.captureSelected('uuid-1', { mode: 'screen' });
    channel.emit({ event: 'screen', topic: 'screen:uuid-1', subscription: 'sub-2', seq: 3, data: { session: row('uuid-1'), text: 'mirror' } });
    state.now += REPLICA_LIVE_WINDOW_MS + 1;
    // The sessions heartbeat also stopped: everything falls back to live.
    expect((await client.captureSelected('uuid-1', { mode: 'screen' })).text).toBe('live:uuid-1');
  });
});
