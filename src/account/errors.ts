/**
 * Account error types. Every message is safe to print: it never contains a
 * session token, device code, gateway JWT or raw server text, and is passed
 * through `cleanText` on construction.
 *
 * `code`/`exitCode` follow `src/output.ts` (`fail()` uses them directly).
 */
import { cleanText } from './sanitize.js';

export const LOGIN_HINT = 'run `pocketshell-tui-client login`';

/** A login/account failure whose message is safe to show (exit 1). */
export class AccountError extends Error {
  readonly code: string;
  readonly exitCode: number;
  constructor(message: unknown = '', options: { code?: string; exitCode?: number } = {}) {
    super(cleanText(String(message), 2000));
    this.name = 'AccountError';
    this.code = options.code ?? 'ACCOUNT_ERROR';
    this.exitCode = options.exitCode ?? 1;
  }
}

/**
 * There is no usable session (missing, unsafe, expired, broker 401, or
 * `POCKETSHELL_BROKER_URL` names another broker). code `NOT_LOGGED_IN`, exit 3.
 */
export class NotLoggedIn extends AccountError {
  constructor(message = `not logged in; ${LOGIN_HINT}`) {
    super(message, { code: 'NOT_LOGGED_IN', exitCode: 3 });
    this.name = 'NotLoggedIn';
  }
}

/**
 * A credentials file exists but is refused (symlink, not regular, foreign
 * owner, group/world permissions, others-writable directory). Behaves as
 * NotLoggedIn everywhere; the subclass only lets login/logout explain it.
 */
export class CredentialsUnsafe extends NotLoggedIn {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialsUnsafe';
  }
}

/** The broker could not be reached (DNS, TCP, TLS, timeout). code `BROKER_UNAVAILABLE`, exit 1. */
export class BrokerUnavailable extends AccountError {
  constructor(message: string, code = 'BROKER_UNAVAILABLE') {
    super(message, { code, exitCode: 1 });
    this.name = 'BrokerUnavailable';
  }
}

/**
 * HTTP 429 on a session-bearing endpoint. Says nothing about the session:
 * never NotLoggedIn, never a reason to delete credentials. code
 * `BROKER_RATE_LIMITED`, exit 1.
 */
export class BrokerRateLimited extends BrokerUnavailable {
  constructor(message: string) {
    super(message, 'BROKER_RATE_LIMITED');
    this.name = 'BrokerRateLimited';
  }
}

/** `login` was cancelled (AbortSignal / Ctrl+C). code `CANCELLED`, exit 130. */
export class LoginCancelled extends AccountError {
  constructor(message = 'Login cancelled.') {
    super(message, { code: 'CANCELLED', exitCode: 130 });
    this.name = 'LoginCancelled';
  }
}
