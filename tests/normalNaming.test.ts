import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { clientConfigDir, sharedConfigDir, runtimeDir } from '../src/paths.js';
const original = process.platform;
afterEach(() => { Object.defineProperty(process, 'platform', {value: original}); vi.unstubAllEnvs(); });
it('keeps normal main package/bin names consistent with the lock and installer', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  expect(pkg.name).toBe('@pocketshell/tui-client');
  expect(lock.name).toBe(pkg.name);
  expect(lock.packages[''].name).toBe(pkg.name);
  expect(lock.packages[''].bin).toEqual(Object.fromEntries(Object.entries(pkg.bin).map(([name, path]) => [name, (path as string).replace(/^\.\//, '')])));
  const installer = readFileSync(new URL('../scripts/apply-windows-pty-overlay.mjs', import.meta.url), 'utf8');
  expect(installer).toContain("pkg.name !== '@pocketshell/tui-client'");
});
it('retains protected qualified Windows account, hosts and runtime paths', () => {
  Object.defineProperty(process, 'platform', {value: 'win32'});
  vi.stubEnv('XDG_CONFIG_HOME', 'C:/owned/config'); vi.stubEnv('XDG_RUNTIME_DIR', 'C:/owned/runtime');
  expect(clientConfigDir()).toBe(join('C:\\owned\\config', 'pocketshell-client'));
  expect(sharedConfigDir()).toBe(join('C:\\owned\\config', 'pocketshell-client-account'));
  expect(runtimeDir()).toBe('C:\\owned\\runtime');
});
it('preserves current main POSIX TUI host/runtime naming and shared account', () => {
  Object.defineProperty(process, 'platform', {value: 'linux'});
  vi.stubEnv('XDG_CONFIG_HOME', '/owned/config'); vi.stubEnv('XDG_RUNTIME_DIR', '/owned/runtime');
  expect(clientConfigDir()).toBe('/owned/config/pocketshell-tui-client');
  expect(sharedConfigDir()).toBe('/owned/config/pocketshell');
  expect(runtimeDir()).toBe('/owned/runtime/pocketshell-tui-client');
});
