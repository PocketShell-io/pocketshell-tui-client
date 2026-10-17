#!/usr/bin/env bash
# Install or upgrade psc from a GitHub Release (no npm registry).
#
# Usage:
#   scripts/install-psc.sh [--version v0.7.5] [--prefix ~/.local/psc]
#                          [--asset linux-x64|generic] [--repo OWNER/REPO]
#
# Defaults: latest release, prefix ~/.local/psc, linux-x64 asset on
# Linux/x86_64, generic Node bundle elsewhere. Downloads the tarball plus
# SHA256SUMS.txt with `gh`, verifies the sha256, then installs globally
# from the tarball. Afterwards put "$PREFIX/bin" on PATH.
set -euo pipefail

REPO="PocketShell-io/pocketshell-tui-client"
TAG=""
PREFIX="${HOME}/.local/psc"
ASSET=""

while [ $# -gt 0 ]; do
  case "$1" in
    --version) TAG="$2"; shift 2 ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    --asset) ASSET="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,/^set -euo pipefail$/p' "$0" | sed '$d; s/^# \?//'
      exit 0
      ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

for cmd in gh npm sha256sum; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "install-psc: required command '$cmd' not found" >&2; exit 1; }
done

if [ -z "$TAG" ]; then
  TAG="$(gh release view --repo "$REPO" --json tagName -q .tagName)"
fi
version="${TAG#v}"

if [ -z "$ASSET" ]; then
  if [ "$(uname -s)" = "Linux" ] && [ "$(uname -m)" = "x86_64" ]; then
    ASSET="linux-x64"
  else
    ASSET="generic"
  fi
fi

if [ "$ASSET" = "linux-x64" ]; then
  TARBALL="pocketshell-tui-client-${version}-linux-x64.tgz"
else
  TARBALL="pocketshell-tui-client-${version}.tgz"
fi

tmp="$(mktemp -d "${TMPDIR:-/tmp}/psc-install.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

gh release download "$TAG" --repo "$REPO" \
  --pattern "$TARBALL" --pattern SHA256SUMS.txt \
  --dir "$tmp" --clobber
(cd "$tmp" && grep -F " $TARBALL" SHA256SUMS.txt | sha256sum -c -)
npm install --global --prefix "$PREFIX" "$tmp/$TARBALL"

echo "installed $TARBALL from $TAG into $PREFIX"
echo "put on PATH: export PATH=\"$PREFIX/bin:\$PATH\""
"$PREFIX/bin/psc" --version
