/**
 * Client-side host-key pins for gateway SSH: the ONLY source of host trust.
 * Port of pocketshell/gateway/pins.py — same file, same format, same
 * checks, so a pin made by either client is honoured by both.
 *
 * File: ${XDG_CONFIG_HOME:-~/.config}/pocketshell/gateway_known_hosts
 * (dir 0700, file 0600, atomic writes), one known_hosts line per device:
 *
 *     pocketshell-gateway.<id lower>-<sha256(id)[:12]> <keytype> <base64> <device-id>
 *
 * Legacy three-field lines `pocketshell-gateway.<device-id> <keytype>
 * <base64>` are still read; the next write migrates them. Because OpenSSH
 * would honour ANY known_hosts syntax in this file (markers, wildcards,
 * hashed names), every line is validated strictly on every read.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { gatewayPinsFile } from '../paths.js';
import { DEVICE_ID_RE, EndpointError, HOST_KEY_ALIAS_PREFIX, hostKeyAlias, validateDeviceId } from './endpoint.js';

export const MAX_PIN_FILE_BYTES = 1 << 20;
export const MAX_KEY_BLOB_BYTES = 8192;
export const MIN_RSA_BITS = 2048;

const ECDSA_CURVES: Record<string, [string, number]> = {
  'ecdsa-sha2-nistp256': ['nistp256', 65],
  'ecdsa-sha2-nistp384': ['nistp384', 97],
  'ecdsa-sha2-nistp521': ['nistp521', 133],
};
export const KEY_TYPES = ['ssh-ed25519', ...Object.keys(ECDSA_CURVES), 'ssh-rsa'];
const KEY_TYPE_LABEL: Record<string, string> = {
  'ssh-ed25519': 'ED25519',
  'ecdsa-sha2-nistp256': 'ECDSA',
  'ecdsa-sha2-nistp384': 'ECDSA',
  'ecdsa-sha2-nistp521': 'ECDSA',
  'ssh-rsa': 'RSA',
};
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** A malformed/missing pin or an unsafe pin file. The message is safe to print. */
export class PinError extends Error {
  readonly code: string;
  readonly exitCode = 1;
  constructor(message: string, code = 'PIN_ERROR') {
    super(message);
    this.name = 'PinError';
    this.code = code;
  }
}

export interface HostKey {
  keyType: string;
  blobB64: string;
}

export function keyLine(key: HostKey): string {
  return `${key.keyType} ${key.blobB64}`;
}

export function keyLabel(key: HostKey): string {
  return KEY_TYPE_LABEL[key.keyType] ?? key.keyType;
}

