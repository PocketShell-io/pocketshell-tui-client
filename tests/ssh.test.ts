import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  classifySshFailure,
  controlPathFor,
  explainSshExit,
  newStatusFilePath,
  PROXY_MARKER,
  runSshCaptured,
  shQuote,
  validateDestination,
  writeStatusFile,
} from '../src/transport/openssh.js';
import { buildSshArgv } from '../src/transport/ssh.js';
import { ConnectionError } from '../src/transport/types.js';

const tmp = mkdtempSync(join(tmpdir(), 'psc-ssh-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('buildSshArgv', () => {
  it('builds a batch-mode multiplexed exec with the command as ONE argv element', () => {
    const command = `PATH="$HOME/.local/bin:$PATH" pocketshell sessions list --json 'a b'`;
    const argv = buildSshArgv({
      config: { destination: 'box', port: 2222, user: 'me', identityFile: '/k/id' },
      controlPath: '/run/x/s-0123456789abcdef',
      kind: 'exec',
      command,
    });
    expect(argv.slice(0, 2)).toEqual(['-o', 'BatchMode=yes']);
    expect(argv).toContain('ConnectTimeout=15');
    expect(argv).toContain('ServerAliveInterval=15');
    expect(argv).toContain('ServerAliveCountMax=3');
    expect(argv).toContain('ControlMaster=auto');
    expect(argv).toContain('ControlPath=/run/x/s-0123456789abcdef');
    expect(argv).toContain('ControlPersist=60');
    expect(argv.join(' ')).toContain('-p 2222 -l me -i /k/id -o IdentitiesOnly=yes');
    expect(argv.slice(-4)).toEqual(['-T', '--', 'box', command]);
  });

  it('attach uses -t and no BatchMode; omits unset options', () => {
    const argv = buildSshArgv({ config: { destination: 'me@box' }, controlPath: null, kind: 'attach', command: 'aplexer attach x' });
    expect(argv).not.toContain('BatchMode=yes');
    expect(argv).not.toContain('-p');
    expect(argv).not.toContain('-i');
    expect(argv.some((a) => a.startsWith('ControlPath'))).toBe(false);
    expect(argv.slice(-4)).toEqual(['-t', '--', 'me@box', 'aplexer attach x']);
  });

  it('refuses option-injection and malformed destinations', () => {
    for (const bad of ['-oProxyCommand=evil', 'a b', 'x\ny', '', 'tab\there']) {
      expect(() => validateDestination(bad)).toThrow(ConnectionError);
    }
    expect(() => buildSshArgv({ config: { destination: 'ok', user: '-oX' }, controlPath: null, kind: 'exec', command: 'x' })).toThrow();
    expect(() => buildSshArgv({ config: { destination: 'ok', port: 70000 }, controlPath: null, kind: 'exec', command: 'x' })).toThrow();
    expect(validateDestination('user@host.example')).toBe('user@host.example');
  });
});

