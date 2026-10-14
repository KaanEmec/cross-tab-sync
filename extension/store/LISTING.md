# Chrome Web Store listing

Upload: `cross-tab-sync-brave-<version>.zip` from the GitHub release, or `pnpm build && pnpm zip` (`dist/zips/`). Brave users install it from the store with **Add to Brave**. Visibility: **Unlisted** (installable by link, normal review).

## Store listing tab

- **Name:** Cross-Tab-Sync (from the manifest).
- **Summary** (≤132 characters; the store shows the manifest `description`, so keep the two equal): Keep the same open tabs in Brave and Safari. End-to-end encrypted, through a hosted or your own server.
- **Category:** Productivity. **Language:** English.
- **Description:**

  > Cross-Tab-Sync keeps one shared set of open tabs between your browsers: Brave, and Safari on macOS (Safari uses the separate Cross-Tab-Sync app).
  >
  > Click Start syncing, copy the invite link, and paste it into the extension in your other browser. Tabs you open, navigate or close on the browser you are using appear on the other one. Closing a window or quitting never deletes shared tabs; only closing an individual tab does.
  >
  > Tab addresses are encrypted in this browser before they are sent. The server only stores ciphertext. The key travels only inside your invite link. No account, no analytics, no ads.
  >
  > Uses the free hosted server by default; you can run your own with Docker (open source, MIT): https://github.com/KaanEmec/cross-tab-sync
- **Icon:** 128×128, `dist/brave/icons/icon-128.png`.
- **Screenshots:** 1 to 5, exactly 1280×800 or 640×400 (PNG or JPEG). Suggested: the popup with Start syncing; the popup after sync with Devices and the invite link; Brave and Safari side by side showing the same tabs.
  Ready-made: `store/assets/` has `screenshot-1.png` to `screenshot-3.png` (1280×800), `marquee-1400x560.png` and `small-tile-440x280.png`.
- **Homepage:** https://github.com/KaanEmec/cross-tab-sync. **Support:** https://github.com/KaanEmec/cross-tab-sync/issues.

## Privacy practices tab

- **Single purpose:** Synchronize the user's open browser tabs with their other browsers through an end-to-end encrypted sync server.
- **`tabs`:** Read the address, pinned state and order of open tabs and open, update, move or close tabs, to mirror the user's tabs from their other browser. Tabs are only changed in response to the user's own tab changes on another of their browsers.
- **`storage`:** Store the sync server address, this device's credentials, the encryption key and changes waiting to be sent, locally in the browser.
- **`alarms`:** Run the periodic sync (about every five minutes) and retry after network errors while the service worker is asleep.
- **Host permissions** (optional, `https://*/*`, `http://localhost/*`, `http://127.0.0.1/*`): Nothing is granted at install. When the user clicks Start syncing or pastes an invite link, the extension requests access to exactly one origin, the sync server they chose (default `https://cts.kexperiments.com`; self-hosters enter their own), so the background service worker can reach its API. Loopback is for local development. No content scripts; page content is never read.
- **Remote code:** No, I am not using remote code. All JavaScript is in the package.
- **Data usage**, collected: **Web history** only (the addresses of open tabs). Not collected: personally identifiable information, health, financial, authentication, personal communications, location, user activity, website content. Addresses are encrypted on the device before transmission (AES-256-GCM); the server stores only ciphertext and cannot read them.
- **Certifications:** check all three (not sold or transferred to third parties outside the approved use cases; not used for purposes unrelated to the single purpose; not used for creditworthiness or lending).
- **Privacy policy URL:** https://github.com/KaanEmec/cross-tab-sync/blob/main/docs/PRIVACY.md
- Expect the install prompt to show "Read your browsing history" (from `tabs`); the in-product disclosure next to Start syncing covers it.

## Dashboard steps

1. Sign in at https://chrome.google.com/webstore/devconsole with a Google account that has 2-Step Verification on; pay the one-time registration fee; set and verify the contact email under **Account**.
2. **Items › New item**, upload the zip.
3. Fill **Store listing** and **Privacy practices** as above.
4. **Distribution:** Free, all regions, visibility **Unlisted**.
5. **Submit for review.** After approval, copy the item id from the dashboard into the store link in `docs/INSTALL.md` and `README.md` (`https://chromewebstore.google.com/detail/cross-tab-sync/<id>`).
6. Updates: bump `version` in `extension/package.json` (the store rejects an equal or lower version), tag, upload the new release zip under **Package**, submit.
