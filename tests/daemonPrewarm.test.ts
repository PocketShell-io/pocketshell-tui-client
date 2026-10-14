/** daemon/prewarm.ts: usage recording, the 24 h window, background warming, network-change watching. */
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const netState = vi.hoisted(() => ({ interfaces: [] as unknown }));
vi.mock('node:os', async (original) => {
  const actual = await original<typeof import('node:os')>();
  return {
    ...actual,
    networkInterfaces: () => netState.interfaces,
  };
});

import { addHost } from '../src/hosts/store.js';
import {
  PREWARM_WINDOW_MS,
  noteHostUsed,
  preWarm,
  recentHosts,
  watchNetworkChanges,
} from '../src/daemon/prewarm.js';
import type { HostEntry } from '../src/hosts/store.js';

let xdg: string | undefined;
beforeEach(() => {
  xdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'psc-prewarm-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  if (xdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = xdg;
});

const gatewayHost = (name: string): HostEntry => ({ name, mode: 'gateway', gateway: { deviceId: `dev-${name}` } });
const usageFile = (): string => join(process.env.XDG_CONFIG_HOME!, 'pocketshell-tui-client', 'daemon-usage.json');

describe('pre-warm usage recording', () => {
  it('records usage 0600, throttled per host, pruned after a week', () => {
    const before = Date.now();
    noteHostUsed(gatewayHost('alpha'));
    expect((statSync(usageFile()).mode & 0o777).toString(8)).toBe('600');
    const first = JSON.parse(readFileSync(usageFile(), 'utf8')) as { hosts: Record<string, number> };
    expect(first.hosts.alpha).toBeGreaterThanOrEqual(before);
    // A second use within the throttle window does not rewrite the file.
    const st = statSync(usageFile());
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1_000);
    noteHostUsed(gatewayHost('alpha'));
    expect(statSync(usageFile()).mtimeMs).toBe(st.mtimeMs);
    // A stale entry is pruned on the next write.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 8 * 24 * 60 * 60 * 1000);
    noteHostUsed(gatewayHost('beta'));
    const pruned = JSON.parse(readFileSync(usageFile(), 'utf8')) as { hosts: Record<string, number> };
    expect(pruned.hosts.alpha).toBeUndefined();
    expect(pruned.hosts.beta).toBeGreaterThan(0);
  });

  it('refuses a loosened usage file and falls back to memory', () => {
    noteHostUsed(gatewayHost('gamma'));
    writeFileSync(usageFile(), readFileSync(usageFile(), 'utf8'), { mode: 0o644 });
    expect(recentHosts().map((h) => h.name)).toEqual([]);
  });

  it('serves the 24 h window from saved hosts, gateway-mode only, newest first', () => {
    addHost({ name: 'old', mode: 'gateway', gateway: { deviceId: 'dev-old' } }, { replace: true });
    addHost({ name: 'recent', mode: 'gateway', gateway: { deviceId: 'dev-recent' } }, { replace: true });
    addHost({ name: 'sshy', mode: 'ssh', ssh: { destination: 'x' } }, { replace: true });
    const now = Date.now();
    writeFileSync(
      usageFile(),
      JSON.stringify({ version: 1, hosts: { old: now - 25 * 60 * 60 * 1000, recent: now - 60_000, sshy: now - 60_000 } }),
      { mode: 0o600 },
    );
    expect(recentHosts().map((h) => h.name)).toEqual(['recent']);
    // Both inside a doubled window, newest first.
    expect(recentHosts(PREWARM_WINDOW_MS * 2).map((h) => h.name)).toEqual(['recent', 'old']);
  });
});

describe('pre-warm execution', () => {
  it('warms recent hosts with bounded concurrency and swallows failures', async () => {
    for (const name of ['one', 'two', 'three']) addHost({ name, mode: 'gateway', gateway: { deviceId: `dev-${name}` } }, { replace: true });
    writeFileSync(usageFile(), JSON.stringify({ version: 1, hosts: { one: Date.now(), two: Date.now(), three: Date.now() } }), { mode: 0o600 });
    const warmed: string[] = [];
    let running = 0;
    let peak = 0;
    await preWarm(async (host) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 30));
      running--;
      if (host.name === 'three') throw Error('offline fixture');
      warmed.push(host.name);
    });
    expect(warmed.sort()).toEqual(['one', 'two']);
    expect(peak).toBeLessThanOrEqual(2);
    // A failed host is retried on the next cycle, not skipped forever.
    await preWarm(async (host) => {
      warmed.push(`retry:${host.name}`);
    });
    expect(warmed).toContain('retry:three');
  });

  it('shares one in-flight cycle and starts a fresh one after it settles', async () => {
    addHost({ name: 'only', mode: 'gateway', gateway: { deviceId: 'dev-only' } }, { replace: true });
    writeFileSync(usageFile(), JSON.stringify({ version: 1, hosts: { only: Date.now() } }), { mode: 0o600 });
    let cycles = 0;
    const first = preWarm(async () => {
      cycles++;
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    const shared = preWarm(async () => {
      cycles++;
    });
    expect(shared).toBe(first);
    await first;
    await preWarm(async () => {
      cycles++;
    });
    expect(cycles).toBe(2);
  });
});

describe('network change watching', () => {
  it('fires exactly when the interface fingerprint changes', async () => {
    netState.interfaces = {
      eth0: [
        { family: 'IPv4', address: '192.0.2.1', internal: false, mac: 'a', netmask: '', cidr: null, scopeid: 0 },
      ],
    };
    const events: string[] = [];
    const timer = watchNetworkChanges(() => events.push('changed'), 20);
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(events).toEqual([]); // unchanged fingerprint: silent
    netState.interfaces = {
      eth0: [
        { family: 'IPv4', address: '192.0.2.1', internal: false, mac: 'a', netmask: '', cidr: null, scopeid: 0 },
        { family: 'IPv6', address: '2001:db8::9', internal: false, mac: 'b', netmask: '', cidr: null, scopeid: 0 },
      ],
    };
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(events.length).toBeGreaterThanOrEqual(1);
    clearInterval(timer);
  });
});
