/**
 * Gateway mode's ssh side: the hardened argv, the ProxyCommand, and an
 * end-to-end run — real OpenSSH → ProxyCommand (our proxy) → an in-process
 * fake gateway → the local sshd — when this machine accepts key-based ssh
 * to localhost.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { hostKeyAlias, legacyHostKeyAlias, resolveEndpoint } from '../src/gateway/endpoint.js';
import { addPin, parseHostKey, pinFilePath } from '../src/gateway/pins.js';
import {
  buildGatewaySshArgv,
  cliInvocation,
  GatewayConnection,
  HARDENING_OPTIONS,
  openGatewayConnection,
  proxyCommand,
} from '../src/transport/gateway.js';
import { findSsh, PROXY_MARKER, runSshCaptured } from '../src/transport/openssh.js';
import { ConnectionError } from '../src/transport/types.js';

const savedXdg = process.env.XDG_CONFIG_HOME;
let xdg: string;
beforeAll(() => {
  xdg = mkdtempSync(join(tmpdir(), 'psc-gw-'));
  process.env.XDG_CONFIG_HOME = xdg;
});
afterAll(() => {
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  rmSync(xdg, { recursive: true, force: true });
});

const dev = resolveEndpoint('ws://127.0.0.1:8080', true);
const prod = resolveEndpoint(undefined);

describe('proxyCommand', () => {
  it('quotes every element and doubles % for ssh token expansion', () => {
    expect(proxyCommand('home-lab', dev, ['/opt/my node%/bin/node', '/a b/cli.js'])).toBe(
      "'/opt/my node%%/bin/node' '/a b/cli.js' gateway proxy home-lab --server ws://127.0.0.1:8080 --insecure-dev",
    );
    expect(proxyCommand('home-lab', prod, ['/usr/bin/node', "/it's/cli.js"])).toBe(
      `/usr/bin/node '/it'\\''s/cli.js' gateway proxy home-lab`,
    );
    expect(proxyCommand('h:1', resolveEndpoint('wss://gw.example:8443'), ['/n', '/c.js'])).toBe(
      '/n /c.js gateway proxy h:1 --server wss://gw.example:8443',
    );
  });

  it('refuses control characters, backslashes, a relative interpreter and bad ids', () => {
    expect(() => proxyCommand('home-lab', prod, ['/usr/bin/node', '/a\\b/cli.js'])).toThrow(/backslash/);
    expect(() => proxyCommand('home-lab', prod, ['/usr/bin/node', '/a\nb'])).toThrow();
    expect(() => proxyCommand('home-lab', prod, ['node', '/cli.js'])).toThrow(/absolute/);
    expect(() => proxyCommand('$(id)', prod, ['/n', '/c.js'])).toThrow();
  });

  it('locates this CLI (tsx in dev, dist/cli.js when built)', () => {
    const inv = cliInvocation();
    expect(inv[0]).toBe(process.execPath);
    const script = inv[inv.length - 1]!;
    expect(script).toMatch(/\/(src\/cli\.ts|dist\/cli\.js)$/);
    if (script.endsWith('.ts')) expect(inv.slice(1, 3)).toEqual(['--import', createRequire(script).resolve('tsx')]);
  });
});

describe('buildGatewaySshArgv', () => {
  const base = {
    deviceId: 'Home-Lab',
    endpoint: prod,
    pinFile: '/home/u/.config/pocketshell/gateway_known_hosts',
    alias: hostKeyAlias('Home-Lab'),
    statusDir: '/run/user/1/pocketshell-client',
    invocation: ['/usr/bin/node', '/opt/psc/dist/cli.js'],
  };

  it('puts -F none and every hardening option first, the alias after --', () => {
    const argv = buildGatewaySshArgv({ ...base, user: 'me', kind: 'exec', command: 'pocketshell sessions list --json' });
    expect(argv.slice(0, 2)).toEqual(['-F', 'none']);
    const opts = argv.slice(2, 2 + HARDENING_OPTIONS.length * 2).filter((_, i) => i % 2 === 1);
    expect(opts).toEqual(HARDENING_OPTIONS);
    for (const opt of [
      'StrictHostKeyChecking=yes',
      'GlobalKnownHostsFile=/dev/null',
      'UpdateHostKeys=no',
      'CheckHostIP=no',
      'ForwardAgent=no',
      'ForwardX11=no',
      'ClearAllForwardings=yes',
      'PermitLocalCommand=no',
      'PubkeyAuthentication=yes',
      'PreferredAuthentications=publickey',
      'PasswordAuthentication=no',
      'KbdInteractiveAuthentication=no',
      'IdentitiesOnly=yes',
      'ConnectTimeout=30',
      'ServerAliveInterval=30',
      'ServerAliveCountMax=3',
      'BatchMode=yes',
      `UserKnownHostsFile=${base.pinFile}`,
      `HostKeyAlias=${hostKeyAlias('Home-Lab')}`,
      'ProxyCommand=/usr/bin/node /opt/psc/dist/cli.js gateway proxy Home-Lab',
      'ControlMaster=no',
      'ControlPath=none',
      'ControlPersist=no',
    ]) {
      expect(argv).toContain(opt);
    }
    expect(argv.slice(-5)).toEqual(['me', '-T', '--', hostKeyAlias('Home-Lab'), 'pocketshell sessions list --json']);
  });

  it('attach: -t, no BatchMode; legacy alias accepted; foreign alias refused', () => {
    const argv = buildGatewaySshArgv({ ...base, alias: legacyHostKeyAlias('Home-Lab'), kind: 'attach', command: 'x' });
    expect(argv).not.toContain('BatchMode=yes');
    expect(argv.slice(-4)).toEqual(['-t', '--', 'pocketshell-gateway.Home-Lab', 'x']);
    expect(() => buildGatewaySshArgv({ ...base, alias: hostKeyAlias('other'), kind: 'exec', command: 'x' })).toThrow(/alias/);
  });

  it('without a control dir, multiplexing is explicitly off', () => {
    const argv = buildGatewaySshArgv({ ...base, statusDir: null, kind: 'exec', command: 'x' });
    expect(argv).toContain('ControlMaster=no');
    expect(argv).toContain('ControlPath=none');
    expect(argv).toContain('ControlPersist=no');
  });

  it('refuses unsafe users and paths', () => {
    expect(() => buildGatewaySshArgv({ ...base, user: '-oX', kind: 'exec', command: 'x' })).toThrow(/login name/);
    expect(() => buildGatewaySshArgv({ ...base, user: 'a b', kind: 'exec', command: 'x' })).toThrow(/login name/);
    expect(() => buildGatewaySshArgv({ ...base, pinFile: '/home/a b/pins', kind: 'exec', command: 'x' })).toThrow(/pin file/);
    expect(() => buildGatewaySshArgv({ ...base, pinFile: 'relative/pins', kind: 'exec', command: 'x' })).toThrow(/absolute/);
    expect(() => buildGatewaySshArgv({ ...base, identityFile: '/nonexistent/key', kind: 'exec', command: 'x' })).toThrow(/does not exist/);
    expect(() => buildGatewaySshArgv({ ...base, identityFile: '/tmp/%h', kind: 'exec', command: 'x' })).toThrow(/identity file/);
  });
});

describe('openGatewayConnection', () => {
  it('refuses to run without a pin (NOT_PINNED) and with a bad server (usage)', async () => {
    await expect(openGatewayConnection('lab', { deviceId: 'nopin-box' })).rejects.toMatchObject({
      code: 'NOT_PINNED',
      exitCode: 4,
    });
    await expect(openGatewayConnection('lab', { deviceId: 'nopin-box', server: 'wss://x.example/path' })).rejects.toMatchObject({
      exitCode: 2,
    });
    await expect(openGatewayConnection('lab', { deviceId: 'bad id' })).rejects.toBeInstanceOf(ConnectionError);
  });
});

// --- end to end ---------------------------------------------------------------

const HOST_KEY_FILE = '/etc/ssh/ssh_host_ed25519_key.pub';
function localSshWorks(): boolean {
  if (!existsSync(HOST_KEY_FILE)) return false;
  const probe = spawnSync(
    'ssh',
    ['-F', 'none', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'ConnectTimeout=5', '-o', 'LogLevel=ERROR', 'localhost', 'true'],
    { timeout: 10_000 },
  );
  return probe.status === 0;
}

const e2e = localSshWorks();

describe.skipIf(!e2e)('end to end through a fake gateway to the local sshd', () => {
  let wss: WebSocketServer;
  let port = 0;
  let connections = 0;
  let mode: 'bridge' | 'offline' = 'bridge';
  let controlDir: string;
  const fixture = resolve(__dirname, 'fixtures/gateway-proxy-runner.ts');
  const invocation = [process.execPath, '--import', createRequire(fixture).resolve('tsx'), fixture];

  beforeAll(async () => {
    controlDir = mkdtempSync('/tmp/psc-e2e-');
    wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((r) => wss.once('listening', () => r()));
    port = (wss.address() as AddressInfo).port;
    wss.on('connection', (ws) => {
      connections++;
      ws.once('message', (data) => {
        const auth = JSON.parse(data.toString());
        if (auth.token !== 'test-token' || mode === 'offline') {
          ws.send(JSON.stringify({ type: 'error', v: 1, code: 'host_offline', message: 'host is offline' }));
          ws.close(4503);
          return;
        }
        const tcp = connect(22, '127.0.0.1');
        tcp.on('connect', () => ws.send(JSON.stringify({ type: 'ready', v: 1, device_id: auth.device_id, ssh_host_key: '' })));
        tcp.on('data', (chunk) => ws.send(chunk, { binary: true }));
        tcp.on('close', () => ws.close(1000));
        tcp.on('error', () => ws.close(1011));
        ws.on('message', (chunk: Buffer) => tcp.write(chunk));
        ws.on('close', () => tcp.destroy());
      });
    });
    const [type, b64] = readFileSync(HOST_KEY_FILE, 'utf8').trim().split(' ');
    addPin('local-box', parseHostKey(`${type} ${b64}`));
  });

  afterAll(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((r) => wss.close(() => r()));
    rmSync(controlDir, { recursive: true, force: true });
  });

  function connection(deviceId: string, statusDir: string | null): GatewayConnection {
    return new GatewayConnection('lab', findSsh(), {
      deviceId,
      endpoint: resolveEndpoint(`ws://127.0.0.1:${port}`, true),
      pinFile: pinFilePath(),
      alias: hostKeyAlias(deviceId),
      statusDir,
      invocation,
    });
  }

  it('runs each command over a fresh tunnel', async () => {
    const conn = connection('local-box', controlDir);
    const before = connections;
    let t = Date.now();
    const first = await conn.exec(`printf '%s\\n' "it's" "$((6*7))"; echo err >&2; exit 7`, { timeoutMs: 30_000 });
    const firstMs = Date.now() - t;
    expect(first).toMatchObject({ exitCode: 7, stdout: "it's\n42\n", timedOut: false });
    expect(first.stderr).toContain('err');
    t = Date.now();
    const second = await conn.exec('cat', { timeoutMs: 30_000, stdin: 'piped stdin' });
    const secondMs = Date.now() - t;
    expect(second).toMatchObject({ exitCode: 0, stdout: 'piped stdin' });
    expect(connections - before).toBe(2); // each exec reauthorizes and repins
    console.log(`gateway e2e: first exec ${firstMs} ms, fresh second exec ${secondMs} ms`);
  }, 60_000);

  it('a key that does not match the pin is a HOST_KEY_FAILED ConnectionError', async () => {
    addPin('wrong-key', parseHostKey('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGuV1O9rNRp7VtgPq3H6Mze4PugDi32wsIYRrGAzHWLb'));
    await expect(connection('wrong-key', null).exec('true', { timeoutMs: 30_000 })).rejects.toMatchObject({
      code: 'HOST_KEY_FAILED',
      exitCode: 4,
    });
  }, 60_000);

  it('a gateway refusal surfaces as the proxy-classified code (HOST_OFFLINE)', async () => {
    addPin('offline-box', parseHostKey('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGuV1O9rNRp7VtgPq3H6Mze4PugDi32wsIYRrGAzHWLb'));
    mode = 'offline';
    try {
      const error = await connection('offline-box', null)
        .exec('true', { timeoutMs: 30_000 })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(error).toBeInstanceOf(ConnectionError);
      expect(error).toMatchObject({ code: 'HOST_OFFLINE', exitCode: 4 });
      expect((error as Error).message).toMatch(/host is offline.*gateway run/);
    } finally {
      mode = 'bridge';
    }
  }, 60_000);

  // --- independent per-invocation status receipts --------------------------

  const wrongKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGuV1O9rNRp7VtgPq3H6Mze4PugDi32wsIYRrGAzHWLb';
  const withStatus = (id: string) => connection(id, controlDir);
  const leftovers = () => readdirSync(controlDir).filter((name) => name.startsWith('st-'));

  it('the proxy stderr marker is retained without multiplexing', async () => {
    addPin('offline-mux', parseHostKey(wrongKey));
    mode = 'offline';
    try {
      const raw = await runSshCaptured(findSsh(), withStatus('offline-mux').argv('exec', 'true'), { timeoutMs: 30_000 });
      expect(raw.exitCode).toBe(255);
      expect(raw.stderr).toContain(PROXY_MARKER);
      expect(raw.stderr).toMatch(/Connection closed by UNKNOWN port 65535/);
    } finally {
      mode = 'bridge';
    }
  }, 60_000);

  it('status: a host-offline refusal is HOST_OFFLINE (exit 4), not CONNECT_FAILED', async () => {
    addPin('offline-mux', parseHostKey(wrongKey));
    mode = 'offline';
    try {
      const error = await withStatus('offline-mux')
        .exec('true', { timeoutMs: 30_000 })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(error).toBeInstanceOf(ConnectionError);
      expect(error).toMatchObject({ code: 'HOST_OFFLINE', exitCode: 4 });
      expect((error as Error).message).toMatch(/host is offline.*gateway run/);
      expect(leftovers()).toEqual([]);
    } finally {
      mode = 'bridge';
    }
  }, 60_000);

  it('status: a token-mint failure inside the proxy (broker 401) is NOT_LOGGED_IN, exit 3', async () => {
    addPin('nologin-mux', parseHostKey(wrongKey));
    process.env.PSC_TEST_GATEWAY_TOKEN_ERROR = 'Your PocketShell login is no longer valid; run `pocketshell-client login`.';
    const before = connections;
    try {
      await expect(withStatus('nologin-mux').exec('true', { timeoutMs: 30_000 })).rejects.toMatchObject({
        code: 'NOT_LOGGED_IN',
        exitCode: 3,
        message: expect.stringMatching(/login is no longer valid/),
      });
      expect(connections).toBe(before); // never dialed the gateway
      expect(leftovers()).toEqual([]);
    } finally {
      delete process.env.PSC_TEST_GATEWAY_TOKEN_ERROR;
    }
  }, 60_000);

  it('status: attach that never gets a session raises the typed error too', async () => {
    addPin('attach-mux', parseHostKey(wrongKey));
    mode = 'offline';
    try {
      await expect(withStatus('attach-mux').attachInteractive('true')).rejects.toMatchObject({ code: 'HOST_OFFLINE', exitCode: 4 });
      expect(leftovers()).toEqual([]);
    } finally {
      mode = 'bridge';
    }
  }, 60_000);

  it('status: remote exit 255 with output is passed through; empty ssh-like errors remain ambiguous', async () => {
    const conn = withStatus('local-box');
    const nested = await conn.exec(`echo 'ssh: connect to host inner port 22: Connection refused' >&2; exit 255`, {
      timeoutMs: 30_000,
    }).catch((error) => {
      expect(error).toMatchObject({ code: 'CONNECT_FAILED' });
      return null;
    });
    expect(nested).toBeNull();
    const withOutput = await conn.exec(`echo partial; echo 'Permission denied (publickey).' >&2; exit 255`, { timeoutMs: 30_000 });
    expect(withOutput).toMatchObject({ exitCode: 255, stdout: 'partial\n' });
    expect(leftovers()).toEqual([]);
  }, 60_000);
});
