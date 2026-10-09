import { describe, expect, it } from 'vitest';
import { validateBinary, validateHostEntry, type HostEntry } from '../src/hosts/store.js';

const native: HostEntry = { name: 'alias', mode: 'gateway', gateway: { deviceId: 'device-fixture' },
  nativeWindowsCli: { executable: 'C:/Protected Runtime/Scripts/pocketshell.exe', transport: 'openssh-git-bash', deviceId: 'device-fixture' } };

describe('saved native profile authority', () => {
  it('allows spaces/drive colon only in the explicit device-bound native profile', () => {
    expect(validateHostEntry(native)).toBe(native);
    expect(() => validateBinary(native.nativeWindowsCli!.executable)).toThrow();
    expect(validateBinary('~/.local/bin/pocketshell')).toBe('~/.local/bin/pocketshell');
  });
  it('rejects changed device, transport, missing policy or binary conflicts', () => {
    expect(() => validateHostEntry({ ...native, gateway: { deviceId: 'different-fixture' } })).toThrow(/device ID/);
    expect(() => validateHostEntry({ ...native, binary: 'pocketshell' })).toThrow(/cannot coexist/);
    expect(() => validateHostEntry({ ...native, mode: 'ssh', ssh: { destination: 'fixture' } })).toThrow(/direct/);
    expect(() => validateHostEntry({ ...native, mode: 'local' })).toThrow(/direct/);
    expect(() => validateHostEntry({ ...native, nativeWindowsCli: null as never })).toThrow(/policy/);
    expect(() => validateHostEntry({ ...native, nativeWindowsCli: { ...native.nativeWindowsCli!, transport: 'cmd-git-bash' as never } })).toThrow(/not qualified/);
  });
  it('leaves explicit Linux/local/direct SSH host validation unchanged', () => {
    for (const mode of ['local', 'ssh', 'gateway'] as const) {
      expect(() => validateHostEntry({ name: 'fixture', mode, binary: '~/.local/bin/pocketshell',
        ...(mode === 'ssh' ? { ssh: { destination: 'ssh-alias' } } : {}),
        ...(mode === 'gateway' ? { gateway: { deviceId: 'device-fixture' } } : {}) })).not.toThrow();
    }
  });
});
