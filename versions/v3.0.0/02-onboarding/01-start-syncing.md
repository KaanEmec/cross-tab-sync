# Start syncing from the popup

## Goal
Let a non-technical person start syncing and invite a second browser from the popup alone.

## Expected outcome
On a fresh install, **Start syncing** creates a session on the hosted server (or a self-hosted one), and the popup immediately shows an invite link to paste into the other browser. Client rules are in [PROTOCOL.md](../../../docs/PROTOCOL.md#client-behavior-v10-offline-merging-recovery-controls); the sync core is unchanged.

## Tasks
- `src/core/config.ts`: `DEFAULT_SERVER_URL = "https://cts.kexperiments.com"`.
- Unpaired popup: primary button **Start syncing**; secondary **I have an invite link** reveals the existing paste field; **Advanced** keeps only the Server URL field, which also applies to Start syncing. The device name field stays, prefilled `<Browser> on <OS>`.
- Disclosure line next to Start syncing: "Tab addresses are encrypted in this browser before they are sent. The server only stores ciphertext."
- Start syncing: persist the form, `permissions.request` for the server origin (user gesture), generate the root key, compute `keyCheck`, `POST /v3/sessions`, store credentials, key and `keyVerified`. Map `403 sessions_closed` and `429 rate_limited` (with the retry time) to clear messages.
- After success: main view with Devices expanded and an invite already created, with "Install the extension in your other browser and paste this link there."
- Invite links: always `#CODE.KEY`, built from the stored server URL; a link without a key (or a bare code) is invalid input with a clear message. Joining compares `keyCheck` before anything else and self-revokes with `key_mismatch` on mismatch (unchanged). Map `403 session_full`.
- Remove: keyless pairing, `KEY_REQUIRED` self-revocation, `PUT session/key`, `key_set` handling, the `link` response field and the separate code field.
- All client routes `/v3`. A `404` from any `/v3` route reports "This server runs an older version" (errorKind `server`).
- Unit tests for each popup state and error mapping; integration test against the real server: start, invite, join, cross-session isolation.
