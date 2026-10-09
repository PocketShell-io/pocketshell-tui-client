/**
 * The on-disk CLI session, SHARED with the Python `pocketshell` CLI:
 * `${XDG_CONFIG_HOME:-~/.config}/pocketshell/credentials.json` (port of
 * `credentials.py`; same format, same write and read discipline).
 *
 * Write: directory created 0700 (an existing one we own is tightened to
 * 0700); JSON written to a fresh temp name opened O_CREAT|O_EXCL|O_NOFOLLOW
 * mode 0600, fsynced, renamed over the final name; directory fsynced.
 *
 * Read: the directory must be ours and not group/other-writable; the file is
 * opened O_NOFOLLOW (a symlink is refused) and must be a regular file we own
 * with no group/other bits. Anything else is CredentialsUnsafe (a
 * NotLoggedIn) whose message never echoes the file's contents.
 *
 * Node has no `openat`, so (unlike Python) paths are re-resolved per
 * operation rather than relative to a directory fd.
 */
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
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
import { dirname, join } from 'node:path';
import { credentialsFile, sharedConfigDir } from '../paths.js';
import { SESSION_TOKEN_RE } from './broker.js';
import { AccountError, CredentialsUnsafe, LOGIN_HINT, NotLoggedIn } from './errors.js';
import { isObject, loadsStrict } from './json.js';

export const FILE_NAME = 'credentials.json';
export const FORMAT_VERSION = 1;
const MAX_FILE_BYTES = 16 * 1024;

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_DIRECTORY = constants.O_DIRECTORY ?? 0;
const O_NONBLOCK = constants.O_NONBLOCK ?? 0;

/** A stored CLI session. `accessToken` is a 30-day bearer secret: never print it. */
export interface Credentials {
  brokerUrl: string;
  accessToken: string;
  tokenId: string;
  email: string;
  /** Unix seconds. */
  expiresAt: number;
  label: string;
}

export function isExpired(creds: Credentials, now = Date.now() / 1000): boolean {
  return creds.expiresAt <= now;
}

const euid = (): number => process.geteuid?.() ?? -1;
const mode = (st: Stats): string => `0o${(st.mode & 0o7777).toString(8)}`;
const errno = (error: unknown): string => String((error as NodeJS.ErrnoException)?.code ?? 'error');

function notLoggedIn(): NotLoggedIn {
  return new NotLoggedIn(`Not logged in; ${LOGIN_HINT}.`);
}

function checkDirForRead(directory: string): void {
  let dfd: number;
  try {
    dfd = openSync(directory, constants.O_RDONLY | O_DIRECTORY);
  } catch (error) {
    const code = errno(error);
    if (code === 'ENOENT') throw notLoggedIn();
    if (code === 'ENOTDIR') {
      throw new CredentialsUnsafe(
        `${directory} is not a directory; refusing to read credentials. Remove it and ${LOGIN_HINT}.`,
      );
    }
    throw new NotLoggedIn(`Cannot open ${directory} (${code}); ${LOGIN_HINT}.`);
  }
  try {
    const st = fstatSync(dfd);
    if (st.uid !== euid() || st.mode & 0o022) {
      try {
        lstatSync(join(directory, FILE_NAME));
      } catch (error) {
        // A lax shared dir with no credentials in it is just "not logged in".
        if (errno(error) === 'ENOENT') throw notLoggedIn();
      }
      throw new CredentialsUnsafe(
        `${directory} is not owned by you or is writable by others (mode ${mode(st)}); refusing to ` +
          `read credentials. Fix it with \`chmod 700 ${directory}\` and ${LOGIN_HINT}.`,
      );
    }
  } finally {
    closeSync(dfd);
  }
}

/**
 * The stored session (possibly expired), or throw NotLoggedIn /
 * CredentialsUnsafe. `allowSharedMode` is for logout only: a file we own
 * whose mode leaked it still holds OUR token, and revoking it is what should
 * happen next. Symlinks and foreign-owned files are refused regardless.
 */
export function load(options: { allowSharedMode?: boolean } = {}): Credentials {
  const directory = sharedConfigDir();
  const path = credentialsFile();
  checkDirForRead(directory);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (error) {
    const code = errno(error);
    if (code === 'ENOENT') throw notLoggedIn();
    if (code === 'ELOOP' || code === 'EMLINK') {
      throw new CredentialsUnsafe(`${path} is a symlink; refusing to read it. Remove it and ${LOGIN_HINT}.`);
    }
    throw new NotLoggedIn(`Cannot open ${path} (${code}); ${LOGIN_HINT}.`);
  }
  let raw: Uint8Array;
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) {
      throw new CredentialsUnsafe(`${path} is not a regular file; refusing to read it. Remove it and ${LOGIN_HINT}.`);
    }
    if (st.uid !== euid()) {
      throw new CredentialsUnsafe(`${path} is not owned by you; refusing to read it. Remove it and ${LOGIN_HINT}.`);
    }
    if (st.mode & 0o077 && !options.allowSharedMode) {
      throw new CredentialsUnsafe(
        `${path} is accessible by other users (mode ${mode(st)}); refusing to use it. Treat the session ` +
          'as leaked: run `pocketshell-client logout` to revoke it, then `pocketshell-client login`.',
      );
    }
    if (st.size > MAX_FILE_BYTES) throw new NotLoggedIn(`${path} is too large to be a credentials file; ${LOGIN_HINT}.`);
    const buf = Buffer.alloc(MAX_FILE_BYTES + 1);
    let total = 0;
    for (;;) {
      const n = readSync(fd, buf, total, buf.length - total, null);
      if (n === 0) break;
      total += n;
      if (total >= buf.length) break;
    }
    raw = buf.subarray(0, total);
  } finally {
    closeSync(fd);
  }
  return parse(raw, path);
}

