/** Local terminal ownership for an explicitly opted-in session attachment. */
import type { ReadStream, WriteStream } from 'node:tty';
import type { IPty, IDisposable } from '@lydell/node-pty';

export interface SessionInteractiveOptions {
  sessionDetach?: boolean;
  /** Optional owner-supplied bound; session attaches have no default deadline. */
  timeoutMs?: number;
  input?: ReadStream;
  output?: WriteStream;
}
let terminalOwned = false;

export async function runSessionInteractive(file: string, argv: readonly string[], env: NodeJS.ProcessEnv,
  options: SessionInteractiveOptions): Promise<number | null> {
  const input = options.input ?? process.stdin, output = options.output ?? process.stdout;
  if (!input.isTTY || !output.isTTY || input.readableEncoding !== null || input.listenerCount('data') !== 0 || terminalOwned) {
    throw new Error('Session detach requires exclusive ownership of a byte-mode local terminal.');
  }
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) throw new Error('Invalid session attach deadline.');
  terminalOwned = true;
  try {
    const { spawn } = await import('@lydell/node-pty');
    if (input.listenerCount('data') !== 0) throw new Error('Local terminal ownership changed while loading PTY support.');
    return await new Promise<number | null>((resolve, reject) => {
      const raw = Boolean(input.isRaw), flowing = input.readableFlowing;
      let child: IPty | undefined, done = false, stopping = false, detached = false, prefix = false;
      let failure: unknown;
      let windowsFinishing = false;
      let childExit!: () => void;
      let childExitCode: number | null = null;
      const childExited = new Promise<void>(resolve => { childExit = resolve; });
      const disposables: IDisposable[] = [], timers: NodeJS.Timeout[] = [];
      const dimensions = () => ({ cols: Math.max(1, output.columns || 80), rows: Math.max(1, output.rows || 24) });
      const kill = (signal: NodeJS.Signals) => {
        if (!child) return;
        if (process.platform !== 'win32') {
          try { process.kill(-child.pid, signal); } catch { /* group already closed */ }
          // Backend kill also closes its PTY; used on Windows without a signal.
        }
        try { child.kill(process.platform === 'win32' ? undefined : signal); } catch { /* already closed */ }
      };
      const restore = () => {
        input.off('data', onInput); input.off('end', onEnd); input.off('error', onError);
        output.off('resize', onResize); output.off('drain', onDrain); output.off('error', onError);
        process.off('exit', onProcessExit);
        for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.off(signal, onSignal);
        for (const timer of timers) clearTimeout(timer);
        for (const disposable of disposables) disposable.dispose();
        // Restoring is attempted even when startup or transport throws.
        try { input.setRawMode(raw); } finally { if (flowing === true) input.resume(); else input.pause(); }
      };
      const finish = (code: number | null) => {
        if (done) return;
        if (process.platform === 'win32' && child) {
          if (windowsFinishing) return;
          windowsFinishing = true; stopping = true;
          input.pause(); input.off('data', onInput);
          const owned = child as IPty & { shutdownAsync?: () => Promise<void> };
          const bound = new Promise<never>((_resolve, reject) => {
            timers.push(setTimeout(() => reject(new Error(
              'Windows cleanup incomplete after eight seconds; detach success refused.')), 8000));
          });
          const cleanup = Promise.resolve().then(() => {
            if (typeof owned.shutdownAsync !== 'function') {
              throw new Error('Qualified Windows PTY cleanup completion bridge is required.');
            }
            return owned.shutdownAsync();
          });
          const complete = () => {
            done = true;
            try { restore(); } catch (error) { failure ??= error; }
            if (failure) reject(failure); else resolve(detached ? 0 : childExitCode);
          };
          Promise.race([Promise.all([cleanup, childExited]), bound]).then(complete, error => {
            failure ??= error; complete();
          });
          return;
        }
        done = true;
        // This owns only the local PTY child family, never the remote worker.
        kill('SIGKILL');
        try { restore(); } catch (error) { failure ??= error; }
        if (failure) reject(failure); else resolve(detached ? 0 : code);
      };
      const stop = (isDetach: boolean, error?: unknown) => {
        if (done || stopping) return;
        stopping = true; detached = isDetach; failure = error;
        input.pause(); input.off('data', onInput);
        if (process.platform === 'win32' && child) { finish(null); return; }
        kill('SIGTERM');
        if (done) return;
        timers.push(setTimeout(() => {
          kill('SIGKILL');
          if (!done) timers.push(setTimeout(() => { failure ??= new Error('Local session transport did not exit after cancellation.'); finish(null); }, 1000));
        }, 2000));
      };
      const onInput = (chunk: Buffer) => {
        if (stopping || done) return;
        const bytes: number[] = [];
        for (let index = 0; index < chunk.length; index++) {
          const byte = chunk[index]!;
          if (prefix) {
            prefix = false;
            if (byte === 0x64) {
              try {
                if (bytes.length) child!.write(Buffer.from(bytes));
                stop(true);
                if (index + 1 < chunk.length) input.unshift(chunk.subarray(index + 1));
              } catch (error) { stop(false, error); }
              return;
            }
            bytes.push(0x02);
            if (byte === 0x02) continue; // Ctrl-b Ctrl-b is a literal prefix.
          } else if (byte === 0x02) { prefix = true; continue; }
          bytes.push(byte);
        }
        if (bytes.length) {
          try { child!.write(Buffer.from(bytes)); } catch (error) { stop(false, error); }
        }
      };
      const onResize = () => { try { const { cols, rows } = dimensions(); child!.resize(cols, rows); } catch (error) { stop(false, error); } };
      const onDrain = () => { if (!stopping && !done) child?.resume(); };
      const onEnd = () => stop(false);
      const onError = (error: Error) => stop(false, error);
      const onSignal = () => stop(false);
      const onProcessExit = () => { kill('SIGKILL'); try { restore(); } catch { /* OS process exits */ } };
      try {
        child = spawn(file, [...argv], { ...dimensions(), env, name: env.TERM ?? 'xterm-256color', encoding: null, handleFlowControl: false });
        disposables.push(child.onExit(event => {
          childExitCode = event.signal ? null : event.exitCode;
          childExit();
          finish(childExitCode);
        }));
        disposables.push(child.onData(data => {
          if (!done) { try { if (!output.write(data)) child!.pause(); } catch (error) { stop(false, error); } }
        }));
        input.setRawMode(true);
        input.on('data', onInput); input.on('end', onEnd); input.on('error', onError);
        output.on('resize', onResize); output.on('drain', onDrain); output.on('error', onError);
        process.on('exit', onProcessExit);
        for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, onSignal);
        if (options.timeoutMs !== undefined) timers.push(setTimeout(() => stop(false, new Error('Session attach deadline exceeded.')), options.timeoutMs));
        input.resume();
      } catch (error) { failure = error; finish(null); }
    });
  } finally { terminalOwned = false; }
}