describe('classifySshFailure', () => {
  const ctx = { hostName: 'box', how: 'over ssh' };
  const fail = (stderr: string, exitCode: number | null = 255) => classifySshFailure({ exitCode, stderr, timedOut: false }, ctx);

  it.each([
    ['ssh: Could not resolve hostname nope: Name or service not known\n', 'CONNECT_FAILED'],
    ['ssh: connect to host 10.0.0.1 port 22: Connection refused\n', 'CONNECT_FAILED'],
    ['ssh: connect to host 10.0.0.1 port 22: Connection timed out\n', 'CONNECT_FAILED'],
    ['kex_exchange_identification: Connection closed by remote host\n', 'CONNECT_FAILED'],
    ['me@box: Permission denied (publickey,password).\n', 'AUTH_FAILED'],
    ['No ED25519 host key is known for box and you have requested strict checking.\nHost key verification failed.\n', 'HOST_KEY_FAILED'],
  ])('%s → %s', (stderr, code) => {
    const error = fail(stderr);
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error!.code).toBe(code);
    expect(error!.exitCode).toBe(4);
    expect(error!.message).toContain('box');
  });

  it('reads the proxy marker line, with exit 3 for NOT_LOGGED_IN', () => {
    const error = fail(`${PROXY_MARKER}: NOT_LOGGED_IN: not logged in\nConnection closed by UNKNOWN port 65535\n`);
    expect(error!.code).toBe('NOT_LOGGED_IN');
    expect(error!.exitCode).toBe(3);
    const offline = fail(`${PROXY_MARKER}: HOST_OFFLINE: gateway refused: host_offline: nope\n`);
    expect(offline!.code).toBe('HOST_OFFLINE');
    expect(offline!.exitCode).toBe(4);
  });

  it('leaves a remote command that merely exits 255 (or anything else) alone', () => {
    expect(fail('my script failed\n')).toBeNull();
    expect(fail('Permission denied (publickey).\n', 1)).toBeNull();
    expect(classifySshFailure({ exitCode: null, stderr: 'Connection refused', timedOut: true }, ctx)).toBeNull();
  });
});

describe('classifySshFailure: a remote command that exits 255 itself', () => {
  const ctx = { hostName: 'box', how: 'over ssh' };
  it('any stdout means the session ran: never a connection failure', () => {
    const outcome = { exitCode: 255, stdout: 'partial\n', stderr: 'ssh: connect to host inner port 22: Connection refused\n', timedOut: false };
    expect(classifySshFailure(outcome, ctx)).toBeNull();
    expect(classifySshFailure({ ...outcome, stdout: '' }, ctx)?.code).toBe('CONNECT_FAILED');
  });
});

describe('explainSshExit', () => {
  const ctx = { hostName: 'box', how: 'through the gateway', hint: { NOT_LOGGED_IN: 'run login' } };
  const nested = { exitCode: 255, stdout: '', stderr: 'ssh: connect to host inner port 22: Connection refused\n', timedOut: false };
  // Stand-ins for `ssh -O check`: exit 0 = a master is running, 1 = none.
  const live = { sshPath: '/bin/true', controlPath: join(tmp, 's-live') };
  const dead = { sshPath: '/bin/false', controlPath: join(tmp, 's-dead') };

  it('status file beats stderr: NOT_LOGGED_IN exit 3 although ssh only said "Connection closed"', async () => {
    const statusFile = newStatusFilePath(tmp);
    writeStatusFile(statusFile, `${PROXY_MARKER}: NOT_LOGGED_IN: not logged in`);
    const error = await explainSshExit(
      { exitCode: 255, stdout: '', stderr: 'Connection closed by UNKNOWN port 65535\r\n', timedOut: false },
      ctx,
      { ...dead, statusFile },
    );
    expect(error).toMatchObject({ code: 'NOT_LOGGED_IN', exitCode: 3 });
    expect(error!.message).toContain('run login');
    expect(existsSync(statusFile)).toBe(false); // consumed
  });

  it('status file beats a stderr marker, which beats generic ssh stderr', async () => {
    const statusFile = newStatusFilePath(tmp);
    writeStatusFile(statusFile, `${PROXY_MARKER}: HOST_OFFLINE: gateway refused: host_offline: asleep`);
    const stderr = `${PROXY_MARKER}: CONNECT_FAILED: other\nConnection closed by UNKNOWN port 65535\n`;
    const withFile = await explainSshExit({ exitCode: 255, stdout: '', stderr, timedOut: false }, ctx, { ...dead, statusFile });
    expect(withFile?.code).toBe('HOST_OFFLINE');
    const without = await explainSshExit({ exitCode: 255, stdout: '', stderr, timedOut: false }, ctx, { ...dead, controlPath: null });
    expect(without?.code).toBe('CONNECT_FAILED');
    expect(without?.message).toContain('other');
  });

  it('a status file is consumed but ignored when ssh did not exit 255', async () => {
    const statusFile = newStatusFilePath(tmp);
    writeStatusFile(statusFile, `${PROXY_MARKER}: HOST_OFFLINE: x`);
    expect(await explainSshExit({ exitCode: 0, stdout: '', stderr: '', timedOut: false }, ctx, { ...dead, statusFile })).toBeNull();
    expect(existsSync(statusFile)).toBe(false);
  });

  it('a live master after the run means our connection worked: the 255 is the remote command\'s', async () => {
    expect(await explainSshExit(nested, ctx, live)).toBeNull();
    expect((await explainSshExit(nested, ctx, dead))?.code).toBe('CONNECT_FAILED');
    // without multiplexing there is nothing to ask: stderr decides
    expect((await explainSshExit(nested, ctx, { ...live, controlPath: null }))?.code).toBe('CONNECT_FAILED');
  });

  it('the mux client\'s own complaint stays a connection failure even with a live master', async () => {
    const mux = { exitCode: 255, stdout: '', stderr: 'mux_client_request_session: session request failed: Session open refused by peer\n', timedOut: false };
    expect((await explainSshExit(mux, ctx, live))?.code).toBe('CONNECT_FAILED');
  });
});

