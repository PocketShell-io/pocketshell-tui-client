/**
 * `login`, `logout`, `whoami`: the PocketShell account (device flow). One
 * login with the Python `pocketshell` CLI (shared credentials file).
 * The logic lives in src/account; this file only renders it.
 */
import type { Command } from 'commander';
import {
  canOpenBrowser,
  cleanText,
  login,
  logout,
  openBrowser,
  whoami,
  type PendingLogin,
} from '../account/index.js';
import { emit, isJsonMode, setJsonMode } from '../output.js';
import { action, jsonOption } from './common.js';

function when(epoch: number): string {
  const date = new Date(epoch * 1000);
  if (Number.isNaN(date.getTime())) return String(epoch);
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** Warnings go to stderr in both modes (stdout stays machine-readable). */
function warn(message: string): void {
  process.stderr.write(`warning: ${cleanText(message, 2000)}\n`);
}

const LOGIN_HELP = `
Prints a short code and a URL; approve the code in the browser while signed in
to PocketShell. The session is stored in
\${XDG_CONFIG_HOME:-~/.config}/pocketshell/credentials.json (mode 0600), shared
with the \`pocketshell\` CLI. An existing login is never replaced silently: pass
--force to replace it (the old session is then revoked). Ctrl+C cancels (exit 130).

--json streams TWO JSON lines on stdout (the one command that does):
  1. as soon as the code is issued, relay it to a human:
     {"event":"pending","userCode":"BCDF-GHJK","verificationUri":"https://...",
      "verificationUriComplete":"https://...?code=BCDF-GHJK"|null,"expiresIn":600}
  2. when done: {"ok":true,"event":"logged_in","email":...,"label":...,"expiresAt":...}
     or the standard error document {"ok":false,"error":{"code","message"}}
     (codes: ALREADY_LOGGED_IN, CANCELLED, BROKER_UNAVAILABLE, ACCOUNT_ERROR, ...).
A failure before a code is issued prints only the error document.`;

export function registerAccount(program: Command): void {
  jsonOption(
    program
      .command('login')
      .description('log in to your PocketShell account (device flow)')
      .option('--label <text>', 'name for this session shown on the approval page (default: user@hostname)')
      .option('--no-open', 'do not try to open a web browser')
      .option('--force', 'replace an existing, still-valid login'),
  )
    .addHelpText('after', LOGIN_HELP)
    .action(
      action(async (opts: { label?: string; open: boolean; force?: boolean; json?: boolean }) => {
        if (opts.json) setJsonMode(true);
        const json = isJsonMode();
        const controller = new AbortController();
        const onSigint = (): void => controller.abort();
        process.once('SIGINT', onSigint);
        try {
          const creds = await login({
            label: opts.label,
            force: Boolean(opts.force),
            signal: controller.signal,
            onWarning: warn,
            onPending: (info: PendingLogin) => {
              if (json) {
                process.stdout.write(
                  `${JSON.stringify({
                    event: 'pending',
                    userCode: info.userCode,
                    verificationUri: info.verificationUri,
                    verificationUriComplete: info.verificationUriComplete,
                    expiresIn: info.expiresIn,
                  })}\n`,
                );
              } else {
                const out = (line: string): boolean => process.stdout.write(`${line}\n`);
                if (info.verificationUriComplete !== null) {
                  out(`To log in, open:  ${info.verificationUriComplete}`);
                } else {
                  out(`To log in, open:  ${info.verificationUri}`);
                  out(`and enter code:   ${info.userCode}`);
                }
                out(`Confirm the code shown in the browser matches: ${info.userCode}`);
                out('The page will ask you to type its last 4 characters before approving.');
              }
              if (opts.open && info.verificationUriComplete !== null && canOpenBrowser()) {
                openBrowser(info.verificationUriComplete);
              }
              if (!json) process.stdout.write('Waiting for approval (Ctrl+C to cancel)...\n');
            },
          });
          emit(
            { ok: true, event: 'logged_in', email: creds.email, label: creds.label, expiresAt: creds.expiresAt },
            () => `Logged in as ${cleanText(creds.email)}.`,
          );
        } finally {
          process.removeListener('SIGINT', onSigint);
        }
      }),
    );

  jsonOption(
    program.command('logout').description('revoke this machine\'s session (best effort) and delete the stored credentials'),
  ).action(
    action(async (opts: { json?: boolean }) => {
      if (opts.json) setJsonMode(true);
      const result = await logout();
      if (result.result === 'removed_unsafe') warn('Removed an unsafe credentials file without contacting the broker.');
      if (result.result === 'removed_unreadable') warn('Removed an unreadable credentials file.');
      if (result.warning !== null) {
        warn(
          `could not revoke the session on the broker (${result.warning}); ` +
            `it stays valid until ${when(result.expiresAt ?? 0)}.`,
        );
      }
      emit(
        {
          ok: true,
          loggedIn: false,
          result: result.result,
          revoked: result.revoked,
          warning: result.warning,
          expiresAt: result.expiresAt,
        },
        () => (result.result === 'not_logged_in' ? 'Not logged in.' : result.result === 'logged_out' ? 'Logged out.' : ''),
      );
    }),
  );

  jsonOption(
    program
      .command('whoami')
      .description('show the logged-in account (checked with the broker)')
      .addHelpText(
        'after',
        '\n--json: {"ok":true,"loggedIn":true,"email","label","brokerUrl","expiresAt","tokenId","verified"};\n' +
          'not logged in: {"ok":false,"error":{"code":"NOT_LOGGED_IN","message"}}, exit 3.',
      ),
  ).action(
    action(async (opts: { json?: boolean }) => {
      if (opts.json) setJsonMode(true);
      // NotLoggedIn propagates: {"ok":false,"error":{"code":"NOT_LOGGED_IN"}}, exit 3.
      const { info, warnings, sessionsUrl } = await whoami();
      emit(
        {
          ok: true,
          loggedIn: true,
          email: info.email,
          label: info.label,
          brokerUrl: info.broker_url,
          expiresAt: info.expires_at,
          tokenId: info.token_id,
          verified: info.verified,
        },
        () =>
          [
            `Logged in as ${info.email}`,
            `  label:    ${info.label}`,
            `  broker:   ${cleanText(info.broker_url)}`,
            `  expires:  ${when(info.expires_at)}`,
            `  verified: ${info.verified ? 'yes' : 'no'}`,
            `Review or revoke sessions at ${sessionsUrl}`,
          ].join('\n'),
      );
      for (const warning of warnings) warn(warning);
    }),
  );
}
