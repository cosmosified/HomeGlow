'use strict';

// Per-table metadata used by the PostgreSQL adapter to translate SQLite-specific
// SQL (INSERT OR REPLACE/IGNORE upserts and INSERT ... insertId via RETURNING).
//
// - idColumn: the auto-increment/identity primary key column name, or null if the
//   table has no single serial id (used to append RETURNING <id> so run() can
//   report insertId the way better-sqlite3's lastInsertRowid does).
// - conflict: the column(s) forming the UNIQUE/PRIMARY KEY target for an
//   `INSERT OR REPLACE` upsert (translated to ON CONFLICT (...) DO UPDATE).
const TABLE_META = {
    chores: { idColumn: 'id' },
    users: { idColumn: 'id', conflict: ['id'] },
    events: { idColumn: 'id' },
    settings: { idColumn: null, conflict: ['key'] },
    prizes: { idColumn: 'id' },
    calendar_sources: { idColumn: 'id' },
    photo_sources: { idColumn: 'id' },
    admin_pin: { idColumn: null },
    devices: { idColumn: 'id', conflict: ['name'] },
    tabs: { idColumn: 'id' },
    chore_schedules: { idColumn: 'id' },
    chore_history: { idColumn: 'id' },
    calendar_events_cache: { idColumn: 'id', conflict: ['source_id', 'event_uid', 'start_time'] },
    calendar_sync_status: { idColumn: null, conflict: ['source_id'] },
    google_accounts: { idColumn: 'id' },
    google_oauth_states: { idColumn: null, conflict: ['state'] },
    google_picked_media: { idColumn: 'id', conflict: ['source_id', 'google_media_id'] },
    homeglow_photos: { idColumn: 'id' },
};

module.exports = { TABLE_META };
