// Engine-agnostic Knex configuration + factory.
//
// The data layer is being migrated from raw better-sqlite3 to Knex + Objection.
// This module is the single place that knows how to build a Knex instance for a
// given engine. SQLite is the only shipped/validated engine today; the `postgres`
// branch is wired so it can be enabled later via DB_ENGINE=postgres + DATABASE_URL
// without touching call sites.

const path = require('path');
const Knex = require('knex');

const MIGRATIONS_DIR = path.resolve(__dirname, 'migrations');
const MIGRATIONS_TABLE = 'knex_migrations';
// SQLite's in-memory sentinel. Demo mode uses it so nothing a visitor does is
// written to disk.
const MEMORY_FILENAME = ':memory:';

// Resolve the SQLite file the same way index.js's legacy connection does, so both
// the legacy `db` and Knex point at the exact same database file during the
// migration period.
//
// ':memory:' is passed through untouched — it is a sentinel, not a path, and
// path.resolve() would turn it into a real file next to the app (which is
// exactly how a demo instance ended up persisting visitor data).
function resolveSqlitePath(filename) {
    if (filename === MEMORY_FILENAME) return MEMORY_FILENAME;
    if (filename) return path.resolve(filename);
    if (process.env.DB_PATH === MEMORY_FILENAME) return MEMORY_FILENAME;
    return process.env.DB_PATH
        ? path.resolve(process.env.DB_PATH)
        : path.resolve(__dirname, '..', 'data', 'tasks.db');
}

function knexConfig(overrides = {}) {
    const engine = overrides.engine || process.env.DB_ENGINE || 'sqlite';

    if (engine === 'sqlite') {
        const filename = resolveSqlitePath(overrides.filename);
        const inMemory = filename === MEMORY_FILENAME;
        return {
            client: 'better-sqlite3',
            connection: { filename },
            // SQLite has no notion of a column default unless we say so; Knex
            // requires this for inserts that omit columns.
            useNullAsDefault: true,
            pool: {
                // Every connection to ':memory:' gets its OWN private database,
                // so an in-memory instance must be single-connection or the
                // schema and the data end up on different handles.
                ...(inMemory ? { min: 1, max: 1 } : {}),
                // Enforce foreign keys on every connection, matching the legacy
                // `newDb.pragma('foreign_keys = ON')` behavior.
                afterCreate: (conn, done) => {
                    try {
                        conn.pragma('foreign_keys = ON');
                        done(null, conn);
                    } catch (err) {
                        done(err, conn);
                    }
                },
            },
            migrations: { directory: MIGRATIONS_DIR, tableName: MIGRATIONS_TABLE },
        };
    }

    if (engine === 'postgres') {
        return {
            client: 'pg',
            connection: overrides.connectionString || process.env.DATABASE_URL,
            pool: { min: 0, max: 5 },
            migrations: { directory: MIGRATIONS_DIR, tableName: MIGRATIONS_TABLE },
        };
    }

    throw new Error(`Unknown DB_ENGINE: ${engine}`);
}

function createKnex(overrides = {}) {
    return Knex(knexConfig(overrides));
}

module.exports = { createKnex, knexConfig, resolveSqlitePath, MIGRATIONS_DIR, MIGRATIONS_TABLE, MEMORY_FILENAME };
