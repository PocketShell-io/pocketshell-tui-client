/** Generation fingerprints are private in-memory values, never diagnostics. */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { requireLogin } from '../account/index.js';
import { resolveEndpoint } from '../gateway/endpoint.js';
import { loadPinEntries, pinFilePath } from '../gateway/pins.js';
import { hostsFile } from '../paths.js';
import type { HostEntry } from '../hosts/store.js';
export interface Policy {
  generation: string;
  accountExpires: number;
}
function fileGeneration(path: string, privateFile: boolean, optional = false): unknown {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw Error('unsafe or missing policy file');
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== process.geteuid?.() || st.mode & (privateFile ? 0o077 : 0o022))
      throw Error('unsafe policy file');
    let digest: string | null = null;
    if (privateFile) {
      if (st.size > 128 * 1024) throw Error('identity file bounds');
      const bytes = Buffer.alloc(st.size);
      let n = 0;
      while (n < bytes.length) {
        const count = readSync(fd, bytes, n, bytes.length - n, n);
        if (!count) throw Error('identity file changed while reading');
        n += count;
      }
      digest = createHash('sha256').update(bytes).digest('hex');
      bytes.fill(0);
    }
    return [path, st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs, st.mode, digest];
  } finally {
    closeSync(fd);
  }
}
export function gatewayPolicy(host: HostEntry): Policy {
  const config = host.gateway;
  if (!config || host.nativeWindowsCli) throw Error('unsupported persistent host policy');
  const credentials = requireLogin(); // Existing safe read, expiry, and broker binding checks.
  const pins = loadPinEntries();
  const pin = pins.get(config.deviceId);
  if (!pin) throw Error('host is not pinned');
  const endpoint = resolveEndpoint(config.server, config.server?.startsWith('ws://') ?? false);
  const identityPaths = config.identityFile
    ? [
        resolve(
          config.identityFile.startsWith('~/')
            ? join(homedir(), config.identityFile.slice(2))
            : config.identityFile,
        ),
      ]
    : ['id_ed25519', 'id_ecdsa', 'id_rsa', 'id_dsa', 'id_ecdsa_sk', 'id_ed25519_sk', 'id_xmss'].map((n) =>
        join(homedir(), '.ssh', n),
      );
  // Identity content hashes remain private in memory; key bytes are never logged or sent over IPC.
  for (const path of identityPaths) {
    const parent = resolve(path, '..');
    try {
      const st = lstatSync(parent);
      if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.geteuid?.() || st.mode & 0o022)
        throw Error('unsafe identity directory');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const identities = identityPaths.map((path) => fileGeneration(path, true, !config.identityFile));
  const generation = createHash('sha256')
    .update(
      JSON.stringify({
        policy: 1,
        host,
        endpoint: endpoint.wsBase,
        account: credentials,
        config: fileGeneration(hostsFile(), false, true),
        pinFile: pinFilePath(),
        pins: [...pins],
        identities,
        helper: process.env.PSC_RPC_BINARY ?? 'a',
      }),
    )
    .digest('hex');
  return { generation, accountExpires: credentials.expiresAt * 1000 };
}
