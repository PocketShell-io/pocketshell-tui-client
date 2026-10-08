/**
 * The account API other modules use. (Being implemented: device login,
 * credentials file, broker client.)
 */

export class NotLoggedIn extends Error {
  readonly code = 'NOT_LOGGED_IN';
  readonly exitCode = 3;
  constructor(message = 'not logged in: run `pocketshell-client login`') {
    super(message);
    this.name = 'NotLoggedIn';
  }
}

/**
 * Exchange the stored login session for a fresh short-lived (≤ 5 min)
 * broker JWT for the gateway (`POST /cli/gateway/token`). Throws
 * NotLoggedIn when there is no usable session.
 */
export async function mintGatewayToken(): Promise<string> {
  throw new NotLoggedIn();
}
