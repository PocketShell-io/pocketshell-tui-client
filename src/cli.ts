#!/usr/bin/env node
/**
 * pocketshell-client (alias `psc`): PocketShell from a terminal.
 *
 * With no arguments on a TTY it opens the TUI. Every TUI action also exists
 * as a subcommand with `--json`, so agents and scripts get the same reach.
 */
import { Command } from 'commander';
import { registerAccount } from './commands/account.js';
import { registerGateway } from './commands/gateway.js';
import { registerHosts } from './commands/hosts.js';
import { registerCatalog, registerExec, registerSessions, registerWorkspaces } from './commands/sessions.js';
import { fail, setJsonMode } from './output.js';
import { runTui } from './tui/index.js';
import { VERSION } from './version.js';

const program = new Command();
program
  .name('pocketshell-client')
  .description(
    'PocketShell in the terminal: sessions on your hosts over local, ssh, or gateway connections.\n' +
      'Run with no arguments for the interactive UI; every action is also a subcommand (add --json for agents).',
  )
  .version(VERSION)
  .option('-H, --host <name>', 'saved host for every subcommand (same as the per-command -H)')
  .option('--json', 'machine-readable output for every subcommand')
  .showHelpAfterError()
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
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
  process.exitCode = fail(error);
});
