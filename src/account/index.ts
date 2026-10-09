/**
 * The PocketShell account API (device-flow login, the shared credentials
 * file, the broker client). Port of the Python CLI's `pocketshell.account`;
 * `pocketshell login` and `pocketshell-tui-client login` are one login (same
 * `~/.config/pocketshell/credentials.json`).
 *
 * Consumers:
 * - gateway transport: `mintGatewayToken()` / `requireLogin()`.
 * - TUI: `login({ onPending })`, `whoami()`, `logout()`, `isLoggedIn()`.
 * - commands/account.ts: the CLI rendering of the same.
 *
 * Errors carry `code`/`exitCode` for `output.fail()`: NotLoggedIn
 * (NOT_LOGGED_IN, 3), BrokerRateLimited (BROKER_RATE_LIMITED, 1),
 * BrokerUnavailable (BROKER_UNAVAILABLE, 1), LoginCancelled (CANCELLED, 130),
 * AccountError (ACCOUNT_ERROR / ALREADY_LOGGED_IN / USAGE). Messages never
 * contain a token.
 */
import * as broker from './broker.js';
import { resolveBrokerUrl, sessionBrokerUrl, SESSIONS_URL } from './config.js';
import * as store from './credentials.js';
import { isExpired, type Credentials } from './credentials.js';
import { defaultLabel, deviceLogin, revokeQuietly, validateLabel, type PendingLogin } from './device.js';
import { AccountError, BrokerRateLimited, CredentialsUnsafe, NotLoggedIn } from './errors.js';
import { cleanText } from './sanitize.js';

export {
  AccountError,
  BrokerRateLimited,
  BrokerUnavailable,
  CredentialsUnsafe,
  LoginCancelled,
  NotLoggedIn,
} from './errors.js';
export type { Credentials } from './credentials.js';
export type { GatewayToken } from './broker.js';
export type { PendingLogin } from './device.js';
export { canOpenBrowser, openBrowser } from './browser.js';
export { defaultLabel, validateLabel } from './device.js';
export { cleanText } from './sanitize.js';
export { SESSIONS_URL } from './config.js';

/** The resolved broker base URL for a NEW login (`$POCKETSHELL_BROKER_URL` or production). Throws AccountError if invalid. */
export function brokerUrl(): string {
  return resolveBrokerUrl();
}

/**
 * The stored session (possibly expired), or null when there is none or the
 * file is unusable (unsafe permissions, symlink, corrupt). No network I/O.
 */
export function loadCredentials(): Credentials | null {
  try {
    return store.load();
  } catch (error) {
    if (error instanceof NotLoggedIn) return null;
    throw error;
  }
}

/**
 * True when a safe, unexpired session exists whose broker matches
 * `$POCKETSHELL_BROKER_URL` (if set). Local check only — a session revoked
 * on the broker is detected only by `mintGatewayToken()` / `whoami()`.
 */
export function isLoggedIn(): boolean {
  try {
    requireLogin();
    return true;
  } catch {
    return false;
  }
}

/**
 * Throw NotLoggedIn exactly when `mintGatewayToken` would refuse before
 * contacting the broker (no/unsafe/expired session, or a broker mismatch).
 */
export function requireLogin(options: { brokerUrl?: string } = {}): Credentials {
  const creds = store.requireSession();
  sessionBrokerUrl(creds.brokerUrl, options.brokerUrl);
  return creds;
}

export interface MintOptions {
  /** Must name the same broker as the stored session (default: `$POCKETSHELL_BROKER_URL` if set). */
  brokerUrl?: string;
  signal?: AbortSignal;
  /** Test seams. */
  fetch?: typeof fetch;
  now?: number;
}

/**
 * Exchange the stored session for a short-lived (≤ 5 min) broker JWT plus its
 * expiry (`POST /cli/gateway/token`, sent ONLY to the stored broker).
 * Throws NotLoggedIn (code NOT_LOGGED_IN, exit 3) when there is no usable
 * session or the broker answers 401; BrokerRateLimited on 429;
 * BrokerUnavailable when unreachable; AccountError otherwise. The token is a
 * bearer credential: never print, log, or put it in argv/env.
 */
