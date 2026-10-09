import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { applyOverlay, installOverlayForPlatform } from '../scripts/apply-windows-pty-overlay.mjs';

const lane = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = join(lane, '.tmp/windows-overlay-fixtures'); fs.mkdirSync(scratch, { recursive: true });
const sha = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const manifest = JSON.parse(fs.readFileSync(new URL('../vendor/windows-pty-overlay/manifest.json', import.meta.url)));
function fixture() {
  const root = fs.mkdtempSync(join(scratch, 'overlay-'));
  const deps = join(root, 'node_modules/@lydell'); fs.mkdirSync(deps, { recursive: true });
  for (const archive of manifest.archives) {
    const compressed = fs.readFileSync(new URL('../vendor/windows-pty-overlay/'+archive.asset, import.meta.url));
    assert.equal('sha512-'+createHash('sha512').update(compressed).digest('base64'), archive.integrity);
    const tar = gunzipSync(compressed), seen = new Set();
    for (let offset = 0; offset < tar.length; ) {
      const header = tar.subarray(offset, offset + 512); offset += 512;
      if (header.every(x => x === 0)) break;
      const field = (at, length) => header.toString('utf8', at, at+length).split('\0')[0];
      assert.ok(header[156] === 48 || header[156] === 0, 'only regular fixture archive entries');
      const name = field(0, 100), prefix = field(345, 155);
      const relativePath = (prefix ? prefix+'/' : '')+name;
      assert.ok(relativePath.startsWith('package/'));
      const path = relativePath.slice(8), expected = archive.files.find(f => f.path === path);
      assert.ok(expected && !seen.has(path), 'only exact original inventory members'); seen.add(path);
      const size = parseInt(field(124, 12).trim(), 8); assert.ok(Number.isSafeInteger(size) && size >= 0);
      const bytes = tar.subarray(offset, offset+size); assert.equal(bytes.length, size);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256);
      const target = join(deps, archive.package.slice('@lydell/'.length), path);
      fs.mkdirSync(dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
      offset += Math.ceil(size/512)*512;
    }
    assert.equal(seen.size, archive.files.length);
  }
  function writable(dir) { for (const name of fs.readdirSync(dir)) { const p = join(dir, name); if (fs.statSync(p).isDirectory()) writable(p); else fs.chmodSync(p, 0o644); } }
  writable(deps);
  fs.writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  return { root, platform: join(deps, 'node-pty-win32-x64'), wrapper: join(deps, 'node-pty'), dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function census(f) { return manifest.archives.flatMap((a, i) => a.files.map(x => [a.package+'/'+x.path, sha(join(i ? f.platform : f.wrapper, x.path))])); }

test('official package is RED for release verify; checked application GREEN changes exactly2 JS, not native files', () => {
  const f = fixture(); try {
    const before = census(f); assert.throws(() => applyOverlay(f.root, { verifyOnly: true }), /not been applied/);
    assert.deepEqual(applyOverlay(f.root), { target: 'win32-x64', state: 'verified', modified: 2 });
    const after = census(f), changed = after.filter((x, i) => x[1] !== before[i][1]).map(x => x[0]);
    assert.deepEqual(changed.sort(), manifest.patches.map(p => '@lydell/node-pty-win32-x64/'+p.path).sort());
    assert.equal(applyOverlay(f.root, { verifyOnly: true }).modified, 0);
    assert.equal(applyOverlay(f.root).modified, 0);
  } finally { f.dispose(); }
});

for (const [name, side, path] of [
  ['unknown agent', 'platform', 'lib/windowsPtyAgent.js'],
  ['unknown terminal', 'platform', 'lib/windowsTerminal.js'],
  ['foreign PE', 'platform', 'prebuilds/win32-x64/conpty.node'],
  ['wrapper change', 'wrapper', 'index.js'],
  ['version change', 'platform', 'package.json'],
]) test(`${name} refuses before any patch write`, () => {
  const f = fixture(); try {
    if (name === 'version change') { const p = join(f[side], path); const pkg = JSON.parse(fs.readFileSync(p)); pkg.version = '0.0.0'; fs.writeFileSync(p, JSON.stringify(pkg)); }
    else fs.appendFileSync(join(f[side], path), 'x');
    const before = census(f);
    assert.throws(() => applyOverlay(f.root), /refused/); assert.deepEqual(census(f), before);
  } finally { f.dispose(); }
});

test('known but partial overlay refuses unchanged', () => {
  const f = fixture(); try {
    const p = manifest.patches[0]; fs.copyFileSync(new URL('../vendor/windows-pty-overlay/'+p.payload, import.meta.url), join(f.platform, p.path));
    const before = census(f); assert.throws(() => applyOverlay(f.root), /partially applied/); assert.deepEqual(census(f), before);
  } finally { f.dispose(); }
});

test('extra file and linked file refuse before patching', () => {
  const f = fixture(); try {
    fs.writeFileSync(join(f.platform, 'extra'), 'x'); assert.throws(() => applyOverlay(f.root), /inventory/); fs.unlinkSync(join(f.platform, 'extra'));
    const agent = join(f.platform, manifest.patches[0].path); fs.renameSync(agent, agent+'.saved'); fs.symlinkSync(agent+'.saved', agent);
    assert.throws(() => applyOverlay(f.root), /symbolic link/);
  } finally { f.dispose(); }
});

test('second-file rename failure restores first file and never reports success', () => {
  const f = fixture(), originalRename = fs.renameSync; try {
    const before = census(f); let injected = false;
    fs.renameSync = (from, to) => {
      if (!injected && to === join(f.platform, manifest.patches[1].path)) { injected = true; throw new Error('controlled second commit failure'); }
      return originalRename(from, to);
    };
    assert.throws(() => applyOverlay(f.root), /controlled second commit/); assert.deepEqual(census(f), before);
    assert.equal(fs.readdirSync(join(f.platform, 'lib')).some(x => x.includes('.psc-overlay-')), false);
  } finally { fs.renameSync = originalRename; f.dispose(); }
});

test('non-targeted platform does not inspect or mutate dependencies', () => {
  assert.deepEqual(installOverlayForPlatform('/absent', 'linux', 'x64'), { target: 'linux-x64', state: 'not-targeted', modified: 0 });
});


test('hoisted dependency outside the designated private root refuses unchanged', () => {
  const f = fixture(); try {
    const nested = join(f.root, 'nested'); fs.mkdirSync(nested); fs.writeFileSync(join(nested, 'package.json'), '{}');
    const before = census(f); assert.throws(() => applyOverlay(nested), /outside private installation root/); assert.deepEqual(census(f), before);
  } finally { f.dispose(); }
});

test('changed maintained payload refuses before any dependency write', () => {
  const f = fixture(); try {
    const scripts = join(f.root, 'scripts'), vendor = join(f.root, 'vendor/windows-pty-overlay');
    fs.mkdirSync(scripts); fs.mkdirSync(dirname(vendor));
    fs.copyFileSync(new URL('../scripts/apply-windows-pty-overlay.mjs', import.meta.url), join(scripts, 'apply-windows-pty-overlay.mjs'));
    fs.cpSync(fileURLToPath(new URL('../vendor/windows-pty-overlay', import.meta.url)), vendor, { recursive: true });
    fs.appendFileSync(join(vendor, manifest.patches[0].payload), 'x'); const before = census(f);
    assert.throws(() => execFileSync(process.execPath, [join(scripts, 'apply-windows-pty-overlay.mjs'), '--target-root', f.root], { stdio: 'pipe', shell: false, windowsHide: true }));
    assert.deepEqual(census(f), before);
  } finally { f.dispose(); }
});


test('changed original SRI archive refuses before dependency writes', () => {
  const f = fixture(); try {
    const scripts = join(f.root, 'scripts'), vendor = join(f.root, 'vendor/windows-pty-overlay');
    fs.mkdirSync(scripts); fs.mkdirSync(dirname(vendor));
    fs.copyFileSync(new URL('../scripts/apply-windows-pty-overlay.mjs', import.meta.url), join(scripts, 'apply-windows-pty-overlay.mjs'));
    fs.cpSync(fileURLToPath(new URL('../vendor/windows-pty-overlay', import.meta.url)), vendor, { recursive: true });
    fs.appendFileSync(join(vendor, manifest.archives[0].asset), 'x'); const before = census(f);
    assert.throws(() => execFileSync(process.execPath, [join(scripts, 'apply-windows-pty-overlay.mjs'), '--target-root', f.root], { stdio: 'pipe', shell: false, windowsHide: true }));
    assert.deepEqual(census(f), before);
  } finally { f.dispose(); }
});