/** OpenSSH `SHA256:` fingerprint (unpadded base64) of a key blob. */
export function fingerprintOfBlob(blob: Uint8Array): string {
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

export function fingerprint(key: HostKey): string {
  return fingerprintOfBlob(Buffer.from(key.blobB64, 'base64'));
}

function sameKey(a: HostKey | undefined, b: HostKey | undefined): boolean {
  return !!a && !!b && a.keyType === b.keyType && a.blobB64 === b.blobB64;
}

// --- SSH wire format --------------------------------------------------------

class Reader {
  private pos = 0;
  constructor(private readonly data: Buffer) {}

  string(): Buffer {
    if (this.data.length - this.pos < 4) throw new PinError('truncated key blob');
    const n = this.data.readUInt32BE(this.pos);
    this.pos += 4;
    if (n > this.data.length - this.pos) throw new PinError('truncated key blob');
    const out = this.data.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  mpintPositive(): bigint {
    const raw = this.string();
    if (raw.length === 0) throw new PinError('malformed RSA key (empty integer)');
    if (raw[0]! & 0x80) throw new PinError('malformed RSA key (negative integer)');
    if (raw.length > 1 && raw[0] === 0 && !(raw[1]! & 0x80)) throw new PinError('malformed RSA key (non-minimal integer)');
    return BigInt(`0x${raw.toString('hex')}`);
  }

  done(): void {
    if (this.pos !== this.data.length) throw new PinError('trailing bytes after the key blob');
  }
}

function bitLength(n: bigint): number {
  return n === 0n ? 0 : n.toString(2).length;
}

function checkBlob(keyType: string, blob: Buffer): void {
  const r = new Reader(blob);
  const innerRaw = r.string();
  if (!/^[\x00-\x7f]*$/.test(innerRaw.toString('latin1'))) throw new PinError('key blob type is not ASCII');
  const inner = innerRaw.toString('ascii');
  if (inner !== keyType) {
    throw new PinError(`key blob is of type ${JSON.stringify(inner).slice(0, 40)}, not the stated ${keyType}`);
  }
  if (keyType === 'ssh-ed25519') {
    if (r.string().length !== 32) throw new PinError('malformed ssh-ed25519 key (public key must be 32 bytes)');
  } else if (keyType in ECDSA_CURVES) {
    const [curve, pointLen] = ECDSA_CURVES[keyType]!;
    if (r.string().toString('latin1') !== curve) throw new PinError(`malformed ${keyType} key (curve is not ${curve})`);
    const point = r.string();
    if (point.length !== pointLen || point[0] !== 0x04) throw new PinError(`malformed ${keyType} key (bad public point)`);
  } else {
    const e = r.mpintPositive();
    const n = r.mpintPositive();
    if (e < 3n || e % 2n === 0n) throw new PinError('malformed ssh-rsa key (bad public exponent)');
    if (bitLength(n) < MIN_RSA_BITS) {
      throw new PinError(`ssh-rsa host key is ${bitLength(n)} bits; at least ${MIN_RSA_BITS} are required`);
    }
  }
  r.done();
}

/**
 * Validate a `<keytype> <base64>` host-key line: exactly two fields
 * separated by one space, printable ASCII only, a supported type, canonical
 * base64 decoding to a well-formed blob of that type, nothing trailing.
 */
export function parseHostKey(text: string): HostKey {
  if (typeof text !== 'string') throw new PinError('host key must be text');
  const stripped = text.replace(/^ +| +$/g, '');
  if (!stripped) throw new PinError('host key line is empty');
  if (!/^[\x20-\x7e]*$/.test(stripped)) {
    throw new PinError(
      "host key line contains a newline, tab, control or non-ASCII character; paste exactly one '<keytype> <base64>' line",
    );
  }
  const fields = stripped.split(' ');
  if (fields.length !== 2 || !fields.every(Boolean)) {
    throw new PinError(
      "host key line must be exactly '<keytype> <base64>' separated by one space (no options, markers, host names or comments)",
    );
  }
  const [keyType, b64] = fields as [string, string];
  if (!KEY_TYPES.includes(keyType)) {
    throw new PinError(`unsupported host key type ${JSON.stringify(keyType).slice(0, 40)}; expected one of ${KEY_TYPES.join(', ')}`);
  }
  if (!B64_RE.test(b64) || b64.length % 4) throw new PinError('host key blob is not valid base64');
  const blob = Buffer.from(b64, 'base64');
  if (blob.toString('base64') !== b64) throw new PinError('host key blob is not canonical base64');
  if (blob.length > MAX_KEY_BLOB_BYTES) throw new PinError('host key blob is too large');
  checkBlob(keyType, blob);
  return { keyType, blobB64: b64 };
}

// --- the pin file -----------------------------------------------------------

export function pinFilePath(): string {
  return gatewayPinsFile();
}

function checkOwnedPrivate(path: string, st: Stats, what: string): void {
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) throw new PinError(`${what} ${path} is not owned by you; refusing to trust it`, 'PIN_FILE_UNSAFE');
  if (st.mode & 0o022) {
    throw new PinError(
      `${what} ${path} is writable by group/others; fix with \`chmod go-w ${path}\` and re-check its contents`,
      'PIN_FILE_UNSAFE',
    );
  }
}

export interface PinEntry {
  deviceId: string;
  key: HostKey;
  /** The known_hosts name actually in the file (current or legacy alias). */
  alias: string;
}

export function isLegacy(entry: PinEntry): boolean {
  return entry.alias !== hostKeyAlias(entry.deviceId);
}

function notAPin(path: string, lineno: number): PinError {
  return new PinError(
    `${path}:${lineno} is not a pocketshell gateway pin; this file must only be edited with \`gateway pin/unpin\``,
    'PIN_FILE_UNSAFE',
  );
}

function parsePinLine(line: string, lineno: number, path: string): PinEntry {
  const fields = line.split(' ');
  if ((fields.length !== 3 && fields.length !== 4) || !fields[0]!.startsWith(HOST_KEY_ALIAS_PREFIX)) throw notAPin(path, lineno);
  const alias = fields[0]!;
  let deviceId: string;
  if (fields.length === 4) {
    deviceId = fields[3]!;
    if (!DEVICE_ID_RE.test(deviceId)) throw new PinError(`${path}:${lineno} has an invalid device id`, 'PIN_FILE_UNSAFE');
    if (alias !== hostKeyAlias(deviceId)) throw notAPin(path, lineno);
  } else {
    deviceId = alias.slice(HOST_KEY_ALIAS_PREFIX.length);
    if (!DEVICE_ID_RE.test(deviceId)) throw new PinError(`${path}:${lineno} has an invalid device id`, 'PIN_FILE_UNSAFE');
  }
  let key: HostKey;
  try {
    key = parseHostKey(`${fields[1]} ${fields[2]}`);
  } catch (error) {
    throw new PinError(`${path}:${lineno}: ${(error as Error).message}`, 'PIN_FILE_UNSAFE');
  }
  return { deviceId, key, alias };
}

function caseCollision(deviceId: string, existing: Iterable<string>): string | null {
  const folded = deviceId.toLowerCase();
  for (const other of existing) if (other !== deviceId && other.toLowerCase() === folded) return other;
  return null;
}

function readAll(fd: number, max: number): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const buf = Buffer.alloc(Math.min(65536, max + 1 - total));
    if (buf.length === 0) break;
    const n = readSync(fd, buf, 0, buf.length, null);
    if (n === 0) break;
    chunks.push(buf.subarray(0, n));
    total += n;
  }
  return Buffer.concat(chunks);
}

