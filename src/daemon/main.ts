/** Private backend reached only through the native listener's peer-UID boundary. */
import { registerHosts } from '../commands/hosts.js';
import { Command, CommanderError } from 'commander';
import { closeChannels, warmHost, pingHost } from './services.js';
import { preWarm, watchNetworkChanges } from './prewarm.js';
import { resolveAHost } from '../commands/a.js';
import { dispatchA } from '../commands/a.js';
import { fail, usageError } from '../output.js';
import { VERSION } from '../version.js';
import { requests, type RequestContext } from './context.js';
import { frames, sendFrame } from './framing.js';

/**
 * Keep recently used hosts warm: once at start, and again whenever the
 * network changes underneath us. Background-only — it never touches the
 * idle timer (which counts client requests, not this traffic).
 */
const reWarm = (): void => {
  void preWarm(warmHost);
};
reWarm();
watchNetworkChanges(reWarm);
interface Request {
  protocol: number;
  id: string;
  namespace: string;
  argv: string[];
  stdin: string | null;
  tty: boolean;
  deadline: number;
  cancel?: boolean;
}
const active = new Map<string, AbortController>();
process.once('SIGTERM', () => {
  for (const controller of active.values()) controller.abort();
  closeChannels();
  process.stdin.destroy();
});
let writes = Promise.resolve();
let queuedBytes = 0;
function reply(id: string, kind: string, data = '', status = 0, fallback = false): void {
  const bytes = Buffer.byteLength(data);
  if (queuedBytes + bytes > 32 << 20) throw Error('daemon output queue bounds');
  queuedBytes += bytes;
  writes = writes.then(() => sendFrame(process.stdout, { protocol: 1, id, kind, data, status, fallback }));
  writes = writes.finally(() => {
    queuedBytes -= bytes;
  });
  writes.catch(() => process.exit(1));
}
function supported(argv: string[]): boolean {
  const a = argv.filter((v) => v !== '--json');
  // `psc vault status` is the local vault command, never `<host> status` (an older relay may still send it).
  if (a[0] === 'vault') return false;
  if (a[0] === 'a') a.shift();
  return a[0] === 'hosts'
    ? a.length === 1 || a[1] === '--check' || a[1] === 'check'
    : ['ls', 'list', 'status', 'show', 'send', 'capture'].includes(a[1] ?? '');
}
async function dispatch(r: Request): Promise<void> {
  if (r.cancel) {
    active.get(r.id)?.abort();
    return;
  }
  if (
    r.protocol !== 1 ||
    r.namespace !== process.env.PSC_DAEMON_NAMESPACE ||
    !/^[a-f0-9]{32}$/.test(r.id) ||
    !Array.isArray(r.argv) ||
    r.argv.length > 256 ||
    r.argv.some((v) => typeof v !== 'string') ||
    r.deadline <= Date.now() ||
    r.deadline > Date.now() + 61_000 ||
    active.size >= 64 ||
    active.has(r.id)
  )
    throw Error('invalid request');
  const controller = new AbortController();
  active.set(r.id, controller);
  let outputBytes = 0;
  const context: RequestContext = {
    json: r.argv.includes('--json') || process.env.PSC_JSON === '1',
    stdin: Buffer.from(r.stdin ?? '', 'base64').toString('utf8'),
    tty: r.tty,
    exitCode: 0,
    signal: controller.signal,
    write: (stream, text) => {
      outputBytes += Buffer.byteLength(text);
      if (outputBytes > 16 << 20) throw Error('output bounds');
      // Individual frames stay bounded even for a large capture.
      for (let i = 0; i < text.length; ) {
        let end = Math.min(text.length, i + 64 * 1024);
        if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff)
          end--;
        reply(r.id, stream, text.slice(i, end));
        i = end;
      }
    },
  };
  const timer = setTimeout(() => controller.abort(), Math.max(1, r.deadline - Date.now()));
  try {
    await requests.run(context, async () => {
      if (r.argv[0] === 'daemon') {
        switch (r.argv[1]) {
          case 'noop':
            break;
          case 'reconnect':
            closeChannels();
            reWarm();
            break;
          case 'ping':
            if (!r.argv[2]) throw usageError('daemon ping requires a host');
            context.write(
              'stdout',
              JSON.stringify({ ok: true, result: await pingHost(resolveAHost(r.argv[2])) }) + '\n',
            );
            break;
          case 'warm':
            if (!r.argv[2]) throw usageError('daemon warm requires a host');
            await warmHost(resolveAHost(r.argv[2]));
            break;
          case 'start':
          case 'status':
            context.write(
              'stdout',
              JSON.stringify({
                running: true,
                protocol: 1,
                version: VERSION,
                pid: process.pid,
                active: active.size,
              }) + '\n',
            );
            break;
          default:
            throw usageError('daemon supports start, warm, noop, status, stop');
        }
      } else if (!supported(r.argv) || r.argv.includes('--help') || r.argv.includes('-h')) {
        reply(r.id, 'status', '', 0, true);
        return;
      } else {
        let argv = r.argv[0] === 'a' ? r.argv.slice(1) : r.argv;
        // Existing hosts check parser is a different top-level spelling; normalize only this spelling.
        if (
          argv.filter((v) => v !== '--json')[0] === 'hosts' &&
          argv.filter((v) => v !== '--json')[1] === 'check'
        ) {
          const program = new Command('psc');
          registerHosts(program);
          const configure = (command: Command): void => {
            command.exitOverride();
            command.configureOutput({ outputError: () => {} });
            for (const sub of command.commands) configure(sub);
          };
          configure(program);
          try {
            await program.parseAsync(
              argv.filter((v) => v !== '--json'),
              { from: 'user' },
            );
          } catch (error) {
            context.exitCode = fail(error instanceof CommanderError ? usageError(error.message) : error);
          }
          reply(r.id, 'status', '', context.exitCode);
          return;
        }
        try {
          await dispatchA(argv);
        } catch (error) {
          if (error instanceof CommanderError && error.exitCode === 0) context.exitCode = 0;
          else context.exitCode = fail(error instanceof CommanderError ? usageError(error.message) : error);
        }
      }
      reply(r.id, 'status', '', context.exitCode);
    });
  } catch (error) {
    requests.run(context, () => {
      context.exitCode = fail(error);
    });
    reply(r.id, 'status', '', context.exitCode);
  } finally {
    clearTimeout(timer);
    active.delete(r.id);
  }
}
try {
  for await (const value of frames(process.stdin))
    void dispatch(value as Request).catch(() => process.exit(1));
  for (const controller of active.values()) controller.abort();
  closeChannels();
  await writes;
} catch {
  closeChannels();
  process.exitCode = 1;
}
