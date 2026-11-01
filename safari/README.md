# Safari wrapper

A minimal macOS app that hosts the Safari web extension. Generated once with Apple's packager and committed; the extension resources inside it are copied from `extension/dist/safari`.

**Users** install the signed, notarized `Cross-Tab-Sync-<version>.dmg` from the GitHub release: drag the app to Applications, open it once, then enable Cross-Tab-Sync in Safari › Settings › Extensions and set its website access to **All Websites**. See [docs/INSTALL.md](../docs/INSTALL.md).

## Build locally (developers)

```sh
cd extension && pnpm build && cd ..
./safari/sync-resources.sh
open safari/Cross-Tab-Sync/Cross-Tab-Sync.xcodeproj
```

In Xcode, select your team under Signing (a free personal team works), then Run. A locally signed build is not notarized, so Safari shows it only with Settings › Developer › *Allow unsigned extensions* (resets when Safari quits). Enable Cross-Tab-Sync under Settings › Extensions and grant it **All Websites**; without that Safari hides tab URLs from the extension.

Unsigned command-line build:

```sh
xcodebuild -project safari/Cross-Tab-Sync/Cross-Tab-Sync.xcodeproj -scheme Cross-Tab-Sync -configuration Debug CODE_SIGN_IDENTITY="" CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=NO build
```

## Release

Releases are built on a Mac, never by GitHub Actions. Tag the version, then run from the repository root:

```sh
git tag -a v3.0.5 -m v3.0.5
make release VERSION=v3.0.5            # DRY_RUN=1 builds and signs everything but publishes nothing
```

[`scripts/release.sh`](../scripts/release.sh) builds from `git archive <tag>` into `release/<tag>/`: the server binaries, the extension zips, and the Safari app archived with Developer ID (manual signing), notarized and stapled, packed into `Cross-Tab-Sync-<version>.dmg`, which is signed, notarized and stapled too. `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` come from the tag (`v3.0.0` → `3.0.0`). Once the tag is on GitHub it pushes the image `ghcr.io/kaanemec/cross-tab-sync` (`<version>` and, for a tag without `-`, `latest`; `linux/amd64` and `linux/arm64`), creates the GitHub release with generated notes (a prerelease for a tag with `-`) and all assets, and redeploys the hosted server through Coolify. It stops with a clear message when a prerequisite is missing.

Prerequisites: Xcode, Go, Node with pnpm, `gh` logged in with the `write:packages` scope, Docker through Colima with `docker-buildx`, and in the login keychain:

| Item | What |
| --- | --- |
| `Developer ID Application: <name> (<team>)` | The signing identity with its private key (developer.apple.com › Certificates, or Xcode › Settings › Accounts › Manage Certificates). The team id is read from it. |
| notarytool profile `cross-tab-sync-notary` | An App Store Connect API key (Users and Access › Integrations › Team Keys, access Developer): `xcrun notarytool store-credentials cross-tab-sync-notary --key AuthKey_<KEYID>.p8 --key-id <KEYID> --issuer <ISSUER_ID>` |
| generic password `cross-tab-sync-coolify-token` | A Coolify API token allowed to deploy: `security add-generic-password -s cross-tab-sync-coolify-token -a coolify -w` (prompts for the value) |

`xcrun notarytool log <submission-id> --keychain-profile cross-tab-sync-notary` explains a rejected submission.

## Notes

- Targets macOS 13+ (Safari 18.4+ is required at runtime; see `docs/COMPATIBILITY.md`). Safari 18.4+ loads Developer ID signed, notarized extensions without *Allow unsigned extensions*.
- The packager derived different bundle ids for the app and the extension; the project was patched so both share the `com.kaanemec.crosstabsync` prefix.
- `SafariWebExtensionHandler.swift` is the packager's default. The extension does not use native messaging and its manifest does not request it.
- Regenerate from scratch only if the resource file set changes: `xcrun safari-web-extension-packager extension/dist/safari --project-location safari --app-name Cross-Tab-Sync --bundle-identifier com.kaanemec.crosstabsync --macos-only --swift --no-open --copy-resources`, then re-apply the bundle id and deployment target patch.
