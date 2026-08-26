// Roll a test database back to an earlier schema level so the next boot replays
// the migrations above it.
//
// Setting settings.SYSTEM_SCHEMA_ID used to be enough, because the legacy chain
// in index.js decided what to run from that row alone. Knex owns the schema now
// and its knex_migrations ledger is the source of truth, so a replay has to
// retract the ledger entries too — otherwise knex.migrate.latest() sees nothing
// pending and the migration under test never runs.
//
// NOTE: not named *.test.js, so `node --test` will not execute it as a suite.

const Database = require('better-sqlite3');

// Post-baseline migration filenames encode the legacy schemaId they reproduce
// (e.g. `20240102000020_schema20_chore_history_kind.js` -> 20). Mirrors
// db/migrate.js's SCHEMA_ID_PATTERN.
const SCHEMA_ID_PATTERN = /^\d+_schema(\d+)[_.]/;

function parseSchemaId(name) {
    const match = SCHEMA_ID_PATTERN.exec(name);
    if (!match) return null;
    const schemaId = Number(match[1]);
    return Number.isInteger(schemaId) ? schemaId : null;
}

/**
 * Rewind `dbPath` to `schemaId`: update the legacy marker and delete the Knex
 * ledger rows for every migration above that level.
 *
 * @param {string} dbPath  SQLite file
 * @param {number} schemaId  the level to pretend the database is at
 * @returns {string[]} the ledger entries retracted
 */
function rollbackToSchema(dbPath, schemaId) {
    const db = new Database(dbPath);
    try {
        db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('SYSTEM_SCHEMA_ID', ?)").run(String(schemaId));

        const hasLedger = db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'knex_migrations'")
            .get();
        if (!hasLedger) return [];

        const retracted = db
            .prepare('SELECT name FROM knex_migrations')
            .all()
            .map((row) => row.name)
            .filter((name) => {
                const migrationSchemaId = parseSchemaId(name);
                return migrationSchemaId !== null && migrationSchemaId > schemaId;
            });

        const del = db.prepare('DELETE FROM knex_migrations WHERE name = ?');
        for (const name of retracted) del.run(name);
        return retracted;
    } finally {
        db.close();
    }
}

module.exports = { rollbackToSchema, parseSchemaId };
