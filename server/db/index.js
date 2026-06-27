'use strict';

const path = require('node:path');
const Database = require('better-sqlite3');
const SqliteAdapter = require('./sqliteAdapter');

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
        throw new Error("DB_ENGINE='postgres' is not implemented yet (planned for Phase 5).");
    }

    throw new Error(`Unknown DB_ENGINE '${engine}'. Expected 'sqlite' or 'postgres'.`);
}

module.exports = { createDatabase, SqliteAdapter };
