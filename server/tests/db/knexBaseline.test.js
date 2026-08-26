// Task 3 tests: the v14 baseline migration builds a complete schema-14 database
// on a fresh DB, and baseline ADOPTION stamps an existing (ledger-less) schema-14
// DB without re-running DDL or losing data.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createKnex } = require('../../db/knex');
const { adoptOrMigrate, findPostBaselineMigrations, BASELINE_SCHEMA_VERSION } = require('../../db/migrate');
const { tmpDir } = require('../helpers/serverHarness');
const fs = require('node:fs');

fs.mkdirSync(tmpDir, { recursive: true });

// The schema level a fully-migrated database reports in settings.SYSTEM_SCHEMA_ID:
// the highest schemaId among the post-baseline migrations, or the baseline itself
// when there are none. Computed rather than hardcoded so adding a migration does
// not silently rot this suite.
const postBaseline = findPostBaselineMigrations();
const LATEST_SCHEMA_VERSION = postBaseline.length > 0
    ? postBaseline[postBaseline.length - 1].schemaId
    : BASELINE_SCHEMA_VERSION;

const SCHEMA_TABLES = [
    'users', 'chores', 'chore_schedules', 'chore_history', 'prizes', 'settings',
    'events', 'admin_pin', 'devices', 'tabs', 'calendar_sources',
    'calendar_events_cache', 'calendar_sync_status', 'photo_sources',
    'google_picked_media', 'homeglow_photos', 'google_accounts', 'google_oauth_states',
];

function tmpDb(label) {
    return path.join(tmpDir, `knexbase-${label}-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.db`);
}

function cleanup(file) {
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.rmSync(`${file}${suffix}`, { force: true }); } catch { /* ignore */ }
    }
}

test('baseline migration builds a complete schema-14 database on a fresh DB', async () => {
    const file = tmpDb('fresh');
    const knex = createKnex({ engine: 'sqlite', filename: file });
    try {
        const result = await adoptOrMigrate(knex);
        assert.equal(result.adopted, false, 'fresh DB is migrated, not adopted');

        for (const t of SCHEMA_TABLES) {
            assert.equal(await knex.schema.hasTable(t), true, `table ${t} created`);
        }

        // Tables that schema 14 removed / never ships fresh.
        assert.equal(await knex.schema.hasTable('widget_tab_assignments'), false, 'no widget_tab_assignments');
        assert.equal(await knex.schema.hasTable('chores_backup'), false, 'no vestigial chores_backup');

        // Schema-14 columns present.
        assert.equal(await knex.schema.hasColumn('tabs', 'config_json'), true);
        assert.equal(await knex.schema.hasColumn('devices', 'device_settings_json'), true);
        assert.equal(await knex.schema.hasColumn('chore_schedules', 'duration'), true);
        assert.equal(await knex.schema.hasColumn('chore_schedules', 'parent_schedule_id'), true);
        assert.equal(await knex.schema.hasColumn('photo_sources', 'picker_session_id'), true);

        // Seeded bonus user.
        const bonus = await knex('users').where({ id: 0 }).first();
        assert.ok(bonus, 'bonus user seeded');
        assert.equal(bonus.username, 'bonus');

        // Folded-in FK index present.
        const idx = await knex('sqlite_master')
            .where({ type: 'index', name: 'idx_chore_history_chore_schedule_id' })
            .first();
        assert.ok(idx, 'idx_chore_history_chore_schedule_id created');

        // Baseline recorded in the ledger.
        const ledger = await knex('knex_migrations').select('name');
        assert.ok(ledger.some((m) => m.name.endsWith('_baseline_v14.js')), 'baseline stamped in knex_migrations');
    } finally {
        await knex.destroy();
        cleanup(file);
    }
});

test('knex.migrate.rollback runs the baseline down() and drops the schema', async () => {
    const file = tmpDb('rollback');
    const knex = createKnex({ engine: 'sqlite', filename: file });
    try {
        await adoptOrMigrate(knex);
        assert.equal(await knex.schema.hasTable('users'), true, 'schema built before rollback');

        const [, rolledBack] = await knex.migrate.rollback();
        assert.ok(rolledBack.some((m) => m.endsWith('_baseline_v14.js')), 'baseline rolled back');

        // down() dropped all baseline tables.
        for (const t of SCHEMA_TABLES) {
            assert.equal(await knex.schema.hasTable(t), false, `table ${t} dropped by down()`);
        }
    } finally {
        await knex.destroy();
        cleanup(file);
    }
});

test('baseline ADOPTION stamps an existing schema-14 DB without re-running DDL or losing data', async () => {
    const file = tmpDb('adopt');

    // Build a schema-14 DB, then strip the Knex ledger to simulate a legacy
    // install that predates Knex, and add sentinel data.
    const setup = createKnex({ engine: 'sqlite', filename: file });
    try {
        await adoptOrMigrate(setup); // builds schema + ledger
        await setup.schema.dropTableIfExists('knex_migrations');
        await setup.schema.dropTableIfExists('knex_migrations_lock');
        await setup('users').insert({ username: 'sentinel', email: 's@example.com', profile_picture: '' });
        // SYSTEM_SCHEMA_ID is seeded by the baseline and advanced by every
        // post-baseline migration, so it now reads the latest level.
    } finally {
        await setup.destroy();
    }

    // Re-open as if starting the app against this legacy schema-14 DB.
    const knex = createKnex({ engine: 'sqlite', filename: file });
    try {
        // Must NOT throw: re-running the baseline DDL on existing tables would
        // error ("table users already exists"). Adoption stamps instead.
        const result = await adoptOrMigrate(knex);
        assert.equal(result.adopted, true, 'existing schema-14 DB is adopted, not rebuilt');
        assert.deepEqual(result.applied, [], 'no migration DDL re-run during adoption');

        const ledger = await knex('knex_migrations').select('name');
        assert.ok(ledger.some((m) => m.name.endsWith('_baseline_v14.js')), 'baseline stamped as applied');

        // Data preserved.
        const sentinel = await knex('users').where({ username: 'sentinel' }).first();
        assert.ok(sentinel, 'sentinel user preserved (no data loss)');
        const sv = await knex('settings').where({ key: 'SYSTEM_SCHEMA_ID' }).first();
        assert.equal(sv.value, String(LATEST_SCHEMA_VERSION), 'schema version row preserved');

        // Idempotent: a second startup does nothing destructive.
        const again = await adoptOrMigrate(knex);
        assert.equal(again.adopted, false, 'ledger now exists; no re-adoption');
        assert.deepEqual(again.applied, [], 'nothing new to apply');
    } finally {
        await knex.destroy();
        cleanup(file);
    }
});
