# Cross-Tab-Sync

Cross-Tab-Sync preserves your browsing context when switching between Safari on macOS and Brave on Windows. Browser extensions share open webpage tabs through a small service hosted on your VPS.

## App behavior

- One device controls the shared session at a time. Recent local browser activity triggers automatic takeover; a browser merely remaining open does not.
- The active device publishes changes automatically. Other devices follow, adding missing tabs without creating another copy of an already-open URL.
- Synchronization runs approximately every five minutes while the browser and computer are available, and immediately on takeover or manual actions.
- **Hand over** saves current changes and releases control. **Continue here** retrieves the latest session and takes control.
- Tabs close remotely only after a recorded individual-tab closure during tracked use. Closing a window, quitting, crashing, or missing tabs in a snapshot does not delete shared tabs.
- Navigating a shared tab updates its counterpart. Existing destination tabs are reused.
- Reconnecting devices reconcile ownership, revisions, and pending changes before publishing.
- Offline changes merge without duplicate URLs. Known closures suppress stale tabs; intentional new openings survive concurrent closures. Divergent offline navigation preserves both resulting URLs.
- Received changes stay in the background and preserve the receiving browser's current selection.

Duplicate detection uses the complete browser-reported URL, preserving query parameters and fragments. Existing local duplicates remain; the shared URL stays present until its last local copy closes.

## First-release scope

Sync ordinary HTTP/HTTPS webpage tabs, with tab order and pinned state where browser support permits. Collect eligible tabs across normal windows without recreating window organization; add received tabs to a designated normal window.

Exclude private tabs, browser-internal pages, tab groups, cookies, history, login sessions, unsaved forms, and in-memory page state. Automatic ownership is an inference from activity, with manual buttons as overrides.

## Suggested architecture

- **Extensions:** shared TypeScript WebExtension logic and a small HTML/CSS popup, with browser-specific adapters and manifests.
- **Safari:** minimal Swift macOS app wrapper, packaged with Xcode.
- **Backend:** Go HTTP API with SQLite for devices, ownership, revisions, changes, and recovery snapshots.
- **Hosting:** HTTPS on the VPS, optionally using Docker Compose and Caddy.
- **Protocol:** snapshots plus retry-safe open, navigate, and close operations. Persist pending changes locally; enforce ownership and revisions on the server.

See [the roadmap](ROADMAP.md) for version milestones, epics, and implementation jobs.
