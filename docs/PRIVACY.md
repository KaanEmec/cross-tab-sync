# Privacy policy

Cross-Tab-Sync keeps the open tabs of your browsers in sync through a server: the hosted one at `https://cts.kexperiments.com` (operated by Kaan Emeç) or one you run yourself. This policy covers the extension, the Safari app and the hosted server. Effective 2026-10-14.

## What the extension sends

Tab addresses are encrypted in this browser before they are sent. The server only stores ciphertext. The key is created in your first browser and travels only inside the invite links you paste into your other browsers; it is never sent to the server.

The server stores, per sync session:

- each tab's encrypted address and a keyed fingerprint of it (so it can merge duplicates without reading them), pinned state and order;
- when tabs were opened, changed or closed, and by which of your devices;
- your device names (for example "Brave on Windows"), browser type, and when each device was last seen;
- a hash of each device token and a check value that lets browsers confirm they hold the same key.

It never receives page titles, page contents, cookies, history, form data or private-window tabs. It cannot read, change or invent a tab address. The server software logs the method, route, status and device id of each request; never addresses, tokens or IP addresses. To limit abuse, the server keeps client IP addresses in memory for up to 10 minutes when a session is created or a browser joins one; they are not written to disk.

## What stays in your browser

The server address, device id and token, the encryption key, and a local journal of tab changes not yet sent (with readable addresses), in the browser's extension storage. Nothing leaves the browser except the encrypted requests above.

## What is not done

No analytics, tracking, advertising or third-party services. Data is not sold, shared or used for anything but syncing your tabs.

## Deleting your data

**Disconnect** in the extension removes that device from the session. When the last device of a session disconnects, the server deletes the session and all its data immediately. Sessions with no activity for 180 days are deleted automatically. Revoked devices stay listed (without access) for 7 days.

## Self-hosted servers

If you use your own server, you are its operator and this policy describes what the software stores; the hosted instance's operator sees nothing.

## Contact

Questions and requests: open an issue at <https://github.com/KaanEmec/cross-tab-sync/issues>.
