#!/usr/bin/env bash
# Builds and publishes a release on a Mac from the local tag $1 (vX.Y.Z), in this order:
#   server binaries, extension zips, the Developer ID signed and notarized Safari app and DMG,
#   then (once the tag is on GitHub) the GHCR image, the GitHub release with all assets, and a
#   Coolify redeploy of the hosted server (cts.kexperiments.com).
# Everything is built from `git archive <tag>`, so the working tree is never touched.
# Assets land in release/<tag>/ (ignored by git).
#
# DRY_RUN=1 runs every check and every local build (including signing and the image build) but
# publishes nothing: no notarization, image push, GitHub release or deploy; it prints those commands.
#
# Usage: make release VERSION=vX.Y.Z [DRY_RUN=1]. One-time setup: safari/README.md#release.
set -euo pipefail

REPO=KaanEmec/cross-tab-sync
IMAGE=ghcr.io/kaanemec/cross-tab-sync
PLATFORMS=linux/amd64,linux/arm64
BUILDER=cross-tab-sync
IDENTITY="Developer ID Application"
NOTARY_PROFILE=cross-tab-sync-notary
COOLIFY_TOKEN_ITEM=cross-tab-sync-coolify-token
COOLIFY_URL=https://coolify.kexperiments.com
COOLIFY_APP_UUID=wax2mvy8vyhooqyeuls91oxs

die() { echo "release: $*" >&2; exit 1; }
step() { printf '\n==> %s\n' "$*"; }
# Runs a command that publishes something or leaves the machine; DRY_RUN=1 prints it instead.
publish() {
  if [ "$dry" = 1 ]; then printf 'dry run, skipped:'; printf ' %q' "$@"; echo; else "$@"; fi
}

