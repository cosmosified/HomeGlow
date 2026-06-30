// Phase 4 unit tests for the SQLite -> PostgreSQL SQL translator.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    toPostgres,
    convertPlaceholders,
    convertUpsert,
    convertDateFunctions,
    insertTargetTable,
} = require('../../db/sqlTranslate');

test('convertPlaceholders numbers ? sequentially', () => {
    assert.equal(convertPlaceholders('SELECT * FROM t WHERE a = ? AND b = ?'), 'SELECT * FROM t WHERE a = $1 AND b = $2');
    assert.equal(convertPlaceholders('INSERT INTO t (a,b,c) VALUES (?,?,?)'), 'INSERT INTO t (a,b,c) VALUES ($1,$2,$3)');
});

test('INSERT OR IGNORE becomes ON CONFLICT DO NOTHING', () => {
    const out = convertUpsert('INSERT OR IGNORE INTO devices (name, updateTime) VALUES (?, CURRENT_TIMESTAMP)');
    assert.match(out, /^INSERT INTO devices/);
    assert.match(out, /ON CONFLICT DO NOTHING/);
    assert.doesNotMatch(out, /INSERT OR IGNORE/);
});

test('INSERT OR REPLACE on settings upserts on key', () => {
    const out = convertUpsert('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    assert.match(out, /INSERT INTO settings \(key, value\) VALUES \(\?, \?\) ON CONFLICT \(key\) DO UPDATE SET value = excluded\.value/);
});

test('INSERT OR REPLACE on a multi-column conflict target', () => {
    const out = convertUpsert(
        'INSERT OR REPLACE INTO calendar_events_cache (source_id, event_uid, start_time, title) VALUES (?, ?, ?, ?)'
    );
    assert.match(out, /ON CONFLICT \(source_id, event_uid, start_time\) DO UPDATE SET title = excluded\.title/);
});

test('existing explicit ON CONFLICT is preserved (only INSERT OR REPLACE keyword rewritten)', () => {
    const out = convertUpsert(
        'INSERT OR REPLACE INTO calendar_sync_status (source_id, sync_interval_minutes) VALUES (?, ?) ON CONFLICT(source_id) DO UPDATE SET sync_interval_minutes = excluded.sync_interval_minutes'
    );
    assert.match(out, /^INSERT INTO calendar_sync_status/);
    // should not double-append an ON CONFLICT
    assert.equal((out.match(/ON CONFLICT/gi) || []).length, 1);
});

test('ON CONFLICT clause is inserted before RETURNING', () => {
    const out = convertUpsert('INSERT OR IGNORE INTO users (id, username) VALUES (?, ?) RETURNING id');
    assert.match(out, /ON CONFLICT DO NOTHING RETURNING id$/);
});

test('datetime helpers translate to text-format Postgres expressions', () => {
    assert.match(convertDateFunctions("datetime('now')"), /to_char\(\(now\(\) AT TIME ZONE 'UTC'\), 'YYYY-MM-DD HH24:MI:SS'\)/);
    assert.match(
        convertDateFunctions("WHERE datetime(created_at) < datetime('now', '-15 minutes')"),
        /WHERE created_at < to_char\(\(now\(\) AT TIME ZONE 'UTC'\) \+ interval '-15 minutes'/
    );
    assert.match(convertDateFunctions('updateTime = CURRENT_TIMESTAMP'), /updateTime = to_char/);
});

test('toPostgres composes upsert + datetime + placeholders', () => {
    const out = toPostgres('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    assert.equal(out, 'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value');
});

test('insertTargetTable detects table for all insert flavors', () => {
    assert.equal(insertTargetTable('INSERT INTO chores (a) VALUES (?)'), 'chores');
    assert.equal(insertTargetTable('INSERT OR IGNORE INTO devices (name) VALUES (?)'), 'devices');
    assert.equal(insertTargetTable('INSERT OR REPLACE INTO settings (key) VALUES (?)'), 'settings');
    assert.equal(insertTargetTable('UPDATE chores SET a = ?'), null);
});
