'use strict';

// SqliteAdapter implements the async persistence port (see ./index.js) over
// better-sqlite3.
//
// better-sqlite3 is synchronous; each method returns an already-resolved Promise
// so call sites use the exact same async interface they will use for PostgreSQL.
// Introducing this adapter does not, by itself, change application behavior — the
// existing code keeps using the raw `db` handle until call sites are migrated
// (Phase 3/4 of docs/db-abstraction-and-postgres-plan.md).
class SqliteAdapter {
    /**
     * @param {import('better-sqlite3').Database} rawDb
     */
    constructor(rawDb) {
        this.raw = rawDb;
        this.dialect = 'sqlite';
    }

    /** Fetch a single row (or undefined). */
    async get(sql, params = []) {
        return this.raw.prepare(sql).get(...params);
    }

    /** Fetch all matching rows. */
    async all(sql, params = []) {
        return this.raw.prepare(sql).all(...params);
    }

    /**
     * Execute a write. Returns a normalized result so callers do not depend on
     * driver-specific shapes:
     *  - rowCount: number of affected rows
     *  - insertId: last inserted row id (SQLite rowid; Postgres will use RETURNING)
     */
    async run(sql, params = []) {
        const info = this.raw.prepare(sql).run(...params);
        return { rowCount: info.changes, insertId: info.lastInsertRowid };
    }

    /** Execute raw, possibly multi-statement, parameterless SQL (DDL / scripts). */
    async exec(sql) {
        this.raw.exec(sql);
    }

    /**
     * Run `fn` inside a transaction. The callback receives this adapter; all
     * queries run on the single better-sqlite3 connection.
     *
     * better-sqlite3 is synchronous and the adapter resolves on the microtask
     * queue, so awaited queries inside the callback do not yield to I/O and the
     * BEGIN/COMMIT remains atomic in practice. (The PostgreSQL adapter will check
     * out a dedicated pooled client for true isolation.) Avoid awaiting unrelated
     * I/O inside a SQLite transaction callback.
     */
    async tx(fn) {
        this.raw.exec('BEGIN');
        try {
            const result = await fn(this);
            this.raw.exec('COMMIT');
            return result;
        } catch (err) {
            try {
                this.raw.exec('ROLLBACK');
            } catch {
                // Ignore rollback failure; surface the original error.
            }
            throw err;
        }
    }

    /** Close the underlying connection. */
    async close() {
        this.raw.close();
    }
}

module.exports = SqliteAdapter;