export async function mintGatewayTokenWithExpiry(options: MintOptions = {}): Promise<broker.GatewayToken> {
  const creds = store.requireSession();
  const target = sessionBrokerUrl(creds.brokerUrl, options.brokerUrl);
  return broker.mintGatewayToken(target, creds.accessToken, {
    fetch: options.fetch,
    signal: options.signal,
    now: options.now,
  });
}

/** `mintGatewayTokenWithExpiry()` returning just the JWT string. Same errors. */
export async function mintGatewayToken(options: MintOptions = {}): Promise<string> {
  return (await mintGatewayTokenWithExpiry(options)).token;
}

export interface LoginOptions {
  /** Session label shown on the approval page (default `user@hostname`); validated. */
  label?: string;
  /** Replace an existing unexpired login (the old session is revoked after the new one is saved). */
  force?: boolean;
  /** Called once with the code/URL to show. */
  onPending: (info: PendingLogin) => void;
  /** Safe-to-print warnings (suppressed untrusted URL, unsafe old file being replaced). */
  onWarning?: (message: string) => void;
  /** Abort to cancel → LoginCancelled (exit 130). */
  signal?: AbortSignal;
  /** Test seams: `sleep` in seconds, `monotonic` returns seconds. */
  sleep?: (seconds: number, signal?: AbortSignal) => Promise<void>;
  monotonic?: () => number;
  fetch?: typeof fetch;
}

/**
 * Log in with the device flow and save the session. Refuses (AccountError,
 * code ALREADY_LOGGED_IN, exit 1) when an unexpired session exists and
 * `force` is not set. Resolves to the saved credentials.
 */
export async function login(options: LoginOptions): Promise<Credentials> {
  const base = resolveBrokerUrl();
  const label = options.label !== undefined ? validateLabel(options.label) : defaultLabel();
  let previous: Credentials | null = null;
  try {
    previous = store.load();
  } catch (error) {
    if (error instanceof CredentialsUnsafe) options.onWarning?.(`${error.message} It will be replaced.`);
    else if (!(error instanceof NotLoggedIn)) throw error;
  }
  if (previous !== null && !isExpired(previous) && !options.force) {
    throw new AccountError(
      `Already logged in as ${cleanText(previous.email)}. Run \`pocketshell-tui-client logout\` first, ` +
        'or `pocketshell-tui-client login --force` to replace this login.',
      { code: 'ALREADY_LOGGED_IN' },
    );
  }
  const creds = await deviceLogin({
    baseUrl: base,
    label,
    onPending: options.onPending,
    onWarning: options.onWarning,
    signal: options.signal,
    sleep: options.sleep,
    monotonic: options.monotonic,
    fetch: options.fetch,
  });
  if (previous !== null && previous.accessToken !== creds.accessToken) {
    // The old token only ever goes to the broker stored with it.
    await revokeStored(previous, { fetch: options.fetch });
  }
  return creds;
}

const RATE_LIMITED_SHORT = 'the broker is rate limiting requests from this network';

/** Revoke at the STORED broker. null on success, else why not (safe text). */
async function revokeStored(
  creds: Credentials,
  options: { raiseRateLimited?: boolean; fetch?: typeof fetch } = {},
): Promise<string | null> {
  if (isExpired(creds)) return null;
  try {
    const target = sessionBrokerUrl(creds.brokerUrl);
    if (await broker.logout(target, creds.accessToken, { fetch: options.fetch })) return null;
    return 'the broker did not confirm the revocation';
  } catch (error) {
    if (error instanceof BrokerRateLimited) {
      if (options.raiseRateLimited) throw error;
      return RATE_LIMITED_SHORT;
    }
    if (error instanceof AccountError) return error.message;
    throw error;
  }
}

