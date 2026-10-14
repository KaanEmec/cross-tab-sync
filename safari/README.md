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

## Release signing

The `safari` job in `.github/workflows/release.yml` archives with Developer ID (manual signing), packs `Cross-Tab-Sync-<version>.dmg`, signs it, notarizes it with `notarytool`, staples it and attaches it to the release. `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` come from the tag (`v3.0.0` → `3.0.0`). Without `MACOS_CERT_P12_BASE64` the job skips and the release ships without a DMG.

Repository secrets (Settings › Secrets and variables › Actions, or `gh secret set NAME`):

| Secret | Value |
| --- | --- |
| `MACOS_CERT_P12_BASE64` | Developer ID Application certificate with its private key, `.p12`, base64 |
| `MACOS_CERT_PASSWORD` | Password chosen when exporting the `.p12` |
| `KEYCHAIN_PASSWORD` | Any random string; protects the temporary CI keychain |
| `APPLE_TEAM_ID` | 10-character team id (developer.apple.com › Membership) |
| `ASC_KEY_ID` | App Store Connect API key id |
| `ASC_ISSUER_ID` | App Store Connect issuer id (UUID) |
| `ASC_API_KEY_P8` | Full text of `AuthKey_<ASC_KEY_ID>.p8`, including the BEGIN/END lines |

**Certificate.** developer.apple.com › Certificates › + › *Developer ID Application* (needs the Account Holder role), or Xcode › Settings › Accounts › Manage Certificates › + › Developer ID Application. Then in Keychain Access › My Certificates, right-click *Developer ID Application: <name> (<team>)* (it must show the private key underneath) › Export › `.p12` with a password, and:

```sh
base64 -i DeveloperID.p12 | gh secret set MACOS_CERT_P12_BASE64
```

**API key.** App Store Connect › Users and Access › Integrations › App Store Connect API › Team Keys › Generate (access: Developer). Download `AuthKey_<KEYID>.p8` (only once); the issuer id is shown above the key list.

```sh
gh secret set ASC_API_KEY_P8 < AuthKey_<KEYID>.p8
```

**Manual notarization** on a developer machine with the certificate in the login keychain, after building the extension and running `sync-resources.sh` as above:

```sh
out="$(mktemp -d)"   # run from the repository root
xcrun notarytool store-credentials cts-notary --key AuthKey_<KEYID>.p8 --key-id <KEYID> --issuer <ISSUER_ID>
xcodebuild archive -project safari/Cross-Tab-Sync/Cross-Tab-Sync.xcodeproj -scheme Cross-Tab-Sync \
  -configuration Release -destination 'generic/platform=macOS' -archivePath "$out"/Cross-Tab-Sync.xcarchive \
  CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY="Developer ID Application" DEVELOPMENT_TEAM=<TEAM_ID> \
  MARKETING_VERSION=3.0.0 CURRENT_PROJECT_VERSION=3.0.0
# export.plist: method developer-id, signingStyle manual, teamID <TEAM_ID> (same as in release.yml)
xcodebuild -exportArchive -archivePath "$out"/Cross-Tab-Sync.xcarchive -exportOptionsPlist export.plist -exportPath "$out"/export
mkdir -p "$out"/dmg && ditto "$out"/export/Cross-Tab-Sync.app "$out"/dmg/Cross-Tab-Sync.app && ln -sf /Applications "$out"/dmg/Applications
hdiutil create -volname Cross-Tab-Sync -srcfolder "$out"/dmg -format UDZO -ov "$out"/Cross-Tab-Sync-3.0.0.dmg
codesign --sign "Developer ID Application" --timestamp "$out"/Cross-Tab-Sync-3.0.0.dmg
xcrun notarytool submit "$out"/Cross-Tab-Sync-3.0.0.dmg --keychain-profile cts-notary --wait
xcrun stapler staple "$out"/Cross-Tab-Sync-3.0.0.dmg
spctl -a -t open --context context:primary-signature -v "$out"/Cross-Tab-Sync-3.0.0.dmg
```

`xcrun notarytool log <submission-id> --keychain-profile cts-notary` explains a rejected submission.

## Notes

- Targets macOS 13+ (Safari 18.4+ is required at runtime; see `docs/COMPATIBILITY.md`). Safari 18.4+ loads Developer ID signed, notarized extensions without *Allow unsigned extensions*.
- The packager derived different bundle ids for the app and the extension; the project was patched so both share the `com.kaanemec.crosstabsync` prefix.
- `SafariWebExtensionHandler.swift` is the packager's default. The extension does not use native messaging and its manifest does not request it.
- Regenerate from scratch only if the resource file set changes: `xcrun safari-web-extension-packager extension/dist/safari --project-location safari --app-name Cross-Tab-Sync --bundle-identifier com.kaanemec.crosstabsync --macos-only --swift --no-open --copy-resources`, then re-apply the bundle id and deployment target patch.
