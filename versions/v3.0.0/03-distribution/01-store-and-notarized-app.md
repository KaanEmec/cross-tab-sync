# Publish to the Chrome Web Store and a notarized Safari app

## Goal
Install both extensions without developer tools: Brave from the Chrome Web Store, Safari from a signed, notarized DMG.

## Expected outcome
A tagged release produces the Web Store upload zip and `Cross-Tab-Sync-<version>.dmg`; the store listing and privacy policy are ready; INSTALL.md walks a non-technical reader through both browsers and optional self-hosting.

## Tasks
- Extension `package.json` version `3.0.0` (the build writes it into both manifests); `pnpm zip` output is the Web Store upload.
- `safari.json`: drop `nativeMessaging` and the native branch in `core/diag.ts` (diagnostics keep console and `/v3/diag`); keep `optional_host_permissions`.
- `extension/store/LISTING.md`: name, summary (≤ 132 characters), description, category Productivity, single-purpose statement, justifications for `tabs`, `storage`, `alarms` and host permissions, data-use answers ("web history" collected, encrypted, not sold), remote code: no, dashboard steps, screenshots 1280×800 or 640×400, 128 px icon, visibility Unlisted.
- `docs/PRIVACY.md`: what the server sees (threat model), what the extension stores locally, no analytics, deletion = Disconnect (last device deletes the session; 180 days idle), hosted operator Kaan Emeç, contact via GitHub issues.
- `release.yml` `safari` job on `macos-latest`: build extension, `safari/sync-resources.sh`, `MARKETING_VERSION` from the tag, `xcodebuild archive` and `-exportArchive` with Developer ID (manual signing), `xcrun notarytool submit --wait` with an App Store Connect API key, `xcrun stapler staple`, `hdiutil` DMG, upload to the release. Skip cleanly when secrets are absent (env-check step, not `if:` on secrets).
- `safari/README.md`: secrets `MACOS_CERT_P12_BASE64`, `MACOS_CERT_PASSWORD`, `KEYCHAIN_PASSWORD`, `APPLE_TEAM_ID`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_API_KEY_P8`.
- `docs/INSTALL.md` for non-technical readers, in order: Brave (store link placeholder, Start syncing, copy invite); Safari 18.4+ (download DMG, open once, Safari Settings › Extensions, enable, Edit Websites: All Websites, paste invite); optional self-hosting (Docker Compose with `CTS_DOMAIN` and Caddy; Coolify: public repo, Dockerfile build pack, base directory `/server`, port 8080, volume `/data`, no env required, `CTS_MAX_SESSIONS=1` for a personal server; session lifetime; shortened backups and upgrade). README gets a 3-step install block linking to it.
- `deploy/docker-compose.yml` drops `CTS_PUBLIC_URL`; `deploy/README.md` and `server/README.md` config tables list `CTS_MAX_SESSIONS`, `CTS_MAX_DEVICES`, `CTS_SESSION_RETENTION`.
- Validate on real browsers: store/DMG install, Start syncing on the hosted server, invite into the other browser, Disconnect of the last device removes the session.
