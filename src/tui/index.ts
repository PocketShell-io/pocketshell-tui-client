/** The full-screen terminal UI. (Being implemented.) */
export async function runTui(_options: { host?: string }): Promise<number> {
  process.stderr.write('the TUI is not implemented yet; see --help for the CLI\n');
  return 1;
}
