// schemaId 24 — optional emoji icon for a chore.
//
// Knex port of the legacy module server/migrations/schema24-choreIcon.js.
//
// Stored on the chore rather than the schedule: the icon describes what the chore
// *is*, so every schedule of "Make your bed" shows the same picture regardless of
// who it is assigned to or when it recurs.
//
// TEXT with no default — NULL means "no icon", and the widget keeps showing its
// checkmark for those. Emoji are stored as the literal character rather than a
// name, so adding one to the bank later needs no migration and an unknown value
// still renders.

const { addColumnIfMissing, dropColumnIfPresent, setLegacySchemaId } = require('../migrationHelpers');

const SCHEMA_ID = 24;

exports.up = async function up(knex) {
    await addColumnIfMissing(knex, 'chores', 'icon', 'TEXT');
    await setLegacySchemaId(knex, SCHEMA_ID);
};

exports.down = async function down(knex) {
    await dropColumnIfPresent(knex, 'chores', 'icon');
    await setLegacySchemaId(knex, SCHEMA_ID - 1);
};
