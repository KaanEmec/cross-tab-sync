# Cross-Tab-Sync server

Go service implementing [docs/PROTOCOL.md](../docs/PROTOCOL.md) v3 (routes under `/v3`). Stdlib `net/http`, SQLite via `modernc.org/sqlite` (no CGO), embedded migrations applied at startup.

One server hosts many independent sessions. A browser starts a session with `POST /v3/sessions`, invites others with pairing codes, and every token maps to a device and the device to its session: no request names a session, session ids never leave the server, and ids from another session behave as unknown. Revoking a session's last active device deletes the session and all its rows; the hourly prune deletes sessions without device activity for `CTS_SESSION_RETENTION`.

URLs are end-to-end encrypted: the server stores and returns each tab's `urlKey` (keyed hash, used to coalesce duplicates) and `urlEnc` (ciphertext) verbatim. It only checks their length and base64url alphabet and never decodes `urlEnc`; it holds no key. Operation objects with unknown fields (such as a plaintext `url`) are rejected with `400 invalid_request`. Each session's `keyCheck` (an HMAC derived from its key) is set once by `POST /v3/sessions` and returned with the session so browsers can detect a wrong key.

**Upgrading from v2**: the first start of a v3 server keeps the existing session (with all its devices, tabs, history and snapshots) when it has a key check and an active device; otherwise it drops the old data. Active devices whose names collide (ignoring case) get a ` N` suffix. `/v1` and `/v2` routes answer `404 not_found`; the `pair-code` command, `PUT /v2/session/key` and `CTS_PUBLIC_URL` are gone.

## Build and test

```sh
go build -o bin/cross-tab-sync ./cmd/cross-tab-sync
go vet ./... && go test -race ./... && golangci-lint run
```

## Run

```sh
CTS_ALLOW_INSECURE=1 ./bin/cross-tab-sync serve     # local development over plain HTTP
CTS_MAX_SESSIONS=1 ./bin/cross-tab-sync serve       # personal server: the first browser's session only
```

The CLI has one command, `serve`; sessions and invites are created from the extension. See [deploy/](../deploy) for the Compose + Caddy setup (`CTS_DOMAIN=tabs.example.com docker compose up -d`).

| Variable | Default | Meaning |
| --- | --- | --- |
| `CTS_ADDR` | `:8080` | Listen address |
| `CTS_DB_PATH` | `./data/cts.db` | SQLite file (created `0600`, WAL mode) |
| `CTS_ALLOW_INSECURE` | `false` | Accept plain HTTP. Otherwise requests need TLS or `X-Forwarded-Proto: https` (set by Caddy; never expose the service port directly) |
| `CTS_OWNER_LIVENESS` | `10m` | Owner is stale after this long without heartbeat or operations |
| `CTS_SNAPSHOT_RETENTION` | `20` | Recovery snapshots kept per session |
| `CTS_HISTORY_RETENTION` | `720h` | Operation log and tombstones kept per session (Go duration) |
| `CTS_SESSION_RETENTION` | `4320h` | Sessions none of whose devices has been seen for this long are deleted with all their data (Go duration, 180 days) |
| `CTS_MAX_SESSIONS` | `0` | Sessions on this server; `0` is unlimited, a personal server sets `1`. Beyond it `POST /v3/sessions` answers `403 sessions_closed` |
| `CTS_MAX_DEVICES` | `10` | Active devices per session (at least 1). Beyond it `POST /v3/pair` answers `403 session_full` |
| `CTS_CLIENT_IP_HEADER` | unset | Header carrying the client IP for the rate limit, e.g. `CF-Connecting-IP` behind Cloudflare (first comma-separated entry). Unset or absent from a request: the last `X-Forwarded-For` entry (the one the reverse proxy sets), else the connection address. Only set it when every request passes the proxy that writes the header |
| `CTS_DEBUG` | `false` | Development aid. Enables `POST /v3/diag`, where the extension (with diagnostics on, by default when its server is a loopback address) sends its trace: event kinds, tab ids, entry id prefixes, op types and run results, never URLs or tokens. Each line is logged at info level as `msg: "diag"` with `device_id` and `line`. Unset: the route answers `404 not_found`. Do not enable in production |

With `CTS_MAX_SESSIONS=1`, once the only session is deleted (its last device disconnected, or pruned after `CTS_SESSION_RETENTION`), the slot is open to anyone who can reach the server. To recover a slot taken by a stranger, stop the server, delete `cts.db`, `cts.db-wal` and `cts.db-shm` in the data volume, and start it again.

