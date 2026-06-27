'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const SqliteAdapter = require('./sqliteAdapter');
const PostgresAdapter = require('./postgresAdapter');

/**
 * The async persistence port. Both the SQLite adapter (now) and the PostgreSQL
 * adapter (Phase 5) implement this shape, so application/repository code depends
 * only on this interface — never on a specific driver.
 *
 * @typedef {Object} DbPort
 * @property {(sql: string, params?: any[]) => Promise<any|undefined>} get
 *   Fetch a single row, or undefined.
 * @property {(sql: string, params?: any[]) => Promise<any[]>} all
 *   Fetch all matching rows.
 * @property {(sql: string, params?: any[]) => Promise<{rowCount:number, insertId?:number|bigint}>} run
 *   Execute a write; returns affected row count and last insert id.
 * @property {(sql: string) => Promise<void>} exec
 *   Execute raw, possibly multi-statement, parameterless SQL (DDL / scripts).
 * @property {(fn: (tx: DbPort) => Promise<any>) => Promise<any>} tx
 *   Run a function inside a transaction (commit on resolve, rollback on throw).
 * @property {() => Promise<void>} close
 *   Close the connection / pool.
 * @property {'sqlite'|'postgres'} dialect
 *   The active SQL dialect, for dialect-specific helpers.
 */

/**
 * Create a persistence adapter implementing {@link DbPort}.
 *
 * Phase 2: only the 'sqlite' engine is implemented. The 'postgres' engine is
 * added in Phase 5 (see docs/db-abstraction-and-postgres-plan.md). Engine
 * selection follows `options.engine` then `process.env.DB_ENGINE`, defaulting to
 * 'sqlite' so current behavior is preserved.
 *
 * @param {Object} [options]
 * @param {'sqlite'|'postgres'} [options.engine]
 * @param {string} [options.filename] SQLite file path (or ':memory:')
 * @param {boolean} [options.verbose] Log SQL via better-sqlite3 verbose
 * @returns {DbPort}
 */
function createDatabase(options = {}) {
    const engine = options.engine || process.env.DB_ENGINE || 'sqlite';

    if (engine === 'sqlite') {
        const filename =
            options.filename ||
            (process.env.DB_PATH
                ? path.resolve(process.env.DB_PATH)
                : path.resolve(__dirname, '..', 'data', 'tasks.db'));

        const raw = new Database(filename, options.verbose ? { verbose: console.log } : {});
        raw.pragma('foreign_keys = ON');
        return new SqliteAdapter(raw);
    }

    if (engine === 'postgres') {
        // Lazy-require pg so SQLite-only deployments don't need it loaded.
        const { Pool } = require('pg');
        const connectionString = options.connectionString || process.env.DATABASE_URL;
        if (!connectionString) {
            throw new Error("DB_ENGINE='postgres' requires DATABASE_URL (or options.connectionString).");
        }
        const pool = new Pool({ connectionString, max: options.poolMax || 5 });
        return new PostgresAdapter(pool);
    }

    throw new Error(`Unknown DB_ENGINE '${engine}'. Expected 'sqlite' or 'postgres'.`);
}

// On a fresh PostgreSQL database, load the baseline schema (equivalent to SQLite
// schema version 14) if the core tables are not present yet. No-op once created.
async function bootstrapPostgresSchema(db) {
    const existing = await db.get("SELECT to_regclass('public.settings') AS t");
    if (existing && existing.t) {
        return false;
    }
    const schemaSql = fs.readFileSync(path.resolve(__dirname, 'schema.postgres.sql'), 'utf8');
    await db.exec(schemaSql);
    return true;
}

module.exports = { createDatabase, bootstrapPostgresSchema, SqliteAdapter, PostgresAdapter };
