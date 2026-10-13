#!/usr/bin/env node
/**
 * Build the standalone single-file CLI bundle (`dist-bundle/psc.mjs`), its
 * self-contained `dist-bundle/package.json`, and an `npm pack` tarball.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dist-bundle');
const outFile = join(outDir, 'psc.mjs');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

mkdirSync(outDir, { recursive: true });

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
  engines: {
    node: '>=20',
  },
};

writeFileSync(join(outDir, 'package.json'), `${JSON.stringify(bundlePkg, null, 2)}\n`);
execFileSync('npm', ['pack', '--quiet'], { cwd: outDir, stdio: 'inherit' });
