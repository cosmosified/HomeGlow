// schemaId 15 — chore due time + reminder sound.
//
// Knex port of the legacy module server/migrations/schema15-choreDueTimeSound.js.
// Adds the per-schedule due time and the sound/reminder settings the dashboard
// uses to nag about an overdue chore.

const { addColumnIfMissing, dropColumnIfPresent, setLegacySchemaId } = require('../migrationHelpers');

const SCHEMA_ID = 15;

const COLUMNS = [
    ['due_time', 'TEXT'],
    ['sound_enabled', 'INTEGER DEFAULT 0'],
    ['sound', 'TEXT'],
    ['reminder_interval_minutes', 'INTEGER'],
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
