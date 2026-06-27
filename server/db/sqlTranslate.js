'use strict';

const { TABLE_META } = require('./schemaMeta');

// Translates the SQLite-dialect SQL used throughout the app into PostgreSQL.
// The SQLite adapter runs queries unchanged; only the PostgreSQL adapter applies
// these transforms. See docs/db-abstraction-and-postgres-plan.md (section 4).

// SQLite datetime('now') yields a UTC 'YYYY-MM-DD HH:MM:SS' text value; reproduce
// the same text shape in Postgres so stored timestamps remain string-comparable.
const PG_NOW = "to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS')";

// `?` positional params -> `$1, $2, ...`. Our queries never contain `?` inside
// string literals, so a sequential replacement is safe.
function convertPlaceholders(sql) {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
}

// SQLite date/time helpers -> Postgres text equivalents.
function convertDateFunctions(sql) {
    // datetime('now', '-15 minutes') / datetime('now', '+1 day') ...
    sql = sql.replace(
        /datetime\('now',\s*'([+-]?\d+)\s+(\w+)'\)/gi,
        (_, n, unit) => `to_char((now() AT TIME ZONE 'UTC') + interval '${n} ${unit}', 'YYYY-MM-DD HH24:MI:SS')`
    );
    // datetime('now')
    sql = sql.replace(/datetime\('now'\)/gi, PG_NOW);
    // datetime(<column>) -> <column> (already stored as comparable text)
    sql = sql.replace(/datetime\(\s*([a-zA-Z_][\w.]*)\s*\)/gi, '$1');
    // CURRENT_TIMESTAMP used in DML assignments/values -> text now()
    sql = sql.replace(/CURRENT_TIMESTAMP/g, PG_NOW);
    return sql;
}

function appendBeforeReturning(sql, clause) {
    const idx = sql.search(/\sRETURNING\b/i);
    if (idx === -1) return sql.replace(/\s*$/, '') + clause;
    return sql.slice(0, idx) + clause + sql.slice(idx);
}

// INSERT OR IGNORE / INSERT OR REPLACE -> ON CONFLICT forms.
function convertUpsert(sql) {
    const ignore = sql.match(/^\s*INSERT\s+OR\s+IGNORE\s+INTO\s+([a-zA-Z_]\w*)/i);
    if (ignore) {
        sql = sql.replace(/INSERT\s+OR\s+IGNORE\s+INTO/i, 'INSERT INTO');
        if (!/ON\s+CONFLICT/i.test(sql)) {
            sql = appendBeforeReturning(sql, ' ON CONFLICT DO NOTHING');
        }
        return sql;
    }

    const replace = sql.match(/^\s*INSERT\s+OR\s+REPLACE\s+INTO\s+([a-zA-Z_]\w*)\s*\(([^)]*)\)/i);
    if (replace) {
        const table = replace[1];
        const cols = replace[2].split(',').map((c) => c.trim());
        sql = sql.replace(/INSERT\s+OR\s+REPLACE\s+INTO/i, 'INSERT INTO');
        if (/ON\s+CONFLICT/i.test(sql)) return sql; // statement already specifies it

        const conflict = (TABLE_META[table] || {}).conflict;
        if (!conflict) return appendBeforeReturning(sql, ' ON CONFLICT DO NOTHING');

        const updateCols = cols.filter((c) => !conflict.includes(c));
        const clause = updateCols.length
            ? ` ON CONFLICT (${conflict.join(', ')}) DO UPDATE SET ${updateCols.map((c) => `${c} = excluded.${c}`).join(', ')}`
            : ` ON CONFLICT (${conflict.join(', ')}) DO NOTHING`;
        return appendBeforeReturning(sql, clause);
    }

    return sql;
}

// Full SQLite -> Postgres translation for a parameterized statement.
function toPostgres(sql) {
    let out = convertUpsert(sql);
    out = convertDateFunctions(out);
    out = convertPlaceholders(out);
    return out;
}

// The target table of an INSERT (any flavor), or null.
function insertTargetTable(sql) {
    const m = sql.match(/^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+([a-zA-Z_]\w*)/i);
    return m ? m[1] : null;
}

module.exports = {
    toPostgres,
    convertPlaceholders,
    convertDateFunctions,
    convertUpsert,
    insertTargetTable,
    PG_NOW,
};
