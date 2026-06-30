// Knex startup migration strategy with baseline adoption.
//
// Three startup scenarios are handled by adoptOrMigrate():
//   * Fresh DB (no schema yet)              -> knex.migrate.latest() runs the
//                                              baseline migration, building v14.
//   * Existing DB already at v14, no ledger -> the baseline is stamped into
//     (a "legacy" install)                    knex_migrations as already-applied
//                                              (its DDL is NOT re-run), then any
//                                              newer migrations are applied.
//   * DB already managed by Knex            -> knex.migrate.latest() applies only
//                                              migrations newer than what's run.
//
// Pre-14 databases are first lifted to v14 by the legacy migration chain in
// index.js BEFORE adoptOrMigrate() is called (Option A), so by the time we get
// here an existing DB is always at the baseline level.

const fs = require('fs');
const { MIGRATIONS_DIR } = require('./knex');

const BASELINE_SUFFIX = '_baseline_v14.js';

// The name Knex records in knex_migrations is the migration's filename. Resolve
// it from disk so the stamped name always matches what knex.migrate.latest()
// expects (a mismatch would make Knex try to RE-RUN the baseline on an existing
// DB and fail). There is exactly one baseline migration.
function findBaselineMigrationName() {
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.js'));
    const baseline = files.find((f) => f.endsWith(BASELINE_SUFFIX));
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

// Mark the baseline migration as already applied (batch 1) without running its
// DDL. Idempotent.
async function stampBaselineAsApplied(knex) {
    await ensureKnexLedgerTables(knex);
    const baselineName = findBaselineMigrationName();
    const existing = await knex('knex_migrations').where({ name: baselineName }).first();
    if (!existing) {
        await knex('knex_migrations').insert({ name: baselineName, batch: 1, migration_time: new Date() });
    }
    return baselineName;
}

async function adoptOrMigrate(knex) {
    const hasLedger = await knex.schema.hasTable('knex_migrations');
    // The legacy `settings` table is the cheapest "schema already exists" probe.
    const legacySchemaPresent = await knex.schema.hasTable('settings');
    const adopted = !hasLedger && legacySchemaPresent;

    if (adopted) {
        await stampBaselineAsApplied(knex);
    }

    // Fresh DB: runs the baseline (+ anything newer). Adopted/up-to-date DB: runs
    // only migrations newer than the stamped baseline.
    const [batchNo, applied] = await knex.migrate.latest();
    return { adopted, batchNo, applied };
}

module.exports = {
    adoptOrMigrate,
    stampBaselineAsApplied,
    ensureKnexLedgerTables,
    findBaselineMigrationName,
};
