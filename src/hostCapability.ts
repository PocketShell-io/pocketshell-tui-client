/**
 * Per-host session-backend capability cache, persisted on disk.
 *
 * Which backend serves a host's sessions — the `pocketshell` wrapper or a
 * direct `a` — costs a probe round trip to learn, so the verdict is cached
 * per host (key: host name + host-key fingerprint) for 24 h instead of once
 * per process. On any failure that suggests the backend changed, the entry
 * is dropped (see hostClient.ts) and the next call re-probes.
 *
 * File: `${clientConfigDir}/backend-cache.json` (dir 0700, file 0600,
 * atomic writes). The stored `direct` path is validated like a hosts.json
 * `--binary` before it is ever spliced into a host command line. Windows
 * keeps the cache in memory only: the reviewed native custody kinds are a
 * fixed set (credentials, pins, hosts) and this file must not invent one.
 */
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { HostEntry } from './hosts/store.js';
import { clientConfigDir } from './paths.js';
import { fingerprint, loadPins } from './gateway/pins.js';

/** How long a cached backend verdict is trusted without re-probing. */
export const CAPABILITY_TTL_MS = 24 * 60 * 60 * 1000;
/** Entries untouched for this long are pruned on the next write. */
const PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CACHE_BYTES = 1 << 20;
const MAX_HOSTS = 64;

export interface BackendCapability {
  /** The `pocketshell` wrapper answered a schema-valid, error-free listing. */
  wrapper: boolean;
  /** A validated `a` executable path (or the bare word `a`), null when absent. */
  direct: string | null;
  /** The resident helper negotiated `a rpc` (learned via the daemon path). */
  rpc: boolean | null;
  /** The wrapper binary this verdict was measured for. */
  binary: string;
  checkedAt: number;
}

interface CacheFile {
  version: 1;
  hosts: Record<string, BackendCapability>;
}

function cacheFile(): string {
  return join(clientConfigDir(), 'backend-cache.json');
}

/**
 * The trust key for a host's cached backend: its name plus the fingerprint
 * of the host key the connection is pinned to (gateway pins), so a re-keyed
 * or re-enrolled device never inherits a stale verdict. SSH and local hosts
 * have no psc-side pin; their stable target identity stands in.
 */
export function capabilityKey(host: HostEntry): string {
  let fingerprintId = 'local';
  if (host.mode === 'gateway' && host.gateway) {
    try {
      const key = loadPins().get(host.gateway.deviceId);
      fingerprintId = key ? fingerprint(key) : 'unpinned';
    } catch {
      fingerprintId = 'unpinned';
    }
  } else if (host.mode === 'ssh' && host.ssh) {
    fingerprintId = `ssh-${createHash('sha256')
      .update(JSON.stringify([host.ssh.destination, host.ssh.user ?? null, host.ssh.port ?? null]))
      .digest('hex')}`;
  }
  return `${host.name}\n${fingerprintId}`;
}

