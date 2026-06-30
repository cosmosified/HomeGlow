#!/usr/bin/env node
'use strict';

// One-time data migration: copy all rows from an existing SQLite database into a
// PostgreSQL database, then advance each identity sequence past the copied ids.
//
// Usage:
//   DB_PATH=./data/tasks.db \
//   DATABASE_URL=postgres://user:pass@host:5432/homeglow \
//   node scripts/migrate-sqlite-to-postgres.js
//
// Safe to re-run: every insert uses ON CONFLICT DO NOTHING. See
// docs/db-abstraction-and-postgres-plan.md (Phase 7).

const path = require('node:path');
const Database = require('better-sqlite3');
const { Pool } = require('pg');
const { bootstrapPostgresSchema } = require('../db');
const PostgresAdapter = require('../db/postgresAdapter');

// Tables in FK-dependency order (parents before children).
const TABLES = [
    'users',
    'chores',
    'settings',
    'prizes',
    'calendar_sources',
    'photo_sources',
    'admin_pin',
    'devices',
    'events',
    'tabs',
    'chore_schedules',
    'chore_history',
    'calendar_events_cache',
    'calendar_sync_status',
    'google_accounts',
    'google_oauth_states',
    'google_picked_media',
    'homeglow_photos',
];

// Tables whose `id` identity sequence must be advanced after copying explicit ids.
const ID_TABLES = [
    'chores', 'users', 'events', 'prizes', 'calendar_sources', 'photo_sources',
    'devices', 'tabs', 'chore_schedules', 'chore_history', 'calendar_events_cache',
    'google_accounts', 'google_picked_media', 'homeglow_photos',
];

async function main() {
    const dbPath = process.env.DB_PATH
        ? path.resolve(process.env.DB_PATH)
        : path.resolve(__dirname, '..', 'data', 'tasks.db');
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
        console.error('DATABASE_URL is required.');
        process.exit(1);
    }

    console.log(`Source SQLite : ${dbPath}`);
    console.log(`Target Postgres: ${connectionString.replace(/:[^:@/]*@/, ':****@')}`);

    const sqlite = new Database(dbPath, { readonly: true });
    const pool = new Pool({ connectionString });
    const pg = new PostgresAdapter(pool);

    try {
        const created = await bootstrapPostgresSchema(pg);
        console.log(created ? 'Created baseline schema on target.' : 'Target schema already present.');

        let grandTotal = 0;
        for (const table of TABLES) {
            const tableExists = sqlite
                .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
                .get(table);
            if (!tableExists) {
                console.log(`- ${table}: (absent in source, skipped)`);
                continue;
            }

            const rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
            let copied = 0;
            for (const row of rows) {
                const cols = Object.keys(row);
                // Every Postgres column is lowercase; quoting the lowercased name
                // matches exactly and safely handles reserved words (e.g. "end").
                const colSql = cols.map((c) => `"${c.toLowerCase()}"`).join(', ');
                const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
                const values = cols.map((c) => row[c]);
                const res = await pool.query(
                    `INSERT INTO ${table} (${colSql}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
                    values
                );
                copied += res.rowCount;
            }
            grandTotal += copied;
            console.log(`- ${table}: ${copied}/${rows.length} rows copied`);
        }

        console.log('Advancing identity sequences...');
        for (const table of ID_TABLES) {
            await pool.query(
                `SELECT setval(
                    pg_get_serial_sequence($1, 'id'),
                    GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${table}), 1),
                    (SELECT COUNT(*) FROM ${table}) > 0
                 )`,
                [table]
            );
        }

        console.log(`Done. ${grandTotal} rows copied. Verify with the app pointed at DB_ENGINE=postgres.`);
    } finally {
        sqlite.close();
        await pg.close();
    }
}

main().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
});
