# Real-browser validation

Everything in this repository is verified by unit tests, an integration test against the real server, and code review. The checks below need the real browsers: Safari on macOS and Brave on Windows, both paired to one server. Record the result of each line (pass, fail, notes) plus browser and OS versions. They cover the roadmap jobs `v0.1.0/01-session-contract/02`, `v0.2.0/03-reconciliation/02` and `v1.0.0/03-release/02`.

## Results so far (2026-10-14, Safari 27.0 and Brave 1.97 / Chromium 155 on one Mac, macOS 26.6.2, local server over HTTP)

Driven with AppleScript on both browsers and Chrome DevTools Protocol on Brave; server state read from SQLite. Verified: pairing both browsers; initial publish of 10 tabs; additions, navigation and explicit closures propagating both ways; duplicate copies on one device (one entry, close only on the last copy, in owner and follower roles); whole-window close in Brave and in Safari producing no closures; Safari quit and relaunch producing no closures and no takeover; Brave relaunch as follower staying follower; remote close of the local active tab leaving it open and detached without republishing; automatic handover within about 1 s on focus or click in either direction, including after a silent loss of ownership. Fixed during this pass: restart taking over, same-site URL rewrites republishing detached tabs, a superseded owner not noticing until its next contact. Second round (same day, after your report of tabs not closing): found and fixed three more defects. A takeover during the 2 s close hold recreated the entry and lost the close; the next capture in the same run still saw a tab being removed and published it as a ghost entry; and Safari restores tabs without firing any event, so restored tabs were never re-matched and closing them closed nothing. All three are covered by tests with an asynchronous fake browser, and re-verified live: closes in both browsers reach the server within 4 s, Safari materializes the full session on takeover, and both browsers' tab sets equal the server's entries. A fourth defect followed: the held-close "burst" heuristic treated three quick cmd-W closes as a window close and dropped them; removed, and five rapid closes in Safari plus three in Brave each produced one close per tab. Added a pairing-link flow and device identity in the popup (verified in Brave by screenshot; Safari popup not inspected). Not yet verified: Windows, pinned-state application, two separate machines, long offline periods, restore from snapshot in the real popup, and Safari's native-messaging log (no lines reached the host app; the server-side trace with `CTS_DEBUG=1` works instead and showed a correct takeover one minute after a relaunch).

Setup: follow [INSTALL.md](INSTALL.md). Run the server with `CTS_ALLOW_INSECURE=1` on a LAN address only for a first smoke test; use HTTPS for everything else.

## Capability checks (answers the open questions in [COMPATIBILITY.md](COMPATIBILITY.md))

- [ ] Safari: pairing from the popup shows the host-permission prompt, `permissions.onAdded` completes pairing when the popup closes.
- [ ] Safari: the popup lists tab URLs only after *All Websites* access is granted; before that, the status shows nothing eligible.
- [ ] Both: a received tab opens in the background; the active tab and focused window do not change. A new window created when none is suitable stays unfocused.
- [ ] Both: `runtime.onStartup` fires on launch (log line "startup reset"), and restored tabs are matched to their previous entries, not republished.
- [x] Both: closing a window, quitting, and crash recovery do not produce `close` operations (check the other device keeps its tabs).
- [ ] Safari: the 5-minute alarm fires while Safari is open; after relaunch the first run happens within a minute.
- [ ] Both: the server receives requests without CORS errors once the origin is granted (check the worker console).

## Manual handover (v0.1.0)

- [ ] Safari → Brave: Hand over on Safari, Continue here on Brave: missing tabs appear in the background, existing tabs are reused, duplicates are not created, pinned state follows where supported.
- [ ] Brave → Safari: same in reverse.
- [ ] Continue here with the server unreachable shows an error and changes nothing.
- [ ] A stale device (handed over earlier, then tries Hand over again) is refused and nothing changes.

## Automatic sync (v0.2.0)

- [x] Use Safari, then switch to Brave and click something: Brave takes over within a few seconds; Safari's popup shows "follower" after its next run.
- [ ] Leave both browsers open and idle: ownership does not flip.
- [x] Open a tab on the owner: it appears on the follower within 5 minutes (or after Sync now).
- [x] Navigate a tab on the owner: the follower's copy follows; no extra tab is created when the destination is already open.
- [x] Close a tab on the owner: the follower's background copy closes; if it is the follower's active tab it stays open (verified on one Mac; window close and quit also verified).
- [x] Open the same URL twice on one device: one shared entry; closing one copy changes nothing remotely; closing the last copy closes remotely.
- [ ] Manual Hand over, then touch the same browser within a minute: no automatic takeover until a fresh interaction after 60 s idle.
- [ ] Sleep the laptop for 10 minutes, wake: no spurious closures; the next run reconciles.

## Offline merging and recovery (v1.0.0)

- [ ] Disconnect one device from the network, open and close tabs, navigate, reconnect: additions and closures merge, no duplicate URLs, the popup shows "N changes waiting" while offline.
- [ ] Navigate the same shared tab to different URLs on both devices while one is offline: after reconnect both URLs exist on both devices.
- [ ] Close a tab on one device while the other, offline, navigated it: the navigated page survives as a new entry.
- [ ] Keep a device offline for longer than the retention setting (set `CTS_HISTORY_RETENTION=1h` to test): on reconnect it full-resyncs, keeps its pending work, and does not resurrect closed tabs.
- [ ] Revoke a device from the other device: it is logged out on its next run and cannot pair again without a new code.
- [ ] Restore a snapshot: the listed tabs reopen in the background; a pre-restore snapshot appears in the list.
- [ ] Pause on one device, close tabs there, resume: nothing is deleted remotely.

## Release

- [ ] Fresh install of the server on the VPS from the published image; backup and restore work as documented.
- [ ] Fresh Brave install from the release zip; fresh Safari build from `safari/` in Xcode.
- [ ] Server upgrade (new image) applies migrations and keeps the session.
- [ ] Server logs contain no URLs, tokens or pairing codes.
