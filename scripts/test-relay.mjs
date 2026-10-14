#!/usr/bin/env node
/** Native boundary integration. Uses only a private temporary runtime and administrative no-ops. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, chmodSync, readdirSync, rmSync, realpathSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir, loadavg } from 'node:os';
import { join, resolve } from 'node:path';
const owned = realpathSync(mkdtempSync(join(tmpdir(), 'psc-relay-test-')));
chmodSync(owned, 0o700);
const binary = resolve('dist-bundle/psc');
const env = {
  ...process.env,
  HOME: owned,
  XDG_RUNTIME_DIR: owned,
  XDG_CONFIG_HOME: join(owned, 'config'),
  PSC_DAEMON: '1',
  PSC_DAEMON_IDLE_MS: '1000',
  PSC_RPC_BINARY: '',
  NODE_OPTIONS: '--require /psc-relay-test/untrusted-preload',
};
const run = (argv) => spawnSync(binary, argv, { env, encoding: 'utf8', timeout: 7000 });
const child = (argv) =>
  new Promise((resolve, reject) => {
    const c = spawn(binary, argv, { env });
    let stdout = '';
    c.stdout.on('data', (d) => (stdout += d));
    c.on('error', reject);
    c.on('close', (status) =>
      status === 0 ? resolve(JSON.parse(stdout)) : reject(Error('relay failed ' + status)),
    );
  });
try {
  const rows = await Promise.all(Array.from({ length: 32 }, () => child(['daemon', 'start'])));
  assert.equal(new Set(rows.map((r) => r.pid)).size, 1, 'exactly one backend');
  delete env.NODE_OPTIONS; // Legacy fallback continues to use the caller's ordinary environment.
  const runtime = join(
    owned,
    readdirSync(owned).find((n) => n.startsWith('psc-daemon-')),
  );
  const path = join(
    runtime,
    readdirSync(runtime).find((n) => n.endsWith('.sock')),
  );
  const rejectFrame = (body) =>
    new Promise((resolve, reject) => {
      const c = connect(path);
      const timer = setTimeout(() => {
        c.destroy();
        reject(Error('protocol rejection timeout'));
      }, 1000);
      let bytes = 0;
      c.on('connect', () => c.write(body));
      c.on('data', (d) => (bytes += d.length));
      c.on('error', () => {});
      c.on('close', () => {
        clearTimeout(timer);
        assert.equal(bytes, 0);
        resolve();
      });
    });
  const encoded = Buffer.from(
    JSON.stringify({
      protocol: 2,
      id: 'f'.repeat(32),
      namespace: 'foreign',
      argv: ['daemon', 'noop'],
      stdin: null,
      tty: false,
      deadline: Date.now() + 1000,
    }),
  );
  const h = Buffer.alloc(4);
  h.writeUInt32BE(encoded.length);
  await rejectFrame(Buffer.concat([h, encoded]));
  h.writeUInt32BE((2 << 20) + 1);
  await rejectFrame(h);
  assert.equal(run(['daemon', 'noop']).status, 0, 'invalid peers cannot kill the backend');
  await new Promise((resolve, reject) => {
    const c = spawn(binary, ['daemon', 'status'], { env });
    c.stdout.destroy();
    c.on('error', reject);
    c.on('close', (code) => {
      assert.equal(code, 0, 'EPIPE exits cleanly');
      resolve();
    });
  });
  if (process.argv.includes('--bench')) {
    const samples = [];
    let failures = 0;
    const load = loadavg();
    for (let i = 0; i < 1000; i++) {
      const start = performance.now();
      const r = run(['daemon', 'noop']);
      samples.push(performance.now() - start);
      if (r.status !== 0) failures++;
    }
    samples.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        samples: 1000,
        failures,
        load,
        p50: samples[499],
        p95: samples[949],
        p99: samples[989],
        max: samples[999],
      }),
    );
    assert.equal(failures, 0);
  }
  const before = JSON.parse(run(['daemon', 'status']).stdout).pid;
  await new Promise((r) => setTimeout(r, 2200));
  assert.equal(JSON.parse(run(['daemon', 'status']).stdout).running, false, 'idle expiry removes listener');
  const after = JSON.parse(run(['daemon', 'start']).stdout).pid;
  assert.notEqual(after, before, 'a fresh backend follows idle expiry');
  assert.equal(run(['daemon', 'stop']).status, 0);
  for (let i = 0; i < 10; i++) {
    assert.equal(run(['daemon', 'start']).status, 0, 'restart after shutdown');
    assert.equal(run(['daemon', 'stop']).status, 0, 'stop waits for its verified socket');
  }
  const legacy = run(['-H', 'local', 'exec', '--', 'sh', '-c', 'printf parity; exit 7']);
  assert.equal(legacy.status, 7);
  assert.equal(legacy.stdout, 'parity');
  // An unusable daemon runtime (a group-writable parent) must fall back to
  // the classic path at once: correct answer, no multi-second timeout, no
  // spawn, and daemon status stays a clean "not running".
  const unsafe = mkdtempSync(join(tmpdir(), 'psc-unsafe-parent-'));
  chmodSync(unsafe, 0o775);
  const unsafeRuntime = { ...env, XDG_RUNTIME_DIR: join(unsafe, 'runtime') };
  {
    const started = process.hrtime.bigint();
    const hosts = spawnSync(binary, ['hosts', '--json'], { env: unsafeRuntime, encoding: 'utf8', timeout: 7000 });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(hosts.status, 0, `unsafe runtime must fall back, not fail: ${hosts.stderr}`);
    assert.equal(JSON.parse(hosts.stdout).ok, true);
    assert.equal(ms < 1500, true, `unsafe runtime fallback took ${ms} ms`);
    const daemonStatus = spawnSync(binary, ['daemon', 'status'], { env: unsafeRuntime, encoding: 'utf8', timeout: 7000 });
    assert.equal(daemonStatus.status, 0);
    assert.equal(JSON.parse(daemonStatus.stdout).running, false);
  }
  const status = run(['definitely-not-saved', 'status', 'missing', '--json']);
  assert.notEqual(status.status, 0);
  assert.equal(
    JSON.parse(status.stdout).ok,
    false,
    'host status must autostart and dispatch, not act as daemon status',
  );
  console.log('native integration: 32 cold clients, protocol/frame rejection, EPIPE, idle expiry passed');
} finally {
  run(['daemon', 'stop']);
  rmSync(owned, { recursive: true, force: true });
}
