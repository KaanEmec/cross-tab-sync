# Safari wrapper

A minimal macOS app that hosts the Safari web extension. Generated once with Apple's packager and committed; the extension resources inside it are copied from `extension/dist/safari`.

## Build and run locally

```sh
cd extension && pnpm build && cd ..
./safari/sync-resources.sh
open safari/Cross-Tab-Sync/Cross-Tab-Sync.xcodeproj
```

In Xcode, select your team under Signing (or build unsigned from the command line as below), then Run. Then in Safari: Settings > Developer > *Allow unsigned extensions* (resets when Safari quits), and enable Cross-Tab-Sync under Settings > Extensions. Grant it access to **All Websites**; without that Safari hides tab URLs from the extension.

Unsigned command-line build:

```sh
xcodebuild -project safari/Cross-Tab-Sync/Cross-Tab-Sync.xcodeproj -scheme Cross-Tab-Sync -configuration Debug CODE_SIGN_IDENTITY="" CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=NO build
```

## Notes

- Targets macOS 13+ (Safari 18.4+ is required at runtime; see `docs/COMPATIBILITY.md`).
- The packager derived different bundle ids for the app and the extension; the project was patched so both share the `com.kaanemec.crosstabsync` prefix.
- `SafariWebExtensionHandler.swift` is the packager's default. The extension does not use native messaging.
- Regenerate from scratch only if the resource file set changes: `xcrun safari-web-extension-packager extension/dist/safari --project-location safari --app-name Cross-Tab-Sync --bundle-identifier com.kaanemec.crosstabsync --macos-only --swift --no-open --copy-resources`, then re-apply the bundle id and deployment target patch.
- Distribution outside the App Store needs Developer ID signing and notarization (release epic).
