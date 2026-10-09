import { expect, it, vi } from 'vitest';
import { HostClient } from '../src/hostClient.js';
import { GatewayConnection } from '../src/transport/gateway.js';
import { hostKeyAlias, resolveEndpoint } from '../src/gateway/endpoint.js';
import type { ExecOutcome } from '../src/transport/types.js';
const fake = vi.hoisted(() => ({ interactive: vi.fn(async () => 0) }));
vi.mock('../src/transport/process.js', () => ({ runInteractive: fake.interactive }));
it('production HostClient native attach opts in through hardened GatewayConnection without changing target/pins', async () => {
  const deviceId = 'enrolled-fixture';
  const connection = new GatewayConnection('fixture', '/usr/bin/ssh', {
    deviceId, endpoint: resolveEndpoint(), pinFile: '/owned/pins', alias: hostKeyAlias(deviceId), statusDir: null,
    invocation: ['/qualified/node', '/qualified/client/dist/cli.js'],
  });
  const result = (stdout: string): ExecOutcome => ({ stdout, stderr: '', timedOut: false, exitCode: 0 });
  vi.spyOn(connection, 'exec').mockImplementation(async command => command.endsWith('--version')
    ? result('pocketshell, version 0.5.8') : result(JSON.stringify({ schema: 1, platform: 'win32', os: 'nt', cli_version: '0.5.8', capabilities: ['workspaces', 'tree', 'sessions.list', 'sessions.attach'] })));
  const client = new HostClient(connection, undefined, { name: 'fixture', mode: 'gateway', gateway: { deviceId },
    nativeWindowsCli: { executable: 'C:/Protected/Scripts/pocketshell.exe', transport: 'openssh-git-bash', deviceId } });
  const id = '12345678-1234-1234-1234-123456789abc';
  expect(await client.attach({ name: 'fixture:main', id, workspace: 'C:/fixture', tag: 'main', attached: false })).toBe(0);
  expect(fake.interactive.mock.calls[0]![3]).toEqual({ sessionDetach: true });
  const argv = fake.interactive.mock.calls[0]![1] as string[];
  expect(argv.at(-1)).toBe(`"exec 'C:/Protected/Scripts/pocketshell.exe' sessions attach -- '${id}'"`);
  for (const option of ['StrictHostKeyChecking=yes', 'ControlMaster=no', 'ControlPath=none', 'ControlPersist=no', 'PasswordAuthentication=no', 'ForwardAgent=no']) expect(argv).toContain(option);
  expect(argv).toContain('UserKnownHostsFile=/owned/pins');
  expect(argv).not.toContain('BatchMode=yes');
});
