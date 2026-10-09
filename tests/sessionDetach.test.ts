import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInteractive } from '../src/transport/process.js';
const mock = vi.hoisted(() => ({ spawn: vi.fn(), legacy: vi.fn() }));
vi.mock('@lydell/node-pty', () => ({ spawn: mock.spawn }));
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: mock.legacy }));
function fixture() {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode: ReturnType<typeof vi.fn> };
  input.isTTY = true; input.isRaw = false; input.pause();
  input.setRawMode = vi.fn(value => { input.isRaw = value; });
  const output = new PassThrough() as PassThrough & { isTTY: boolean; columns: number; rows: number };
  output.isTTY = true; output.columns = 91; output.rows = 29;
  const exit = new EventEmitter(), data = new EventEmitter();
  const pty = { pid: 99999999, write: vi.fn(), resize: vi.fn(), pause: vi.fn(), resume: vi.fn(),
    kill: vi.fn(() => { queueMicrotask(() => exit.emit('exit', { exitCode: 255 })); }),
    onData: (f: (data: string) => void) => { data.on('data', f); return { dispose: () => data.off('data', f) }; },
    onExit: (f: (event: { exitCode: number }) => void) => { exit.on('exit', f); return { dispose: () => exit.off('exit', f) }; } };
  mock.spawn.mockReturnValue(pty);
  mock.legacy.mockImplementation(() => { const child = new EventEmitter(); queueMicrotask(() => child.emit('close', 255)); return child; });
  return { input, output, pty, exit, data };
}
afterEach(() => { vi.restoreAllMocks(); mock.spawn.mockReset(); mock.legacy.mockReset(); });
describe('production session detach opt-in', () => {
  it('consumes split Ctrl-b d, returns0, restores terminal and never forwards detach bytes', async () => {
    const f = fixture();
    const pending = runInteractive('/usr/bin/ssh', ['--', 'fixture', 'attach UUID'], { PATH: '/usr/bin' },
      { sessionDetach: true, input: f.input, output: f.output } as never);
    await vi.waitFor(() => expect(mock.spawn).toHaveBeenCalledOnce());
    f.input.write(Buffer.from([97, 2])); f.input.write(Buffer.from([100, 122]));
    expect(await pending).toBe(0);
    expect(f.pty.write.mock.calls.map(c => c[0])).toEqual([Buffer.from([97])]);
    expect(f.input.isRaw).toBe(false); expect(f.input.isPaused()).toBe(true);
    expect(f.input.listenerCount('data')).toBe(0); expect(f.output.listenerCount('resize')).toBe(0);
    expect(f.input.read()).toEqual(Buffer.from([122]));
    expect(mock.legacy).not.toHaveBeenCalled();
  });
  it('forwards prefix escapes/ordinary bytes and resizes real child PTY, restores on natural exit', async () => {
    const f = fixture();
    const pending = runInteractive('/usr/bin/ssh', ['--', 'fixture'], {}, { sessionDetach: true, input: f.input, output: f.output } as never);
    await vi.waitFor(() => expect(mock.spawn).toHaveBeenCalledOnce());
    f.input.write(Buffer.from([2, 2, 120, 2, 99])); f.output.columns = 113; f.output.rows = 37; f.output.emit('resize');
    expect(Buffer.concat(f.pty.write.mock.calls.map(c => c[0]))).toEqual(Buffer.from([2, 120, 2, 99]));
    expect(f.pty.resize).toHaveBeenCalledWith(113, 37);
    f.exit.emit('exit', { exitCode: 7 }); expect(await pending).toBe(7);
    expect(f.input.isRaw).toBe(false); expect(f.input.listenerCount('data')).toBe(0);
  });
  it('preserves inherited stdio for ordinary interactive execution', async () => {
    const f = fixture(); expect(await runInteractive('/bin/sh', ['-c', 'fixture'], {})).toBe(255);
    expect(mock.legacy).toHaveBeenCalledWith('/bin/sh', ['-c', 'fixture'], { stdio: 'inherit', env: {} });
    expect(mock.spawn).not.toHaveBeenCalled(); expect(f.input.setRawMode).not.toHaveBeenCalled();
  });
  it('refuses non-TTY, existing input reader, and concurrent ownership before taking terminal', async () => {
    const f = fixture(); f.input.isTTY = false;
    await expect(runInteractive('fixture', [], {}, { sessionDetach: true, input: f.input, output: f.output } as never)).rejects.toThrow(/exclusive/);
    f.input.isTTY = true; const reader = () => {}; f.input.on('data', reader);
    await expect(runInteractive('fixture', [], {}, { sessionDetach: true, input: f.input, output: f.output } as never)).rejects.toThrow(/exclusive/);
    f.input.off('data', reader); f.input.pause();
    const other = fixture(); mock.spawn.mockReturnValue(f.pty);
    const first = runInteractive('fixture', [], {}, { sessionDetach: true, input: f.input, output: f.output } as never);
    await expect(runInteractive('fixture', [], {}, { sessionDetach: true, input: other.input, output: other.output } as never)).rejects.toThrow(/exclusive/);
    await vi.waitFor(() => expect(mock.spawn).toHaveBeenCalledOnce());
    f.exit.emit('exit', { exitCode: 0 }); await first;
  });
  it('restores terminal/listeners after transport spawn error', async () => {
    const f = fixture(); mock.spawn.mockImplementation(() => { throw new Error('synthetic spawn failure'); });
    await expect(runInteractive('fixture', [], {}, { sessionDetach: true, input: f.input, output: f.output } as never)).rejects.toThrow(/spawn failure/);
    expect(f.input.isRaw).toBe(false); expect(f.input.isPaused()).toBe(true);
    expect(f.input.listenerCount('data')).toBe(0); expect(f.output.listenerCount('resize')).toBe(0);
  });
  it('restores terminal and refuses success on write failure', async () => {
    const f = fixture(); f.pty.write.mockImplementation(() => { throw new Error('synthetic write failure'); });
    const promise = runInteractive('fixture', [], {}, { sessionDetach: true, input: f.input, output: f.output } as never);
    const refused = expect(promise).rejects.toThrow(/write failure/);
    await vi.waitFor(() => expect(mock.spawn).toHaveBeenCalledOnce()); f.input.write('literal'); await refused;
    expect(f.input.isRaw).toBe(false); expect(f.input.listenerCount('data')).toBe(0);
  });
  it('cleans up at an explicit deadline and removes signal/exit listeners', async () => {
    const f = fixture(); const before = ['SIGINT', 'SIGTERM', 'SIGHUP', 'exit'].map(e => process.listenerCount(e));
    await expect(runInteractive('fixture', [], {}, { sessionDetach: true, input: f.input, output: f.output, timeoutMs: 20 } as never)).rejects.toThrow(/deadline/);
    expect(f.input.isRaw).toBe(false); expect(['SIGINT', 'SIGTERM', 'SIGHUP', 'exit'].map(e => process.listenerCount(e))).toEqual(before);
  });
  it('restores after input EOF and SIGTERM, without reporting local detach success', async () => {
    for (const trigger of ['end', 'SIGTERM']) {
      const f = fixture();
      f.pty.kill.mockImplementation(() => { queueMicrotask(() => f.exit.emit('exit', { exitCode: 0, signal: 15 })); });
      const promise = runInteractive('fixture', [], {}, { sessionDetach: true, input: f.input, output: f.output } as never);
      await vi.waitFor(() => expect(mock.spawn).toHaveBeenCalledTimes(trigger === 'end' ? 1 : 2));
      if (trigger === 'end') f.input.emit('end'); else process.emit('SIGTERM');
      expect(await promise).toBeNull(); expect(f.input.isRaw).toBe(false); expect(f.input.listenerCount('data')).toBe(0);
    }
  });

});
