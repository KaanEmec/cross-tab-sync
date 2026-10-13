# Cross-Tab-Sync extension

One TypeScript code base for Brave (Chromium) and Safari (macOS), Manifest V3, no framework and no polyfill. Wire contract: [`docs/PROTOCOL.md`](../docs/PROTOCOL.md). Browser findings: [`docs/COMPATIBILITY.md`](../docs/COMPATIBILITY.md).

| Path | Contents |
| --- | --- |
| `src/core/` | Browser-free logic, unit tested: eligibility, mappings, planner, journal, state, run lock, API client, handover orchestration. |
| `src/adapter/` | `BrowserAdapter` interface, `webext.ts` over `chrome.*`, `fake.ts` in-memory for tests. |
| `src/background/` | MV3 service worker: message handler for the popup, heartbeat alarm, receiving-window tracking. |
| `src/popup/` | Pairing form and status page with **Hand over** / **Continue here**. |
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

## Using it (v0.1, manual)

- **Continue here** takes ownership (`acquire` with `force`), reuses local tabs with the exact same URL, opens missing shared tabs in the background in the last focused normal window, then publishes local tabs that are not shared yet. Status: "Owner, generation G, revision R".
- **Hand over** publishes local tabs that are not shared yet and releases ownership. Status: "Handed over at revision R".
- Neither action closes tabs, changes the active tab or focuses a window. Private windows and non-http(s) pages are never shared. Existing local duplicates are kept.
- While owner, a heartbeat alarm (5 min) keeps ownership alive. **Disconnect** releases ownership, revokes this device on the server and forgets the credentials; tabs stay open.

## Behavior notes and limits (v0.1)

- Tab ids are only valid within one browser session. On browser startup the mappings are set aside and the next action re-matches them to the restored tabs by each tab's last-known URL (kept current from `tabs.onUpdated`); unmatched ones are dropped.
- Navigating a shared tab is not propagated yet (v0.2 `navigate`); the tab stays mapped to its entry.
- URLs the server cannot parse (bad `%` escapes, no host, over 2048 bytes) are never shared. If the server still rejects a batch as invalid, that batch is dropped from the journal, its tabs are unmapped and the popup shows how many changes were dropped.
- Tab order is a hint only; `tabs.move` is unsupported in Safari and not used. New tabs are appended in session order. Pinned state is applied when tabs are created.
- Operations are journaled in `storage.local` before they are sent and removed only on a server result, so retries resend the same `opId`s.

## Integration test (real server)

`pnpm test:integration` builds the Go server (`go build` in `../server`, needs `go` on PATH, otherwise the suite is skipped), starts it on a free loopback port with `CTS_ALLOW_INSECURE=1` and a temporary database, pairs two simulated devices through the real `/v1/pair` and drives `continueHere` / `handOver` with the real `ApiClient` and `fetch` against it. Tests live in `test/integration/*.integration.ts` and are not part of `pnpm test`.
