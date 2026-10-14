/** Run against the installed payload, without broker access or real credentials. */
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const prefix = process.argv[2];
const api = await import(pathToFileURL(join(prefix, 'psc/dist/platform/windows.js')));
const bindings = api.bindings();
assert.equal(Object.keys(bindings).length, 13);
assert.equal(bindings.node.toLowerCase(), process.execPath.toLowerCase());
const root = mkdtempSync(join(process.env.LOCALAPPDATA, 'PocketShell/psc-smoke-'));
// The helper creates the final directory with its protected descriptor.
rmSync(root, { recursive: true });
try {
  api.callNative({ op: 'preflight', root });
  const synthetic = Buffer.from('synthetic-offline-DPAPI-test');
  api.nativeWrite(root, 'credentials', synthetic);
  assert.deepEqual(api.nativeRead(root, 'credentials'), synthetic);
  assert.ok(!readFileSync(join(root, 'credentials.dpapi')).includes(synthetic));
  api.nativeWrite(root, 'hosts', Buffer.from('{"version":1,"hosts":[]}'));
  assert.ok(api.nativeRead(root, 'hosts'));
  api.nativeWrite(root, 'pins', Buffer.from('fixture-pin\n'));
  assert.equal(api.nativeRead(root, 'pins').toString(), 'fixture-pin\n');
  const run = (...args) => {
    const r = spawnSync(bindings.node, [bindings.entry, ...args], { encoding: 'utf8', shell: false });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  assert.match(run('--version'), /0\.3\.1/);
  assert.match(run('hosts'), /local/);
  console.log('Installed bindings, helper ACL preflight, DPAPI roundtrip, hosts and pins: OK');
} finally {
  rmSync(root, { recursive: true, force: true });
}
