-- v3: many sessions per server. Every row belongs to one session, reachable
-- only through its devices; session ids never leave the server. Deleting a
-- session deletes all its rows (ON DELETE CASCADE).
--
-- The v2 singleton becomes session 1 with all its rows when it has a key check
-- and an active device; otherwise nobody could use it again and its data is
-- dropped. Joining the copies with sessions (zero or one row) does both.

CREATE TABLE sessions (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    revision           INTEGER NOT NULL DEFAULT 0,
    generation         INTEGER NOT NULL DEFAULT 0,
    owner_device_id    TEXT,
    owner_last_seen_at INTEGER,
    min_revision       INTEGER NOT NULL DEFAULT 1,
    key_check          TEXT NOT NULL,
    created_at         INTEGER NOT NULL
);

-- Times are Unix milliseconds (UTC).
INSERT INTO sessions (id, revision, generation, owner_device_id, owner_last_seen_at, min_revision, key_check, created_at)
SELECT 1, revision, generation, owner_device_id, owner_last_seen_at, min_revision, key_check,
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM session
WHERE id = 1 AND key_check IS NOT NULL AND EXISTS (SELECT 1 FROM devices WHERE revoked_at IS NULL);

CREATE TABLE devices_v3 (
    id           TEXT PRIMARY KEY,
    session_id   INTEGER NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    browser      TEXT NOT NULL,
    token_hash   BLOB NOT NULL UNIQUE,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    revoked_at   INTEGER
);
INSERT INTO devices_v3 (id, session_id, name, browser, token_hash, created_at, last_seen_at, revoked_at)
SELECT d.id, s.id, d.name, d.browser, d.token_hash, d.created_at, d.last_seen_at, d.revoked_at
FROM devices d, sessions s;

CREATE TABLE pairing_codes_v3 (
    code_hash  BLOB PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at    INTEGER
);
INSERT INTO pairing_codes_v3 (code_hash, session_id, created_by, created_at, expires_at, used_at)
SELECT p.code_hash, s.id, p.created_by, p.created_at, p.expires_at, p.used_at
FROM pairing_codes p, sessions s;

-- Entry ids are client-generated: the same id in another session is another entry.
CREATE TABLE entries_v3 (
    session_id       INTEGER NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    id               TEXT NOT NULL,
    url_key          TEXT NOT NULL,
    url_enc          TEXT NOT NULL DEFAULT '',
    pinned           INTEGER NOT NULL DEFAULT 0,
    position         INTEGER NOT NULL DEFAULT 0,
    opened_by        TEXT NOT NULL,
    created_revision INTEGER NOT NULL,
    updated_revision INTEGER NOT NULL,
    closed_revision  INTEGER,
    url_revision     INTEGER NOT NULL DEFAULT 0,
    url_device       TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (session_id, id)
);
INSERT INTO entries_v3 (session_id, id, url_key, url_enc, pinned, position, opened_by, created_revision, updated_revision,
    closed_revision, url_revision, url_device)
SELECT s.id, e.id, e.url_key, e.url_enc, e.pinned, e.position, e.opened_by, e.created_revision, e.updated_revision,
    e.closed_revision, e.url_revision, e.url_device
FROM entries e, sessions s;

-- seq is the revision assigned to the operation; NULL when it was ignored.
CREATE TABLE operations_v3 (
    session_id INTEGER NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    op_id      TEXT NOT NULL,
    seq        INTEGER,
    device_id  TEXT NOT NULL,
    generation INTEGER NOT NULL,
    type       TEXT NOT NULL,
    payload    TEXT NOT NULL,
    result     TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (session_id, op_id),
    UNIQUE (session_id, seq)
);
INSERT INTO operations_v3 (session_id, op_id, seq, device_id, generation, type, payload, result, created_at)
SELECT s.id, o.op_id, o.seq, o.device_id, o.generation, o.type, o.payload, o.result, o.created_at
FROM operations o, sessions s;

-- Snapshot ids count per session.
CREATE TABLE snapshots_v3 (
    session_id  INTEGER NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    id          INTEGER NOT NULL,
    revision    INTEGER NOT NULL,
    device_id   TEXT NOT NULL,
    reason      TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    entry_count INTEGER NOT NULL,
    entries     TEXT NOT NULL,
    PRIMARY KEY (session_id, id)
);
INSERT INTO snapshots_v3 (session_id, id, revision, device_id, reason, created_at, entry_count, entries)
SELECT s.id, n.id, n.revision, n.device_id, n.reason, n.created_at, n.entry_count, n.entries
FROM snapshots n, sessions s;

DROP TABLE session;
DROP TABLE pairing_codes;
DROP TABLE entries;
DROP TABLE operations;
DROP TABLE snapshots;
DROP TABLE devices;
ALTER TABLE devices_v3 RENAME TO devices;
ALTER TABLE pairing_codes_v3 RENAME TO pairing_codes;
ALTER TABLE entries_v3 RENAME TO entries;
ALTER TABLE operations_v3 RENAME TO operations;
ALTER TABLE snapshots_v3 RENAME TO snapshots;

CREATE INDEX devices_session ON devices (session_id);
-- Active device names are unique per session, ignoring (ASCII) case, as v2
-- already kept them; revoked devices hold no names.
CREATE UNIQUE INDEX devices_active_name ON devices (session_id, name COLLATE NOCASE) WHERE revoked_at IS NULL;
CREATE INDEX pairing_codes_session ON pairing_codes (session_id);
-- At most one open entry per urlKey in a session.
CREATE UNIQUE INDEX entries_open_url_key ON entries (session_id, url_key) WHERE closed_revision IS NULL;
CREATE INDEX operations_created_at ON operations (session_id, created_at);
