/** `login`, `logout`, `whoami`: the PocketShell account (device flow). (Being implemented.) */
import type { Command } from 'commander';

export function registerAccount(program: Command): void {
  program.command('login').description('log in to your PocketShell account (device flow)');
  program.command('logout').description('revoke and delete the login session');
  program.command('whoami').description('show the logged-in account');
}
