/**
 * The built CLI (`dist/cli.js`) as a subprocess: usage errors honour --json
 * (one document on stdout, code USAGE, exit 2), help/version still exit 0,
 * host config is validated at `hosts add`, and local `exec` keeps its
 * quoting/timeout contract. Temp XDG_CONFIG_HOME; nothing touches real
 * sessions.
 */
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');
const CLI = join(ROOT, 'dist', 'cli.js');
let xdg = '';

beforeAll(() => {
  execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'ignore' });
  xdg = mkdtempSync(join(tmpdir(), 'psc-cli-usage-'));
}, 120_000);
afterAll(() => {
  rmSync(xdg, { recursive: true, force: true });
});

function cli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { cwd: ROOT, env: { ...process.env, XDG_CONFIG_HOME: xdg, PSC_JSON: '', PSC_HOST: '', ...env }, timeout: 30_000 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        done({ code, stdout, stderr });
      },
    );
  });
}

/** Exactly one JSON document on stdout. */
function doc(stdout: string): Record<string, any> {
  const lines = stdout.trim().split('\n');
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!);
}

describe('usage errors', () => {
  const cases: Array<[string, string[]]> = [
    ['missing argument', ['sessions', 'create', '--json']],
    ['unknown subcommand', ['sessions', 'bogus', '--json']],
    ['unknown option', ['sessions', 'list', '--bogus', '--json']],
    ['unknown top-level option', ['--bogus', '--json']],
    ['non-numeric timeout', ['exec', '-t', 'abc', '--json', '--', 'true']],
    ['non-numeric --bytes', ['sessions', 'capture', 'x', '--raw', '--bytes', 'abc', '--json']],
    ['--port with no value', ['hosts', 'add', 'z', '--ssh', 'h', '--json', '-p']],
    ['bad port', ['hosts', 'add', 'z', '--ssh', 'h', '-p', '99999', '--json']],
    ['missing subcommand', ['sessions', '--json']],
    ['--bytes without --raw', ['sessions', 'capture', 'x', '--bytes', '10', '--json']],
    ['bad --wait-for regex', ['sessions', 'capture', 'x', '--wait-for', '(', '--json']],
    ['create --attach --json', ['sessions', 'create', 'x', '--attach', '--json']],
  ];
  for (const [label, args] of cases) {
    it(`${label} → USAGE, exit 2, one JSON document`, async () => {
      const r = await cli(args);
      expect(r.code).toBe(2);
      expect(doc(r.stdout)).toMatchObject({ ok: false, error: { code: 'USAGE', message: expect.any(String) } });
    });
  }

  it('PSC_JSON=1 works without --json', async () => {
    const r = await cli(['sessions', 'kill'], { PSC_JSON: '1' });
    expect(r.code).toBe(2);
    expect(doc(r.stdout)).toMatchObject({ ok: false, error: { code: 'USAGE' } });
  });

  it('human mode: a one-line error on stderr, nothing on stdout, exit 2', async () => {
    const r = await cli(['sessions', 'create']);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe("error: missing required argument 'name' (see --help)\n");
  });

  it('--help and --version still exit 0', async () => {
    const help = await cli(['sessions', 'send', '--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toMatch(/NOT submitted unless --enter/);
    expect(help.stdout).toMatch(/<workspace>:<tag>/);
    const version = await cli(['--version']);
    expect(version.code).toBe(0);
    expect(version.stdout).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('a --json after `--` belongs to the command, not psc', async () => {
    const r = await cli(['exec', '--', 'echo', '--json']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('--json\n');
  });
});

describe('hosts add validation', () => {
  const bad: Array<[string, string[]]> = [
    ['binary with shell syntax', ['hosts', 'add', 'h1', '--ssh', 'box', '--binary', 'pocketshell; echo x', '--json']],
    ['binary with a space', ['hosts', 'add', 'h2', '--ssh', 'box', '--binary', 'my pocketshell', '--json']],
    ['ssh destination starting with -', ['hosts', 'add', 'h3', '--ssh=-oProxyCommand=x', '--json']],
    ['ssh destination with whitespace', ['hosts', 'add', 'h4', '--ssh', 'a b', '--json']],
    ['bad gateway device id', ['hosts', 'add', 'h5', '--gateway', 'x', '--json']],
  ];
  for (const [label, args] of bad) {
    it(`${label} → HOST_STORE, exit 2`, async () => {
      const r = await cli(args);
      expect(r.code).toBe(2);
      expect(doc(r.stdout)).toMatchObject({ ok: false, error: { code: 'HOST_STORE' } });
    });
  }

  it('a plain ~ path binary is accepted', async () => {
    const r = await cli(['hosts', 'add', 'ok1', '--ssh', 'box', '--binary', '~/.local/bin/pocketshell', '--json']);
    expect(r.code).toBe(0);
    expect(doc(r.stdout)).toMatchObject({ ok: true, host: { binary: '~/.local/bin/pocketshell' } });
  });
});

describe('connection failures', () => {
  it('an unresolvable ssh host is CONNECT_FAILED, exit 4 (not HOST_CLI_FAILED)', async () => {
    await cli(['hosts', 'add', 'bad', '--ssh', 'nonexistent.invalid', '--replace', '--json']);
    const list = await cli(['sessions', 'list', '-H', 'bad', '--json']);
    expect(list.code).toBe(4);
    expect(doc(list.stdout)).toMatchObject({ ok: false, error: { code: 'CONNECT_FAILED' } });
    const check = await cli(['hosts', 'check', 'bad', '--json']);
    expect(check.code).toBe(4);
    expect(doc(check.stdout)).toMatchObject({ ok: false, error: { code: 'CONNECT_FAILED' } });
  }, 60_000);
});

describe('local exec', () => {
  it('several words are quoted, not re-split', async () => {
    const r = await cli(['exec', '--json', '--', 'printf', '%s|', 'a b', '$HOME']);
    expect(r.code).toBe(0);
    expect(doc(r.stdout)).toMatchObject({ ok: true, exitCode: 0, stdout: 'a b|$HOME|' });
  });

  it('a non-zero exit: ok:false, COMMAND_FAILED, exit = the exit code, fields kept', async () => {
    const r = await cli(['exec', '--json', 'echo out; exit 3']);
    expect(r.code).toBe(3);
    expect(doc(r.stdout)).toMatchObject({
      ok: false,
      exitCode: 3,
      stdout: 'out\n',
      error: { code: 'COMMAND_FAILED', message: 'exit 3' },
    });
  });

  it('a timeout: TIMEOUT, exit 124, in ~2 s, nothing left running', async () => {
    const secs = (15 + Math.random()).toFixed(4);
    const started = Date.now();
    const r = await cli(['exec', '-t', '2', '--json', '--', `sleep ${secs}; true`]);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r.code).toBe(124);
    expect(doc(r.stdout)).toMatchObject({ ok: false, timedOut: true, error: { code: 'TIMEOUT' } });
    let survivors = '';
    try {
      survivors = execFileSync('pgrep', ['-f', `sleep ${secs}`], { encoding: 'utf8' });
    } catch {
      /* none */
    }
    expect(survivors.trim()).toBe('');
  });
});

describe('whoami', () => {
  it('not logged in: the standard error document, exit 3', async () => {
    const r = await cli(['whoami', '--json']);
    expect(r.code).toBe(3);
    expect(doc(r.stdout)).toMatchObject({ ok: false, error: { code: 'NOT_LOGGED_IN' } });
  });
});
