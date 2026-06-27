// Phase 2 unit tests for the persistence port + SQLite adapter (server/db/).
//
// These verify the async DB port contract in isolation (in-memory SQLite), proving
// the adapter behaves correctly BEFORE any application call sites are migrated onto
// it (Phase 3/4). See docs/db-abstraction-and-postgres-plan.md.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('../../db');

function freshDb() {
    return createDatabase({ engine: 'sqlite', filename: ':memory:' });
}

test('dialect reports sqlite', async () => {
    const db = freshDb();
    try {
        assert.equal(db.dialect, 'sqlite');
    } finally {
        await db.close();
    }
});

test('exec/run/get/all round-trip with parameter binding', async () => {
    const db = freshDb();
    try {
        await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, n INTEGER);');

        const ins = await db.run('INSERT INTO t (name, n) VALUES (?, ?)', ['a', 1]);
        assert.equal(ins.rowCount, 1);
        assert.equal(Number(ins.insertId), 1);

        await db.run('INSERT INTO t (name, n) VALUES (?, ?)', ['b', 2]);

        const row = await db.get('SELECT * FROM t WHERE name = ?', ['a']);
        assert.equal(row.n, 1);

        const missing = await db.get('SELECT * FROM t WHERE name = ?', ['nope']);
        assert.equal(missing, undefined);

        const rows = await db.all('SELECT * FROM t ORDER BY id');
        assert.deepEqual(rows.map((r) => r.name), ['a', 'b']);
    } finally {
        await db.close();
    }
});

test('run reports rowCount for UPDATE and DELETE', async () => {
    const db = freshDb();
    try {
        await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER);');
        await db.run('INSERT INTO t (id, v) VALUES (1, 10), (2, 20)');

        const upd = await db.run('UPDATE t SET v = v + 1 WHERE v >= ?', [10]);
        assert.equal(upd.rowCount, 2);

        const del = await db.run('DELETE FROM t WHERE id = ?', [1]);
        assert.equal(del.rowCount, 1);
    } finally {
        await db.close();
    }
});

test('tx commits on success', async () => {
    const db = freshDb();
    try {
        await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER);');

        const result = await db.tx(async (tx) => {
            await tx.run('INSERT INTO t (id, v) VALUES (1, 1)');
            await tx.run('INSERT INTO t (id, v) VALUES (2, 2)');
            return 'ok';
        });

        assert.equal(result, 'ok');
        const rows = await db.all('SELECT * FROM t');
        assert.equal(rows.length, 2);
    } finally {
        await db.close();
    }
});

test('tx rolls back on throw (no partial writes)', async () => {
    const db = freshDb();
    try {
        await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER);');
        await db.run('INSERT INTO t (id, v) VALUES (1, 1)');

        await assert.rejects(
            db.tx(async (tx) => {
                await tx.run('INSERT INTO t (id, v) VALUES (2, 2)');
                throw new Error('boom');
            }),
            /boom/
        );

        const rows = await db.all('SELECT * FROM t ORDER BY id');
        assert.equal(rows.length, 1, 'rolled-back insert must not persist');
        assert.equal(rows[0].id, 1);
    } finally {
        await db.close();
    }
});

test('foreign_keys pragma is ON: ON DELETE CASCADE is enforced', async () => {
    const db = freshDb();
    try {
        await db.exec(`
            CREATE TABLE parent (id INTEGER PRIMARY KEY);
            CREATE TABLE child (
                id INTEGER PRIMARY KEY,
                parent_id INTEGER,
                FOREIGN KEY (parent_id) REFERENCES parent(id) ON DELETE CASCADE
            );
        `);
        await db.run('INSERT INTO parent (id) VALUES (1)');
        await db.run('INSERT INTO child (id, parent_id) VALUES (1, 1)');

        await db.run('DELETE FROM parent WHERE id = ?', [1]);

        const children = await db.all('SELECT * FROM child');
        assert.equal(children.length, 0, 'cascade should remove child rows');
    } finally {
        await db.close();
    }
});

test('engine selection: unknown throws, postgres not implemented yet', async () => {
    assert.throws(() => createDatabase({ engine: 'mysql' }), /Unknown DB_ENGINE/);
    assert.throws(() => createDatabase({ engine: 'postgres' }), /not implemented yet/);
});
