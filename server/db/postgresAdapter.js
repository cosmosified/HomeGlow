'use strict';

const { toPostgres, insertTargetTable } = require('./sqlTranslate');
const { TABLE_META } = require('./schemaMeta');

// PostgresAdapter implements the async persistence port (see ./index.js) over a
// node-postgres connection pool. App/repository code is written in the SQLite
// dialect; this adapter translates each statement to PostgreSQL via sqlTranslate
// and reproduces better-sqlite3's `lastInsertRowid` using RETURNING.

// Run a translated statement on the given pg client/pool and normalize the result
// to the port's run() shape ({ rowCount, insertId }).
async function runTranslated(executor, sql, params) {
    let text = toPostgres(sql);

    // Reproduce lastInsertRowid: append RETURNING <id> for plain INSERTs into
    // tables that have a serial id, unless the statement already has RETURNING or
    // an ON CONFLICT clause (upserts/ignores don't need an insert id).
    const table = insertTargetTable(sql);
    const meta = table ? TABLE_META[table] : null;
    let idColumn = null;
    if (meta && meta.idColumn && !/RETURNING/i.test(text) && !/ON\s+CONFLICT/i.test(text)) {
        idColumn = meta.idColumn;
        text = `${text} RETURNING ${idColumn}`;
    }

    const res = await executor.query(text, params);
    let insertId;
    if (idColumn && res.rows[0]) {
        insertId = res.rows[0][idColumn];
    } else if (/RETURNING/i.test(text) && res.rows[0] && res.rows[0].id !== undefined) {
        insertId = res.rows[0].id;
    }
    return { rowCount: res.rowCount, insertId };
}

// A port implementation bound to a single pg client (used inside transactions).
class PostgresTxScope {
    constructor(client) {
        this.client = client;
        this.dialect = 'postgres';
    }

    async get(sql, params = []) {
        const res = await this.client.query(toPostgres(sql), params);
        return res.rows[0];
    }

    async all(sql, params = []) {
        const res = await this.client.query(toPostgres(sql), params);
        return res.rows;
    }

    async run(sql, params = []) {
        return runTranslated(this.client, sql, params);
    }

    async exec(sql) {
        await this.client.query(sql); // raw, multi-statement DDL (no translation)
    }
}

class PostgresAdapter {
    constructor(pool) {
        this.pool = pool;
        this.dialect = 'postgres';
    }

    async get(sql, params = []) {
        const res = await this.pool.query(toPostgres(sql), params);
        return res.rows[0];
    }

    async all(sql, params = []) {
        const res = await this.pool.query(toPostgres(sql), params);
        return res.rows;
    }

    async run(sql, params = []) {
        return runTranslated(this.pool, sql, params);
    }

    // Raw, possibly multi-statement DDL (e.g. the baseline schema). Not translated.
    async exec(sql) {
        await this.pool.query(sql);
    }

    async tx(fn) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const result = await fn(new PostgresTxScope(client));
            await client.query('COMMIT');
            return result;
        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch {
                // ignore rollback failure; surface original error
            }
            throw err;
        } finally {
            client.release();
        }
    }

    async close() {
        await this.pool.end();
    }
}

module.exports = PostgresAdapter;
