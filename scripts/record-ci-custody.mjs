import { execFileSync } from 'node:child_process';
import { readdirSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
const walk = (dir, root = dir) => readdirSync(dir).flatMap(name => {
  const p = join(dir, name), st = lstatSync(p);
  if (st.isSymbolicLink()) throw new Error('linked output refused');
  if (st.isDirectory()) return walk(p, root);
  if (!st.isFile()) throw new Error('special output refused');
  return [{path: relative(root, p).replaceAll('\\','/'), bytes: st.size,
    sha256: createHash('sha256').update(readFileSync(p)).digest('hex')}];
}).sort((a,b) => a.path.localeCompare(b.path));
const git = (cwd, ...args) => execFileSync('git', args, {cwd, encoding:'utf8'}).trim();
const core = '../pocketshell-core', expected = '07174896ce7041370bcbf4f791ec513870b9535f';
if (git(core,'rev-parse','HEAD') !== expected) throw new Error('Core source pin mismatch');
writeFileSync('ci-custody.json', JSON.stringify({clientHead:git('.','rev-parse','HEAD'),
  clientTree:git('.','rev-parse','HEAD^{tree}'), coreHead:expected,
  coreTree:git(core,'rev-parse','HEAD^{tree}'), platform:process.platform,
  node:process.version, clientDist:walk('dist'), coreDist:walk(join(core,'dist')),
  runtimeAcceptance:false, normalWindowsInstallAccepted:false},null,2)+'\n');