/** Read and strictly validate the whole pin file. Missing file → no pins. */
export function loadPinEntries(path = pinFilePath()): Map<string, PinEntry> {
  const dir = dirname(path);
  let dfd: number;
  try {
    dfd = openSync(dir, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw new PinError(`cannot open pin directory ${dir}: ${(error as NodeJS.ErrnoException).code ?? 'error'}`, 'PIN_FILE_UNSAFE');
  }
  try {
    checkOwnedPrivate(dir, fstatSync(dfd), 'pin directory');
  } finally {
    closeSync(dfd);
  }
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return new Map();
    if (code === 'ELOOP') throw new PinError(`pin file ${path} is a symlink; refusing to trust it`, 'PIN_FILE_UNSAFE');
    throw new PinError(`cannot open pin file ${path}: ${code ?? 'error'}`, 'PIN_FILE_UNSAFE');
  }
  let data: Buffer;
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new PinError(`pin file ${path} is not a regular file`, 'PIN_FILE_UNSAFE');
    checkOwnedPrivate(path, st, 'pin file');
    data = readAll(fd, MAX_PIN_FILE_BYTES);
  } finally {
    closeSync(fd);
  }
  if (data.length > MAX_PIN_FILE_BYTES) throw new PinError(`pin file ${path} is too large`, 'PIN_FILE_UNSAFE');
  if (!/^[\x00-\x7f]*$/.test(data.toString('latin1'))) throw new PinError(`pin file ${path} contains non-ASCII bytes`, 'PIN_FILE_UNSAFE');
  const text = data.toString('ascii');
  if (text && !text.endsWith('\n')) throw new PinError(`pin file ${path} is truncated (no final newline)`, 'PIN_FILE_UNSAFE');
  const entries = new Map<string, PinEntry>();
  text
    .split('\n')
    .slice(0, -1)
    .forEach((line, index) => {
      const lineno = index + 1;
      const entry = parsePinLine(line, lineno, path);
      if (entries.has(entry.deviceId)) throw new PinError(`${path}:${lineno} pins device ${entry.deviceId} twice`, 'PIN_FILE_UNSAFE');
      const other = caseCollision(entry.deviceId, entries.keys());
      if (other !== null) {
        throw new PinError(
          `${path}:${lineno} pins device ${entry.deviceId}, which differs from pinned device ${other} only in letter case; ` +
            'OpenSSH would not tell them apart. Remove one with `gateway unpin`.',
          'PIN_FILE_UNSAFE',
        );
      }
      entries.set(entry.deviceId, entry);
    });
  return entries;
}

