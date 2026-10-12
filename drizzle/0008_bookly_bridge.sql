CREATE TABLE bookly_links (local_id TEXT PRIMARY KEY NOT NULL, remote_id TEXT NOT NULL UNIQUE, remote_version TEXT NOT NULL, local_digest TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'appointment');
CREATE TABLE bookly_commands (id TEXT PRIMARY KEY NOT NULL, local_id TEXT NOT NULL, payload TEXT NOT NULL, digest TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', error TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX bookly_commands_pending ON bookly_commands(local_id) WHERE status = 'pending';
CREATE TABLE bookly_sync_state (id INTEGER PRIMARY KEY CHECK(id = 1), lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0, last_success TEXT, error TEXT);
INSERT INTO bookly_sync_state(id) VALUES (1);
CREATE TABLE bookly_occupied_slots (slot_start TEXT NOT NULL, appointment_id TEXT NOT NULL, PRIMARY KEY(slot_start, appointment_id));
ALTER TABLE appointments ADD booking_request_id TEXT;
CREATE UNIQUE INDEX appointments_request_id ON appointments(booking_request_id) WHERE booking_request_id IS NOT NULL;

CREATE TABLE bookly_callback_nonces (nonce TEXT PRIMARY KEY NOT NULL, expires INTEGER NOT NULL);

CREATE TABLE bookly_revision_guards (id TEXT PRIMARY KEY NOT NULL, valid INTEGER NOT NULL CHECK(valid=1));