function readCache(): CacheFile | null {
  const path = cacheFile();
  let raw: string;
  try {
    const st = lstatSync(path);
    if (!st.isFile()) return null;
    const uid = process.getuid?.();
    if (uid !== undefined && st.uid !== uid) return null;
    if (st.mode & 0o077) return null;
    if (st.size > MAX_CACHE_BYTES) return null;
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as CacheFile;
    if (parsed?.version !== 1 || typeof parsed.hosts !== 'object' || parsed.hosts === null) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(cache: CacheFile): void {
  const file = cacheFile();
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${basename(file)}.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

function validated(entry: unknown): BackendCapability | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Partial<BackendCapability>;
  if (typeof e.wrapper !== 'boolean' || typeof e.binary !== 'string' || !Number.isFinite(e.checkedAt)) return null;
  if (e.direct !== null && e.direct !== undefined) {
    // The stored word is only ever spliced into host commands single-quoted,
    // so control characters (word-splitting) are what disqualify it.
    if (typeof e.direct !== 'string' || e.direct === '' || e.direct.length > 4096 || /[\r\n\0]/.test(e.direct)) {
      return null;
    }
  }
  if (e.rpc !== null && typeof e.rpc !== 'boolean') return null;
  return {
    wrapper: e.wrapper,
    direct: e.direct ?? null,
    rpc: e.rpc ?? null,
    binary: e.binary,
    checkedAt: e.checkedAt as number,
  };
}

/** The host's cached backend, or null when absent, stale, or unsafe to trust. */
export function loadBackendCapability(host: HostEntry): BackendCapability | null {
  if (process.platform === 'win32') return null;
  const entry = readCache()?.hosts[capabilityKey(host)];
  if (!entry) return null;
  const capability = validated(entry);
  if (!capability || Date.now() - capability.checkedAt > CAPABILITY_TTL_MS) return null;
  if (capability.binary !== (host.binary ?? 'pocketshell')) return null;
  if (!capability.wrapper && capability.direct === null) return null;
  return capability;
}

function updateCapability(
  host: HostEntry,
  mutate: (current: BackendCapability) => Omit<BackendCapability, 'binary' | 'checkedAt'>,
): void {
  if (process.platform === 'win32') return;
  const key = capabilityKey(host);
  const cache = readCache() ?? { version: 1, hosts: {} };
  const now = Date.now();
  const hosts = Object.fromEntries(
    Object.entries(cache.hosts).filter(([, entry]) => {
      const valid = validated(entry);
      return valid !== null && now - valid.checkedAt <= PRUNE_AFTER_MS;
    }),
  ) as Record<string, BackendCapability>;
  const current = hosts[key] ?? {
    wrapper: false,
    direct: null,
    rpc: null,
    binary: host.binary ?? 'pocketshell',
    checkedAt: now,
  };
  hosts[key] = { ...mutate(current), checkedAt: now, binary: host.binary ?? 'pocketshell' };
  const keys = Object.keys(hosts);
  if (keys.length > MAX_HOSTS) {
    for (const k of keys.sort((a, b) => hosts[b]!.checkedAt - hosts[a]!.checkedAt).slice(MAX_HOSTS)) delete hosts[k];
  }
  writeCache({ version: 1, hosts });
}

/** Record a freshly probed backend verdict (a prior `rpc` verdict survives while `a` does). */
export function storeBackendCapability(
  host: HostEntry,
  capability: Omit<BackendCapability, 'binary' | 'checkedAt'>,
): void {
  updateCapability(host, (current) => ({
    ...capability,
    rpc: capability.direct === null ? null : current.rpc ?? null,
  }));
}

/** Drop the host's cached backend (it may have changed under us). */
export function forgetBackendCapability(host: HostEntry): void {
  if (process.platform === 'win32') return;
  const key = capabilityKey(host);
  const cache = readCache();
  if (!cache || !(key in cache.hosts)) return;
  delete cache.hosts[key];
  writeCache(cache);
}

/**
 * Record what the daemon path learned about the resident helper: a
 * successful negotiation proves `a` (as resolved under the user-bin PATH the
 * classic path uses too), an RPC_UNSUPPORTED refusal proves the opposite.
 * Called on every daemon-served request, so a verdict that is already fresh
 * on disk is not rewritten.
 */
export function noteResidentCapability(host: HostEntry, rpc: boolean): void {
  if (process.platform === 'win32') return;
  const key = capabilityKey(host);
  const existing = validated(readCache()?.hosts[key]);
  if (existing && existing.rpc === rpc && Date.now() - existing.checkedAt <= CAPABILITY_TTL_MS) return;
  // A refusal only downgrades what is already known; it never creates an
  // empty verdict (the probe chain owns discovery).
  if (!rpc && !existing) return;
  updateCapability(host, (current) =>
    rpc
      ? { ...current, rpc: true, direct: current.direct ?? 'a', wrapper: current.wrapper }
      : { ...current, rpc: false },
  );
}
