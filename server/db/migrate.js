// Knex startup migration strategy with baseline adoption.
//
// Four startup scenarios are handled by adoptOrMigrate():
//   * Fresh DB (no schema yet)              -> knex.migrate.latest() runs the
//                                              baseline migration (v14) followed
//                                              by every post-baseline migration.
//   * Existing DB at v14, no ledger         -> the baseline is stamped into
//     (a "legacy" install)                    knex_migrations as already-applied
//                                              (its DDL is NOT re-run), then the
//                                              post-baseline migrations 15.. are
//                                              applied normally.
//   * Existing DB already migrated past v14 -> the baseline plus every
//     by upstream's raw legacy chain, no      post-baseline migration whose
//     ledger                                  schemaId <= settings.SYSTEM_SCHEMA_ID
//                                              is stamped as already-applied, so
//                                              none of that DDL is re-run; only
//                                              genuinely newer migrations run.
//   * DB already managed by Knex            -> knex.migrate.latest() applies only
//                                              migrations newer than what's run.
//
// Pre-14 databases are first lifted to v14 by the legacy migration chain in
// index.js BEFORE adoptOrMigrate() is called (Option A). That chain can also lift
// a database all the way to the newest legacy schema id, which is why adoption
// has to consider more than just the baseline.
//
// settings.SYSTEM_SCHEMA_ID is retained for back-compat and is what makes
// adoption of an already-upgraded legacy DB possible; knex_migrations is the
// source of truth from then on.

const fs = require('fs');
const { MIGRATIONS_DIR } = require('./knex');

const BASELINE_SUFFIX = '_baseline_v14.js';
// Schema level encoded by the baseline. Mirrors BASELINE_SCHEMA_VERSION in
// index.js; post-baseline migrations must carry a schemaId above this.
const BASELINE_SCHEMA_VERSION = 14;
const SYSTEM_SCHEMA_ID_KEY = 'SYSTEM_SCHEMA_ID';

// Post-baseline migration filenames encode the legacy schemaId they reproduce,
// e.g. `20240102000015_schema15_chore_due_time_sound.js` -> 15. That is the link
// between Knex's ledger and settings.SYSTEM_SCHEMA_ID.
const SCHEMA_ID_PATTERN = /^\d+_schema(\d+)[_.]/;

function listMigrationFiles() {
    return fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.js'));
}

// Returns the schemaId a migration filename reproduces, or null if the filename
// carries none (the baseline, or any future migration authored without one).
function parseSchemaId(filename) {
    const match = SCHEMA_ID_PATTERN.exec(filename);
    if (!match) return null;
    const schemaId = Number(match[1]);
    return Number.isInteger(schemaId) ? schemaId : null;
}

// Every migration that maps onto a legacy schemaId above the baseline, ordered by
// that schemaId.
function findPostBaselineMigrations() {
    return listMigrationFiles()
        .map((name) => ({ name, schemaId: parseSchemaId(name) }))
        .filter((m) => m.schemaId !== null && m.schemaId > BASELINE_SCHEMA_VERSION)
        .sort((a, b) => a.schemaId - b.schemaId);
}

// The name Knex records in knex_migrations is the migration's filename. Resolve
// it from disk so the stamped name always matches what knex.migrate.latest()
// expects (a mismatch would make Knex try to RE-RUN the baseline on an existing
// DB and fail). There is exactly one baseline migration.
function findBaselineMigrationName() {
    const baseline = listMigrationFiles().find((f) => f.endsWith(BASELINE_SUFFIX));
    if (!baseline) {
        throw new Error(`Baseline migration (*${BASELINE_SUFFIX}) not found in ${MIGRATIONS_DIR}`);
    }
    return baseline;
}

