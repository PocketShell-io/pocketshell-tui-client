/**
 * An SSH private key held only in this process: parse the PEM the vault
 * decrypted (OpenSSH `openssh-key-v1`, or PKCS#1 / PKCS#8 / SEC1 PEM) into a
 * non-exportable-by-us KeyObject plus its SSH public blob, and sign the way
 * an ssh-agent does. Supported: ssh-ed25519, ssh-rsa (rsa-sha2-256/512),
 * ecdsa-sha2-nistp256/384/521.
 */
import { createPrivateKey, createPublicKey, sign, type JsonWebKey, type KeyObject } from 'node:crypto';
import { VaultError } from './format.js';

export interface SshKey {
  type: string;
  /** The SSH wire public key blob. */
  publicBlob: Buffer;
  comment: string;
  sign(data: Buffer, flags: number): Buffer;
}

const AGENT_RSA_SHA2_256 = 2;
const AGENT_RSA_SHA2_512 = 4;

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
}

export function sshString(value: Buffer | string): Buffer {
  const b = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  return Buffer.concat([u32(b.length), b]);
}

/** SSH mpint from unsigned big-endian bytes. */
function mpint(unsigned: Buffer): Buffer {
  let i = 0;
  while (i < unsigned.length - 1 && unsigned[i] === 0) i++;
  let b = unsigned.subarray(i);
  if (b.length > 0 && (b[0]! & 0x80) !== 0) b = Buffer.concat([Buffer.from([0]), b]);
  if (b.length === 1 && b[0] === 0) b = Buffer.alloc(0);
  return sshString(b);
}

export class Reader {
  private offset = 0;
  constructor(private readonly buf: Buffer) {}
  u32(): number {
    if (this.offset + 4 > this.buf.length) throw bad('truncated');
    const v = this.buf.readUInt32BE(this.offset);
    this.offset += 4;
    return v;
  }
  bytes(): Buffer {
    const n = this.u32();
    if (this.offset + n > this.buf.length) throw bad('truncated');
    const v = this.buf.subarray(this.offset, this.offset + n);
    this.offset += n;
    return v;
  }
  string(): string {
    return this.bytes().toString('utf8');
  }
  get done(): boolean {
    return this.offset >= this.buf.length;
  }
}

function bad(what: string): VaultError {
  return new VaultError(`The vault key is not a usable SSH private key (${what}).`, 'VAULT_KEY_UNSUPPORTED', 1);
}

const b64u = (b: Buffer): string => b.toString('base64url');
const unpad = (b: Buffer): Buffer => {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  return b.subarray(i);
};
const big = (b: Buffer): bigint => BigInt(`0x${unpad(b).toString('hex') || '0'}`);
const fromBig = (n: bigint): Buffer => {
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  return Buffer.from(hex, 'hex');
};
const leftPad = (b: Buffer, len: number): Buffer => (b.length >= len ? b.subarray(b.length - len) : Buffer.concat([Buffer.alloc(len - b.length), b]));

const CURVES: Record<string, { jwk: string; size: number; hash: string }> = {
  nistp256: { jwk: 'P-256', size: 32, hash: 'sha256' },
  nistp384: { jwk: 'P-384', size: 48, hash: 'sha384' },
  nistp521: { jwk: 'P-521', size: 66, hash: 'sha512' },
};
const JWK_CURVES: Record<string, string> = { 'P-256': 'nistp256', 'P-384': 'nistp384', 'P-521': 'nistp521' };

function fromKeyObject(key: KeyObject, comment: string): SshKey {
  const jwk = createPublicKey(key).export({ format: 'jwk' }) as JsonWebKey;
  if (jwk.kty === 'OKP' && jwk.crv === 'Ed25519' && jwk.x) {
    const blob = Buffer.concat([sshString('ssh-ed25519'), sshString(Buffer.from(jwk.x, 'base64url'))]);
    return {
      type: 'ssh-ed25519',
      publicBlob: blob,
      comment,
      sign: (data) => Buffer.concat([sshString('ssh-ed25519'), sshString(sign(null, data, key))]),
    };
  }
  if (jwk.kty === 'RSA' && jwk.n && jwk.e) {
    const blob = Buffer.concat([sshString('ssh-rsa'), mpint(Buffer.from(jwk.e, 'base64url')), mpint(Buffer.from(jwk.n, 'base64url'))]);
    return {
      type: 'ssh-rsa',
      publicBlob: blob,
      comment,
      sign: (data, flags) => {
        const [alg, hash] =
          flags & AGENT_RSA_SHA2_512 ? ['rsa-sha2-512', 'sha512'] : flags & AGENT_RSA_SHA2_256 ? ['rsa-sha2-256', 'sha256'] : ['ssh-rsa', 'sha1'];
        return Buffer.concat([sshString(alg!), sshString(sign(hash!, data, key))]);
      },
    };
  }
  if (jwk.kty === 'EC' && jwk.crv && jwk.x && jwk.y && JWK_CURVES[jwk.crv]) {
    const name = JWK_CURVES[jwk.crv]!;
    const curve = CURVES[name]!;
    const q = Buffer.concat([Buffer.from([4]), leftPad(Buffer.from(jwk.x, 'base64url'), curve.size), leftPad(Buffer.from(jwk.y, 'base64url'), curve.size)]);
    const type = `ecdsa-sha2-${name}`;
    const blob = Buffer.concat([sshString(type), sshString(name), sshString(q)]);
    return {
      type,
      publicBlob: blob,
      comment,
      sign: (data) => {
        const raw = sign(curve.hash, data, { key, dsaEncoding: 'ieee-p1363' });
        const r = raw.subarray(0, raw.length / 2);
        const s = raw.subarray(raw.length / 2);
        return Buffer.concat([sshString(type), sshString(Buffer.concat([mpint(r), mpint(s)]))]);
      },
    };
  }
  throw bad('unsupported key type');
}

