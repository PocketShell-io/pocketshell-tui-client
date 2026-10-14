/**
 * Daemon pre-warming: keep channels to recently used hosts resident so the
 * first call after login, reboot or a network change is already warm.
 *
 * Usage recording (`daemon-usage.json`, 0600, atomic writes, pruned after a
 * week) happens only on paths a user actually drove — never on pre-warm
 * traffic itself. Windows keeps usage in memory only, like every other
 * non-custodial state file (see hostCapability.ts).
 *
 * Idle exit is untouched: pre-warm traffic never reaches the relay (it runs
 * inside the daemon process), so the relay's idle timer still counts only
 * real client requests and a pre-warmed but unused daemon still exits.
 */
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { listHosts, type HostEntry } from '../hosts/store.js';
import { clientConfigDir } from '../paths.js';
import { mapConcurrent } from './concurrency.js';
import { trace } from '../trace.js';

/** Hosts used this recently are worth keeping warm. */
export const PREWARM_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Usage entries untouched for this long are pruned on the next write. */
const PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/** Writes are throttled to at most one per host per minute. */
const WRITE_THROTTLE_MS = 60_000;
const MAX_HOSTS = 64;

interface UsageFile {
  version: 1;
  hosts: Record<string, number>;
}

function usageFile(): string {
  return join(clientConfigDir(), 'daemon-usage.json');
}

function readUsage(): UsageFile | null {
  if (process.platform === 'win32') return null;
  const path = usageFile();
  let raw: string;
  try {
    const st = lstatSync(path);
    if (!st.isFile()) return null;
    const uid = process.getuid?.();
    if (uid !== undefined && st.uid !== uid) return null;
    if (st.mode & 0o077) return null;
    if (st.size > 1 << 20) return null;
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as UsageFile;
    if (parsed?.version !== 1 || typeof parsed.hosts !== 'object' || parsed.hosts === null) return null;
    const hosts: Record<string, number> = {};
    for (const [name, at] of Object.entries(parsed.hosts)) {
      if (typeof at === 'number' && Number.isFinite(at) && at > 0) hosts[name] = at;
    }
    return { version: 1, hosts };
  } catch {
    return null;
  }
}

function writeUsage(usage: UsageFile): void {
  if (process.platform === 'win32') return;
  const file = usageFile();
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${basename(file)}.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(usage, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

const lastWritten = new Map<string, number>();
const memoryUsage = new Map<string, number>();

/** Record that a user-driven command used `host` (never called for pre-warm traffic). */
export function noteHostUsed(host: HostEntry): void {
  const now = Date.now();
  memoryUsage.set(host.name, now);
  if (process.platform === 'win32') return;
  const since = lastWritten.get(host.name);
  if (since !== undefined && now - since < WRITE_THROTTLE_MS) return;
  const usage = readUsage() ?? { version: 1, hosts: {} };
  const pruned = Object.fromEntries(
    Object.entries(usage.hosts).filter(([, at]) => now - at <= PRUNE_AFTER_MS),
  );
  pruned[host.name] = now;
  usage.hosts = pruned;
  const names = Object.keys(pruned);
  if (names.length > MAX_HOSTS) {
    for (const name of names.sort((a, b) => pruned[b]! - pruned[a]!).slice(MAX_HOSTS)) delete pruned[name];
  }
  try {
    writeUsage(usage);
    lastWritten.set(host.name, now);
  } catch {
    /* unwritable state dir: usage stays in memory */
  }
}

/** Saved hosts used within the pre-warm window, newest first. */
export function recentHosts(windowMs = PREWARM_WINDOW_MS, now = Date.now()): HostEntry[] {
  const usage = readUsage();
  const recorded = usage ? usage.hosts : Object.fromEntries(memoryUsage);
  const names = Object.entries(recorded)
    .filter(([, at]) => now - at <= windowMs)
    .sort(([, a], [, b]) => b - a)
    .map(([name]) => name);
  if (names.length === 0) return [];
  const byName = new Map(listHosts().map((host) => [host.name, host]));
  return names
    .map((name) => byName.get(name))
    .filter((host): host is HostEntry => Boolean(host))
    .filter((host) => host.mode === 'gateway' && !host.nativeWindowsCli && (!host.binary || host.binary === 'pocketshell'));
}

let warming: Promise<void> | undefined;

/** Warm channels for recently used hosts in the background; failures back off via the existing channel machinery. */
export function preWarm(warm: (host: HostEntry) => Promise<unknown>): Promise<void> {
  if (warming) return warming;
  trace('prewarm');
  warming = (async () => {
    try {
      await mapConcurrent(recentHosts(), 2, async (host) => {
        try {
          await warm(host);
        } catch {
          /* offline hosts, policy failures: the negative cache and backoff own the rest */
        }
      });
    } finally {
      warming = undefined;
    }
  })();
  return warming;
}

function networkFingerprint(): string {
  const entries: Array<[string, string[]]> = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    entries.push([name, (addrs ?? []).filter((a) => !a.internal).map((a) => `${a.family}:${a.address}`).sort()]);
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

/**
 * Watch for network changes (address churn after sleep, Wi-Fi → VPN, DHCP
 * renewal) and re-warm on each. The poll is unref'd: it never keeps the
 * daemon alive by itself.
 */
export function watchNetworkChanges(onChange: () => void, intervalMs = 5_000): NodeJS.Timeout {
  let previous = networkFingerprint();
  const timer = setInterval(() => {
    const current = networkFingerprint();
    if (current !== previous) {
      previous = current;
      onChange();
    }
  }, intervalMs);
  timer.unref();
  return timer;
}
