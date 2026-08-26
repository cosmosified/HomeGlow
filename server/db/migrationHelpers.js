// Shared helpers for the post-baseline Knex migrations in ./migrations.
//
// Every post-baseline migration has to be safe to run against a database that
// upstream `main` already migrated with the raw better-sqlite3 legacy modules
// (schema 15..25). Such a database is baseline-adopted by ../db/migrate.js,
// which stamps the migrations whose schemaId is covered by
// settings.SYSTEM_SCHEMA_ID — but a schema id that was reset, a partially
// applied legacy chain, or a hand-edited settings row must not turn into a hard
// startup failure. So the DDL below is uniformly guarded: adding a column that
// already exists, or creating a table that already exists, is a no-op.
//
// These helpers live outside ./migrations on purpose: Knex treats every .js file
// in the migrations directory as a migration.

// `ALTER TABLE ... ADD COLUMN <name> <definition>` is standard SQL and works on
// both SQLite and PostgreSQL, so the raw form is engine-agnostic enough and
// keeps the column definition byte-identical to the legacy module it mirrors.
async function addColumnIfMissing(knex, table, column, definition) {
    if (!(await knex.schema.hasTable(table))) return false;
    if (await knex.schema.hasColumn(table, column)) return false;
    await knex.raw(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    return true;
}

// SQLite supports DROP COLUMN as of 3.35 (better-sqlite3 12.x bundles far
// newer), with the caveat that the column must not be indexed — callers drop
// dependent indexes first.
async function dropColumnIfPresent(knex, table, column) {
    if (!(await knex.schema.hasTable(table))) return false;
    if (!(await knex.schema.hasColumn(table, column))) return false;
    await knex.raw(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    return true;
}

// Returns true only when the table was actually created, so callers can scope
// one-time data backfills to the creating run.
async function createTableIfMissing(knex, table, ddl) {
    if (await knex.schema.hasTable(table)) return false;
    await knex.raw(ddl);
    return true;
}

// Back-compat only: settings.SYSTEM_SCHEMA_ID is no longer the source of truth
// (knex_migrations is), but the legacy chain in index.js and some tooling still
// read it, and leaving it at 14 on a Knex-built database would invite the legacy
// chain to replay schema 15..25 with raw SQL. Every migration keeps it current,
// exactly as the legacy modules did.
async function setLegacySchemaId(knex, schemaId) {
    if (!(await knex.schema.hasTable('settings'))) return;
    await knex('settings')
        .insert({ key: 'SYSTEM_SCHEMA_ID', value: String(schemaId) })
        .onConflict('key')
        .merge();
}

module.exports = {
    addColumnIfMissing,
    dropColumnIfPresent,
    createTableIfMissing,
    setLegacySchemaId,
};
