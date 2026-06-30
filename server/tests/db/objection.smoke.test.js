// Task 2 smoke test: prove Knex + Objection can read a live HomeGlow SQLite
// database (no behavior change to the running app yet). Boots the server via the
// harness — which initializes + seeds a throwaway DB through the legacy migrations
// — then opens that same file through the engine-agnostic Knex factory and reads
// the seeded `bonus` user (id 0) via an Objection model.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('../helpers/serverHarness');
const { createKnex } = require('../../db/knex');
const User = require('../../db/models/User');

test('Objection reads the seeded bonus user from a live HomeGlow SQLite DB', async () => {
    const server = await startServer();
    let knex;
    try {
        knex = createKnex({ engine: 'sqlite', filename: server.dbPath });

        const bonus = await User.query(knex).findById(0);
        assert.ok(bonus, 'bonus user row exists');
        assert.equal(bonus.id, 0);
        assert.equal(bonus.username, 'bonus');

        // Sanity: the model maps to the real users table and can count rows.
        const all = await User.query(knex);
        assert.ok(Array.isArray(all));
        assert.ok(all.length >= 1, 'at least the bonus user is present');
    } finally {
        if (knex) await knex.destroy();
        await server.stop();
    }
});
