// schemaId 17 — chore transfer + snooze.
//
// Knex port of the legacy module server/migrations/schema17-choreTransferSnooze.js.
//
//   transferable / can_snooze   per-schedule gates for the dashboard long-press
//                               actions; default 1 keeps every existing schedule
//                               transferable and snoozable.
//   snoozed_until               ISO UTC datetime; while in the future the chore is
//                               hidden from the dashboard and excluded from the
//                               daily-completion bonus set.
//   transfer_bonus_clams        pending completion bonus set by the "keep current
//                               reward" transfer path, paid out and cleared on
//                               completion.

const { addColumnIfMissing, dropColumnIfPresent, setLegacySchemaId } = require('../migrationHelpers');

const SCHEMA_ID = 17;

const COLUMNS = [
    ['transferable', 'INTEGER DEFAULT 1'],
    ['can_snooze', 'INTEGER DEFAULT 1'],
    ['snoozed_until', 'TEXT'],
    ['transfer_bonus_clams', 'INTEGER DEFAULT 0'],
];

exports.up = async function up(knex) {
    for (const [column, definition] of COLUMNS) {
        await addColumnIfMissing(knex, 'chore_schedules', column, definition);
    }
    await setLegacySchemaId(knex, SCHEMA_ID);
};

exports.down = async function down(knex) {
    for (const [column] of COLUMNS) {
        await dropColumnIfPresent(knex, 'chore_schedules', column);
    }
    await setLegacySchemaId(knex, SCHEMA_ID - 1);
};
