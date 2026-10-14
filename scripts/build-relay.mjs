#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';
if(process.platform==='win32') process.exit(0); // Windows distribution retains its current direct entry.
await build({entryPoints:['src/daemon/main.ts'],outfile:'dist-bundle/daemon.mjs',bundle:true,platform:'node',target:'node20',format:'esm',banner:{js:"import { createRequire as __pscCreateRequire } from 'node:module'; const require = __pscCreateRequire(import.meta.url);"}});
execFileSync(process.env.PSC_GO ?? 'go',['build','-trimpath','-o',resolve('dist-bundle/psc'),'.'],{cwd:'native/psc-relay',stdio:'inherit'});

const pkg = JSON.parse(readFileSync('dist-bundle/package.json','utf8'));
pkg.bin = { psc:'./psc', 'pocketshell-tui-client':'./psc' };
pkg.files = ['psc','psc.mjs','daemon.mjs'];
writeFileSync('dist-bundle/package.json',JSON.stringify(pkg,null,2)+'\n');
