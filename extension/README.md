# Cross-Tab-Sync extension

One TypeScript code base for Brave (Chromium) and Safari (macOS), Manifest V3, no framework and no polyfill. Wire contract: [`docs/PROTOCOL.md`](../docs/PROTOCOL.md). Browser findings: [`docs/COMPATIBILITY.md`](../docs/COMPATIBILITY.md).

| Path | Contents |
| --- | --- |
| `src/core/` | Browser-free logic, unit tested: eligibility, mappings, planner, journal, state, run lock, API client. `changes.ts` records local tab events, `activity.ts` decides automatic takeover, `apply.ts` applies remote operations, `sync.ts` runs owner/follower syncs, `merge.ts` submits the journal through `merge`, `handover.ts` the manual actions and pairing, `recovery.ts` snapshots and devices (list, rename, revoke), `pairing.ts` pairing-link parsing (`#CODE.KEY`), `crypto.ts` end-to-end URL encryption (sealed in `client.ts`, so the rest of the core sees plaintext URLs), `devices.ts` device identity and list rows, `status.ts` backoff and status texts, `engine.ts` serializes events and runs. |
| `src/adapter/` | `BrowserAdapter` interface, `webext.ts` over `chrome.*`, `fake.ts` in-memory for tests (emits browser events, simulates user actions). |
| `src/background/` | MV3 service worker: wires the engine to browser events, the 5-minute alarm and popup messages. |
| `src/popup/` | Pairing form (pairing link, device name, Advanced: server URL and code) and status page: role, owner, last sync, local changes (saved / waiting / offline), last error; **Hand over**, **Continue here**, **Sync now**, **Pause sync**; **Recover** (snapshots), **This device** (name, rename, browser, short id, server, paired since, encryption) and **Devices** sections; **Invite another browser**. |
| `manifests/` | `base.json` plus per-browser overrides, merged at build time (`_comment*` keys are stripped). |
| `scripts/` | `build.mjs` (esbuild), `icons.mjs` (placeholder PNGs generated at build). |

## Build and test

Requires Node 22+ and pnpm.

```sh
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest
pnpm test:integration  # real Go server + client (needs `go`)
pnpm build       # dist/brave and dist/safari
pnpm watch       # rebuild bundles on change
```

## Brave

1. `pnpm build`
2. Open `brave://extensions`, enable **Developer mode**, **Load unpacked**, pick `extension/dist/brave`.
3. After a rebuild, press the reload button on the extension card.

## Safari

Generate the Xcode wrapper once (Apple renamed the tool; `safari-web-extension-converter` is the old alias):

```sh
pnpm build
xcrun safari-web-extension-packager dist/safari --project-location ../safari \
  --app-name "Cross-Tab-Sync" --bundle-identifier com.kaanemec.crosstabsync \
  --macos-only --swift --no-open
```

Build and run the app in Xcode, then in Safari: **Settings > Advanced > Show features for web developers**, **Settings > Developer > Allow unsigned extensions** (resets when Safari quits), enable the extension under **Settings > Extensions**. For a quick loop without Xcode (Safari 18.4+): **Settings > Developer > Add Temporary Extension…** and pick `dist/safari`.

**Grant website access to "All Websites"** (Settings > Extensions > Cross-Tab-Sync > Edit Websites). Safari reports an empty URL for tabs on sites the extension may not access; such tabs are treated as ineligible and are neither shared nor matched.

## Pairing

Tab URLs are end-to-end encrypted (protocol v2): the server stores only a keyed hash and a ciphertext per tab. The key is created by the first browser and travels only inside invite links (`https://tabs.example.com#ABCD2345.<key>`; the part after `#` never reaches the server).

1. Get a pairing link. **First browser** (empty server): run `cross-tab-sync pair-code` on the server (prints `https://tabs.example.com#ABCD2345` when `CTS_PUBLIC_URL` is set, else the bare code); this browser then generates the key. **Every further browser**: on an already paired browser open the popup, **Invite another browser**, **Copy**. That link contains the encryption key: share it privately; it is valid 10 minutes, single use. Paste it into the other browser's extension; do not open it as a page (pages on the server's own origin are never shared). Every pairing proves the key against the server's stored key check; a wrong key, or a keyless code once the server has a key or another browser, is refused and the new device revokes itself: use an invite link.
2. In the new browser's popup paste the link, check the device name (prefilled `<Browser> on <OS>`), then **Pair**. A bare code works when the browser already knows the server (from an earlier pairing) or with the server URL under **Advanced** (`https://…`; `http://localhost` / `127.0.0.1` only for local development with `CTS_ALLOW_INSECURE=1`). A name another active device already uses gets a number (`Brave on macOS 2`).
3. The browser asks for permission to access the server origin. The extension has no install-time host access; it requests only the server's origin from `optional_host_permissions`. If the prompt closes the popup, pairing still completes in the background (the form is saved first and the worker finishes on `permissions.onAdded`); reopen the popup to see the result.

## Using it (automatic sync, v1.0 offline work)

One browser is the **owner** and publishes changes; the others are **followers** and apply them. Details: [PROTOCOL.md "Client behavior (v0.2 automatic sync)"](../docs/PROTOCOL.md).

