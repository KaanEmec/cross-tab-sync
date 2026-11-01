# Deploy

`docker-compose.yml` runs the Cross-Tab-Sync service (`cts`, built from `../server` with `server/Dockerfile`) behind Caddy, which terminates TLS for `CTS_DOMAIN`. Step-by-step install, backups, upgrades and restore: [docs/INSTALL.md](../docs/INSTALL.md).

Quick start: `CTS_DOMAIN=tabs.example.com CTS_MAX_SESSIONS=1 docker compose up -d`, then enter `https://tabs.example.com` under **Advanced** in the extension and click **Start syncing**. `CTS_MAX_SESSIONS` limits how many independent sessions the server accepts (default `0` = unlimited, as on a public server; `1` for a personal one). Other settings: [server/README.md](../server/README.md).

The service uses the release image `ghcr.io/kaanemec/cross-tab-sync:${CTS_VERSION:-latest}`; set `CTS_VERSION` to pin a version, or `docker compose up -d --build` to build from source.

Without Docker, run a release binary (`cross-tab-sync_<os>_<arch>`) with `cross-tab-sync serve` behind any TLS reverse proxy that sets `X-Forwarded-Proto: https` and replaces `X-Forwarded-For` with the client address (the sign-up rate limit uses its last entry; behind Cloudflare set `CTS_CLIENT_IP_HEADER=CF-Connecting-IP`); keep its port (`CTS_ADDR`) off the public network. Persist `CTS_DB_PATH` and back up the `-wal` and `-shm` files with it.

Caddy compression (`encode zstd gzip`) is enabled. The API paths are under `/v3`; the server only ever stores ciphertext for tab URLs.
