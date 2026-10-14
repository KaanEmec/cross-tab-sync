# Scope everything to sessions

## Goal
Let one server host many independent, mutually invisible, end-to-end encrypted sessions, created from the extension without shell access.

## Expected outcome
Protocol v3 as specified in [PROTOCOL.md](../../../docs/PROTOCOL.md) runs on the server: a browser creates a session with `POST /v3/sessions`, invites join it with `POST /v3/pair`, and no request can see or change another session. A personal server can be limited to one session; the existing live deployment keeps working after the upgrade.

## Tasks
- Migration `0004`: `sessions` table (`id`, `revision`, `generation`, `owner_device_id`, `owner_last_seen_at`, `min_revision`, `key_check NOT NULL`, `created_at`); `session_id` on devices, pairing_codes, entries, operations and snapshots. Uniqueness per session: operations `(session_id, seq)` and `(session_id, op_id)`, open entries `(session_id, url_key)`, active device names per session; entries keyed by `(session_id, id)` so an entry id used in another session never collides.
- Migration data: if the old singleton row has a key check and at least one active device, move it and all rows into one new session; otherwise drop the old data. Test both branches with pre-0004 fixtures.
- Session id is opaque and server-only: the auth middleware resolves token → device → session and every store query filters by it (devices, pairing codes, entries, operations, revision, generation, owner, snapshots, key check, `minRevision`, pruning). Ids from another session behave as unknown (`404 not_found`, `ignored`). One cross-session test per endpoint.
- Routes move to `/v3`; `/v1` and `/v2` (including the debug-only `/v2/diag`, now `/v3/diag`) answer `404 not_found`.
- `POST /v3/sessions {keyCheck, name, browser}`: keyCheck 43 base64url characters, name/browser rules as pair; creates the session and its first device in one transaction; `201 {deviceId, token, name}`; `400 invalid_request`; `403 sessions_closed` when `CTS_MAX_SESSIONS` (default 0 = unlimited) sessions exist.
- `POST /v3/pair` joins the code's session; `403 session_full` when the session has `CTS_MAX_DEVICES` (default 10) active devices. `POST /v3/pairing-codes` returns `{code, expiresAt}`.
- Remove: `PUT /session/key`, `409 key_set`, the `link` field, `CTS_PUBLIC_URL`, the `pair-code` CLI subcommand (CLI is `serve` only) and their tests.
- Rate limit: in-memory per-IP fixed window, 10 requests per 10 minutes shared by `/v3/sessions` and `/v3/pair`, every request counted; `429 rate_limited` with `Retry-After` in seconds. IP = the header named by `CTS_CLIENT_IP_HEADER` when set (first comma-separated entry, e.g. `CF-Connecting-IP`), else the last `X-Forwarded-For` entry, else `RemoteAddr` host. Config `CTS_CLIENT_IP_HEADER` (default empty). Expired entries are swept so memory stays bounded. Never log IPs.
- Session lifetime: revoking a session's last active device deletes the session and all its rows in the same transaction. The hourly prune deletes sessions whose newest device `last_seen_at` is older than `CTS_SESSION_RETENTION` (default `4320h`). History retention runs per session.
- `GET /`: one embedded static HTML page, no JavaScript: what the server is, links to `https://github.com/KaanEmec/cross-tab-sync#install` and `https://github.com/KaanEmec/cross-tab-sync/blob/main/docs/PRIVACY.md`, and "paste invite links into the extension instead of opening them". Every other unmatched path stays `404`.
- Config parsing and tests for `CTS_MAX_SESSIONS`, `CTS_MAX_DEVICES`, `CTS_SESSION_RETENTION`; existing limits unchanged.
