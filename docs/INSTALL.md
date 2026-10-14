# Installation

Three pieces: the server on a VPS, the Brave extension on Windows, the Safari app on macOS. Release assets (server binaries, Brave and Safari zips) are on the GitHub Releases page; the container image is `ghcr.io/kaanemec/cross-tab-sync`.

## 1. Server (VPS, Docker Compose + Caddy)

Prerequisites: a VPS with Docker and the Compose plugin, ports 80, 443 (TCP and UDP) open, and a domain you control.

1. Create a DNS `A` (and `AAAA` if you have IPv6) record, for example `tabs.example.com`, pointing at the VPS. Wait until it resolves; Caddy obtains the Let's Encrypt certificate on first start and needs port 80 reachable.
2. Get the deploy files: `git clone https://github.com/kaanemec/cross-tab-sync && cd cross-tab-sync/deploy`.
3. Put the configuration in `deploy/.env`: `CTS_DOMAIN=tabs.example.com` and optionally `CTS_VERSION=1.0.0` (a release version, no leading `v`; default `latest`).
4. Start: `docker compose pull cts && docker compose up -d`. Check `https://tabs.example.com/healthz` returns `{"status":"ok"}`.
5. Create the first pairing link: `docker compose exec -e CTS_PUBLIC_URL=https://tabs.example.com cts /cross-tab-sync pair-code` prints `https://tabs.example.com#ABCD2345`. Without `CTS_PUBLIC_URL` it prints only the code. It is single use and expires after 10 minutes; run the command again for another. Later browsers are easier: **Invite another browser** in the popup of an already paired browser shows a link to copy.

Settings (`CTS_OWNER_LIVENESS`, `CTS_SNAPSHOT_RETENTION`, ...) are listed in [server/README.md](../server/README.md). The service port is never published; only Caddy reaches it, which is what makes `X-Forwarded-Proto` trustworthy. Without Docker, run a binary from the release with your own TLS proxy ([deploy/README.md](../deploy/README.md)).

### Data, backups and restore

All state is one SQLite database in the `cts-data` volume: `cts.db` plus `cts.db-wal` and `cts.db-shm` (WAL mode). Copying only `cts.db` while the server runs can lose recent writes, so back up the whole directory. Find the volume name with `docker volume ls` (usually `deploy_cts-data`).

```sh
# Backup (stops the server for a few seconds so the WAL is quiescent)
docker compose stop cts
docker run --rm -v deploy_cts-data:/data -v "$PWD":/backup alpine tar czf /backup/cts-$(date +%F).tgz -C /data .
docker compose start cts

# Restore
docker compose stop cts
docker run --rm -v deploy_cts-data:/data -v "$PWD":/backup alpine sh -c \
  'rm -rf /data/* && tar xzf /backup/cts-YYYY-MM-DD.tgz -C /data && chown -R 65532:65532 /data'
docker compose start cts
```

Backups contain device token hashes and your tab URLs in plain text: store them privately. Restoring an old backup also restores old device records; a device revoked after the backup works again until you revoke it again. Run the backup from cron for regular copies; the Caddy volumes (`caddy-data`) hold certificates and can simply be re-issued.

### Upgrades and migrations

```sh
# set the new CTS_VERSION in deploy/.env, take a backup first, then:
docker compose pull cts && docker compose up -d cts
```

Schema migrations are embedded in the binary and applied automatically at startup, in order, each in a transaction; applied versions are recorded in `schema_migrations`. They only move forward, so to roll back to an older image restore the backup taken before the upgrade. Extensions and server share the protocol in [PROTOCOL.md](PROTOCOL.md); upgrade the server first, then the extensions. Building from source instead: `git pull && docker compose up -d --build`.

## 2. Brave on Windows

1. Download `cross-tab-sync-brave-<version>.zip` from the GitHub release and extract it to a permanent folder (Brave reads the files from there on every start; do not delete it).
2. Open `brave://extensions`, enable **Developer mode**, click **Load unpacked** and select the extracted folder (the one containing `manifest.json`).
3. Open the extension popup, paste the pairing link (`https://tabs.example.com#ABCD2345`), check the device name (prefilled as `Brave on Windows`), then **Pair**. Server URL and code can also be entered separately under **Advanced**. If another device already has the name, the server adds a number (`Brave on Windows 2`); rename it under **This device**.
4. Brave asks for permission to access the server origin. **Allow** it; the extension requests no other site access at install. If the popup closes, pairing finishes in the background; reopen the popup.

Update by extracting a newer zip over the folder and pressing reload on the extension card. Details: [extension/README.md](../extension/README.md).

## 3. Safari on macOS

Requires macOS 13+ with Safari 18.4+ ([COMPATIBILITY.md](COMPATIBILITY.md)). The Safari zip holds only the extension resources; the app wrapper is built from source (no Developer ID signing yet).

1. Clone the repository (or extract the source of the release) and build the extension: `cd extension && pnpm install && pnpm build`.
2. Copy the resources and open the project: `cd .. && ./safari/sync-resources.sh && open safari/Cross-Tab-Sync/Cross-Tab-Sync.xcodeproj`. Alternatively unzip `cross-tab-sync-safari-resources-<version>.zip` into `safari/Cross-Tab-Sync/Cross-Tab-Sync Extension/Resources`.
3. In Xcode choose your team under Signing (a free personal team works), then **Run**. Command-line build without signing: see [safari/README.md](../safari/README.md).
4. In Safari: **Settings > Advanced > Show features for web developers**, then **Settings > Developer > Allow unsigned extensions** (this resets every time Safari quits; repeat after each restart for unsigned builds). Enable Cross-Tab-Sync under **Settings > Extensions**.
5. Under the extension's **Edit Websites**, set access to **All Websites**. Without it Safari hides tab URLs and the extension cannot see or share tabs.
6. Pair as in Brave (popup, paste the pairing link, check the name) and allow the server origin when prompted.

## Revoking a device or stopping sync

- **On the device:** popup **Disconnect** releases ownership, revokes this device on the server and forgets its credentials. Tabs stay open. Pairing again later creates a new device identity.
- **From another paired device or with curl:** `DELETE /v1/devices/{id}` with a bearer token of any paired device (ids from `GET /v1/devices`). The revoked device gets `401 device_revoked` and clears its credentials. Revoked devices stay in the list, greyed, for 7 days. See [PROTOCOL.md](PROTOCOL.md).
- **Everything:** stop the server (`docker compose down`). Extensions report errors in the popup until it returns. `docker compose down -v` additionally deletes all data (devices, session, certificates).

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `403 invalid_request` / "HTTPS required" | The server received plain HTTP. Use the `https://` URL through Caddy; never point extensions at port 8080. `CTS_ALLOW_INSECURE=1` is for local development only. |
| `invalid_code` on pairing | Codes are single use and expire after 10 minutes. Create a new link; check the server URL points at this server. |
| Pairing link points at the wrong address | Links from **Invite another browser** use the address the server was reached at. Set `CTS_PUBLIC_URL=https://tabs.example.com` on the server to fix it. |
| `device_revoked` | This device was revoked. Click Disconnect or clear credentials, then pair again with a new code. |
| Caddy has no certificate | DNS does not resolve to the VPS yet, or ports 80/443 are blocked. Check `docker compose logs caddy`. |
| Safari shares nothing or tabs show empty URLs | Website access is not **All Websites**, or unsigned extensions were reset after a Safari restart. Re-enable both. |
| Brave popup closes during pairing | Normal when the permission prompt appears; reopen the popup. |
| Server will not start after restore | Volume files must be owned by uid 65532 (`chown -R 65532:65532 /data` as shown above). |
