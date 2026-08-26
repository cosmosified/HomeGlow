// schemaId 23 — explicit display order for users.
//
// Knex port of the legacy module server/migrations/schema23-userSortOrder.js.
//
// Named sort_order to match the existing convention on calendar_sources /
// photo_sources, which are read with the same `ORDER BY sort_order, id` idiom.

const { addColumnIfMissing, dropColumnIfPresent, setLegacySchemaId } = require('../migrationHelpers');

const SCHEMA_ID = 23;

exports.up = async function up(knex) {
    const added = await addColumnIfMissing(knex, 'users', 'sort_order', 'INTEGER NOT NULL DEFAULT 0');

    // Backfill with the id so existing households keep the exact order they see
    // today (users previously rendered in insertion order). The reorder endpoint
    // renumbers to a dense 1..n on first use; the `, id` tiebreak keeps ties
    // stable until then. Scoped to the creating run so a replay cannot clobber an
    // order the operator has since set.
    if (added) {
        await knex('users').update({ sort_order: knex.ref('id') });
    }

    await setLegacySchemaId(knex, SCHEMA_ID);
};

exports.down = async function down(knex) {
    await dropColumnIfPresent(knex, 'users', 'sort_order');
    await setLegacySchemaId(knex, SCHEMA_ID - 1);
};
