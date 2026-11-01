-- Times are Unix milliseconds (UTC).

CREATE TABLE devices (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    browser      TEXT NOT NULL,
    token_hash   BLOB NOT NULL UNIQUE,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    revoked_at   INTEGER
);

CREATE TABLE pairing_codes (
    code_hash  BLOB PRIMARY KEY,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at    INTEGER
);

-- Exactly one shared session.
CREATE TABLE session (
    id                 INTEGER PRIMARY KEY CHECK (id = 1),
    revision           INTEGER NOT NULL DEFAULT 0,
    generation         INTEGER NOT NULL DEFAULT 0,
    owner_device_id    TEXT REFERENCES devices (id),
    owner_last_seen_at INTEGER
);
INSERT INTO session (id) VALUES (1);

CREATE TABLE entries (
    id               TEXT PRIMARY KEY,
    url              TEXT NOT NULL,
    pinned           INTEGER NOT NULL DEFAULT 0,
    position         INTEGER NOT NULL DEFAULT 0,
    opened_by        TEXT NOT NULL,
    created_revision INTEGER NOT NULL,
    updated_revision INTEGER NOT NULL,
    closed_revision  INTEGER
);
-- At most one open entry per exact URL.
CREATE UNIQUE INDEX entries_open_url ON entries (url) WHERE closed_revision IS NULL;

-- seq is the revision assigned to the operation; NULL when it was ignored.
CREATE TABLE operations (
    op_id      TEXT NOT NULL UNIQUE,
    seq        INTEGER UNIQUE,
    device_id  TEXT NOT NULL,
    generation INTEGER NOT NULL,
    type       TEXT NOT NULL,
    payload    TEXT NOT NULL,
    result     TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE snapshots (
    id          INTEGER PRIMARY KEY,
    revision    INTEGER NOT NULL,
    device_id   TEXT NOT NULL,
    reason      TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    entry_count INTEGER NOT NULL,
    entries     TEXT NOT NULL
);
