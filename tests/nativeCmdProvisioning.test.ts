import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addHost } from '../src/hosts/store.js';
import { registerHosts } from '../src/commands/hosts.js';
vi.mock('../src/hosts/store.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/hosts/store.js')>();
  return { ...real, addHost: vi.fn((entry: Parameters<typeof real.addHost>[0]) => real.validateHostEntry(entry)) };
});
vi.mock('../src/commands/common.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/commands/common.js')>(), action: (fn: (...args: unknown[]) => Promise<void>) => fn,
}));
vi.mock('../src/output.js', async importOriginal => ({ ...await importOriginal<typeof import('../src/output.js')>(), emit: vi.fn() }));
const executable = 'C:/Protected/Scripts/pocketshell.exe';
const base = ['hosts', 'add', 'fixture', '--gateway', 'enrolled-fixture', '--native-windows-cli', executable];
const bash = ['--native-bash', 'C:/Program Files/Git/bin/bash.exe'];
const digest = ['--native-bash-sha256', 'a'.repeat(64)];
async function parse(args: string[]) {
  const program = new Command(); program.exitOverride(); registerHosts(program);
  await program.parseAsync(args, { from: 'user' });
}
beforeEach(() => { vi.mocked(addHost).mockClear(); });
describe('explicit CMD operator provisioning argv', () => {
  it('passes exact Bash/digest/device bindings to real validation without filesystem writes', async () => {
    await parse([...base, '--native-transport', 'openssh-cmd-git-bash', ...bash, ...digest]);
    expect(addHost).toHaveBeenCalledOnce();
    expect(vi.mocked(addHost).mock.calls[0]![0].nativeWindowsCli).toEqual({
      executable, deviceId: 'enrolled-fixture', transport: 'openssh-cmd-git-bash', trustedBashExecutable: bash[1], trustedBashSha256: digest[1],
    });
  });
  it.each([{ args: bash }, { args: digest }, { args: [] }])('refuses incomplete CMD binding $args before storage', async ({ args }) => {
    await expect(parse([...base, '--native-transport', 'openssh-cmd-git-bash', ...args])).rejects.toThrow(/requires/);
    expect(addHost).not.toHaveBeenCalled();
  });
  it('refuses Bash binding on GitBash and retains existing explicit GitBash argv', async () => {
    await expect(parse([...base, '--native-transport', 'openssh-git-bash', ...bash, ...digest])).rejects.toThrow(/require/);
    expect(addHost).not.toHaveBeenCalled();
    await parse([...base, '--native-transport', 'openssh-git-bash']);
    expect(vi.mocked(addHost).mock.calls[0]![0].nativeWindowsCli).toEqual({ executable, deviceId: 'enrolled-fixture', transport: 'openssh-git-bash' });
  });
});
