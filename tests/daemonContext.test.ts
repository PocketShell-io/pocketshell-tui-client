import { describe,it,expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { requests, type RequestContext } from '../src/daemon/context.js';
import { frame,frames,MAX_FRAME } from '../src/daemon/framing.js';
import { emit,isJsonMode,setJsonMode } from '../src/output.js';
import { resolveSendText } from '../src/commands/a.js';
function context(json:boolean,stdin:string):RequestContext {return {json,stdin,tty:false,exitCode:0,signal:new AbortController().signal,write:()=>{}};}
describe('daemon request boundary',()=>{
 it('isolates concurrent JSON and stdin without changing environment',async()=>{
 const env=process.env.PSC_HOST; const a=context(false,'a\n'),b=context(true,'b\n'); const outputs:string[]=[];
 a.write=(_,s)=>outputs.push(s); b.write=(_,s)=>outputs.push(s);
 await Promise.all([requests.run(a,async()=>{await new Promise(r=>setTimeout(r,5));expect(isJsonMode()).toBe(false);expect(await resolveSendText('-')).toBe('a');emit({ok:true},()=> 'human');}),requests.run(b,async()=>{setJsonMode(true);expect(await resolveSendText('-')).toBe('b');emit({ok:true},()=> 'wrong');})]);
 expect(outputs).toContain('human\n');expect(outputs).toContain('{"ok":true}\n');expect(process.env.PSC_HOST).toBe(env);
 });
 it('decodes fragmented and combined frames',async()=>{const s=new PassThrough();const f=frame({x:1});s.write(f.subarray(0,2));s.end(Buffer.concat([f.subarray(2),frame({x:2})]));const values=[];for await(const v of frames(s))values.push(v);expect(values).toEqual([{x:1},{x:2}]);});
 it('rejects oversized and truncated frames',async()=>{for(const data of [Buffer.from([0,0,0,3,1]),(()=>{const b=Buffer.alloc(4);b.writeUInt32BE(MAX_FRAME+1);return b;})()]){const s=new PassThrough();s.end(data);await expect((async()=>{for await(const _ of frames(s)) {}})()).rejects.toThrow();}});
});
