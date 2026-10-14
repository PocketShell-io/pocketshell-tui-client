/** Run against the installed payload, without broker access or real credentials. */
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';

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
  const version = JSON.parse(readFileSync(join(prefix, 'package-manifest.json'), 'utf8')).version;
  assert.equal(run('--version').trim(), version);
  assert.match(run('hosts'), /local/);
  // Actual installed device-flow commands against a loopback-only fake broker.
  const publicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGuV1O9rNRp7VtgPq3H6Mze4PugDi32wsIYRrGAzHWLb';
  const expiry = Math.floor(Date.now() / 1000) + 86400;
  const token = `psc_${'A'.repeat(43)}`;
  const b64 = x => Buffer.from(JSON.stringify(x)).toString('base64url');
  const jwt = `${b64({ alg: 'EdDSA', typ: 'JWT' })}.${b64({ exp: expiry })}.c2ln`;
  const routes = {
    '/auth/device/start': { device_code: 'dc_0123456789abcdefXYZ', user_code: 'BCDF-GHJK', verification_uri: 'https://app.pocketshell.io/device', expires_in: 600, interval: 1 },
    '/auth/device/token': { access_token: token, token_id: 'tok_smoke', expires_at: expiry, email: 'smoke@example.com' },
    '/cli/session': { email: 'smoke@example.com', token_id: 'tok_smoke', label: 'windows-smoke', expires_at: expiry },
    '/cli/gateway/token': { token: jwt, token_type: 'Bearer', expires_at: Math.floor(Date.now() / 1000) + 300 },
    '/identity/v1/devices': { devices: [{ id: 'hetzner-smoke', account_id: 'offline', public_key: '', ssh_host_key: publicKey, revoked: false }] },
  };
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(routes[req.url] ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(routes[req.url] ?? {}));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const env = { ...process.env, XDG_CONFIG_HOME: join(root, 'config'), XDG_RUNTIME_DIR: join(root, 'runtime'),
    POCKETSHELL_BROKER_URL: `http://127.0.0.1:${port}`, POCKETSHELL_BROKER_INSECURE_DEV: '1' };
  const command = async (...args) => {
    const { stdout } = await promisify(execFile)(bindings.node, [bindings.entry, ...args], { env, timeout: 30000, windowsHide: true });
    return stdout.trim().split('\n').map(line => JSON.parse(line));
  };
  try {
    const login = await command('login', '--json', '--no-open', '--label', 'windows-smoke');
    assert.equal(login.at(-1).event, 'logged_in');
    assert.ok(!readFileSync(join(root, 'config/pocketshell-client-account/credentials.dpapi')).includes(Buffer.from(token)));
    const synced = await command('hosts', 'sync', '--server', `ws://127.0.0.1:${port}`, '--insecure-dev', '--json');
    assert.equal(synced[0].ok, true);
    const pinned = await command('gateway', 'pin', 'hetzner-smoke', publicKey, '--json');
    assert.equal(pinned[0].ok, true);
    const hosts = await command('hosts', 'list', '--json');
    assert.ok(hosts[0].hosts.some(host => host.name === 'hetzner'));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  console.log('Installed bindings, ACLs, DPAPI, device login, hosts sync and gateway pin: OK');
} finally {
  rmSync(root, { recursive: true, force: true });
}
