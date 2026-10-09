#!/usr/bin/env node
/**
 * pocketshell-tui-client (alias `psc`): PocketShell from a terminal.
 *
 * With no arguments on a TTY it opens the TUI. Every TUI action also exists
 * as a subcommand with `--json`, so agents and scripts get the same reach.
 */
import { Command, CommanderError } from 'commander';
import { registerAccount } from './commands/account.js';
import { registerGateway } from './commands/gateway.js';
import { registerHosts } from './commands/hosts.js';
import { registerCatalog, registerExec, registerSessions, registerWorkspaces } from './commands/sessions.js';
import { fail, setJsonMode, usageError } from './output.js';
import { runTui } from './tui/index.js';
import { VERSION } from './version.js';

const program = new Command();
program
  .name('pocketshell-tui-client')
  .description(
    'PocketShell in the terminal: sessions on your hosts over local, ssh, or gateway connections.\n' +
      'Run with no arguments for the interactive UI; every action is also a subcommand (add --json for agents).',
  )
  .version(VERSION)
  .option('-H, --host <name>', 'saved host for every subcommand (same as the per-command -H)')
  .option('--json', 'machine-readable output for every subcommand')
  // `psc -H box sessions list` and `psc sessions list -H box` both work: the
  // program-level spelling travels to the subcommand through PSC_HOST.
  .hook('preAction', () => {
    const globals = program.opts<{ host?: string; json?: boolean }>();
    if (globals.host) process.env.PSC_HOST = globals.host;
    if (globals.json) setJsonMode(true);
  });

program
  .command('tui', { isDefault: false })
  .description('open the interactive terminal UI')
  .option('-H, --host <name>', 'start on this host')
  .action(async (opts: { host?: string }) => {
    process.exitCode = await runTui(opts);
  });

registerHosts(program);
registerSessions(program);
registerWorkspaces(program);
registerCatalog(program);
registerExec(program);
registerAccount(program);
registerGateway(program);

/**
 * Usage errors (unknown option or command, missing or invalid argument) are
 * ours to report, not commander's: they become code USAGE, exit 2, and in
 * JSON mode the one JSON document on stdout. `--help` and `--version` still
 * print and exit 0. Applied to every command, since commander copies these
 * settings only into subcommands created after they were set.
 */
function routeUsageErrors(command: Command): void {
  command.exitOverride();
  command.configureOutput({ outputError: () => {} });
  command.showHelpAfterError(false);
  for (const sub of command.commands) routeUsageErrors(sub);
}
routeUsageErrors(program);

/** `--json` anywhere before a `--` separator: known before parsing, so a parse failure honours it. */
function wantsJson(args: readonly string[]): boolean {
  const end = args.indexOf('--');
  return (end === -1 ? args : args.slice(0, end)).includes('--json');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (wantsJson(args)) setJsonMode(true);
  if (args.length === 0) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      process.exitCode = await runTui({});
      return;
    }
    program.outputHelp();
    return;
  }
  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  if (error instanceof CommanderError) {
    // help/version (exit 0) already printed; everything else is a usage error.
    if (error.exitCode === 0) {
      process.exitCode = 0;
      return;
    }
    // `psc sessions` with no subcommand: commander printed the help to stderr.
    const message =
      error.code === 'commander.help' ? 'a subcommand is required' : error.message.replace(/^error:\s*/i, '');
    process.exitCode = fail(usageError(`${message} (see --help)`));
    return;
  }
  process.exitCode = fail(error);
});
