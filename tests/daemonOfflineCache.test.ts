import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Short-TTL negative cache for offline gateway refusals (see services.ts):
 * a HOST_OFFLINE / DEVICE_NOT_FOUND refusal fails fast without re-dialling
 * while cached, expires after its TTL, and never applies across hosts or to
 * other failure kinds.
 */
const state = vi.hoisted(() => ({
  generation: 'A',
  now: 1_700_000_000_000,
  /** Hosts whose negotiation fails, by host name -> RpcFailure code. */
  failures: new Map<string, string>(),
  /** Every HostChannel construction is one live gateway dial (mint + WS). */
  constructions: 0,
}));

vi.mock('../src/daemon/policy.js', () => ({
  gatewayPolicy: () => ({ generation: state.generation, accountExpires: state.now + 300_000 }),
}));

vi.mock('../src/daemon/channel.js', async (original) => {
  const actual = await original<typeof import('../src/daemon/channel.js')>();
  return {
    ...actual,
    HostChannel: class {
      ready: Promise<unknown>;
      constructor(host: any, _expiry: any, retire: (e: unknown, established: boolean) => void) {
        state.constructions++;
        const code = state.failures.get(host.name);
        if (code) {
          const failure = new actual.RpcFailure(code, `fixture ${code}`, true);
          this.ready = Promise.reject(failure);
          // Mirror HostChannel: a failed negotiation closes and retires the slot.
          this.ready.catch((error) => retire(error, false));
        } else {
          this.ready = Promise.resolve({ pscSchema: 3, selectorModes: ['psc'], versions: {} });
        }
      }
      async call(method: string) {
        if (method === 'list') return { schema: 3, sessions: [], errors: [] };
        if (method === 'ping') return { ok: true };
        return {};
      }
      close() {}
    },
  };
});

import { closeChannels, daemonClient } from '../src/daemon/services.js';

const laptop = { name: 'laptop', mode: 'gateway' as const, gateway: { deviceId: 'laptop-id' } };
const desktop = { name: 'desktop', mode: 'gateway' as const, gateway: { deviceId: 'desktop-id' } };

vi.spyOn(Date, 'now').mockImplementation(() => state.now);

beforeEach(() => {
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'psc-offline-cache-'));
  closeChannels();
  state.generation = 'A';
  state.now = 1_700_000_000_000;
  state.failures = new Map();
  state.constructions = 0;
});

describe('daemon offline negative cache', () => {
  it('serves a cached host_offline refusal fast and without re-dialling', async () => {
    state.failures.set('laptop', 'HOST_OFFLINE');
    await expect(daemonClient(laptop)).rejects.toMatchObject({ code: 'HOST_OFFLINE' });
    expect(state.constructions).toBe(1);
    const start = performance.now();
    await expect(daemonClient(laptop)).rejects.toMatchObject({
      code: 'HOST_OFFLINE',
      message: 'fixture HOST_OFFLINE',
    });
    expect(performance.now() - start).toBeLessThan(250);
    expect(state.constructions).toBe(1);
  });

  it('caches host-unknown refusals and re-dials after the TTL expires', async () => {
    state.failures.set('laptop', 'DEVICE_NOT_FOUND');
    await expect(daemonClient(laptop)).rejects.toMatchObject({ code: 'DEVICE_NOT_FOUND' });
    expect(state.constructions).toBe(1);
    state.now += 19_000;
    await expect(daemonClient(laptop)).rejects.toMatchObject({ code: 'DEVICE_NOT_FOUND' });
    expect(state.constructions).toBe(1);
    state.now += 2_000;
    await expect(daemonClient(laptop)).rejects.toMatchObject({ code: 'DEVICE_NOT_FOUND' });
    expect(state.constructions).toBe(2);
  });

  it('leaves online hosts unaffected by a cached refusal', async () => {
    state.failures.set('laptop', 'HOST_OFFLINE');
    await expect(daemonClient(laptop)).rejects.toMatchObject({ code: 'HOST_OFFLINE' });
    const client = await daemonClient(desktop);
    expect((await client.listSessions()).sessions).toEqual([]);
    expect(state.constructions).toBe(2);
    // The online host keeps working while the offline one keeps failing fast.
    expect((await (await daemonClient(desktop)).listSessions()).sessions).toEqual([]);
    expect(state.constructions).toBe(2);
  });

  it('does not leak a cached refusal across hosts', async () => {
    state.failures.set('laptop', 'HOST_OFFLINE');
    await expect(daemonClient(laptop)).rejects.toMatchObject({ code: 'HOST_OFFLINE' });
    // A different host dials for itself even when it fails the same way.
    state.failures.set('desktop', 'HOST_OFFLINE');
    await expect(daemonClient(desktop)).rejects.toMatchObject({ code: 'HOST_OFFLINE' });
    expect(state.constructions).toBe(2);
    // ...and an online host with no refusal configured is untouched.
    state.failures.delete('desktop');
    state.now += 21_000;
    expect((await (await daemonClient(desktop)).listSessions()).sessions).toEqual([]);
  });

  it('never caches auth failures', async () => {
    state.failures.set('laptop', 'NOT_LOGGED_IN');
    await expect(daemonClient(laptop)).rejects.toMatchObject({ code: 'NOT_LOGGED_IN' });
    // Past the reconnect backoff but inside the negative-cache TTL: a cached
    // refusal would fail fast here, an auth failure re-dials instead.
    state.now += 1_000;
    await expect(daemonClient(laptop)).rejects.toMatchObject({ code: 'NOT_LOGGED_IN' });
    expect(state.constructions).toBe(2);
  });
});
