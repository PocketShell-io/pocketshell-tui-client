/** output.ts: error classification (cause unwrapping, timeouts) and the JSON error document. */
import { HostCliFailed, HostCliTooOld } from '@pocketshell/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotLoggedIn } from '../src/account/errors.js';
import { HostCommandError, SessionAmbiguous, SessionNotFound } from '../src/hostClient.js';
import { HostStoreError } from '../src/hosts/store.js';
import { classify, CliError, fail, setJsonMode } from '../src/output.js';
import { ConnectionError } from '../src/transport/types.js';

const row = (name: string, id: string) => ({
  name, id, workspace: null, tag: null, engine: null, profile: null, agent: null,
  agentState: null, agentStateSource: null, attached: false, createdEpoch: null, activityEpoch: null,
});

function wrapped(cause: unknown): HostCliFailed {
  return new HostCliFailed('pocketshell sessions list --json', null, '', false, 'Could not run it', { cause });
}

describe('classify', () => {
  it("a ConnectionError under core's HostCliFailed wins: CONNECT_FAILED, exit 4", () => {
    const c = classify(wrapped(new ConnectionError('cannot reach bad', 'CONNECT_FAILED')));
    expect(c).toMatchObject({ code: 'CONNECT_FAILED', exit: 4, message: 'cannot reach bad' });
  });

  it('a typed cause (NOT_LOGGED_IN) wins too: exit 3', () => {
    expect(classify(wrapped(new NotLoggedIn()))).toMatchObject({ code: 'NOT_LOGGED_IN', exit: 3 });
  });

  it('a cause two levels down is found', () => {
    const middle = new Error('middle', { cause: new ConnectionError('offline', 'HOST_OFFLINE') });
    expect(classify(wrapped(middle))).toMatchObject({ code: 'HOST_OFFLINE', exit: 4 });
  });

  it('a plain transport failure stays HOST_CLI_FAILED, exit 6', () => {
    expect(classify(wrapped(new Error('boom')))).toMatchObject({ code: 'HOST_CLI_FAILED', exit: 6 });
    expect(classify(new HostCliTooOld(1, 2))).toMatchObject({ code: 'HOST_CLI_TOO_OLD', exit: 6 });
  });

  it('node errno causes are not mistaken for our codes', () => {
    const errno = Object.assign(new Error('pipe'), { code: 'EPIPE', errno: -32 });
    expect(classify(wrapped(errno))).toMatchObject({ code: 'HOST_CLI_FAILED', exit: 6 });
  });

  it('timeouts: TIMEOUT, exit 124, with the may-still-complete note', () => {
    const timedOut = new HostCliFailed('x', null, '', true, '`x` did not finish within 30000ms on the host.');
    const c = classify(timedOut);
    expect(c).toMatchObject({ code: 'TIMEOUT', exit: 124 });
    expect(c.message).toMatch(/may still complete/);
    const cmd = new HostCommandError('slow', { exitCode: null, stdout: '', stderr: '', timedOut: true });
    expect(classify(cmd)).toMatchObject({ code: 'TIMEOUT', exit: 124 });
    expect(classify(new HostCommandError('bad', { exitCode: 2, stdout: '', stderr: '', timedOut: false }))).toMatchObject({
      code: 'HOST_COMMAND_FAILED',
      exit: 1,
    });
  });

  it('systemd-run banners are not the error detail', () => {
    const stderr = 'Running as unit: run-u7.service; invocation ID: abc\nno such session\n';
    const error = new HostCliFailed(
      'k',
      1,
      stderr,
      false,
      '`k` failed on the host (exit 1): Running as unit: run-u7.service; invocation ID: abc',
    );
    expect(classify(error).message).toBe('`k` failed on the host (exit 1): no such session');
  });

  it('session, store and usage errors keep their exits', () => {
    expect(classify(new SessionNotFound('x'))).toMatchObject({ code: 'SESSION_NOT_FOUND', exit: 5 });
    expect(classify(new HostStoreError('bad'))).toMatchObject({ code: 'HOST_STORE', exit: 2 });
    expect(classify(new CliError('USAGE', 'nope', 2))).toMatchObject({ code: 'USAGE', exit: 2 });
    expect(classify(new Error('plain'))).toMatchObject({ code: 'ERROR', exit: 1 });
  });
});

describe('fail', () => {
  afterEach(() => vi.restoreAllMocks());

  it('JSON mode: one document on stdout, details merged into error, code/message not overridable', () => {
    setJsonMode(true);
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => (out.push(String(chunk)), true));
    const exit = fail(new SessionAmbiguous('rev', [row('a:rev', 'aaaa1'), row('b:rev', 'bbbb2')]));
    expect(exit).toBe(5);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toEqual({
      ok: false,
      error: {
        code: 'SESSION_AMBIGUOUS',
        message: expect.stringContaining('a:rev, b:rev'),
        candidates: [
          { name: 'a:rev', id: 'aaaa1' },
          { name: 'b:rev', id: 'bbbb2' },
        ],
      },
    });
    out.length = 0;
    fail(new CliError('TIMEOUT', 'slow', 124, { code: 'X', message: 'Y', text: 't' }));
    expect(JSON.parse(out[0]!)).toEqual({ ok: false, error: { code: 'TIMEOUT', message: 'slow', text: 't' } });
  });
});