function parse(raw: Uint8Array, path: string): Credentials {
  const bad = new NotLoggedIn(`${path} is corrupt or from an unsupported version; ${LOGIN_HINT}.`);
  let data: unknown;
  try {
    data = loadsStrict(raw);
  } catch {
    throw bad;
  }
  if (!isObject(data) || data.version !== FORMAT_VERSION) throw bad;
  const strings = ['broker_url', 'access_token', 'token_id', 'email', 'label'] as const;
  if (!strings.every((key) => typeof data[key] === 'string')) throw bad;
  const expiresAt = data.expires_at;
  if (typeof expiresAt !== 'number' || !Number.isInteger(expiresAt)) throw bad;
  const accessToken = data.access_token as string;
  if (!SESSION_TOKEN_RE.test(accessToken)) throw bad;
  return {
    brokerUrl: data.broker_url as string,
    accessToken,
    tokenId: data.token_id as string,
    email: data.email as string,
    expiresAt,
    label: data.label as string,
  };
}

/** The stored session if present, safe and unexpired; else throw NotLoggedIn. */
export function requireSession(): Credentials {
  const creds = load();
  if (isExpired(creds)) throw new NotLoggedIn(`Your PocketShell login has expired; ${LOGIN_HINT}.`);
  return creds;
}

/** The file body, byte-compatible with Python's `json.dumps(indent=2, sort_keys=True)` + "\n". */
export function serialize(creds: Credentials): string {
  const doc: Record<string, unknown> = {
    access_token: creds.accessToken,
    broker_url: creds.brokerUrl,
    email: creds.email,
    expires_at: creds.expiresAt,
    label: creds.label,
    token_id: creds.tokenId,
    version: FORMAT_VERSION,
  };
  // ensure_ascii, like Python's default.
  const text = JSON.stringify(doc, null, 2).replace(
    /[\u0080-\uffff]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  return `${text}\n`;
}

function openDirForWrite(directory: string): number {
  let dfd: number;
  try {
    mkdirSync(dirname(directory), { recursive: true });
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if (errno(error) !== 'EEXIST') throw error;
    }
    dfd = openSync(directory, constants.O_RDONLY | O_DIRECTORY);
  } catch (error) {
    throw new AccountError(`Cannot create ${directory} (${errno(error)}); credentials not saved.`);
  }
  const st = fstatSync(dfd);
  if (st.uid !== euid()) {
    closeSync(dfd);
    throw new AccountError(`${directory} is not owned by you; refusing to store credentials there.`);
  }
  if ((st.mode & 0o7777) !== 0o700) fchmodSync(dfd, 0o700);
  return dfd;
}

/** Atomically write `creds` as a 0600 file in a 0700 directory. Returns the path. */
export function save(creds: Credentials): string {
  if (!SESSION_TOKEN_RE.test(creds.accessToken)) throw new AccountError('refusing to store a malformed session token');
  const directory = sharedConfigDir();
  const path = credentialsFile();
  const payload = Buffer.from(serialize(creds), 'utf8');
  const dfd = openDirForWrite(directory);
  let tmp: string | null = join(directory, `.${FILE_NAME}.${randomBytes(8).toString('hex')}.tmp`);
  try {
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600);
    try {
      fchmodSync(fd, 0o600); // exact mode regardless of umask
      let offset = 0;
      while (offset < payload.length) offset += writeSync(fd, payload, offset);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    tmp = null;
    fsyncSync(dfd);
  } catch (error) {
    throw new AccountError(`Could not write ${path} (${errno(error)}).`);
  } finally {
    if (tmp !== null) {
      try {
        unlinkSync(tmp);
      } catch {
        // already gone
      }
    }
    closeSync(dfd);
  }
  return path;
}

/** Whether anything (file, symlink, ...) sits at the credentials path. */
export function exists(): boolean {
  try {
    lstatSync(credentialsFile());
    return true;
  } catch {
    return false;
  }
}

/** Remove the credentials entry (unlink never follows a symlink). True if removed. */
export function remove(): boolean {
  const path = credentialsFile();
  try {
    unlinkSync(path);
  } catch (error) {
    const code = errno(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw new AccountError(`Could not remove ${path} (${code}).`);
  }
  try {
    const dfd = openSync(sharedConfigDir(), constants.O_RDONLY | O_DIRECTORY);
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    // best effort
  }
  return true;
}
