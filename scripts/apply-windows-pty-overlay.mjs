import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const payloadRoot = fileURLToPath(new URL('../vendor/windows-pty-overlay/', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(join(payloadRoot, 'manifest.json'), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(`Windows PTY overlay refused: ${message}`); };
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

function inspect(root, archive, replacements = new Map()) {
  const absolute = resolve(root);
  const canonical = fs.realpathSync(absolute);
  if ((process.platform === 'win32' ? canonical.toLowerCase() !== absolute.toLowerCase() : canonical !== absolute)) fail('package root is not canonical');
  const actual = [];
  function walk(directory) {
    for (const name of fs.readdirSync(directory)) {
      const path = join(directory, name), stat = fs.lstatSync(path);
      if (stat.isSymbolicLink()) fail('package contains a symbolic link');
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile() && stat.nlink === 1) actual.push(relative(absolute, path).replaceAll('\\', '/'));
      else fail('package contains a non-regular or shared file');
    }
  }
  walk(absolute);
  if (JSON.stringify(actual.sort()) !== JSON.stringify(archive.files.map(x => x.path).sort())) fail('package inventory differs');
  const states = [];
  for (const file of archive.files) {
    const bytes = fs.readFileSync(join(absolute, file.path)), digest = hash(bytes);
    const replacement = replacements.get(file.path);
    if (digest === file.sha256) { if (replacement) states.push('original'); }
    else if (replacement && digest === replacement.patchedSha256) states.push('patched');
    else fail(`unknown bytes at ${file.path}`);
  }
  const pkg = JSON.parse(fs.readFileSync(join(absolute, 'package.json'), 'utf8'));
  if (pkg.name !== archive.package || pkg.version !== archive.version) fail('package name/version differs');
  return states;
}

function atomicWrite(path, bytes) {
  const temporary = `${path}.psc-overlay-${randomUUID()}`;
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: fs.statSync(path).mode & 0o777 });
    fs.renameSync(temporary, path);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

function validateArchives() {
  const entries = [];
  for (const archive of manifest.archives) {
    const compressed = fs.readFileSync(join(payloadRoot, archive.asset));
    if ('sha512-' + createHash('sha512').update(compressed).digest('base64') !== archive.integrity || hash(compressed) !== archive.archiveSha256) fail('original upstream archive integrity differs');
    const tar = gunzipSync(compressed), files = new Map();
    for (let offset = 0; offset < tar.length;) {
      const header = tar.subarray(offset, offset + 512); offset += 512;
      if (header.length !== 512) fail('truncated archive header');
      if (header.every(x => x === 0)) break;
      const field = (at, length) => header.toString('utf8', at, at + length).split('\0')[0];
      if (header[156] !== 0 && header[156] !== 48) fail('non-regular upstream member');
      const prefix = field(345, 155), name = (prefix ? prefix + '/' : '') + field(0, 100);
      const path = name.startsWith('package/') ? name.slice(8) : '';
      const expected = archive.files.find(x => x.path === path);
      if (!expected || files.has(path)) fail('upstream member differs from exact inventory');
      const size = parseInt(field(124, 12).trim(), 8);
      if (!Number.isSafeInteger(size) || size < 0) fail('invalid upstream member size');
      const bytes = tar.subarray(offset, offset + size);
      if (bytes.length !== size || hash(bytes) !== expected.sha256) fail('upstream member bytes differ');
      files.set(path, bytes); offset += Math.ceil(size / 512) * 512;
    }
    if (files.size !== archive.files.length) fail('upstream inventory incomplete');
    entries.push({ archive, files });
  }
  return entries;
}

// A consumer may hoist its original dependency. Never patch that sibling:
// provision the two immutable archives privately inside this package instead.
export function provisionPrivateWindowsDependencies(packageRoot) {
  const entries = validateArchives(), root = resolve(packageRoot);
  if (!samePath(fs.realpathSync(root), root)) fail('private install root is not canonical');
  const pkg = JSON.parse(fs.readFileSync(join(root, 'package.json'), 'utf8'));
  if (pkg.name !== '@pocketshell/tui-client') fail('private install root is not the client package');
  for (const path of [join(root, 'node_modules'), join(root, 'node_modules/@lydell')]) {
    if (!fs.existsSync(path)) fs.mkdirSync(path, { mode: 0o700 });
    const stat = fs.lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(fs.realpathSync(path), path)) fail('private dependency ancestor is linked or invalid');
  }
  const scope = join(root, 'node_modules/@lydell');
  for (const { archive, files } of entries) {
    const target = join(scope, archive.package.slice('@lydell/'.length));
    if (fs.existsSync(target)) {
      inspect(target, archive, archive.package.endsWith('win32-x64') ? new Map(manifest.patches.map(p => [p.path, p])) : new Map());
      continue;
    }
    const staging = fs.mkdtempSync(join(scope, '.psc-private-'));
    try {
      for (const [path, bytes] of files) {
        fs.mkdirSync(dirname(join(staging, path)), { recursive: true, mode: 0o700 });
        fs.writeFileSync(join(staging, path), bytes, { flag: 'wx', mode: 0o600 });
      }
      inspect(staging, archive);
      if (fs.existsSync(target)) fail('private dependency appeared during provisioning');
      fs.renameSync(staging, target);
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  }
}

