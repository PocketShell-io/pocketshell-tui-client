import { win32 } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const fake=vi.hoisted(()=>({calls:[] as any[],bad:false,present:true,body:'',writes:[] as string[]}));
vi.mock('node:fs',async(importOriginal)=>{
 const fs=await importOriginal<typeof import('node:fs')>();
 return {...fs,readFileSync:vi.fn((p:any)=>{
  const path=String(p);
  if(path.endsWith('windows-bindings.json')) {const d='7c1bff98308b66764533f8062caf9a7161c8af0b69b980e385214067c95633ef';return JSON.stringify({version:1,sshFamily:'win32-openssh',helper:'C:\\owned\\psc-security.exe',helperSha256:d,ssh:'C:\\system\\ssh.exe',sshSha256:d,node:'C:\\owned\\node.exe',nodeSha256:d,entry:'C:\\owned\\dist\\cli.js',entrySha256:d,systemRoot:'C:\\Windows'});}
  return Buffer.from('bound-fixture');
 }),realpathSync:vi.fn((p:any)=>p)};
});
vi.mock('node:child_process',()=>({spawnSync:vi.fn((file,argv,opts)=>{
 const req=JSON.parse(opts.input);fake.calls.push({file,argv,opts,req});
 if(fake.bad)return {status:1,stdout:'fake-secret',stderr:'fake-secret'};
 if(req.op==='write'){fake.writes.push(req.data);return {status:0,stdout:JSON.stringify({version:1,ok:true}),stderr:''};}
 const r:any={version:1,ok:true};if(['read','remove','exists'].includes(req.op))r.present=fake.present;
 if(req.op==='read'&&fake.present)r.data=Buffer.from(fake.body).toString('base64');
 return {status:0,stdout:JSON.stringify(r),stderr:''};
}),spawn:vi.fn(()=>{throw Error('real spawn forbidden')})}));
import { windowsAbsolute, windowsProxyCommand, callNative, closedWindowsEnvironment, nativeWrite } from '../src/platform/windows.js';
import { load, save, exists, remove, type Credentials } from '../src/account/credentials.js';
import { buildGatewaySshArgv } from '../src/transport/gateway.js';
import { resolveEndpoint, hostKeyAlias } from '../src/gateway/endpoint.js';
import { addPin, loadPinEntries, requirePinEntry, parseHostKey, fingerprint } from '../src/gateway/pins.js';
import { deviceLogin } from '../src/account/device.js';
const realPlatform=process.platform;
afterEach(()=>{Object.defineProperty(process,'platform',{value:realPlatform});fake.bad=false;fake.present=true;fake.calls=[];fake.writes=[];fake.body='';vi.unstubAllEnvs();});
function windows(){Object.defineProperty(process,'platform',{value:'win32'});vi.stubEnv('XDG_CONFIG_HOME','C:\\owned\\config');vi.stubEnv('XDG_RUNTIME_DIR','C:\\owned\\runtime');}
function roundtrip(s:string):string[]{
 const out:string[]=[];let i=0;
 while(i<s.length){while(s[i]===' ')i++;let v='',quoted=false;
  while(i<s.length&&(quoted||s[i]!==' ')){let n=0;while(s[i]==='\\'){n++;i++;}
   if(s[i]==='"'){v+='\\'.repeat(Math.floor(n/2));if(n%2)v+='"';else quoted=!quoted;i++;}
   else{v+='\\'.repeat(n);if(i<s.length)v+=s[i++]!;}
  }out.push(v);
 }return out;
}
describe('Windows source-only boundary',()=>{
 it.each(['C:relative','\\rooted','\\\\host\\share','C:/a/../b','C:/a:stream','C:/a.','C:/a ','C:/a?','C:/a\x00'])('refuses ambiguous native path %j',p=>expect(()=>windowsAbsolute(p)).toThrow());
 it.each([['C:\\owned\\node.exe','a b','tail\\','quote"x'],['C:\\owned\\node.exe','plain','$HOME','&|<>','é']])('round-trips CreateProcess arguments %j',(...args)=>{const argv=args as string[];expect(roundtrip(windowsProxyCommand(argv))).toEqual(argv);});
 it('refuses ssh percent expansions and controls',()=>{expect(()=>windowsProxyCommand(['C:/owned/node.exe','%h'])).toThrow();expect(()=>windowsProxyCommand(['C:/owned/node.exe','x\n'])).toThrow();});
 it('bound helper receives secret only via stdin, hidden shell=false and closed environment',()=>{
  nativeWrite('C:/owned/config','credentials',Buffer.from('fake-secret'));const c=fake.calls.at(-1);expect(c.file).toBe('C:\\owned\\psc-security.exe');expect(c.argv).toEqual([]);
  expect(c.opts.shell).toBe(false);expect(c.opts.windowsHide).toBe(true);expect(c.opts.stdio).toEqual(['pipe','pipe','pipe']);expect(Object.keys(c.opts.env).sort()).toEqual(['SystemRoot','WINDIR']);expect(JSON.stringify(c.argv)+JSON.stringify(c.opts.env)).not.toContain('fake-secret');
 });
 it('native failure never returns raw body or stderr',()=>{fake.bad=true;expect(()=>callNative({op:'preflight',root:'C:/owned/config'})).toThrow('Windows protected state or executable binding refused');});
 it('Windows credentials read/write remain strict and separate, native remove/exists',()=>{
  windows();const creds:Credentials={brokerUrl:'https://broker.example',accessToken:'psc_'+'A'.repeat(43),tokenId:'fake-id',email:'fixture@example.com',expiresAt:2000000000,label:'fixture'};
  save(creds);fake.body=Buffer.from(fake.writes.at(-1)!,'base64').toString();expect(load()).toEqual(creds);expect(exists()).toBe(true);expect(remove()).toBe(true);
  expect(fake.calls.every(c=>win32.normalize(c.req.root)==='C:\\owned\\config\\pocketshell-client-account')).toBe(true);
 });
 it('missing native credential returns not logged in',()=>{windows();fake.present=false;expect(()=>load()).toThrow('Not logged in');});
 it('native read cannot bypass strict credential schema',()=>{windows();fake.body='{"version":1,"access_token":"wrong"}';expect(()=>load()).toThrow('corrupt');});
 it('storage refusal precedes device flow fetch',async()=>{windows();fake.bad=true;const fetch=vi.fn();await expect(deviceLogin({baseUrl:'https://broker.example',label:'fixture',onPending:vi.fn(),fetch:fetch as any})).rejects.toThrow('Windows protected state');expect(fetch).not.toHaveBeenCalled();});
 it('fresh environment excludes unsafe inherited values',()=>{
  windows();vi.stubEnv('NODE_OPTIONS','--import evil');vi.stubEnv('SSH_AUTH_SOCK','fake-agent');vi.stubEnv('HTTPS_PROXY','https://fake-proxy');
  const env=closedWindowsEnvironment({config:'C:/owned/config',runtime:'C:/owned/runtime',home:'C:/owned/home'},'https://broker.example');
  expect(env.NODE_OPTIONS).toBeUndefined();expect(env.SSH_AUTH_SOCK).toBeUndefined();expect(env.HTTPS_PROXY).toBeUndefined();expect(env.SHELL).toBeUndefined();expect(env.POCKETSHELL_BROKER_URL).toBe('https://broker.example');expect(fake.calls.filter(c=>c.req.op==='check-executable')).toHaveLength(3);
 });
 it('actual Windows gateway argv retains no-reuse and full-pin alias, native proxy and empty global pins',()=>{
  windows();const args=buildGatewaySshArgv({deviceId:'fixture-device',endpoint:resolveEndpoint('wss://gateway.pocketshell.io',false),pinFile:'C:\\owned\\config\\gateway_known_hosts',alias:hostKeyAlias('fixture-device'),invocation:['C:\\owned\\node.exe','C:\\owned\\dist\\cli.js'],kind:'exec',command:'fixture-only'});
  for(const option of ['ControlMaster=no','ControlPath=none','ControlPersist=no','StrictHostKeyChecking=yes','IdentitiesOnly=yes','PasswordAuthentication=no']) expect(args).toContain(option);
  expect(args).not.toContain('GlobalKnownHostsFile=/dev/null');expect(args.some(x=>x.startsWith('GlobalKnownHostsFile=C:/'))).toBe(true);
  const proxy=args.find(x=>x.startsWith('ProxyCommand='))!.slice('ProxyCommand='.length);const decoded=roundtrip(proxy);expect(decoded.slice(0,2)).toEqual(['C:\\owned\\node.exe','C:\\owned\\dist\\cli.js']);expect(decoded).toContain('fixture-device');expect(decoded).toContain('gateway');
  expect(proxy).not.toContain("'/");expect(fake.calls.some(c=>c.req.kind==='empty'&&c.req.op==='write')).toBe(true);
 });
 it('gateway refuses a foreign alias, unbound invocation and plaintext endpoint',()=>{
  windows();const x:any={deviceId:'fixture-device',endpoint:resolveEndpoint('wss://gateway.pocketshell.io',false),pinFile:'C:/owned/pins',alias:hostKeyAlias('fixture-device'),invocation:['C:\\owned\\node.exe','C:\\owned\\dist\\cli.js'],kind:'exec',command:'fixture-only'};
  expect(()=>buildGatewaySshArgv({...x,alias:hostKeyAlias('foreign-device')})).toThrow('does not belong');
  expect(()=>buildGatewaySshArgv({...x,invocation:['C:/unbound/node.exe','C:/unbound/cli.js']})).toThrow('binding refused');
  expect(()=>buildGatewaySshArgv({...x,endpoint:resolveEndpoint('ws://localhost',true)})).toThrow('binding refused');
 });

 it('Windows full public pin is parsed and written through protected native custody',()=>{
  windows();const key=parseHostKey('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGuV1O9rNRp7VtgPq3H6Mze4PugDi32wsIYRrGAzHWLb');
  expect(addPin('fixture-device',key)).toBe(true);
  fake.body=Buffer.from(fake.writes.at(-1)!,'base64').toString();
  const entry=requirePinEntry('fixture-device');expect(entry.key).toEqual(key);expect(entry.alias).toBe(hostKeyAlias('fixture-device'));
  expect(fingerprint(entry.key)).toBe('SHA256:fsLMalVzTXS0DD6o65vqKTk5hByPaxy61KwmlbaaZiU');
  expect(fake.calls.every(c=>c.req.kind==='pins')).toBe(true);
  fake.body=`${hostKeyAlias('foreign-device')} ssh-ed25519 ${key.blobB64} fixture-device\n`;
  expect(()=>loadPinEntries()).toThrow('not a pocketshell gateway pin');
  fake.bad=true;expect(()=>loadPinEntries()).toThrow('Windows pin custody refused');
 });
 it('Windows protected pins reject wildcard, truncation, duplicate and malformed public blob',()=>{
  windows();const key='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGuV1O9rNRp7VtgPq3H6Mze4PugDi32wsIYRrGAzHWLb';
  const line=`${hostKeyAlias('fixture-device')} ${key} fixture-device`;
  for(const body of [`* ${key}\n`,line,line+'\n'+line+'\n',`${hostKeyAlias('fixture-device')} ssh-ed25519 AAAA fixture-device\n`]){
   fake.body=body;expect(()=>loadPinEntries()).toThrow();
  }
 });

});
