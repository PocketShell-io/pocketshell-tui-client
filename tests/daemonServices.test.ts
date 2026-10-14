import { requests } from '../src/daemon/context.js';
import { beforeEach, describe, it, expect, vi } from 'vitest';
const state = vi.hoisted(() => ({
  generation: 'A',
  error: false,
  instances: [] as any[],
  calls: [] as any[],
  failNext: '',
  capable: true,
  legacy: vi.fn(),
}));
const row = {
  name: 'fixture:tag',
  id: '12345678-0000-0000-0000-000000000000',
  workspace: '/fixture',
  tag: 'tag',
  engine: 'shell',
  profile: null,
  agent: null,
  agent_state: null,
  agent_state_source: null,
  attached: false,
  created_epoch: 1,
  activity_epoch: 1,
};
vi.mock('../src/daemon/policy.js', () => ({
  gatewayPolicy: () => {
    if (state.error) throw Error('unsafe fixture policy');
    return { generation: state.generation, accountExpires: Date.now() + 300000 };
  },
}));
vi.mock('../src/transport/index.js', () => ({ openConnection: state.legacy }));
vi.mock('../src/daemon/channel.js', async (original) => {
  const actual = await original<typeof import('../src/daemon/channel.js')>();
  return {
    ...actual,
    HostChannel: class {
      ready = Promise.resolve({
        pscSchema: state.capable ? 3 : null,
        selectorModes: ['psc'],
        versions: { pocketshell: 'fixture cli', aplexer: 'fixture a' },
      });
      closed = false;
      initialContext = requests.getStore();
      constructor(
        _host: any,
        _expiry: any,
        private retire: (e: unknown) => void,
      ) {
        state.instances.push(this);
      }
      async call(method: string, params: any, mutation: boolean) {
        state.calls.push({ method, params, mutation });
        if (state.failNext) {
          const code = state.failNext;
          state.failNext = '';
          throw new actual.RpcFailure(code, 'fixture failure', false);
        }
        if (method === 'list') return { schema: 3, sessions: [row], errors: [] };
        if (method === 'ping') return { ok: true };
        if (method === 'capture') return { session: row, text: 'fixture capture' };
        return { session: row };
      }
      close() {
        if (this.closed) return;
        this.closed = true;
        this.retire(new actual.RpcFailure('CONNECTION_LOST', 'fixture retired'));
      }
    },
  };
});
import { daemonClient, closeChannels } from '../src/daemon/services.js';
const host = { name: 'fixture', mode: 'gateway' as const, gateway: { deviceId: 'Lab' } };
beforeEach(() => {
  closeChannels();
  state.instances = [];
  state.calls = [];
  state.error = false;
  state.capable = true;
  state.generation = 'A';
  state.failNext = '';
  state.legacy.mockReset();
  state.legacy.mockResolvedValue({
    hostName: 'fixture',
    mode: 'gateway',
    exec: vi.fn(),
    attachInteractive: vi.fn(),
    close: vi.fn(),
  });
});
describe('daemon atomic operations and policy retirement', () => {
  it('uses one helper request per selector operation and validates schema3 output', async () => {
    const client = await daemonClient(host);
    expect((await client.listSessions()).sessions[0]?.name).toBe('fixture:tag');
    expect((await client.resolveSession('tag')).id).toBe(row.id);
    expect((await client.captureSelected('tag', { mode: 'screen' })).text).toBe('fixture capture');
    expect((await client.sendSelected('tag', 'hello', { enter: false })).id).toBe(row.id);
    expect(state.calls.map((c) => c.method)).toEqual(['list', 'status', 'capture', 'send']);
    expect(state.calls[0].params).toEqual({ format: 'psc' });
    expect(state.calls.slice(1).every((c) => c.params.selectorMode === 'psc')).toBe(true);
    expect(state.instances).toHaveLength(1);
    expect(state.legacy).not.toHaveBeenCalled();
  });
  it('retires account/pin generations and refuses unsafe or deleted credentials before dispatch', async () => {
    let client = await daemonClient(host);
    await client.listSessions();
    const first = state.instances[0];
    state.generation = 'B';
    client = await daemonClient(host);
    expect(first.closed).toBe(true);
    await client.listSessions();
    state.error = true;
    await expect(client.listSessions()).rejects.toThrow('unsafe fixture policy');
    expect(state.instances[1].closed).toBe(true);
    expect(state.calls).toHaveLength(2);
  });
  it('retries a lost read once and never retries an uncertain send', async () => {
    const client = await daemonClient(host);
    state.failNext = 'CONNECTION_LOST';
    await client.listSessions();
    expect(state.calls).toHaveLength(2);
    state.calls = [];
    state.failNext = 'OUTCOME_UNKNOWN';
    await expect(client.sendSelected('tag', 'hello', { enter: true })).rejects.toMatchObject({
      code: 'OUTCOME_UNKNOWN',
    });
    expect(state.calls).toHaveLength(1);
  });
  it('uses a live ping with negotiated versions, and falls back before mutation for old capabilities', async () => {
    let client = await daemonClient(host);
    expect(await client.probe()).toEqual({ pocketshell: 'fixture cli', aplexer: 'fixture a' });
    expect(state.calls.map((c) => c.method)).toEqual(['ping']);
    closeChannels();
    state.capable = false;
    client = await daemonClient(host);
    expect(state.legacy).toHaveBeenCalledOnce();
    expect(client.connection.hostName).toBe('fixture');
  });
});

it('creates persistent transports outside the caller request context', async () => {
  const context = {
    json: true,
    stdin: 'private fixture payload',
    tty: false,
    exitCode: 0,
    signal: new AbortController().signal,
    write: () => {},
  };
  await requests.run(context, () => daemonClient(host));
  expect(state.instances[0].initialContext).toBeUndefined();
});
