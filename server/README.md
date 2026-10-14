# Cross-Tab-Sync server

Go service implementing [docs/PROTOCOL.md](../docs/PROTOCOL.md). Stdlib `net/http`, SQLite via `modernc.org/sqlite` (no CGO), embedded migrations applied at startup.

## Build and test

```sh
go build -o bin/cross-tab-sync ./cmd/cross-tab-sync
go test -race ./... && golangci-lint run
```

## Run

```sh
CTS_ALLOW_INSECURE=1 ./bin/cross-tab-sync serve     # local development over plain HTTP
./bin/cross-tab-sync pair-code                      # prints a single-use code (stdout), expiry on stderr
CTS_PUBLIC_URL=http://127.0.0.1:8080 ./bin/cross-tab-sync pair-code   # prints http://127.0.0.1:8080#ABCD2345
```

`pair-code` prints a pairing link (`CTS_PUBLIC_URL#CODE`) when `CTS_PUBLIC_URL` is set, otherwise the bare code and a hint on stderr; paste either into the extension popup (a bare code only once the browser knows the server URL). `pair-code` opens the same database as `serve` (it may run while the server is up). In Docker: `docker compose exec cts /cross-tab-sync pair-code`. See [deploy/](../deploy) for the Compose + Caddy setup (`CTS_DOMAIN=tabs.example.com docker compose up -d`).

| Variable | Default | Meaning |
| --- | --- | --- |
| `CTS_ADDR` | `:8080` | Listen address |
| `CTS_DB_PATH` | `./data/cts.db` | SQLite file (created `0600`, WAL mode) |
| `CTS_ALLOW_INSECURE` | `false` | Accept plain HTTP. Otherwise requests need TLS or `X-Forwarded-Proto: https` (set by Caddy; never expose the service port directly) |
| `CTS_OWNER_LIVENESS` | `10m` | Owner is stale after this long without heartbeat or operations |
| `CTS_SNAPSHOT_RETENTION` | `20` | Recovery snapshots kept |
| `CTS_HISTORY_RETENTION` | `720h` | Operation log and tombstones kept (Go duration) |
| `CTS_PUBLIC_URL` | unset | Public base URL, e.g. `https://tabs.example.com` (http/https, no query or fragment). Used for pairing links from `POST /v1/pairing-codes` and `pair-code`. Unset: the API derives it from the request (TLS or `X-Forwarded-Proto` scheme + `Host`) and the CLI prints bare codes |
| `CTS_DEBUG` | `false` | Development aid. Enables `POST /v1/diag`, where the extension (with diagnostics on, by default when its server is a loopback address) sends its trace: event kinds, tab ids, entry id prefixes, op types and run results, never URLs or tokens. Each line is logged at info level as `msg: "diag"` with `device_id` and `line`. Unset: the route answers `404 not_found`. Do not enable in production |

Logs are JSON on stdout with method, route pattern, status, device id and latency only. History older than `CTS_HISTORY_RETENTION` is pruned at startup and hourly (open entries are always kept); clients behind `minRevision` get `410 history_expired` or `fullResync: true` and reload the session. Operations older than the retention window are treated as new if resubmitted, so a resent opening of a pruned closed entry recreates it.

## curl examples

```sh
S=http://localhost:8080
curl -s -X POST $S/v1/pair -d '{"code":"ABCD2345","name":"MacBook Safari","browser":"safari"}'
T=cts_...   # token from the response; "name" is the stored name ("MacBook Safari 2" if taken)
curl -s -X PATCH $S/v1/devices/<deviceId> -H "Authorization: Bearer $T" -d '{"name":"Work Mac"}'   # self only
curl -s -X POST $S/v1/session/acquire -H "Authorization: Bearer $T" -d '{"force":true}'
curl -s -X POST $S/v1/session/operations -H "Authorization: Bearer $T" -d '{
  "generation": 1, "baseRevision": 0,
  "operations": [{"opId":"3f0e8f9c-1b7a-4c2e-9a51-0c8d2b6f4a10","type":"open",
                  "entryId":"8a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d","url":"https://example.com/"}]}'
curl -s "$S/v1/session/changes?since=0" -H "Authorization: Bearer $T"
# Offline journal from any device (no ownership); each op carries its own baseRevision.
curl -s -X POST $S/v1/session/merge -H "Authorization: Bearer $T" -d '{
  "operations": [{"opId":"7c9e6679-7425-40de-944b-e07fc1f90ae7","type":"navigate","baseRevision":1,
                  "entryId":"8a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d","url":"https://example.org/"}]}'
curl -s -X POST $S/v1/session/release -H "Authorization: Bearer $T" -d '{"generation":1}'
```

## Layout

- `cmd/cross-tab-sync` CLI (`serve`, `pair-code`)
- `internal/config` environment configuration
- `internal/store` SQLite access, migrations (`migrations/NNNN_*.sql`), transactions
- `internal/session` pure operation semantics (coalescing, tombstones, validation)
- `internal/api` handlers, auth, HTTPS check, logging, JSON errors
