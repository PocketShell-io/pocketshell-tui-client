#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';
if (process.platform === "win32") process.exit(0); // The Windows package builds its own relay (scripts/build-windows-package.py).
const pkg = JSON.parse(readFileSync('dist-bundle/package.json', 'utf8'));
await build({
  entryPoints: ['src/daemon/main.ts'],
  outfile: 'dist-bundle/daemon.mjs',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  banner: {
    js: "import { createRequire as __pscCreateRequire } from 'node:module'; const require = __pscCreateRequire(import.meta.url);",
  },
});
execFileSync(
  process.env.PSC_GO ?? 'go',
  ['build', '-trimpath', '-ldflags', '-X main.version=' + pkg.version, '-o', resolve('dist-bundle/psc'), '.'],
  {
    cwd: 'native/psc-relay',
    env: {
      ...process.env,
      CGO_ENABLED: '0',
      GOOS: process.platform,
      GOARCH: { x64: 'amd64', arm64: 'arm64', ia32: '386', arm: 'arm' }[process.arch] ?? process.arch,
    },
    stdio: 'inherit',
  },
);

pkg.os = [process.platform];
pkg.cpu = [process.arch];
pkg.bin = { psc: './psc', 'pocketshell-tui-client': './psc' };
pkg.files = ['psc', 'psc.mjs', 'daemon.mjs'];
writeFileSync('dist-bundle/package.json', JSON.stringify(pkg, null, 2) + '\n');

execFileSync('npm', ['pack', '--quiet'], { cwd: resolve('dist-bundle'), stdio: 'inherit' });