- **Automatic takeover.** Using a browser after at least 60 s without interaction (switching tabs, focusing a window, opening a tab, navigating the active tab), or for the first time after it lost ownership, makes it the owner (same as **Continue here**). At most one attempt per 30 s; the first 10 s after browser startup and anything the extension itself does are not interaction. A browser that merely stays focused never takes over.
- **Recording.** Both roles journal local changes: a new URL is one `open` (another tab with an already shared URL is just a local copy), navigating a shared tab is a `navigate` (or a fresh `open` when other copies of it stay behind, or joins the matching entry when the URL is already shared), closing the last local copy of a shared tab is a `close`, sent after a 2 s hold. Closing a window, quitting, crashing, and closes in the first 10 s after startup never delete shared tabs: a held close is dropped when its window is gone or was reported removed, or when three or more tabs of one window close within the hold. The owner sends the journal about 2 s after a change; a follower submits it through `merge` on its next run (5-minute cycle, **Sync now**, or a retry), without taking ownership.
- **Applying.** Followers pull changes every 5 minutes (alarm), on **Sync now**, and after startup; new shared tabs open in the background in the last focused window, navigations update local copies, closes close background copies. The active tab is never closed: it stays open, unlinked, and is not shared again until you navigate it. Nothing ever changes the active tab or focuses a window. If the server no longer has the history since the last sync, the follower resyncs from the full session without closing anything. Taking over first applies the changes since the last sync, then the session.
- **Divergence.** When this browser changed a shared tab that another browser navigated or closed meanwhile, nothing is lost: the local page is kept and published as a new shared tab, and a remote destination opens in its own background tab.
- **Offline (v1.0).** Every journaled change records the revision it was based on. Followers send the journal through `merge`, where the server checks it causally: a navigation of a tab another browser navigated meanwhile becomes a new shared tab (both pages survive), a close or pin change of such a tab is ignored. Network errors and server errors (5xx) mark the browser offline and retry after 30 s, doubling to at most 5 min, with the same operation ids; success resets the backoff. When the server no longer has the history since this browser's revision, it rebuilds from the full session (tabs whose entries are gone are unlinked, never closed) and keeps the journal.
- **Status.** The popup shows **Saved to server**, **N changes waiting (offline, retrying at HH:MM)** or **Paused**. The server accepting a change does not mean the other browsers applied it yet; they do on their next sync. Errors say what to do: pair again (`unauthorized`, revoked device), grant access to the server origin (missing site permission; **Grant access** button), or wait for the retry (unreachable server, 5xx).
- **Pause sync** stops all runs and automatic takeover on this browser; local changes are still journaled. **Resume sync** first releases held closes (dropped when their window is gone, so nothing missing becomes a deletion), then runs.
- **Recover** lists the server's snapshots (time, device, tab count). **Restore** (click twice) takes over if needed, reopens the snapshot's URLs as new shared tabs (nothing is closed or rewound) and opens them here in the background. URLs only: unsaved form input and page state cannot be recovered.
- **This device** shows the name (**Rename**), browser, short id (first 8 characters of the device id; **Copy** copies the full id), server URL, when it was paired and **Encryption: on**. The key is never shown except inside invite links; **Disconnect** forgets it. "Different encryption key" means this browser cannot decrypt the shared tabs: disconnect and pair again with an invite link. The owner line shows `Name (shortid)`.
- **Devices** lists paired devices with short id and last seen, this device marked; **Revoke** (click twice) removes another one. Devices revoked in the last 7 days stay listed, greyed. Use **Disconnect** for this browser; pairing again gives it a new identity.
- **Hand over** publishes, releases ownership and pauses automatic takeover on this browser until the next fresh interaction. **Continue here** takes ownership immediately. **Disconnect** releases ownership, revokes this device on the server and forgets the credentials; tabs stay open.

## Behavior notes and limits

- Tab ids are only valid within one browser session. On browser startup the mappings are set aside and restored tabs are re-matched by their last-known URL as they load (for up to 60 s); unmatched ones are dropped.
- Redirects, loads started by the extension, and URL rewrites by the page shortly after (history.replaceState, hashes, script and login redirects) are not published back: a load the extension starts counts as its own for up to 30 s, and until 10 s after the page first finishes loading. A user navigation in that tab within that window is attributed to the extension too.
- Tab ids are checked against a marker in `storage.session` (cleared when the browser quits) before every event, so restored tabs that reuse ids of the previous session are re-matched by URL even when their events arrive before `runtime.onStartup`. Reloading or updating the extension clears the marker as well and starts the same 10 s grace; an update (`runtime.onInstalled` with reason `update`) always runs that reset and re-matches the open tabs by URL right away.
- Navigating a shared tab to a page that cannot be shared (browser pages, bad URLs) publishes nothing; the tab stays linked to its entry.
- Pinning is applied from remote `update`s and on creation; local pin changes are not published.
- URLs with bad `%` escapes, no host, or over 2048 bytes are never shared (the server cannot check URLs any more, only the sealed fields' shape). If the server still rejects a batch as invalid, that batch is dropped from the journal, its tabs are unmapped and the popup shows how many changes were dropped.
- Tab order is a hint only; `tabs.move` is unsupported in Safari and not used. New tabs are appended in session order.
- Operations are journaled in `storage.local` before they are sent and removed only on a server result, so retries resend the same `opId`s. All engine state (journal, mappings, expectations, detached tabs, activity timestamps) lives in `storage.local`; the worker can be suspended at any time.
