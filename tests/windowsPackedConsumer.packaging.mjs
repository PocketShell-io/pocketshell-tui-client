import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
const prefix = resolve(process.argv[2]);
const root = join(prefix, 'node_modules/@pocketshell/tui-client');
const manifest = JSON.parse(fs.readFileSync(join(root, 'vendor/windows-pty-overlay/manifest.json')));
const sha = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const census = base => manifest.archives.flatMap(a => a.files.map(f => ({ path: a.package+'/'+f.path, sha256: sha(join(base, 'node_modules', a.package, f.path)) })));
const siblingsBefore = census(prefix);
assert.equal(fs.existsSync(join(root, 'node_modules/@lydell')), false, 'actual npm hoisted dependencies, not synthetic nested fixture');
const { installOverlayForPlatform, applyOverlay } = await import(pathToFileURL(join(root, 'scripts/apply-windows-pty-overlay.mjs')));
assert.throws(() => applyOverlay(root), /outside private installation root/, 'original direct overlay containment still refuses');
const result = installOverlayForPlatform(root, 'win32', 'x64');
assert.deepEqual(result, {target:'win32-x64',state:'verified',modified:2});
assert.deepEqual(census(prefix), siblingsBefore, 'never patch hoisted siblings');
const nested = census(root);
for (const file of nested) {
 const patch = manifest.patches.find(p => file.path === '@lydell/node-pty-win32-x64/'+p.path);
 const original = manifest.archives.flatMap(a => a.files.map(f => ({ path:a.package+'/'+f.path, sha256:f.sha256 }))).find(f => f.path === file.path);
 assert.equal(file.sha256, patch?.patchedSha256 ?? original.sha256);
}
assert.equal(installOverlayForPlatform(root, 'win32', 'x64').modified, 0);
assert.equal(applyOverlay(root, {verifyOnly:true}).modified, 0);
fs.writeFileSync(process.argv[3], JSON.stringify({ prefix, packageRoot:root, actualNpmHoisted:true, result, siblingsBefore, siblingsAfter:census(prefix), nested, officialNativeBytesUnchanged:true, sourceSelectorOnly:true, nativeAddonLoaded:false }, null, 2)+'\n');
console.log('actual packed consumer production Windows selector GREEN;26 private files,2 reviewed JS, hoisted siblings unchanged; no native execution');
