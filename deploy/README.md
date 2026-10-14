# Deploy

`docker-compose.yml` runs the Cross-Tab-Sync service (`cts`, built from `../server` with `Dockerfile`) behind Caddy, which terminates TLS for `CTS_DOMAIN`. Step-by-step install, backups, upgrades and restore: [docs/INSTALL.md](../docs/INSTALL.md).

Quick start: `CTS_DOMAIN=tabs.example.com docker compose up -d`, then `docker compose exec cts /cross-tab-sync pair-code`.

The service uses the release image `ghcr.io/kaanemec/cross-tab-sync:${CTS_VERSION:-latest}`; set `CTS_VERSION` to pin a version, or `docker compose up -d --build` to build from source.

Without Docker, run a release binary (`cross-tab-sync_<os>_<arch>`) with `cross-tab-sync serve` behind any TLS reverse proxy that sets `X-Forwarded-Proto: https`; keep its port (`CTS_ADDR`) off the public network. Persist `CTS_DB_PATH` and back up the `-wal` and `-shm` files with it.

Caddy compression (`encode zstd gzip`) is enabled. The API paths are under `/v2`; the server only ever stores ciphertext for tab URLs.