export function loadPins(path = pinFilePath()): Map<string, HostKey> {
  return new Map([...loadPinEntries(path)].map(([id, entry]) => [id, entry.key]));
}

function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory()) throw new PinError(`${dir} is not a directory`, 'PIN_FILE_UNSAFE');
  checkOwnedPrivate(dir, st, 'config directory');
}

function writePins(pins: Map<string, HostKey>, path: string): void {
  const dir = dirname(path);
  ensurePrivateDir(dir);
  const body = Buffer.from(
    [...pins.keys()]
      .sort()
      .map((id) => `${hostKeyAlias(id)} ${keyLine(pins.get(id)!)} ${id}\n`)
      .join(''),
    'ascii',
  );
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const fd = openSync(tmp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    try {
      let off = 0;
      while (off < body.length) off += writeSync(fd, body, off);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* already gone */
    }
    throw error;
  }
  const dfd = openSync(dir, fsConstants.O_RDONLY);
  try {
    fsyncSync(dfd);
  } finally {
    closeSync(dfd);
  }
}

function checkedDeviceId(deviceId: string): string {
  try {
    return validateDeviceId(deviceId);
  } catch (error) {
    if (error instanceof EndpointError) throw new PinError(error.message, 'USAGE');
    throw error;
  }
}

/**
 * Pin `key` for `deviceId`. Returns false if it was already pinned. A
 * different key already pinned is refused unless `replace`.
 */
export function addPin(deviceId: string, key: HostKey, options: { replace?: boolean; path?: string } = {}): boolean {
  checkedDeviceId(deviceId);
  const path = options.path ?? pinFilePath();
  const entries = loadPinEntries(path);
  const pins = new Map([...entries].map(([id, entry]) => [id, entry.key]));
  const other = caseCollision(deviceId, pins.keys());
  if (other !== null) {
    throw new PinError(
      `device ${deviceId} differs from the already pinned device ${other} only in letter case; OpenSSH would not tell ` +
        `them apart. Unpin ${other} first if it is really the same host.`,
    );
  }
  const current = pins.get(deviceId);
  if (sameKey(current, key)) {
    if ([...entries.values()].some(isLegacy)) writePins(pins, path); // migrate legacy lines
    return false;
  }
  if (current && !options.replace) {
    throw new PinError(
      `device ${deviceId} already has a different pinned host key (${fingerprint(current)}). If the host was really ` +
        're-keyed, verify the new key on the host and re-run with --replace.',
      'PIN_MISMATCH',
    );
  }
  pins.set(deviceId, key);
  writePins(pins, path);
  return true;
}

/** Remove and return the pin for `deviceId`; throws if there is none. */
export function removePin(deviceId: string, options: { path?: string } = {}): HostKey {
  checkedDeviceId(deviceId);
  const path = options.path ?? pinFilePath();
  const pins = loadPins(path);
  const key = pins.get(deviceId);
  if (!key) throw new PinError(`no host key is pinned for device ${deviceId}`, 'NOT_PINNED');
  pins.delete(deviceId);
  writePins(pins, path);
  return key;
}

/** The pin for `deviceId` with the alias actually in the file. */
export function requirePinEntry(deviceId: string, options: { path?: string } = {}): PinEntry {
  const entry = loadPinEntries(options.path ?? pinFilePath()).get(deviceId);
  if (!entry) {
    throw new PinError(
      `no host key is pinned for gateway device ${deviceId}. On the host, run \`pocketshell gateway show --host-key\`, ` +
        `then here run \`pocketshell-client gateway pin ${deviceId}\` and paste that one key line. ` +
        "The gateway's advertised key is never trusted.",
      'NOT_PINNED',
    );
  }
  return entry;
}