export interface LogoutResult {
  /**
   * `logged_out`: revoked (or tried to) and deleted; `not_logged_in`: nothing
   * there; `removed_unsafe`: an unsafe file was deleted without contacting
   * the broker; `removed_unreadable`: a corrupt file was deleted.
   */
  result: 'logged_out' | 'not_logged_in' | 'removed_unsafe' | 'removed_unreadable';
  /** Whether the broker confirmed the revocation (false when not attempted). */
  revoked: boolean;
  /** Why the revocation didn't happen (safe text), when it should have. */
  warning: string | null;
  /** Unix seconds the un-revoked session stays valid until (with `warning`). */
  expiresAt: number | null;
}

/**
 * Revoke the session (best effort) and delete the credentials file. A 401
 * counts as logged out. On 429 the file is KEPT and BrokerRateLimited is
 * thrown (exit 1: run logout again shortly).
 */
export async function logout(options: { fetch?: typeof fetch } = {}): Promise<LogoutResult> {
  let creds: Credentials;
  try {
    creds = store.load({ allowSharedMode: true });
  } catch (error) {
    if (error instanceof CredentialsUnsafe) {
      store.remove();
      return { result: 'removed_unsafe', revoked: false, warning: null, expiresAt: null };
    }
    if (error instanceof NotLoggedIn) {
      if (store.exists()) {
        store.remove();
        return { result: 'removed_unreadable', revoked: false, warning: null, expiresAt: null };
      }
      return { result: 'not_logged_in', revoked: false, warning: null, expiresAt: null };
    }
    throw error;
  }
  let problem: string | null;
  try {
    problem = await revokeStored(creds, { raiseRateLimited: true, fetch: options.fetch });
  } catch (error) {
    if (error instanceof BrokerRateLimited) {
      throw new BrokerRateLimited(
        'Could not revoke the session: the PocketShell broker is rate limiting requests from this ' +
          'network (HTTP 429). Your login was kept so it can still be revoked; run ' +
          '`pocketshell-tui-client logout` again shortly.',
      );
    }
    throw error;
  }
  store.remove();
  return {
    result: 'logged_out',
    revoked: problem === null && !isExpired(creds),
    warning: problem,
    expiresAt: problem === null ? null : creds.expiresAt,
  };
}

/** `whoami --json` document (same keys as the Python CLI). */
export interface WhoamiInfo {
  broker_url: string;
  email: string;
  expires_at: number;
  label: string;
  logged_in: true;
  token_id: string;
  verified: boolean;
}

/**
 * The logged-in account, checked with the broker (`GET /cli/session`) when
 * possible. Unreachable/rate-limited broker or a broker mismatch → local copy
 * with `verified: false` and a warning. Throws NotLoggedIn when there is no
 * usable session or the broker answers 401.
 */
export async function whoami(
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<{ info: WhoamiInfo; warnings: string[]; sessionsUrl: string }> {
  const creds = store.requireSession();
  let { email, label, expiresAt } = creds;
  let verified = false;
  const warnings: string[] = [];
  let target: string | null = null;
  try {
    target = sessionBrokerUrl(creds.brokerUrl);
  } catch (error) {
    if (!(error instanceof NotLoggedIn)) throw error;
    warnings.push(`not verified: ${error.message}`);
  }
  if (target !== null) {
    try {
      const session = await broker.getSession(target, creds.accessToken, {
        timeoutMs: 10_000,
        fetch: options.fetch,
        signal: options.signal,
      });
      verified = true;
      ({ email, label, expiresAt } = session);
    } catch (error) {
      if (error instanceof NotLoggedIn || !(error instanceof AccountError)) throw error;
      warnings.push(`could not verify the session with the broker: ${error.message}`);
    }
  }
  return {
    info: {
      broker_url: creds.brokerUrl,
      email: cleanText(email, 320),
      expires_at: expiresAt,
      label: cleanText(label),
      logged_in: true,
      token_id: cleanText(creds.tokenId),
      verified,
    },
    warnings,
    sessionsUrl: SESSIONS_URL,
  };
}