tag=${1:-}
dry=${DRY_RUN:-0}
[[ $tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "usage: make release VERSION=vX.Y.Z [DRY_RUN=1]"
[ "$dry" = 0 ] || [ "$dry" = 1 ] || die "DRY_RUN must be 0 or 1"
version=${tag#v}
# Bundle versions allow only dot-separated integers: v3.0.0-rc.1 -> 3.0.0.
bundle_version=${version%%-*}
prerelease=0
case $version in *-*) prerelease=1 ;; esac

root=$(cd "$(dirname "$0")/.." && pwd)

step "Checking prerequisites"
[ "$(uname -s)" = Darwin ] || die "run this on a Mac"
for tool in git go node pnpm xcodebuild xcrun codesign hdiutil ditto security docker gh curl; do
  command -v "$tool" >/dev/null || die "$tool is not installed"
done
node --version >/dev/null 2>&1 || die "node does not run (try: brew reinstall node)"
git -C "$root" rev-parse -q --verify "refs/tags/$tag^{commit}" >/dev/null \
  || die "tag $tag does not exist; create it first: git tag -a $tag -m $tag"

identities=$(security find-identity -v -p codesigning | grep -c "\"$IDENTITY: " || true)
[ "$identities" = 1 ] || die "expected exactly one valid \"$IDENTITY\" identity in the keychain, found $identities"
team_id=$(security find-identity -v -p codesigning | sed -n "s/.*\"$IDENTITY: .*(\([A-Z0-9]\{10\}\))\".*/\1/p")
[ -n "$team_id" ] || die "could not read the team id from the \"$IDENTITY\" identity"

xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1 \
  || die "notarytool profile $NOTARY_PROFILE is missing or invalid (see safari/README.md#release)"
security find-generic-password -s "$COOLIFY_TOKEN_ITEM" >/dev/null 2>&1 \
  || die "keychain item $COOLIFY_TOKEN_ITEM is missing (see safari/README.md#release)"

gh auth status >/dev/null 2>&1 || die "gh is not logged in: gh auth login"
gh api -i user 2>/dev/null | grep -i '^x-oauth-scopes:' | grep -q 'write:packages' \
  || die "the gh token cannot push images: gh auth refresh -s write:packages"
if gh release view "$tag" -R "$REPO" >/dev/null 2>&1; then
  [ "$dry" = 1 ] || die "release $tag already exists on GitHub"
  echo "dry run: release $tag already exists on GitHub; a real run would stop here"
fi

docker info >/dev/null 2>&1 || die "Docker is not running: colima start"
docker buildx version >/dev/null 2>&1 || die "docker buildx is not installed: brew install docker-buildx"
docker buildx inspect "$BUILDER" >/dev/null 2>&1 \
  || docker buildx create --name "$BUILDER" --driver docker-container >/dev/null
builder_platforms=$(docker buildx inspect --bootstrap "$BUILDER" | grep -i '^platforms:' || true)
for p in ${PLATFORMS//,/ }; do
  case $builder_platforms in *"$p"*) ;; *) die "buildx builder $BUILDER cannot build $p (emulation: docker run --privileged --rm tonistiigi/binfmt --install all)" ;; esac
done

work=$(mktemp -d "${TMPDIR:-/tmp}/cross-tab-sync-release.XXXXXX")
trap 'rm -rf "$work"' EXIT
src="$work/src"
mkdir -p "$src"
git -C "$root" archive "$tag" | tar -x -C "$src"
out="$root/release/$tag"
rm -rf "$out"
mkdir -p "$out"

step "Server binaries"
for target in linux/amd64 linux/arm64 darwin/arm64; do
  goos=${target%/*} goarch=${target#*/}
  (cd "$src/server" && CGO_ENABLED=0 GOOS=$goos GOARCH=$goarch \
    go build -trimpath -ldflags "-s -w" -o "$out/cross-tab-sync_${goos}_${goarch}" ./cmd/cross-tab-sync)
done

step "Extension zips"
(cd "$src/extension" && pnpm install --frozen-lockfile && pnpm test && pnpm build && pnpm zip "$version")
cp "$src"/extension/dist/zips/*.zip "$out/"

step "Safari app: archive and export"
"$src/safari/sync-resources.sh"
xcodebuild archive \
  -project "$src/safari/Cross-Tab-Sync/Cross-Tab-Sync.xcodeproj" \
  -scheme Cross-Tab-Sync -configuration Release \
  -destination 'generic/platform=macOS' \
  -archivePath "$work/Cross-Tab-Sync.xcarchive" \
  CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY="$IDENTITY" DEVELOPMENT_TEAM="$team_id" \
  MARKETING_VERSION="$bundle_version" CURRENT_PROJECT_VERSION="$bundle_version"
cat >"$work/export.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>developer-id</string>
  <key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>$IDENTITY</string>
  <key>teamID</key><string>$team_id</string>
</dict></plist>
EOF
xcodebuild -exportArchive \
  -archivePath "$work/Cross-Tab-Sync.xcarchive" \
  -exportOptionsPlist "$work/export.plist" \
  -exportPath "$work/export"
app="$work/export/Cross-Tab-Sync.app"

step "Safari app: notarize and staple"
# The app gets its own ticket and is stapled before it goes into the DMG, so Safari can verify it
# offline (an unstapled app is checked online at every launch).
ditto -c -k --keepParent "$app" "$work/Cross-Tab-Sync.zip"
publish xcrun notarytool submit "$work/Cross-Tab-Sync.zip" --wait --keychain-profile "$NOTARY_PROFILE"
publish xcrun stapler staple "$app"
publish xcrun stapler validate "$app"

step "DMG"
dmg="$out/Cross-Tab-Sync-$version.dmg"
mkdir -p "$work/dmg"
ditto "$app" "$work/dmg/Cross-Tab-Sync.app"
ln -s /Applications "$work/dmg/Applications"
hdiutil create -volname Cross-Tab-Sync -srcfolder "$work/dmg" -format UDZO -ov "$dmg"
codesign --sign "$IDENTITY" --timestamp "$dmg"
# The DMG gets its own ticket; the app inside is already stapled.
publish xcrun notarytool submit "$dmg" --wait --keychain-profile "$NOTARY_PROFILE"
publish xcrun stapler staple "$dmg"
publish xcrun stapler validate "$dmg"

step "Waiting for $tag on GitHub"
# ProjectHub pushes tags to GitHub every few minutes; the image and release must not run ahead of it.
local_tag=$(git -C "$root" rev-parse "refs/tags/$tag")
if [ "$dry" = 1 ]; then
  remote_tag=$(gh api "repos/$REPO/git/ref/tags/$tag" --jq .object.sha 2>/dev/null || true)
  echo "dry run: $tag on GitHub: ${remote_tag:-not yet}"
else
  for _ in $(seq 40); do
    remote_tag=$(gh api "repos/$REPO/git/ref/tags/$tag" --jq .object.sha 2>/dev/null || true)
    [ -n "$remote_tag" ] && break
    sleep 15
  done
  [ -n "$remote_tag" ] || die "$tag did not reach GitHub within 10 minutes; check the ProjectHub hub, then rerun"
  [ "$remote_tag" = "$local_tag" ] || die "$tag on GitHub ($remote_tag) differs from the local tag ($local_tag)"
fi

step "Image $IMAGE"
tags=(--tag "$IMAGE:$version")
[ "$prerelease" = 1 ] || tags+=(--tag "$IMAGE:latest")
commit=$(git -C "$root" rev-parse "$tag^{commit}")
labels=(
  --label "org.opencontainers.image.title=cross-tab-sync"
  --label "org.opencontainers.image.source=https://github.com/$REPO"
  --label "org.opencontainers.image.url=https://github.com/$REPO"
  --label "org.opencontainers.image.version=$version"
  --label "org.opencontainers.image.revision=$commit"
  --label "org.opencontainers.image.created=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  --label "org.opencontainers.image.licenses=MIT"
)
build=(docker buildx build --builder "$BUILDER" --platform "$PLATFORMS"
  --file "$src/server/Dockerfile" "${tags[@]}" "${labels[@]}")
if [ "$dry" = 1 ]; then
  "${build[@]}" "$src/server"
  echo "dry run, skipped: docker login ghcr.io and the push of ${tags[*]}"
else
  gh auth token | docker login ghcr.io -u KaanEmec --password-stdin
  "${build[@]}" --push "$src/server"
fi

step "GitHub release $tag"
release=(gh release create "$tag" -R "$REPO" --verify-tag --title "$tag" --generate-notes)
[ "$prerelease" = 0 ] || release+=(--prerelease)
GITHUB_TOKEN=$(gh auth token) publish "${release[@]}" "$out"/*

step "Coolify redeploy of the hosted server"
if [ "$dry" = 1 ]; then
  echo "dry run, skipped: POST $COOLIFY_URL/api/v1/deploy {\"uuid\":\"$COOLIFY_APP_UUID\"}"
else
  token=$(security find-generic-password -s "$COOLIFY_TOKEN_ITEM" -w) || die "cannot read keychain item $COOLIFY_TOKEN_ITEM"
  # The header goes through stdin so the token never appears in the process list.
  printf 'Authorization: Bearer %s\n' "$token" | curl -fsS -X POST "$COOLIFY_URL/api/v1/deploy" \
    -H @- -H "Content-Type: application/json" -d "{\"uuid\":\"$COOLIFY_APP_UUID\"}"
  echo
fi

step "Done: $tag (assets in $out)"