// Create the Knex bookkeeping tables if they are absent, matching the structure
// Knex itself uses, so a manually-stamped baseline is indistinguishable from one
// Knex applied.
async function ensureKnexLedgerTables(knex) {
    if (!(await knex.schema.hasTable('knex_migrations'))) {
        await knex.schema.createTable('knex_migrations', (t) => {
            t.increments('id').primary();
            t.string('name');
            t.integer('batch');
            t.timestamp('migration_time');
        });
    }
    if (!(await knex.schema.hasTable('knex_migrations_lock'))) {
        await knex.schema.createTable('knex_migrations_lock', (t) => {
            t.increments('index').primary();
            t.integer('is_locked');
        });
        await knex('knex_migrations_lock').insert({ is_locked: 0 });
    }
}

// Mark migrations as already applied (batch 1) without running their DDL.
// Idempotent: names already in the ledger are left alone. Returns the names it
// actually inserted.
async function stampMigrationsAsApplied(knex, names, batch = 1) {
    await ensureKnexLedgerTables(knex);
    const inserted = [];
    for (const name of names) {
        const existing = await knex('knex_migrations').where({ name }).first();
        if (existing) continue;
        await knex('knex_migrations').insert({ name, batch, migration_time: new Date() });
        inserted.push(name);
    }
    return inserted;
}

// Mark the baseline migration as already applied (batch 1) without running its
// DDL. Idempotent.
async function stampBaselineAsApplied(knex) {
    const baselineName = findBaselineMigrationName();
    await stampMigrationsAsApplied(knex, [baselineName]);
    return baselineName;
}

// The legacy schema marker, or null when it is absent/unparseable. A DB that the
// raw legacy chain lifted past the baseline reports its true level here.
async function readLegacySchemaId(knex) {
    if (!(await knex.schema.hasTable('settings'))) return null;
    const row = await knex('settings').where({ key: SYSTEM_SCHEMA_ID_KEY }).first();
    if (!row) return null;
    const schemaId = Number(row.value);
    return Number.isInteger(schemaId) ? schemaId : null;
}

// Stamp the baseline plus every post-baseline migration the legacy chain has
// already performed, so Knex never re-runs DDL that exists. Migrations above the
// stored schema id are left unstamped and get applied by knex.migrate.latest().
//
// A missing/unparseable SYSTEM_SCHEMA_ID is treated as "baseline only", which is
// safe because the post-baseline migrations are individually guarded and degrade
// to no-ops against columns/tables that already exist.
async function stampAdoptedMigrations(knex) {
    const baselineName = await stampBaselineAsApplied(knex);
    const legacySchemaId = await readLegacySchemaId(knex);

    const covered = legacySchemaId === null
        ? []
        : findPostBaselineMigrations()
            .filter((m) => m.schemaId <= legacySchemaId)
            .map((m) => m.name);

    await stampMigrationsAsApplied(knex, covered);

    return { legacySchemaId, stamped: [baselineName, ...covered] };
}

async function adoptOrMigrate(knex) {
    const hasLedger = await knex.schema.hasTable('knex_migrations');
    // The legacy `settings` table is the cheapest "schema already exists" probe.
    const legacySchemaPresent = await knex.schema.hasTable('settings');
    const adopted = !hasLedger && legacySchemaPresent;

    let legacySchemaId = null;
    let stamped = [];
    if (adopted) {
        ({ legacySchemaId, stamped } = await stampAdoptedMigrations(knex));
    }

    // Fresh DB: runs the baseline + every post-baseline migration. Adopted DB:
    // runs only the migrations above the level the legacy chain reached.
    const [batchNo, applied] = await knex.migrate.latest();
    return { adopted, legacySchemaId, stamped, batchNo, applied };
}

module.exports = {
    adoptOrMigrate,
    stampAdoptedMigrations,
    stampBaselineAsApplied,
    stampMigrationsAsApplied,
    ensureKnexLedgerTables,
    findBaselineMigrationName,
    findPostBaselineMigrations,
    parseSchemaId,
    readLegacySchemaId,
    BASELINE_SCHEMA_VERSION,
    SYSTEM_SCHEMA_ID_KEY,
};
