# Cross-Tab-Sync extension

One TypeScript code base for Brave (Chromium) and Safari (macOS), Manifest V3, no framework and no polyfill. Wire contract: [`docs/PROTOCOL.md`](../docs/PROTOCOL.md). Browser findings: [`docs/COMPATIBILITY.md`](../docs/COMPATIBILITY.md).

| Path | Contents |
| --- | --- |
| `src/core/` | Browser-free logic, unit tested: eligibility, mappings, planner, journal, state, run lock, API client. `changes.ts` records local tab events, `activity.ts` decides automatic takeover, `apply.ts` applies remote operations, `sync.ts` runs owner/follower syncs, `handover.ts` the manual actions and pairing, `engine.ts` serializes events and runs. |
| `src/adapter/` | `BrowserAdapter` interface, `webext.ts` over `chrome.*`, `fake.ts` in-memory for tests (emits browser events, simulates user actions). |
| `src/background/` | MV3 service worker: wires the engine to browser events, the 5-minute alarm and popup messages. |
| `src/popup/` | Pairing form and status page: role, owner, last sync, pending changes, last error; **Hand over**, **Continue here**, **Sync now**. |
| `manifests/` | `base.json` plus per-browser overrides, merged at build time (`_comment*` keys are stripped). |
| `scripts/` | `build.mjs` (esbuild), `icons.mjs` (placeholder PNGs generated at build). |

## Build and test

Requires Node 22+ and pnpm.

```sh
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest
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

1. Create a code on the server (`cross-tab-sync pair-code`) or, on an already paired browser, open the popup and click **Create pairing code**.
2. In the new browser's popup enter the server URL (`https://…`; `http://localhost` only for local development with `CTS_ALLOW_INSECURE=1`), a device name and the code, then **Pair**.
3. The browser asks for permission to access the server origin. The extension has no install-time host access; it requests only the server's origin from `optional_host_permissions`. If the prompt closes the popup, pairing still completes in the background (the form is saved first and the worker finishes on `permissions.onAdded`); reopen the popup to see the result.

## Using it (v0.2, automatic)

One browser is the **owner** and publishes changes; the others are **followers** and apply them. Details: [PROTOCOL.md "Client behavior (v0.2 automatic sync)"](../docs/PROTOCOL.md).

- **Automatic takeover.** Using a browser after at least 60 s without interaction (switching tabs, focusing a window, opening a tab, navigating the active tab), or for the first time after it lost ownership, makes it the owner (same as **Continue here**). At most one attempt per 30 s; the first 10 s after browser startup and anything the extension itself does are not interaction. A browser that merely stays focused never takes over.
- **Recording.** Both roles journal local changes: a new URL is one `open` (another tab with an already shared URL is just a local copy), navigating a shared tab is a `navigate` (or a fresh `open` when other copies of it stay behind, or joins the matching entry when the URL is already shared), closing the last local copy of a shared tab is a `close`. Closing a window, quitting, crashing, and closes in the first 10 s after startup never delete shared tabs. The owner sends the journal about 2 s after a change; a follower keeps it until it becomes owner.
- **Applying.** Followers pull changes every 5 minutes (alarm), on **Sync now**, and after startup; new shared tabs open in the background in the last focused window, navigations update local copies, closes close background copies. The active tab is never closed: it stays open, unlinked, and is not shared again until you navigate it. Nothing ever changes the active tab or focuses a window. If the server no longer has the history since the last sync, the follower resyncs from the full session without closing anything.
- **Hand over** publishes, releases ownership and pauses automatic takeover on this browser until the next fresh interaction. **Continue here** takes ownership immediately. **Disconnect** releases ownership, revokes this device on the server and forgets the credentials; tabs stay open.

## Behavior notes and limits

- Tab ids are only valid within one browser session. On browser startup the mappings are set aside and restored tabs are re-matched by their last-known URL as they load (for up to 60 s); unmatched ones are dropped.
- Redirects and loads started by the extension are recognised through short-lived expectations (30 s), not published back. A user navigation in the same tab during that window is attributed to the extension.
- Navigating a shared tab to a page that cannot be shared (browser pages, bad URLs) publishes nothing; the tab stays linked to its entry.
- Pinning is applied from remote `update`s and on creation; local pin changes are not published.
- URLs the server cannot parse (bad `%` escapes, no host, over 2048 bytes) are never shared. If the server still rejects a batch as invalid, that batch is dropped from the journal, its tabs are unmapped and the popup shows how many changes were dropped.
- Tab order is a hint only; `tabs.move` is unsupported in Safari and not used. New tabs are appended in session order.
- Operations are journaled in `storage.local` before they are sent and removed only on a server result, so retries resend the same `opId`s. All engine state (journal, mappings, expectations, detached tabs, activity timestamps) lives in `storage.local`; the worker can be suspended at any time.
