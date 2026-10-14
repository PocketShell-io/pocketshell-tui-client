/** Private backend reached only through the native listener's peer-UID boundary. */
import { CommanderError } from 'commander';
import { dispatchA } from '../commands/a.js';
import { fail, usageError } from '../output.js';
import { VERSION } from '../version.js';
import { requests, type RequestContext } from './context.js';
import { frames, sendFrame } from './framing.js';
interface Request { protocol: number; id: string; namespace: string; argv: string[]; stdin: string | null; tty: boolean; deadline: number; cancel?: boolean }
const active = new Map<string,AbortController>();
let writes = Promise.resolve();
function reply(id: string, kind: string, data = '', status = 0, fallback = false): void {
  writes = writes.then(() => sendFrame(process.stdout, { protocol:1,id,kind,data,status,fallback }));
  writes.catch(() => process.exit(1));
}
function supported(argv: string[]): boolean {
  const a = argv.filter(v=>v!=='--json');
  if (a[0]==='a') a.shift();
  return a[0]==='hosts' ? a.length===1 || a[1]==='--check' || a[1]==='check' : ['ls','list','status','show','send','capture'].includes(a[1] ?? '');
}
async function dispatch(r: Request): Promise<void> {
  if (r.cancel) { active.get(r.id)?.abort(); return; }
  if (r.protocol!==1 || r.namespace!==process.env.PSC_DAEMON_NAMESPACE || !/^[a-f0-9]{32}$/.test(r.id) || !Array.isArray(r.argv) || r.argv.length>256 || r.argv.some(v=>typeof v!=='string') || r.deadline<=Date.now() || r.deadline>Date.now()+61_000 || active.size>=64 || active.has(r.id)) throw Error('invalid request');
  const controller = new AbortController(); active.set(r.id,controller);
  let outputBytes=0;
  const context: RequestContext = { json:r.argv.includes('--json') || process.env.PSC_JSON==='1',stdin:Buffer.from(r.stdin??'','base64').toString('utf8'),tty:r.tty,exitCode:0,signal:controller.signal,write:(stream,text)=>{
    outputBytes+=Buffer.byteLength(text); if (outputBytes>16<<20) throw Error('output bounds');
    // Individual frames stay bounded even for a large capture.
    for (let i=0;i<text.length;i+=64*1024) reply(r.id,stream,text.slice(i,i+64*1024));
  }};
  const timer = setTimeout(()=>controller.abort(),Math.max(1,r.deadline-Date.now()));
  try {
    await requests.run(context, async()=>{
      if (r.argv[0]==='daemon') {
        switch(r.argv[1]) {
          case 'noop': break;
          case 'start':
          case 'status': context.write('stdout',JSON.stringify({running:true,protocol:1,version:VERSION,pid:process.pid,active:active.size})+'\n'); break;
          default: throw usageError('daemon supports start, noop, status, stop');
        }
      } else if (!supported(r.argv) || r.argv.includes('--help') || r.argv.includes('-h')) { reply(r.id,'status','',0,true); return; }
      else {
        let argv=r.argv[0]==='a'?r.argv.slice(1):r.argv;
        // Existing hosts check parser is a different top-level spelling; normalize only this spelling.
        if(argv[0]==='hosts'&&argv[1]==='check') { reply(r.id,'status','',0,true); return; }
        try { await dispatchA(argv); }
        catch(error) {
          if(error instanceof CommanderError&&error.exitCode===0) context.exitCode=0;
          else context.exitCode=fail(error instanceof CommanderError?usageError(error.message):error);
        }
      }
      reply(r.id,'status','',context.exitCode);
    });
  } catch { reply(r.id,'stderr','psc: daemon operation failed\n'); reply(r.id,'status','',1); }
  finally { clearTimeout(timer); active.delete(r.id); }
}
try {
  for await (const value of frames(process.stdin)) void dispatch(value as Request).catch(()=>process.exit(1));
  for(const controller of active.values()) controller.abort();
  await writes;
} catch { process.exitCode=1; }
