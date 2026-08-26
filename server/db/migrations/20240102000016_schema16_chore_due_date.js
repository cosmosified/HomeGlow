// schemaId 16 — one-off chore due date.
//
// Knex port of the legacy module server/migrations/schema16-choreDueDate.js.

const { addColumnIfMissing, dropColumnIfPresent, setLegacySchemaId } = require('../migrationHelpers');

const SCHEMA_ID = 16;

exports.up = async function up(knex) {
    await addColumnIfMissing(knex, 'chore_schedules', 'due_date', 'TEXT');
    await setLegacySchemaId(knex, SCHEMA_ID);
};

exports.down = async function down(knex) {
    await dropColumnIfPresent(knex, 'chore_schedules', 'due_date');
    await setLegacySchemaId(knex, SCHEMA_ID - 1);
};
