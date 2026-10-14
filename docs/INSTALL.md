# Installation

Cross-Tab-Sync keeps the same open tabs in Brave and Safari. Install the extension in each browser, click **Start syncing** in the first one, and paste the invite link it shows into the second. No account is needed.

By default the extension uses the hosted server `https://cts.kexperiments.com`. Tab addresses are encrypted in your browser before they are sent; the server only stores ciphertext ([PRIVACY.md](PRIVACY.md)). You can also run your own server (section 3).

## 1. Brave

1. Open the [Cross-Tab-Sync page in the Chrome Web Store](https://chromewebstore.google.com/detail/cross-tab-sync/doimphmglhmgenljfmaopbphbhmpcfdk) in Brave and click **Add to Brave**, then **Add extension**.
2. Click the puzzle icon in the toolbar and pin Cross-Tab-Sync, then click its icon.
3. If this is your first browser: check the device name and click **Start syncing**. Brave asks to let the extension reach the sync server; click **Allow**. If the popup closes, click the icon again.
4. The popup now shows an invite link and "Install the extension in your other browser and paste this link there." Click **Copy** and get the link to your other computer privately (for example a note to yourself). It works once, for 10 minutes.

If Brave is your second browser, click **I have an invite link** instead, paste the link and confirm.

**Without the store:** download `cross-tab-sync-brave-<version>.zip` from the [latest release](https://github.com/KaanEmec/cross-tab-sync/releases/latest), extract it to a folder you keep, open `brave://extensions`, turn on **Developer mode**, click **Load unpacked** and pick that folder. This copy does not update itself.

**Profiles:** an extension belongs to one browser profile and can only see that profile's tabs, so install and pair Cross-Tab-Sync in the single profile you want synced. A second profile with the extension would pair as another device and compete for control. Chrome or Brave account sync may copy the install to another computer, but never the pairing or the key: that copy shows up unpaired. Also works in Chrome: the Brave build is plain Chromium.

## 2. Safari on macOS

Needs Safari 18.4 or newer (macOS 13+).

1. Download `Cross-Tab-Sync-<version>.dmg` from the [latest release](https://github.com/KaanEmec/cross-tab-sync/releases/latest), open it and drag **Cross-Tab-Sync** to **Applications**.
2. Open the Cross-Tab-Sync app once, then quit it.
3. In Safari open **Settings › Extensions** and tick **Cross-Tab-Sync**.
4. Click **Edit Websites** and set access to **All Websites**. Without this Safari hides tab addresses and nothing syncs.
5. Click the Cross-Tab-Sync icon in the toolbar, click **I have an invite link**, paste the link from Brave and confirm. Allow access to the sync server when Safari asks. (If Safari is your first browser, use **Start syncing** and paste its invite into Brave instead.)

Your tabs now follow you: the browser you are using shares its tabs, the other one catches up when you switch to it.

**Invite links contain the encryption key.** Paste them only into the extension, never into the address bar, and do not share them with anyone else.

## 3. Your own server (optional)

Run the server yourself, then in each extension open **Advanced**, enter your server address (for example `https://tabs.example.com`) and click **Start syncing** (first browser) or paste the invite (second browser). Set `CTS_MAX_SESSIONS=1` on a personal server so nobody else can start a session on it. Other settings: [server/README.md](../server/README.md).

### Docker Compose

You need a server with Docker, ports 80 and 443 open, and a domain name.

1. Point a DNS record such as `tabs.example.com` at the server and wait until it resolves.
2. `git clone https://github.com/KaanEmec/cross-tab-sync && cd cross-tab-sync/deploy`
3. Create `deploy/.env` with `CTS_DOMAIN=tabs.example.com` and `CTS_MAX_SESSIONS=1`; optionally `CTS_VERSION=3.0.0` to pin a release (default `latest`).
4. `docker compose pull cts && docker compose up -d`. `https://tabs.example.com/healthz` should answer `{"status":"ok"}`.

Caddy obtains the HTTPS certificate on first start. The service port is never published; only Caddy reaches it. Without Docker: [deploy/README.md](../deploy/README.md).

### Coolify

New resource › **Public repository** `https://github.com/KaanEmec/cross-tab-sync`, branch `main`, build pack **Dockerfile**, base directory `/server`, Dockerfile `/Dockerfile`, exposed port `8080`. Set your domain, add a persistent volume mounted at `/data`, leave port mappings empty and the health check off (the image has no shell). No environment variables are required; add `CTS_MAX_SESSIONS=1` for a personal server. Deploy.

### Backups

All data is one SQLite database in the data volume (`cts.db`, `cts.db-wal`, `cts.db-shm`); back up the whole directory while the server is stopped. With Compose (the volume is usually `deploy_cts-data`, see `docker volume ls`):

```sh
docker compose stop cts
docker run --rm -v deploy_cts-data:/data -v "$PWD":/backup alpine tar czf /backup/cts-$(date +%F).tgz -C /data .
docker compose start cts
# restore: stop cts, then
docker run --rm -v deploy_cts-data:/data -v "$PWD":/backup alpine sh -c \
  'rm -rf /data/* && tar xzf /backup/cts-YYYY-MM-DD.tgz -C /data && chown -R 65532:65532 /data'
```

Backups hold only encrypted tab addresses and token hashes, but keep them private. A restored backup also restores devices revoked after it was taken.

### Upgrades

Take a backup, set the new `CTS_VERSION`, then `docker compose pull cts && docker compose up -d cts` (Coolify: Redeploy, or let a release trigger it: the release workflow calls Coolify's deploy API when the repository secret `COOLIFY_TOKEN` holds an API token). Database migrations run automatically and only move forward; to go back, restore the backup. Upgrade the server before the extensions. A v2 server upgraded to v3 keeps its paired browsers.

## Stopping sync

- **Disconnect** in the popup removes this browser from the session; its tabs stay open. To sync again, use a new invite.
- **Revoke** in the Devices section removes another of your browsers (for example a lost laptop).
- When the last browser of a session disconnects, the server deletes the session and all its data at once. Sessions unused for 180 days are deleted automatically (`CTS_SESSION_RETENTION`).

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Invite link refused or expired | Links work once, for 10 minutes. Create a new invite in a synced browser. |
| "Key mismatch" | That browser joined with a different link. Disconnect it and paste a fresh invite. |
| "This server runs an older version" | The server needs upgrading to v3. |
| Start syncing refused: no new sessions | The server's `CTS_MAX_SESSIONS` limit is reached. |
| Joining refused: session full | A session holds up to 10 browsers (`CTS_MAX_DEVICES`). Revoke an old one. |
| "Too many requests" | Wait 10 minutes and try again. |
| Safari syncs nothing or shows empty addresses | Set **Edit Websites** to **All Websites** in Safari › Settings › Extensions. |
| Popup closed while connecting | Normal when the permission prompt appears; click the icon again. |
| "HTTPS required" (own server) | Use the `https://` address through Caddy or Coolify, never port 8080 directly. |
| No certificate (own server) | DNS does not point at the server yet, or ports 80/443 are blocked: `docker compose logs caddy`. |
| Server will not start after a restore | Files must belong to uid 65532 (the `chown` above). |