describe('runSshCaptured', () => {
  it('returns promptly when a background process keeps stderr open (ControlPersist + ProxyCommand)', async () => {
    const started = Date.now();
    const outcome = await runSshCaptured('/bin/sh', ['-c', 'sleep 5 >/dev/null & echo out; echo err >&2; exit 3'], {
      timeoutMs: 10_000,
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(outcome).toMatchObject({ exitCode: 3, stdout: 'out\n', timedOut: false });
    expect(outcome.stderr).toContain('err');
  });

  it('feeds stdin and enforces the timeout', async () => {
    const echoed = await runSshCaptured('/bin/cat', [], { timeoutMs: 5_000, stdin: 'hello' });
    expect(echoed.stdout).toBe('hello');
    const slow = await runSshCaptured('/bin/sleep', ['5'], { timeoutMs: 200 });
    expect(slow.timedOut).toBe(true);
    expect(slow.exitCode).toBeNull();
  });

  it('on timeout escalates to SIGKILL and never waits on pipes a background child holds', async () => {
    const started = Date.now();
    // Ignores SIGTERM; a background child keeps both pipes open for 30 s.
    const stubborn = await runSshCaptured(
      '/bin/sh',
      ['-c', "trap '' TERM; sleep 30 & echo started; while :; do sleep 0.1; done"],
      { timeoutMs: 200 },
    );
    const took = Date.now() - started;
    expect(stubborn).toMatchObject({ exitCode: null, timedOut: true, stdout: 'started\n' });
    expect(took).toBeGreaterThanOrEqual(2_000); // waited for the SIGTERM grace
    expect(took).toBeLessThan(5_500); // SIGKILL + bounded settle, not the 30 s sleeper
  }, 10_000);

  it('settles shortly after exit even if a background child holds stdout', async () => {
    const started = Date.now();
    const outcome = await runSshCaptured('/bin/sh', ['-c', 'sleep 5 & echo out; exit 0'], { timeoutMs: 10_000 });
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(outcome).toMatchObject({ exitCode: 0, stdout: 'out\n', timedOut: false });
  });
});

describe('control sockets', () => {
  it('derives short, config-specific paths', () => {
    const a = controlPathFor('s', ['box', 22], tmp);
    const b = controlPathFor('s', ['box', 2222], tmp);
    expect(a).not.toBe(b);
    expect(a).toMatch(/\/s-[0-9a-f]{16}$/);
    expect(controlPathFor('s', ['box', 22], tmp)).toBe(a);
  });
});

describe('shQuote', () => {
  it('quotes like shlex.quote', () => {
    expect(shQuote('plain/path-1.js')).toBe('plain/path-1.js');
    expect(shQuote('a b')).toBe("'a b'");
    expect(shQuote("it's")).toBe(`'it'\\''s'`);
    expect(shQuote('')).toBe("''");
  });
});