function parseOpenSsh(pem: string): SshKey {
  const body = pem
    .replace(/-----BEGIN OPENSSH PRIVATE KEY-----/, '')
    .replace(/-----END OPENSSH PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const raw = Buffer.from(body, 'base64');
  const magic = Buffer.from('openssh-key-v1\0', 'latin1');
  if (raw.length < magic.length || !raw.subarray(0, magic.length).equals(magic)) throw bad('not openssh-key-v1');
  const r = new Reader(raw.subarray(magic.length));
  const cipher = r.string();
  if (cipher !== 'none') throw bad('the key is still encrypted with its own passphrase; re-upload it on the web');
  r.string(); // kdfname
  r.bytes(); // kdfoptions
  const count = r.u32();
  if (count !== 1) throw bad('expected exactly one key');
  r.bytes(); // public key
  const priv = new Reader(r.bytes());
  if (priv.u32() !== priv.u32()) throw bad('corrupt private section');
  const type = priv.string();
  let jwk: JsonWebKey;
  if (type === 'ssh-ed25519') {
    const pub = priv.bytes();
    const sk = priv.bytes();
    if (pub.length !== 32 || sk.length !== 64) throw bad('ed25519 sizes');
    jwk = { kty: 'OKP', crv: 'Ed25519', x: b64u(pub), d: b64u(sk.subarray(0, 32)) };
  } else if (type === 'ssh-rsa') {
    const n = priv.bytes();
    const e = priv.bytes();
    const d = priv.bytes();
    const iqmp = priv.bytes();
    const p = priv.bytes();
    const q = priv.bytes();
    const dBig = big(d);
    jwk = {
      kty: 'RSA',
      n: b64u(unpad(n)),
      e: b64u(unpad(e)),
      d: b64u(unpad(d)),
      p: b64u(unpad(p)),
      q: b64u(unpad(q)),
      dp: b64u(fromBig(dBig % (big(p) - 1n))),
      dq: b64u(fromBig(dBig % (big(q) - 1n))),
      qi: b64u(unpad(iqmp)),
    };
  } else if (type.startsWith('ecdsa-sha2-')) {
    const name = priv.string();
    const curve = CURVES[name];
    if (!curve || type !== `ecdsa-sha2-${name}`) throw bad('unsupported curve');
    const point = priv.bytes();
    const d = priv.bytes();
    if (point.length !== 1 + 2 * curve.size || point[0] !== 4) throw bad('ecdsa point');
    jwk = {
      kty: 'EC',
      crv: curve.jwk,
      x: b64u(point.subarray(1, 1 + curve.size)),
      y: b64u(point.subarray(1 + curve.size)),
      d: b64u(leftPad(unpad(d), curve.size)),
    };
  } else {
    throw bad(`unsupported key type ${type.slice(0, 40)}`);
  }
  const comment = priv.string();
  try {
    return fromKeyObject(createPrivateKey({ key: jwk, format: 'jwk' }), comment);
  } catch (error) {
    if (error instanceof VaultError) throw error;
    throw bad('key material rejected');
  }
}

/** Parse a decrypted private key PEM. Never includes key bytes in errors. */
export function parsePrivateKey(pem: string): SshKey {
  if (pem.includes('-----BEGIN OPENSSH PRIVATE KEY-----')) return parseOpenSsh(pem);
  if (/-----BEGIN (ENCRYPTED PRIVATE KEY|.* PRIVATE KEY-----\s*Proc-Type: 4,ENCRYPTED)/.test(pem)) {
    throw bad('the key is still encrypted with its own passphrase; re-upload it on the web');
  }
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: pem, format: 'pem' });
  } catch {
    throw bad('unreadable PEM');
  }
  return fromKeyObject(key, '');
}

/** `type base64` authorized_keys line for the public blob. */
export function publicKeyLine(key: SshKey): string {
  return `${key.type} ${key.publicBlob.toString('base64')}${key.comment ? ` ${key.comment.replace(/[\r\n]/g, ' ')}` : ''}`;
}
