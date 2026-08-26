// schemaId 19 — namespaced key/value store for manifest plugins.
//
// Knex port of the legacy module server/migrations/schema19-pluginStorage.js.
//
// Values are JSON documents; plugin_id matches plugins.plugin_id. Server-side
// state here survives devices, reloads, and image upgrades (tasks.db is
// bind-mounted).

const { createTableIfMissing, setLegacySchemaId } = require('../migrationHelpers');

const SCHEMA_ID = 19;

const PLUGIN_STORAGE_DDL = `
    CREATE TABLE IF NOT EXISTS plugin_storage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plugin_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(plugin_id, key)
    )
`;

exports.up = async function up(knex) {
    await createTableIfMissing(knex, 'plugin_storage', PLUGIN_STORAGE_DDL);
    await setLegacySchemaId(knex, SCHEMA_ID);
};

exports.down = async function down(knex) {
    await knex.schema.dropTableIfExists('plugin_storage');
    await setLegacySchemaId(knex, SCHEMA_ID - 1);
};
