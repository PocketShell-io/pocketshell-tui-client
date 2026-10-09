import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
it('production runInteractive consumes local detach, preserves literal/PTY resize, reaps child and restores terminal', () => {
  const root = resolve(__dirname, '..');
  const receipt = JSON.parse(execFileSync('/usr/bin/python3', [resolve(root, 'tests/fixtures/sessionInteractiveDriver.py'),
    process.execPath, resolve(root, 'node_modules/tsx/dist/loader.mjs'), resolve(root, 'src/transport/process.ts'),
    resolve(root, 'tests/fixtures/sessionInteractiveClient.ts')], { encoding: 'utf8', timeout: 16000, env: { HOME: root, PATH: '/usr/bin:/bin' } }));
  expect(receipt.transcript).toContain('BYTES:6c69746572616c0a');
  expect(receipt.transcript).toContain('RESIZE:37:113');
  expect(receipt.transcript).toContain('RESULT:0');
  expect(receipt.transcript).not.toContain('DETACH_FORWARDED');
  expect(receipt).toMatchObject({ terminalRestored: true, childAliveAfterExit: false, nodeExit: 0, geometry: [37, 113] });
});