Logs are JSON on stdout with method, route pattern, status, device id and latency only; never URLs, tokens, session ids or client IPs. Request bodies are limited to 256 KiB. `POST /v3/sessions` and `POST /v3/pair` share an in-memory budget of 10 requests per 10 minutes per client IP, IPv6 addresses counted per /64 (`429 rate_limited` with `Retry-After`); client IPs live only in that memory, for at most 10 000 clients at once. A session keeps at most 10 live pairing codes; a new one replaces the oldest. History older than `CTS_HISTORY_RETENTION` is pruned per session at startup and hourly (open entries are always kept); clients behind `minRevision` get `410 history_expired` or `fullResync: true` and reload the session. Operations older than the retention window are treated as new if resubmitted, so a resent opening of a pruned closed entry recreates it.

## API summary

| Method and path | Auth | Purpose |
| --- | --- | --- |
| `GET /` | none | Static page without script: what the server is, install and privacy links |
| `GET /healthz` | none | `{"status":"ok"}` |
| `POST /v3/sessions` | none, rate limited | New session with `{keyCheck, name, browser}` and the caller as first device |
| `POST /v3/pair` | none, rate limited | Join the code's session with `{code, name, browser}` |
| `POST /v3/pairing-codes` | device | `{code, expiresAt}`: single use, 10 minutes, for the caller's session |
| `GET /v3/devices`, `PATCH`/`DELETE /v3/devices/{id}` | device | List, rename self, revoke (the last active device deletes the session) |
| `GET /v3/session`, `GET /v3/session/changes?since=R` | device | Session model, operations after `R` |
| `POST /v3/session/{acquire,release,heartbeat,operations,merge}` | device | Ownership and writes |
| `GET /v3/snapshots`, `POST /v3/snapshots/{id}/restore` | device | Recovery snapshots (ids count per session) |

## curl examples

```sh
S=http://localhost:8080
# The extension derives keyCheck from the session key (docs/PROTOCOL.md, Encryption); any 43 base64url chars work here.
curl -s -X POST $S/v3/sessions -d '{"keyCheck":"Q2hlY2tDaGVja0NoZWNrQ2hlY2tDaGVja0NoZWNrQ2h","name":"MacBook Safari","browser":"safari"}'
T=cts_...   # token from the response
curl -s -X POST $S/v3/pairing-codes -H "Authorization: Bearer $T"     # {"code":"ABCD2345","expiresAt":"..."}
curl -s -X POST $S/v3/pair -d '{"code":"ABCD2345","name":"MacBook Safari","browser":"safari"}'   # name comes back as "MacBook Safari 2"
curl -s -X PATCH $S/v3/devices/<deviceId> -H "Authorization: Bearer $T" -d '{"name":"Work Mac"}'   # self only
curl -s -X POST $S/v3/session/acquire -H "Authorization: Bearer $T" -d '{"force":true}'
# Clients send urlKey (43 base64url chars) and urlEnc (1-4096 base64url chars), derived from the
# session key. The server never decodes urlEnc: placeholders work.
curl -s -X POST $S/v3/session/operations -H "Authorization: Bearer $T" -d '{
  "generation": 1, "baseRevision": 0,
  "operations": [{"opId":"3f0e8f9c-1b7a-4c2e-9a51-0c8d2b6f4a10","type":"open",
                  "entryId":"8a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
                  "urlKey":"DxFdsGK3wN0DCxaHjJnepcNUtJ3DezjriEYXnHeD6dc",
                  "urlEnc":"AQAAAAAAAAAAAAAAAHBsYWNlaG9sZGVy"}]}'
curl -s "$S/v3/session/changes?since=0" -H "Authorization: Bearer $T"
# Offline journal from any device (no ownership); each op carries its own baseRevision.
curl -s -X POST $S/v3/session/merge -H "Authorization: Bearer $T" -d '{
  "operations": [{"opId":"7c9e6679-7425-40de-944b-e07fc1f90ae7","type":"navigate","baseRevision":1,
                  "entryId":"8a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d","urlKey":"gZjRusQKEDNlOnjkiADO_J5rl0_wdcZuVUi1weFForA",
                  "urlEnc":"AQAAAAAAAAAAAAAAAG90aGVyIHBsYWNl"}]}'
curl -s -X POST $S/v3/session/release -H "Authorization: Bearer $T" -d '{"generation":1}'
```

## Layout

- `cmd/cross-tab-sync` CLI (`serve`)
- `internal/config` environment configuration
- `internal/store` SQLite access scoped per session, migrations (`migrations/NNNN_*.sql`), transactions, pruning
- `internal/session` pure operation semantics (coalescing, tombstones, validation)
- `internal/api` handlers, auth, rate limit, root page, HTTPS check, logging, JSON errors
