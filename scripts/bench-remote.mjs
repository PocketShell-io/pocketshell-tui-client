#!/usr/bin/env node
/** Fresh-process latency; output is validated but never recorded (may contain private captures). */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { cpus, loadavg, platform } from 'node:os';
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1]; };
const host = opt('host', 'hetzner'), psc = opt('psc', 'psc');
const mode = opt('mode', 'warm'), runs = Number(opt('runs', mode === 'cold' ? '20' : '100'));
if (!['cold', 'warm', 'legacy', 'reconnect', 'idle-expiry', 'helper-absent'].includes(mode) || !Number.isInteger(runs) || runs < 1) throw Error('invalid mode/runs');
const timeout = Number(opt('timeout-ms', '60000'));
const env = { ...process.env, ...(mode === 'legacy' ? { PSC_DAEMON: '0' } : {}) };
function run(argv, input) {
  const start = process.hrtime.bigint();
  const r = spawnSync(psc, argv, { input, encoding: 'utf8', timeout, maxBuffer: 16 << 20, env });
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  let valid = r.status === 0 && !r.error;
  if (valid && argv.includes('--json')) { try { valid = JSON.parse(r.stdout).ok === true; } catch { valid = false; } }
  return { ms, status: r.status, signal: r.signal, error: r.error?.code ?? null, valid, out: r.stdout };
}
const tag = `psc-bench-${process.pid}-${Date.now()}`;
const created = run([host, 'start', tag, '-C', '~', '-e', 'shell', '--json']);
if (!created.valid) throw Error('throwaway session creation failed (output withheld)');
const session = JSON.parse(created.out).id ?? JSON.parse(created.out).name;
const operations = {
  version: ['--version'], hosts: ['hosts', '--json'],
  'hosts-check': ['hosts', 'check', host, '--json'], ls: [host, 'ls', '--json'],
  status: [host, 'status', session, '--json'], capture: [host, 'capture', session, '--lines', '5', '--json'],
  'send-no-enter': [host, 'send', session, '--no-enter', 'x', '--json'],
  'send-submit': [host, 'send', session, 'true', '--json'],
  'send-multiline': [host, 'send', session, 'true\ntrue', '--json'],
};
const selected = opt('operations', Object.keys(operations).join(',')).split(',');
const results = {};
const summarize = samples => {
  const sorted = samples.map(s => s.ms).sort((a,b) => a-b);
  const q = p => sorted[Math.max(0, Math.ceil(p * sorted.length)-1)];
  return { samples: samples.length, failures: samples.filter(s => !s.valid).length, p50:q(.5), p95:q(.95), p99:q(.99), max:q(1), observations:samples.map(({out,...s})=>s) };
};
let binary;
try { const path = realpathSync(psc); binary = { path, sha256:createHash('sha256').update(readFileSync(path)).digest('hex') }; }
catch { binary = { command:psc }; }
const metadata = { host, route:'client → gateway → host (verify host configuration)', mode, runs, binary, version:run(['--version']).out.trim(), platform:platform(), cpu:cpus()[0]?.model, load:loadavg(), captureLines:5, sendBytes:{noEnter:1,submitted:4,multiline:9}, sessionCount:null, operationSpellings:{} };
try {
  const listing = run([host,'ls','--json']);
  if (listing.valid) metadata.sessionCount = JSON.parse(listing.out).sessions?.length ?? null;
  for (const name of selected) {
    const argv = operations[name]; if (!argv) throw Error(`unknown operation ${name}`);
    metadata.operationSpellings[name] = argv.map(v => v === session ? '<owned-session>' : v);
    if (mode === 'warm') { const warm = run(argv); if (!warm.valid) throw Error(`warmup failed for ${name}`); }
    const samples = [];
    for (let i=0;i<runs;i++) {
      if (['cold','reconnect'].includes(mode)) { const stop = run(['daemon','stop']); if (!stop.valid) throw Error('daemon stop failed'); }
      samples.push(run(argv));
    }
    results[name] = summarize(samples);
    process.stderr.write(`${name}: n=${runs} failures=${results[name].failures} p50=${results[name].p50.toFixed(1)} p95=${results[name].p95.toFixed(1)} p99=${results[name].p99.toFixed(1)} max=${results[name].max.toFixed(1)} ms\n`);
  }
} finally {
  const stopped = run([host, 'stop', session, '--if-exists', '--json']);
  if (!stopped.valid) process.stderr.write('owned benchmark session cleanup failed; tag='+tag+'\n');
}
process.stdout.write(JSON.stringify({metadata,results},null,2)+'\n');
if (Object.values(results).some(r=>r.failures)) process.exitCode=1;
