-- v2: end-to-end encrypted URLs. The server stores only url_key (keyed hash,
-- the coalescing identity) and url_enc (ciphertext). Plaintext history cannot
-- be converted, so it is deleted; every device is revoked and pairs again.

DELETE FROM operations;
DELETE FROM entries;
DELETE FROM snapshots;

-- Key check of the shared encryption key (base64url HMAC), set once by the
-- first browser through PUT /v2/session/key.
ALTER TABLE session ADD COLUMN key_check TEXT;

-- The generation is kept: it only ever increases.
UPDATE session SET revision = 0, min_revision = 1, owner_device_id = NULL, owner_last_seen_at = NULL,
    key_check = NULL;

-- Times are Unix milliseconds (UTC).
UPDATE devices SET revoked_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE revoked_at IS NULL;

ALTER TABLE entries RENAME COLUMN url TO url_key;
ALTER TABLE entries ADD COLUMN url_enc TEXT NOT NULL DEFAULT '';

-- At most one open entry per urlKey (same exact URL under the same key).
DROP INDEX entries_open_url;
CREATE UNIQUE INDEX entries_open_url_key ON entries (url_key) WHERE closed_revision IS NULL;
