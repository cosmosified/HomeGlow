// Baseline migration: the full HomeGlow schema as of schema-version 14.
//
// This is the single source of truth for a FRESH install's schema. Existing
// SQLite databases are not rebuilt by this migration — they are "baseline
// adopted" at startup (see ../migrate.js): the legacy migration chain lifts any
// pre-14 DB up to 14, then this baseline is stamped into knex_migrations as
// already-applied without re-running the DDL below. All schema changes after v14
// are authored as new Knex migrations.
//
// Fidelity note: the statements below mirror the exact schema-14 DDL produced by
// the historical migration chain (verified by introspecting a freshly-migrated
// DB), with two deliberate changes:
//   * the vestigial `chores_backup` table (a one-time migration artifact) is NOT
//     recreated for fresh installs;
//   * `idx_chore_history_chore_schedule_id` is ADDED to index the
//     `ON DELETE SET NULL` foreign key that was previously unindexed.
//
// SQLite is the only shipped engine today; this baseline uses SQLite DDL. A
// PostgreSQL baseline would be authored separately when that engine is enabled.

const TABLE_DDL = [
    `CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT,
        email TEXT,
        profile_picture TEXT
    )`,
    `CREATE TABLE chores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        clam_value INTEGER DEFAULT 0
    )`,
    `CREATE TABLE chore_schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chore_id INTEGER NOT NULL,
        user_id INTEGER NULL,
        crontab TEXT NULL,
        visible INTEGER NOT NULL DEFAULT 1,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        duration TEXT DEFAULT 'day-of',
        interval TEXT,
        parent_schedule_id INTEGER REFERENCES chore_schedules(id) ON DELETE SET NULL,
        FOREIGN KEY (chore_id) REFERENCES chores(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE chore_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        chore_schedule_id INTEGER NULL,
        date TEXT NOT NULL,
        clam_value INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        title TEXT DEFAULT NULL,
        FOREIGN KEY (chore_schedule_id) REFERENCES chore_schedules(id) ON DELETE SET NULL
    )`,
    `CREATE TABLE prizes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        clam_cost INTEGER NOT NULL
    )`,
    `CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT
    )`,
    `CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        summary TEXT,
        start TEXT,
        end TEXT,
        description TEXT
    )`,
    `CREATE TABLE admin_pin (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        pin_hash TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        updateTime TEXT DEFAULT CURRENT_TIMESTAMP,
        device_settings_json TEXT
    )`,
    `CREATE TABLE tabs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_name TEXT NOT NULL,
        number INTEGER NOT NULL,
        label TEXT NOT NULL,
        icon TEXT NOT NULL,
        show_label INTEGER DEFAULT 1,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        config_json TEXT,
        FOREIGN KEY (device_name) REFERENCES devices(name) ON DELETE CASCADE ON UPDATE CASCADE,
        UNIQUE(device_name, number)
    )`,
    `CREATE TABLE calendar_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        url TEXT NOT NULL,
        username TEXT,
        password TEXT,
        color TEXT NOT NULL DEFAULT '#6e44ff',
        enabled INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE calendar_events_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER NOT NULL,
        event_uid TEXT NOT NULL,
        title TEXT,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        description TEXT,
        location TEXT,
        all_day INTEGER DEFAULT 0,
        raw_data TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (source_id) REFERENCES calendar_sources(id) ON DELETE CASCADE,
        UNIQUE(source_id, event_uid, start_time)
    )`,
    `CREATE TABLE calendar_sync_status (
        source_id INTEGER PRIMARY KEY,
        last_sync_at TEXT,
        last_sync_status TEXT,
        last_sync_message TEXT,
        event_count INTEGER DEFAULT 0,
        sync_interval_minutes INTEGER DEFAULT 15,
        FOREIGN KEY (source_id) REFERENCES calendar_sources(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE photo_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        url TEXT,
        api_key TEXT,
        username TEXT,
        password TEXT,
        album_id TEXT,
        refresh_token TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        picker_session_id TEXT,
        picker_session_expire TEXT
    )`,
    `CREATE TABLE google_picked_media (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER NOT NULL,
        google_media_id TEXT NOT NULL,
        filename TEXT,
        mime_type TEXT,
        local_path TEXT NOT NULL,
        width INTEGER,
        height INTEGER,
        created_time TEXT,
        downloaded_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(source_id, google_media_id),
        FOREIGN KEY (source_id) REFERENCES photo_sources(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE homeglow_photos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER NOT NULL,
        filename TEXT NOT NULL,
        original_name TEXT,
        mime_type TEXT,
        size INTEGER,
        uploaded_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (source_id) REFERENCES photo_sources(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE google_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        google_sub TEXT UNIQUE,
        email TEXT,
        name TEXT,
        picture TEXT,
        access_token_enc TEXT,
        refresh_token_enc TEXT,
        token_expiry TEXT,
        scopes TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE google_oauth_states (
        state TEXT PRIMARY KEY,
        redirect_uri TEXT NOT NULL,
        return_url TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
];

const INDEX_DDL = [
    `CREATE INDEX idx_calendar_sources_enabled ON calendar_sources(enabled)`,
    `CREATE INDEX idx_calendar_sources_sort_order ON calendar_sources(sort_order)`,
    `CREATE INDEX idx_photo_sources_enabled ON photo_sources(enabled)`,
    `CREATE INDEX idx_photo_sources_sort_order ON photo_sources(sort_order)`,
    `CREATE INDEX idx_devices_device_name ON devices(name)`,
    `CREATE INDEX idx_tabs_device_name ON tabs(device_name)`,
    `CREATE INDEX idx_cache_source_id ON calendar_events_cache(source_id)`,
    `CREATE INDEX idx_cache_start_time ON calendar_events_cache(start_time)`,
    `CREATE INDEX idx_cache_end_time ON calendar_events_cache(end_time)`,
    `CREATE INDEX idx_chore_schedules_chore_id ON chore_schedules(chore_id)`,
    `CREATE INDEX idx_chore_schedules_user_id ON chore_schedules(user_id)`,
    `CREATE INDEX idx_chore_schedules_visible ON chore_schedules(visible)`,
    `CREATE INDEX idx_chore_schedules_duration ON chore_schedules(duration)`,
    `CREATE INDEX idx_chore_schedules_parent_schedule_id ON chore_schedules(parent_schedule_id)`,
    `CREATE INDEX idx_chore_history_user_id ON chore_history(user_id)`,
    `CREATE INDEX idx_chore_history_date ON chore_history(date)`,
    `CREATE INDEX idx_chore_history_user_date ON chore_history(user_id, date)`,
    // FOLDED IN: index the previously-unindexed ON DELETE SET NULL foreign key.
    `CREATE INDEX idx_chore_history_chore_schedule_id ON chore_history(chore_schedule_id)`,
    `CREATE INDEX idx_google_picked_media_source ON google_picked_media(source_id)`,
    `CREATE INDEX idx_homeglow_photos_source ON homeglow_photos(source_id)`,
    `CREATE INDEX idx_google_oauth_states_created ON google_oauth_states(created_at)`,
];

// Tables dropped in reverse dependency order for `down()`.
const DROP_ORDER = [
    'google_oauth_states',
    'google_accounts',
    'homeglow_photos',
    'google_picked_media',
    'photo_sources',
    'calendar_sync_status',
    'calendar_events_cache',
    'calendar_sources',
    'tabs',
    'devices',
    'admin_pin',
    'events',
    'settings',
    'prizes',
    'chore_history',
    'chore_schedules',
    'chores',
    'users',
];

exports.up = async function up(knex) {
    for (const ddl of TABLE_DDL) {
        await knex.raw(ddl);
    }
    for (const ddl of INDEX_DDL) {
        await knex.raw(ddl);
    }
    // Seed the reserved "bonus" user (id 0) used for bonus chores.
    await knex.raw(
        "INSERT OR IGNORE INTO users (id, username, email, profile_picture) VALUES (0, 'bonus', 'bonus@example.com', '')"
    );
    // Back-compat: keep the legacy schema-version marker so any tooling that reads
    // it still sees the baseline level. Knex's knex_migrations ledger is the real
    // source of truth going forward.
    await knex.raw(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('SYSTEM_SCHEMA_ID', '14')"
    );
};

exports.down = async function down(knex) {
    for (const table of DROP_ORDER) {
        await knex.raw(`DROP TABLE IF EXISTS ${table}`);
    }
};
