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
      async subscribe(topics: string[], params: Record<string, unknown> = {}) {
        return this.call('subscribe', { topics, ...params }) as Promise<{ subscription: string; seq: number }>;
      }
      async unsubscribe(subscription: string) {
        return this.call('unsubscribe', { subscription }) as Promise<{ unsubscribed: string }>;
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

type ReplicaClient = {
  listSessions(options?: { fresh?: boolean }): Promise<{ sessions: Array<{ id: string | null }>; errors: unknown[] }>;
  resolveSession(selector: string, options?: { fresh?: boolean }): Promise<{ id: string | null; name: string }>;
  captureSelected(selector: string, options: { mode: 'screen' | 'raw'; bytes?: number; fresh?: boolean }): Promise<{ row: { id: string | null }; text: string }>;
};

async function residentClient(): Promise<ReplicaClient> {
  return requests.run(context(), async () => daemonClient(host)) as Promise<ReplicaClient>;
}

/**
 * Production serves every command inside `requests.run` (daemon/main.ts),
 * which is where `replicaMeta` lands. Run the operation in a retained
 * context and report the value together with the meta it recorded.
 */
async function served<T>(client: ReplicaClient, fn: (client: ReplicaClient) => Promise<T>): Promise<{ value: T; meta: unknown }> {
  const ctx = context() as ReturnType<typeof context> & { replicaMeta?: unknown };
  const value = await requests.run(ctx, () => fn(client));
  return { value, meta: ctx.replicaMeta };
}

describe('daemon sessions replica', () => {
  it('subscribes sessions after the channel is ready and serves ls from the replica', async () => {
    const client = await residentClient();
    const channel = state.channels.at(-1)!;
    expect(state.calls.filter((c) => c.method === 'subscribe')).toEqual([
      { method: 'subscribe', params: { topics: ['sessions'], format: 'psc' } },
    ]);
    channel.emit(snapshot([row('uuid-1'), row('uuid-2')], 7));
    const { value: listing, meta } = await served(client, (c) => c.listSessions());
    expect(listing.sessions.map((r) => r.id)).toEqual(['uuid-1', 'uuid-2']);
    expect(state.calls.some((c) => c.method === 'list')).toBe(false);
    expect(meta).toMatchObject({ source: 'replica', seq: 7 });
  });

  it('status resolves from the replica with pickSession semantics', async () => {
    const client = await residentClient();
    state.channels.at(-1)!.emit(snapshot([row('uuid-1')]));
    expect((await served(client, (c) => c.resolveSession('uuid-1'))).value.id).toBe('uuid-1');
    expect((await served(client, (c) => c.resolveSession('proj:uuid-1'))).value.id).toBe('uuid-1');
    await expect(served(client, (c) => c.resolveSession('missing'))).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    expect(state.calls.some((c) => c.method === 'status')).toBe(false);
  });

  it('falls back to a live round trip once the last frame is older than the window', async () => {
    const client = await residentClient();
    state.channels.at(-1)!.emit(snapshot([row('uuid-1')]));
    state.now += REPLICA_LIVE_WINDOW_MS + 1;
    const { meta } = await served(client, (c) => c.listSessions());
    expect(state.calls.some((c) => c.method === 'list')).toBe(true);
    expect(meta).toMatchObject({ source: 'live' });
  });

  it('a heartbeat keeps the replica live past the window', async () => {
    const client = await residentClient();
    const channel = state.channels.at(-1)!;
    channel.emit(snapshot([row('uuid-1')]));
    state.now += REPLICA_LIVE_WINDOW_MS + 1;
    channel.emit({ event: 'heartbeat', topic: 'sessions', seq: 9, generation: 'gen-1' });
    const { value: listing, meta } = await served(client, (c) => c.listSessions());
    expect(listing.sessions.map((r) => r.id)).toEqual(['uuid-1']);
    expect(meta).toMatchObject({ source: 'replica', seq: 9 });
  });

  it('--fresh forces a live round trip even while the replica is live', async () => {
    const client = await residentClient();
    state.channels.at(-1)!.emit(snapshot([row('uuid-1')]));
    const { meta } = await served(client, (c) => c.listSessions({ fresh: true }));
    expect(state.calls.some((c) => c.method === 'list')).toBe(true);
    expect(meta).toMatchObject({ source: 'live' });
  });

  it('a generation change on a heartbeat retires the replica', async () => {
    const client = await residentClient();
    const channel = state.channels.at(-1)!;
    channel.emit({ ...snapshot([row('uuid-1')]), generation: 'gen-1' });
    channel.emit({ event: 'heartbeat', topic: 'sessions', seq: 2, generation: 'gen-2' });
    await served(client, (c) => c.listSessions());
    expect(state.calls.some((c) => c.method === 'list')).toBe(true);
  });

  it('a closed channel never serves the replica again', async () => {
    const client = await residentClient();
    const channel = state.channels.at(-1)!;
    channel.emit(snapshot([row('uuid-1')]));
    channel.close({ code: 'AUTH_LEASE_EXPIRED' });
    await served(client, (c) => c.listSessions());
    // The re-established channel re-subscribes; before its snapshot lands,
    // reads round-trip instead of serving the dropped replica.
    expect(state.calls.some((c) => c.method === 'list')).toBe(true);
  });

  it('a protocol-1 channel never subscribes and always round-trips', async () => {
    state.protocol = 1;
    const client = await residentClient();
    const { meta } = await served(client, (c) => c.listSessions());
    expect(state.calls.some((c) => c.method === 'subscribe')).toBe(false);
    expect(state.calls.some((c) => c.method === 'list')).toBe(true);
    expect(meta).toMatchObject({ source: 'live' });
  });

  it('a gap heartbeat marks the topic stale: one live refresh, then replica again', async () => {
    const client = await residentClient();
    const channel = state.channels.at(-1)!;
    channel.emit(snapshot([row('uuid-1')], 7));
    expect((await served(client, (c) => c.listSessions())).meta).toMatchObject({ source: 'replica', seq: 7 });
    // A heartbeat with gap:true carries no data: the freshness proof is void.
    channel.emit({ event: 'heartbeat', topic: 'sessions', seq: 8, generation: 'gen-1', gap: true });
    const listsBefore = state.calls.filter((c) => c.method === 'list').length;
    const refreshed = await served(client, (c) => c.listSessions());
    expect(state.calls.filter((c) => c.method === 'list')).toHaveLength(listsBefore + 1);
    expect(refreshed.meta).toMatchObject({ source: 'live' });
    // The refresh cleared the mark: the next read is local again.
    const again = await served(client, (c) => c.listSessions());
    expect(again.meta).toMatchObject({ source: 'replica' });
    expect(state.calls.filter((c) => c.method === 'list')).toHaveLength(listsBefore + 1);
  });

  it('a gap snapshot still replaces (full state, no refresh needed)', async () => {
    const client = await residentClient();
    const channel = state.channels.at(-1)!;
    channel.emit(snapshot([row('uuid-1')], 7));
    channel.emit({ ...snapshot([row('uuid-2')], 8), gap: true });
    const { value: listing, meta } = await served(client, (c) => c.listSessions());
    expect(listing.sessions.map((r) => r.id)).toEqual(['uuid-2']);
    expect(meta).toMatchObject({ source: 'replica', seq: 8 });
    expect(state.calls.some((c) => c.method === 'list')).toBe(false);
  });
});

describe('daemon screen mirror', () => {
  it('first capture round-trips and subscribes; later captures serve the mirror', async () => {
    const client = await residentClient();
    const channel = state.channels.at(-1)!;
    channel.emit(snapshot([row('uuid-1')]));
    const { value: first, meta: firstMeta } = await served(client, (c) => c.captureSelected('uuid-1', { mode: 'screen' }));
    expect(first.text).toBe('live:uuid-1');
    expect(state.calls.filter((c) => c.method === 'capture')).toHaveLength(1);
    expect(state.calls.some((c) => c.method === 'subscribe' && c.params.topics.includes('screen:uuid-1'))).toBe(true);
    expect(firstMeta).toMatchObject({ source: 'live' });

    channel.emit({ event: 'screen', topic: 'screen:uuid-1', subscription: 'sub-2', seq: 4, data: { session: row('uuid-1'), text: 'mirror text' } });
    const { value: second, meta } = await served(client, (c) => c.captureSelected('uuid-1', { mode: 'screen' }));
    expect(second.text).toBe('mirror text');
    expect(state.calls.filter((c) => c.method === 'capture')).toHaveLength(1);
    expect(meta).toMatchObject({ source: 'replica', seq: 4 });

    // A gap frame is full state: replace, never merge.
    channel.emit({ event: 'screen', topic: 'screen:uuid-1', subscription: 'sub-2', seq: 5, gap: true, data: { session: row('uuid-1'), text: 'replaced wholesale' } });
    expect((await served(client, (c) => c.captureSelected('uuid-1', { mode: 'screen' }))).value.text).toBe('replaced wholesale');
  });

  it('ended drops the mirror and the next capture round-trips', async () => {
    const client = await residentClient();
    const channel = state.channels.at(-1)!;
    channel.emit(snapshot([row('uuid-1')]));
    await served(client, (c) => c.captureSelected('uuid-1', { mode: 'screen' }));
    channel.emit({ event: 'screen', topic: 'screen:uuid-1', subscription: 'sub-2', seq: 3, data: { session: row('uuid-1'), text: 'x' } });
    channel.emit({ event: 'ended', topic: 'screen:uuid-1', subscription: 'sub-2', seq: 4 });
    const after = (await served(client, (c) => c.captureSelected('uuid-1', { mode: 'screen' }))).value;
    expect(after.text).toBe('live:uuid-1');
    expect(state.calls.filter((c) => c.method === 'capture')).toHaveLength(2);
  });

  it('--fresh and raw mode bypass the mirror', async () => {
    const client = await residentClient();
    const channel = state.channels.at(-1)!;
    channel.emit(snapshot([row('uuid-1')]));
    await served(client, (c) => c.captureSelected('uuid-1', { mode: 'screen' }));
    channel.emit({ event: 'screen', topic: 'screen:uuid-1', subscription: 'sub-2', seq: 3, data: { session: row('uuid-1'), text: 'mirror' } });
    expect((await served(client, (c) => c.captureSelected('uuid-1', { mode: 'screen', fresh: true }))).value.text).toBe('live:uuid-1');
    expect((await served(client, (c) => c.captureSelected('uuid-1', { mode: 'raw' }))).value.text).toBe('live:uuid-1');
  });

  it('a mirror older than the window is not served', async () => {
    const client = await residentClient();
    const channel = state.channels.at(-1)!;
    channel.emit(snapshot([row('uuid-1')]));
    await served(client, (c) => c.captureSelected('uuid-1', { mode: 'screen' }));
    channel.emit({ event: 'screen', topic: 'screen:uuid-1', subscription: 'sub-2', seq: 3, data: { session: row('uuid-1'), text: 'mirror' } });
    state.now += REPLICA_LIVE_WINDOW_MS + 1;
    // The sessions heartbeat also stopped: everything falls back to live.
    expect((await served(client, (c) => c.captureSelected('uuid-1', { mode: 'screen' }))).value.text).toBe('live:uuid-1');
  });

  it('a screen heartbeat proves mirror freshness; a gap heartbeat forces one live refresh', async () => {
    const client = await residentClient();
    const channel = state.channels.at(-1)!;
    channel.emit(snapshot([row('uuid-1')]));
    await served(client, (c) => c.captureSelected('uuid-1', { mode: 'screen' }));
    channel.emit({ event: 'screen', topic: 'screen:uuid-1', subscription: 'sub-2', seq: 3, data: { session: row('uuid-1'), text: 'mirror' } });
    // 5 s pass with only heartbeats: the mirror stays live past its own window.
    state.now += 5_000;
    channel.emit({ event: 'heartbeat', topic: 'sessions', seq: 4 });
    channel.emit({ event: 'heartbeat', topic: 'screen:uuid-1', subscription: 'sub-2', seq: 4 });
    state.now += REPLICA_LIVE_WINDOW_MS;
    const { value: kept, meta } = await served(client, (c) => c.captureSelected('uuid-1', { mode: 'screen' }));
    expect(kept.text).toBe('mirror');
    expect(meta).toMatchObject({ source: 'replica', seq: 4 });
    // A gap heartbeat voids the proof: the next capture round-trips once,
    // re-primes the mirror, and the one after is local again.
    channel.emit({ event: 'heartbeat', topic: 'screen:uuid-1', subscription: 'sub-2', seq: 5, gap: true });
    const capturesBefore = state.calls.filter((c) => c.method === 'capture').length;
    const { value: live, meta: liveMeta } = await served(client, (c) => c.captureSelected('uuid-1', { mode: 'screen' }));
    expect(live.text).toBe('live:uuid-1');
    expect(liveMeta).toMatchObject({ source: 'live' });
    expect(state.calls.filter((c) => c.method === 'capture')).toHaveLength(capturesBefore + 1);
    expect((await served(client, (c) => c.captureSelected('uuid-1', { mode: 'screen' }))).value.text).toBe('live:uuid-1');
    expect(state.calls.filter((c) => c.method === 'capture')).toHaveLength(capturesBefore + 1);
  });
});
