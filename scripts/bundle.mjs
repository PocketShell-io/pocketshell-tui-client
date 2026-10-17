#!/usr/bin/env node
/**
 * Build the standalone single-file CLI bundle (`dist-bundle/psc.mjs`), its
 * self-contained `dist-bundle/package.json`, and an `npm pack` tarball.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dist-bundle');
const outFile = join(outDir, 'psc.mjs');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

mkdirSync(outDir, { recursive: true });
rmSync(join(outDir, 'node_modules'), { recursive: true, force: true });

await build({
  entryPoints: [join(root, 'src', 'cli.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: false,
  banner: {
    js: "import { createRequire as __pscCreateRequire } from 'node:module'; const require = __pscCreateRequire(import.meta.url);",
  },
});

chmodSync(outFile, 0o755);

const bundlePkg = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  license: pkg.license,
  author: pkg.author,
  type: 'module',
  bin: {
    'pocketshell-tui-client': './psc.mjs',
    psc: './psc.mjs',
  },
  files: ['psc.mjs'],
  dependencies: {
    '@lydell/node-pty': pkg.dependencies['@lydell/node-pty'] ?? '1.2.0-beta.15',
  },
  optionalDependencies: {
    '@lydell/node-pty-darwin-arm64': '1.2.0-beta.15',
    '@lydell/node-pty-darwin-x64': '1.2.0-beta.15',
    '@lydell/node-pty-linux-arm64': '1.2.0-beta.15',
    '@lydell/node-pty-linux-x64': '1.2.0-beta.15',
    '@lydell/node-pty-win32-arm64': '1.2.0-beta.15',
    '@lydell/node-pty-win32-x64': '1.2.0-beta.15',
  },
  engines: {
    node: '>=20',
  },
};

writeFileSync(join(outDir, 'package.json'), `${JSON.stringify(bundlePkg, null, 2)}\n`);
execFileSync('npm', ['pack', '--quiet'], { cwd: outDir, stdio: 'inherit' });
