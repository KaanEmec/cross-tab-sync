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
```

`pair-code` opens the same database as `serve` (it may run while the server is up). In Docker: `docker compose exec cts /cross-tab-sync pair-code`. See [deploy/](../deploy) for the Compose + Caddy setup (`CTS_DOMAIN=tabs.example.com docker compose up -d`).

| Variable | Default | Meaning |
| --- | --- | --- |
| `CTS_ADDR` | `:8080` | Listen address |
| `CTS_DB_PATH` | `./data/cts.db` | SQLite file (created `0600`, WAL mode) |
| `CTS_ALLOW_INSECURE` | `false` | Accept plain HTTP. Otherwise requests need TLS or `X-Forwarded-Proto: https` (set by Caddy; never expose the service port directly) |
| `CTS_OWNER_LIVENESS` | `10m` | Owner is stale after this long without heartbeat or operations |
| `CTS_SNAPSHOT_RETENTION` | `20` | Recovery snapshots kept |

Logs are JSON on stdout with method, path, status, device id and latency only.

## curl examples

```sh
S=http://localhost:8080
curl -s -X POST $S/v1/pair -d '{"code":"ABCD2345","name":"MacBook Safari","browser":"safari"}'
T=cts_...   # token from the response
curl -s -X POST $S/v1/session/acquire -H "Authorization: Bearer $T" -d '{"force":true}'
curl -s -X POST $S/v1/session/operations -H "Authorization: Bearer $T" -d '{
  "generation": 1, "baseRevision": 0,
  "operations": [{"opId":"3f0e8f9c-1b7a-4c2e-9a51-0c8d2b6f4a10","type":"open",
                  "entryId":"8a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d","url":"https://example.com/"}]}'
curl -s "$S/v1/session/changes?since=0" -H "Authorization: Bearer $T"
curl -s -X POST $S/v1/session/release -H "Authorization: Bearer $T" -d '{"generation":1}'
```

## Layout

- `cmd/cross-tab-sync` CLI (`serve`, `pair-code`)
- `internal/config` environment configuration
- `internal/store` SQLite access, migrations (`migrations/NNNN_*.sql`), transactions
- `internal/session` pure operation semantics (coalescing, tombstones, validation)
- `internal/api` handlers, auth, HTTPS check, logging, JSON errors
