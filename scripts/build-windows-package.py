#!/usr/bin/env python3
"""Build the offline Windows x64 PSC zip on Linux or Windows."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
NODE_VERSION = "24.13.1"
NODE_SHA256 = "fba577c4bb87df04d54dd87bbdaa5a2272f1f99a2acbf9152e1a91b8b5f0b279"
CORE_COMMIT = "93db1bc082a806ecdf2d96641d30edf5afba585d"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build(args):
    core = Path(args.core_dir).resolve()
    # CI checks out this exact pin; an archive checkout may instead supply it explicitly.
    if not args.core_archive:
        actual = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=core, text=True).strip()
        if actual != CORE_COMMIT:
            raise ValueError("Core source must match the maintained CI pin")
    subprocess.run(["node", "node_modules/typescript/bin/tsc", "-p", "tsconfig.json"], cwd=ROOT, check=True)
    version = json.loads((ROOT / "package.json").read_text())["version"]
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        archive = work / "node.zip"
        with urllib.request.urlopen(f"https://nodejs.org/dist/v{NODE_VERSION}/node-v{NODE_VERSION}-win-x64.zip") as response:
            archive.write_bytes(response.read())
        if digest(archive) != NODE_SHA256:
            raise ValueError("Official Node archive SHA256 mismatch")
        payload = work / "payload"
        payload.mkdir()
        with zipfile.ZipFile(archive) as z:
            (payload / "node.exe").write_bytes(z.read(f"node-v{NODE_VERSION}-win-x64/node.exe"))
            (payload / "NODE-LICENSE.txt").write_bytes(z.read(f"node-v{NODE_VERSION}-win-x64/LICENSE"))
        psc = payload / "psc"
        shutil.copytree(ROOT / "dist", psc / "dist")
        for file in ("package.json", "LICENSE"):
            if (ROOT / file).is_file():
                shutil.copyfile(ROOT / file, psc / file)
        for name in ("commander", "ws", "hash-wasm"):
            shutil.copytree(ROOT / "node_modules" / name, psc / "node_modules" / name)
        target = psc / "node_modules/@pocketshell/core"
        shutil.copytree(core / "dist", target / "dist")
        shutil.copyfile(core / "package.json", target / "package.json")
        if (core / "LICENSE").is_file():
            shutil.copyfile(core / "LICENSE", target / "LICENSE")
        shutil.copytree(ROOT / "vendor/windows-pty-overlay", psc / "vendor/windows-pty-overlay")
        (psc / "scripts").mkdir()
        shutil.copyfile(ROOT / "scripts/apply-windows-pty-overlay.mjs", psc / "scripts/apply-windows-pty-overlay.mjs")
        shutil.copyfile(ROOT / "scripts/windows/install-preflight.mjs", psc / "scripts/install-preflight.mjs")
        selector = "import {installOverlayForPlatform} from './scripts/apply-windows-pty-overlay.mjs'; console.log(JSON.stringify(installOverlayForPlatform(process.cwd(),'win32','x64')));"
        subprocess.run(["node", "--input-type=module", "-e", selector], cwd=psc, check=True)
        env = dict(os.environ, GOOS="windows", GOARCH="amd64", CGO_ENABLED="0")
        subprocess.run([args.go, "build", "-trimpath", "-o", str(payload / "psc-security.exe"), "."],
                       cwd=ROOT / "native/psc-security", env=env, check=True)
        # The resident relay (named-pipe daemon boundary, classic fallback).
        # Same offline cross-build; psc.cmd invokes it, it invokes node.
        subprocess.run([args.go, "build", "-trimpath",
                        "-ldflags", "-X main.version=" + version,
                        "-o", str(payload / "psc.exe"), "."],
                       cwd=ROOT / "native/psc-relay", env=env, check=True)
        for file in ("install.ps1", "psc.cmd"):
            shutil.copyfile(ROOT / "scripts/windows" / file, payload / file)
        inventory = {p.relative_to(payload).as_posix(): digest(p) for p in sorted(payload.rglob("*")) if p.is_file()}
        manifest = {"version": version, "coreCommit": CORE_COMMIT, "clientCommit": subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(), "nodeVersion": NODE_VERSION,
            "nodeArchiveSha256": NODE_SHA256, "files": inventory}
        (payload / "package-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        result = out / f"psc-windows-x64-{version}.zip"
        with zipfile.ZipFile(result, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
            for path in sorted(payload.rglob("*")):
                if path.is_file():
                    info = zipfile.ZipInfo(path.relative_to(payload).as_posix(), (1980, 1, 1, 0, 0, 0))
                    info.compress_type = zipfile.ZIP_DEFLATED
                    z.writestr(info, path.read_bytes())
        result.with_suffix(".zip.sha256").write_text(f"{digest(result)}  {result.name}\n")
        print(result)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--core-dir", default=ROOT.parent / "pocketshell-core")
    parser.add_argument("--core-archive", action="store_true", help="Core was extracted with git archive of the recorded pin")
    parser.add_argument("--go", default="go")
    parser.add_argument("--out", default=ROOT / "out/windows")
    build(parser.parse_args())