export function applyOverlay(packageRoot, { verifyOnly = false } = {}) {
  validateArchives();
  const require = createRequire(join(resolve(packageRoot), 'package.json'));
  // resolve() inspects package metadata only; never load a foreign JS/native addon.
  let wrapper, platform;
  try {
    const privateScope = join(resolve(packageRoot), 'node_modules/@lydell');
    // Absolute private entry paths avoid Node's cached earlier hoisted resolution.
    wrapper = dirname(require.resolve(fs.existsSync(join(privateScope, 'node-pty')) ? join(privateScope, 'node-pty/index.js') : '@lydell/node-pty'));
    platform = dirname(dirname(require.resolve(fs.existsSync(join(privateScope, 'node-pty-win32-x64')) ? join(privateScope, 'node-pty-win32-x64/lib/index.js') : '@lydell/node-pty-win32-x64')));
  } catch { fail('expected installed package unavailable or invalid'); }
  for (const dependency of [wrapper, platform]) {
    const within = relative(resolve(packageRoot), dependency);
    if (within === '..' || within.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) || isAbsolute(within)) fail('dependency lies outside private installation root');
  }
  const patches = new Map(manifest.patches.map(p => [p.path, p]));
  const buffers = new Map();
  for (const p of manifest.patches) {
    const bytes = fs.readFileSync(join(payloadRoot, p.payload));
    if (hash(bytes) !== p.patchedSha256 || hash(fs.readFileSync(join(payloadRoot, p.diff))) !== p.diffSha256) fail('maintained patch payload/diff differs');
    buffers.set(p.path, bytes);
  }
  inspect(wrapper, manifest.archives[0]);
  const states = inspect(platform, manifest.archives[1], patches);
  if (states.every(s => s === 'patched')) return { target: manifest.target, state: 'verified', modified: 0 };
  if (!states.every(s => s === 'original')) fail('partially applied overlay; restore fresh staging before retry');
  if (verifyOnly) fail('overlay has not been applied');
  const originals = new Map(manifest.patches.map(p => [p.path, fs.readFileSync(join(platform, p.path))]));
  const committed = [];
  try {
    for (const p of manifest.patches) { atomicWrite(join(platform, p.path), buffers.get(p.path)); committed.push(p.path); }
    if (!inspect(platform, manifest.archives[1], patches).every(s => s === 'patched')) fail('post-write verification failed');
  } catch (error) {
    const rollbackErrors = [];
    for (const path of committed.reverse()) {
      try { atomicWrite(join(platform, path), originals.get(path)); } catch (e) { rollbackErrors.push(e); }
    }
    if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], 'Overlay failed and rollback incomplete; do not promote this staging directory');
    throw error;
  }
  return { target: manifest.target, state: 'verified', modified: manifest.patches.length };
}

export function installOverlayForPlatform(packageRoot, platform = process.platform, arch = process.arch) {
  if (platform !== 'win32' || arch !== 'x64') return { target: `${platform}-${arch}`, state: 'not-targeted', modified: 0 };
  provisionPrivateWindowsDependencies(packageRoot);
  return applyOverlay(packageRoot);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let targetRoot = null, verifyOnly = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--verify' && !verifyOnly) verifyOnly = true;
    else if (args[i] === '--target-root' && targetRoot === null) {
      targetRoot = args[++i];
      if (!targetRoot || !targetRoot.match(/^(?:[A-Za-z]:[\\/]|\/)/)) fail('target root must be absolute');
    } else fail('unsupported or repeated argument');
  }
  const root = targetRoot ?? fileURLToPath(new URL('../', import.meta.url));
  const result = targetRoot !== null || verifyOnly ? applyOverlay(root, { verifyOnly }) : installOverlayForPlatform(root);
  process.stdout.write(JSON.stringify(result) + '\n');
}
