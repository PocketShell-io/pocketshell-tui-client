/** Native Windows security authority. No shell or environment-selected helper. */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, win32, join } from 'node:path';
import { fileURLToPath } from 'node:url';
export class WindowsSecurityError extends Error {
  readonly code = 'WINDOWS_SECURITY';
  constructor() { super('Windows protected state or executable binding refused'); }
}
export interface WindowsBindings { version: 1; sshFamily: 'win32-openssh'; helper: string; helperSha256: string; ssh: string; sshSha256: string; node: string; nodeSha256: string; entry: string; entrySha256: string; systemRoot: string; }
export type Kind = 'credentials' | 'pins' | 'hosts' | 'empty' | 'status';
export interface NativeRequest { op: 'preflight' | 'read' | 'write' | 'remove' | 'exists' | 'check-executable' | 'check-identity'; root: string; kind?: Kind; name?: string; data?: string; path?: string; }
export interface NativeReply { version: 1; ok: boolean; code?: string; present?: boolean; data?: string; }
export function windowsAbsolute(value: string): string {
  if (!/^[A-Za-z]:[\\/]/.test(value) || /[\x00-\x1f\x7f]/.test(value) || value.slice(2).includes(':')) throw new WindowsSecurityError();
  if (value.split(/[\\/]/).slice(1).some(x => x === '.' || x === '..' || /[. ]$/.test(x) || /[<>"|?*]/.test(x))) throw new WindowsSecurityError();
  return win32.normalize(value);
}
export function quoteWindowsArg(value: string): string {
  if (/[\x00-\x1f\x7f%]/.test(value)) throw new WindowsSecurityError();
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
}
export function windowsProxyCommand(argv: readonly string[]): string {
  if (argv.length < 2) throw new WindowsSecurityError(); windowsAbsolute(argv[0]!);
  return argv.map(quoteWindowsArg).join(' ');
}
function sha(path: string): string { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
export function bindings(): WindowsBindings {
  // This file is supplied only by reviewed protected package staging, never by an env flag.
  try {
    const p = join(dirname(dirname(fileURLToPath(import.meta.url))), 'windows-bindings.json');
    const b = JSON.parse(readFileSync(p, 'utf8')) as WindowsBindings;
    if (b.version !== 1 || Object.keys(b).length !== 11 || b.sshFamily !== 'win32-openssh') throw new WindowsSecurityError();
    windowsAbsolute(b.systemRoot);
    for (const [path, digest] of [[b.helper,b.helperSha256],[b.ssh,b.sshSha256],[b.node,b.nodeSha256],[b.entry,b.entrySha256]]) {
      windowsAbsolute(path!); if (!/^[a-f0-9]{64}$/.test(digest!) || sha(path!) !== digest) throw new WindowsSecurityError();
      if (win32.normalize(realpathSync(path!)).toLowerCase() !== win32.normalize(path!).toLowerCase()) throw new WindowsSecurityError();
    }
    if (win32.basename(b.ssh).toLowerCase() !== 'ssh.exe' || win32.basename(b.helper).toLowerCase() !== 'psc-security.exe') throw new WindowsSecurityError();
    return b;
  } catch { throw new WindowsSecurityError(); }
}
export function callNative(request: NativeRequest): NativeReply {
  try {
    const b = bindings(); windowsAbsolute(request.root);
    const r = spawnSync(b.helper, [], { shell: false, windowsHide: true, stdio: ['pipe','pipe','pipe'],
      input: JSON.stringify({ version: 1, ...request }), encoding: 'utf8', timeout: 10000, maxBuffer: 2 * 1024 * 1024,
      cwd: dirname(b.helper), env: { SystemRoot: b.systemRoot, WINDIR: b.systemRoot } });
    if (r.error || r.status !== 0 || r.signal || r.stderr) throw new WindowsSecurityError();
    const v = JSON.parse(r.stdout) as NativeReply;
    if (v.version !== 1 || typeof v.ok !== 'boolean' || !v.ok || Object.keys(v).some(k => !['version','ok','present','data'].includes(k))) throw new WindowsSecurityError();
    if (v.present !== undefined && typeof v.present !== 'boolean') throw new WindowsSecurityError();
    if (v.data !== undefined && (typeof v.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v.data))) throw new WindowsSecurityError();
    return v;
  } catch { throw new WindowsSecurityError(); }
}
export function nativeRead(root: string, kind: Kind, name?: string): Buffer | null {
  const r=callNative({ op:'read',root,kind,...(name ? { name } : {}) });
  if (typeof r.present !== 'boolean' || (!r.present && r.data !== undefined)) throw new WindowsSecurityError();
  if (!r.present) return null; if (r.data === undefined) throw new WindowsSecurityError();
  const data=Buffer.from(r.data,'base64'); if (data.length > (kind==='credentials' ? 16384 : 1048576)) throw new WindowsSecurityError(); return data;
}
export function nativeWrite(root: string, kind: Kind, data: Uint8Array, name?: string): void {
  callNative({ op:'write',root,kind,data:Buffer.from(data).toString('base64'),...(name ? { name } : {}) });
}
export function closedWindowsEnvironment(roots: { config: string; runtime: string; home: string }, broker: string): NodeJS.ProcessEnv {
  const b=bindings(); for(const root of Object.values(roots)) windowsAbsolute(root);
  if (!broker.startsWith('https://') || new URL(broker).username || new URL(broker).password) throw new WindowsSecurityError();
  callNative({op:'preflight',root:roots.config}); callNative({op:'preflight',root:roots.runtime});
  callNative({op:'check-executable',root:roots.config,path:b.ssh}); callNative({op:'check-executable',root:roots.config,path:b.node}); callNative({op:'check-executable',root:roots.config,path:b.entry});
  return { SystemRoot:b.systemRoot,WINDIR:b.systemRoot,USERPROFILE:roots.home,HOME:roots.home,
    XDG_CONFIG_HOME:roots.config,XDG_RUNTIME_DIR:roots.runtime,TEMP:roots.runtime,TMP:roots.runtime,
    PATH:win32.dirname(b.ssh),POCKETSHELL_BROKER_URL:broker };
}
