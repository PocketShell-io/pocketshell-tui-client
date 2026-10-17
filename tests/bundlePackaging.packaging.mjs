import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dist-bundle');

// 1. Test bundle.mjs (generic bundle)
execFileSync(process.execPath, ['scripts/bundle.mjs'], { cwd: root, stdio: 'inherit' });
const genericPkg = JSON.parse(readFileSync(join(outDir, 'package.json'), 'utf8'));
assert.ok(genericPkg.dependencies?.['@lydell/node-pty'], 'generic package must declare @lydell/node-pty dependency');
assert.ok(
  genericPkg.optionalDependencies?.['@lydell/node-pty-linux-x64'],
  'generic package must declare @lydell/node-pty-linux-x64 optionalDependency',
);

// 2. Test build-relay.mjs (platform-specific binary bundle)
if (process.platform === 'linux' && process.arch === 'x64') {
  execFileSync(process.execPath, ['scripts/build-relay.mjs'], {
    cwd: root,
    env: { ...process.env, PSC_GO: existsSync('/usr/local/go/bin/go') ? '/usr/local/go/bin/go' : process.env.PSC_GO },
    stdio: 'inherit',
  });
  const relayPkg = JSON.parse(readFileSync(join(outDir, 'package.json'), 'utf8'));
  assert.ok(relayPkg.bundleDependencies?.includes('@lydell/node-pty'), 'bundleDependencies includes @lydell/node-pty');
  assert.ok(
    relayPkg.bundleDependencies?.includes('@lydell/node-pty-linux-x64'),
    'bundleDependencies includes @lydell/node-pty-linux-x64',
  );

  const tarballName = `pocketshell-tui-client-${relayPkg.version}.tgz`;
  const tarballPath = join(outDir, tarballName);
  assert.ok(existsSync(tarballPath), `tarball ${tarballName} exists`);

  const listing = execFileSync('tar', ['-ztvf', tarballPath], { encoding: 'utf8' });
  assert.match(
    listing,
    /package\/node_modules\/@lydell\/node-pty-linux-x64\/prebuilds\/linux-x64\/pty\.node/,
    'tarball must contain native pty.node',
  );
}

console.log('bundle packaging tests passed: node-pty correctly declared and bundled');
