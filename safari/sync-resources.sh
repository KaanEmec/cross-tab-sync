#!/bin/sh
# Copies the built Safari extension (extension/dist/safari) into the Xcode project.
# Run after `pnpm build` in extension/. The Xcode project references these files by name,
# so adding a new file to the extension requires adding it in Xcode too.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
src="$here/../extension/dist/safari"
dst="$here/Cross-Tab-Sync/Cross-Tab-Sync Extension/Resources"
[ -f "$src/manifest.json" ] || { echo "build the extension first: cd extension && pnpm build" >&2; exit 1; }
rm -rf "$dst"
mkdir -p "$dst"
cp -R "$src"/. "$dst"/
echo "synced $src -> $dst"
