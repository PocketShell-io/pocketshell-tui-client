import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBackendCapability } from '../src/hostCapability.js';

/**
 * Old-helper fallback (see channel.helperCommand + services.daemonClient):
 * when the resident negotiation fails with an undispatched RPC_UNSUPPORTED
 * (a host helper that predates `a rpc --stdio`, or one shadowed by a shell
 * alias), the daemon serves the host over the legacy transport instead of
 * throwing, caches that verdict briefly, and re-dials after the TTL or a
 * policy-generation change (e.g. the helper was upgraded). Dispatched
 * failures are never mistaken for an old helper.
 */
const state = vi.hoisted(() => ({
  generation: 'A',
  now: 1_700_000_000_000,
  /** 'unsupported' (negotiation) | 'connlost' (dispatched) | 'ok'. */
  mode: 'unsupported',
  constructions: 0,
  savedEnv: undefined as string | undefined,
}));

vi.mock('../src/daemon/policy.js', () => ({
  gatewayPolicy: () => ({ generation: state.generation, accountExpires: state.now + 300_000 }),
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
      negotiated = { protocol: 1 };
      onEvent: unknown = undefined;
      ready: Promise<unknown>;
      constructor(_host: any, _expiry: any, retire: (e: unknown, established: boolean) => void) {
        state.constructions++;
        if (state.mode === 'unsupported') {
          const failure = new actual.RpcFailure('RPC_UNSUPPORTED', 'fixture old helper', true);
          this.ready = Promise.reject(failure);
          this.ready.catch((error) => retire(error, false));
        } else if (state.mode === 'connlost') {
          const failure = new actual.RpcFailure('CONNECTION_LOST', 'fixture lost', true);
          this.ready = Promise.reject(failure);
          this.ready.catch((error) => retire(error, false));
        } else {
          this.ready = Promise.resolve({ pscSchema: 3, selectorModes: ['psc'], versions: {} });
        }
      }
      async call() {
        return {};
      }
      close() {}
    },
  };
});

import { requests } from '../src/daemon/context.js';
import { USER_BIN_PATH } from '@pocketshell/core';
import { helperCommand } from '../src/daemon/channel.js';
import { closeChannels, daemonClient } from '../src/daemon/services.js';
import { openConnection } from '../src/transport/index.js';

const laptop = { name: 'laptop', mode: 'gateway' as const, gateway: { deviceId: 'laptop-id' } };

vi.spyOn(Date, 'now').mockImplementation(() => state.now);

function stubContext() {
  return {
    json: false,
    stdin: '',
    tty: false,
    exitCode: 0,
    signal: new AbortController().signal,
    write: () => {},
  };
}

beforeEach(() => {
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'psc-helper-fallback-'));
  closeChannels();
  state.generation = 'A';
  state.now = 1_700_000_000_000;
  state.mode = 'unsupported';
  state.constructions = 0;
  vi.mocked(openConnection).mockClear();
  delete process.env.PSC_RPC_BINARY;
});

describe('resident helper command', () => {
  it('resolves the helper like the legacy transport: user bins first, no shadowing function', () => {
    expect(helperCommand()).toBe(
      `export PATH="${USER_BIN_PATH}:$PATH"; unset -f a; exec a rpc --stdio --protocol 2`,
    );
  });

  it('keeps an absolute development helper untouched', () => {
    process.env.PSC_RPC_BINARY = '/opt/aplexer-test/a';
    expect(helperCommand()).toBe('exec /opt/aplexer-test/a rpc --stdio --protocol 2');
  });

  it('refuses a non-absolute development helper', () => {
    process.env.PSC_RPC_BINARY = 'relative/a';
    expect(() => helperCommand()).toThrow('development helper must be an absolute path');
  });
});

describe('old-helper legacy fallback', () => {
  it('serves legacy instead of throwing, and marks the request transport', async () => {
    const context = stubContext();
    const client = await requests.run(context, () => daemonClient(laptop));
    expect(client.connection.hostName).toBe('laptop');
    expect(vi.mocked(openConnection)).toHaveBeenCalledTimes(1);
    expect(state.constructions).toBe(1);
    expect(context.transportPath).toBe('legacy');
    // An old-helper refusal downgrades knowledge but never invents it: with
    // nothing probed yet, there is still no backend verdict to serve.
    expect(loadBackendCapability(laptop)).toBeNull();
  });

  it('caches the verdict briefly, then re-dials', async () => {
    await daemonClient(laptop);
    expect(state.constructions).toBe(1);
    await daemonClient(laptop);
    expect(state.constructions).toBe(1);
    expect(vi.mocked(openConnection)).toHaveBeenCalledTimes(2);
    state.now += 31_000;
    await daemonClient(laptop);
    expect(state.constructions).toBe(2);
  });

  it('re-dials on policy generation change (helper upgraded)', async () => {
    await daemonClient(laptop);
    expect(state.constructions).toBe(1);
    expect(vi.mocked(openConnection)).toHaveBeenCalledTimes(1);
    state.generation = 'B';
    state.mode = 'ok';
    const context = stubContext();
    await requests.run(context, () => daemonClient(laptop));
    expect(state.constructions).toBe(2);
    expect(context.transportPath).toBe('resident');
    // The upgraded helper serves resident: no further legacy dial.
    expect(vi.mocked(openConnection)).toHaveBeenCalledTimes(1);
  });

  it('rethrows dispatched failures instead of falling back', async () => {
    state.mode = 'connlost';
    await expect(daemonClient(laptop)).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
    expect(vi.mocked(openConnection)).not.toHaveBeenCalled();
  });
});
