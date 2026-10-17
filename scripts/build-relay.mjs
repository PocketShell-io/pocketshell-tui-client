#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

function resolveGo() {
  if (process.env.PSC_GO) return process.env.PSC_GO;
  if (existsSync('/usr/local/go/bin/go')) return '/usr/local/go/bin/go';
  return 'go';
}

execFileSync(
  resolveGo(),
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

const platformPkg = `@lydell/node-pty-${process.platform}-${process.arch}`;
const nodePtyDir = resolve('node_modules/@lydell');
if (existsSync(nodePtyDir)) {
  mkdirSync('dist-bundle/node_modules/@lydell', { recursive: true });
  const ptyWrapper = resolve(nodePtyDir, 'node-pty');
  const ptyPlatform = resolve(nodePtyDir, `node-pty-${process.platform}-${process.arch}`);
  const bundledDeps = [];
  if (existsSync(ptyWrapper)) {
    cpSync(ptyWrapper, 'dist-bundle/node_modules/@lydell/node-pty', { recursive: true, dereference: true });
    bundledDeps.push('@lydell/node-pty');
  }
  if (existsSync(ptyPlatform)) {
    cpSync(ptyPlatform, `dist-bundle/node_modules/@lydell/node-pty-${process.platform}-${process.arch}`, { recursive: true, dereference: true });
    bundledDeps.push(platformPkg);
  }
  if (bundledDeps.length > 0) {
    pkg.dependencies = {
      ...(pkg.dependencies ?? {}),
      ...Object.fromEntries(bundledDeps.map((name) => [name, '1.2.0-beta.15'])),
    };
    pkg.bundleDependencies = bundledDeps;
  }
}

writeFileSync('dist-bundle/package.json', JSON.stringify(pkg, null, 2) + '\n');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
execFileSync(npmCmd, ['pack', '--quiet'], { cwd: resolve('dist-bundle'), stdio: 'inherit', shell: process.platform === 'win32' });
