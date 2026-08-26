// schemaId 20 — typed chore_history.kind.
//
// Knex port of the legacy module server/migrations/schema20-choreHistoryKind.js.
//
// chore_history rows were distinguishable only by magic strings ('Regular
// chores', 'Adjustment', ...). A typed `kind` column makes metrics computable and
// fixes the daily-bonus dedupe/revoke fragility (it matched on clam_value = the
// *current* reward setting).
//
// Vocabulary: completion | daily_bonus | transfer_bonus | adjustment | missed |
// spent. NOT NULL DEFAULT 'completion' means any writer we missed degrades to the
// pre-change status quo instead of NULL.

const { addColumnIfMissing, dropColumnIfPresent, setLegacySchemaId } = require('../migrationHelpers');

const SCHEMA_ID = 20;

// The partial unique index is SQLite/PostgreSQL `CREATE UNIQUE INDEX ... WHERE`,
// which Knex's schema builder cannot express, so it stays raw. It is what gives
// the nightly missed-chore logger hard idempotency (it is an INSERT OR IGNORE
// target).
const MISSED_UNIQUE_INDEX = `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chore_history_missed_unique
      ON chore_history(user_id, chore_schedule_id, date) WHERE kind = 'missed'
`;
const KIND_INDEX = 'CREATE INDEX IF NOT EXISTS idx_chore_history_kind ON chore_history(kind)';

exports.up = async function up(knex) {
    const added = await addColumnIfMissing(
        knex,
        'chore_history',
        'kind',
        "TEXT NOT NULL DEFAULT 'completion'"
    );

    // Backfill only on the run that adds the column. Re-running it against a
    // database where the app has since written real `kind` values would
    // reclassify rows by their title, which is exactly the magic-string coupling
    // this column removed.
    if (added) {
        // Most-specific first; the column default covers real completions
        // (title = chore title, schedule id set).
        await knex('chore_history')
            .where({ title: 'Regular chores' })
            .whereNull('chore_schedule_id')
            .update({ kind: 'daily_bonus' });
        await knex('chore_history').where({ title: 'Transfer bonus' }).update({ kind: 'transfer_bonus' });
        await knex('chore_history').where({ title: 'Adjustment' }).update({ kind: 'adjustment' });
        // Legacy migrateClamsToHistory balance imports (NULL title, NULL
        // schedule) are balances, NOT completions — counting them as completions
        // would inflate metrics.
        await knex('chore_history')
            .whereNull('title')
            .whereNull('chore_schedule_id')
            .update({ kind: 'adjustment' });
    }

    await knex.raw(MISSED_UNIQUE_INDEX);
    await knex.raw(KIND_INDEX);

    await setLegacySchemaId(knex, SCHEMA_ID);
};

exports.down = async function down(knex) {
    // SQLite refuses to drop an indexed column, so the indexes go first.
    await knex.raw('DROP INDEX IF EXISTS idx_chore_history_missed_unique');
    await knex.raw('DROP INDEX IF EXISTS idx_chore_history_kind');
    await dropColumnIfPresent(knex, 'chore_history', 'kind');
    await setLegacySchemaId(knex, SCHEMA_ID - 1);
};
