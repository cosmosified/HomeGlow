// Phase 1 characterization ("golden master") tests for the data persistence layer.
//
// Purpose: lock in the OBSERVABLE behavior of the current SQLite-backed API so the
// identical suite can be re-run unchanged after every phase of the persistence
// abstraction work, and against PostgreSQL once that adapter exists. See
// docs/db-abstraction-and-postgres-plan.md (Phase 1).
//
// These tests assert at the HTTP API boundary on purpose: that boundary is
// engine-agnostic, so the SAME assertions verify SQLite today and Postgres later.
// The cases below concentrate on the dialect-RISKY SQL behaviors (sequences,
// upsert, insert-returning-id, FK cascade) because those are where SQLite and
// Postgres diverge and where regressions during the refactor are most likely.
//
// Broader full-CRUD response snapshots and the below-API tests (transaction
// ROLLBACK, deep JSON round-trip, FK-index presence) are stubbed as `todo` so the
// coverage map is explicit and can be filled in incrementally.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('../helpers/serverHarness');

let server;

test.before(async () => {
    server = await startServer();
});

test.after(async () => {
    if (server) await server.stop();
});

// --- helpers -----------------------------------------------------------------

const uniq = () => `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

function createUser(api, username) {
    return api('/api/users', {
        method: 'POST',
        body: JSON.stringify({ username, email: `${username}@example.com`, profile_picture: '' }),
    });
}

// =============================================================================
// SQL semantics — the dialect-risky behaviors (precise, engine-agnostic)
// =============================================================================

test('sequence continuity: auto-increment ids advance and are never reused', async () => {
    const { api } = server;

    const a = await createUser(api, `seqA-${uniq()}`);
    const b = await createUser(api, `seqB-${uniq()}`);

    assert.equal(a.status, 200, 'create user A');
    assert.equal(b.status, 200, 'create user B');
    assert.equal(typeof a.body.id, 'number');
    assert.equal(typeof b.body.id, 'number');

    // Consecutive inserts increment by exactly 1 (SQLite AUTOINCREMENT today;
    // Postgres IDENTITY must reproduce this after a setval() sequence reset).
    assert.equal(b.body.id, a.body.id + 1, 'second insert id == first + 1');

    // Deleting the latest row must NOT cause id reuse on the next insert.
    const del = await api(`/api/users/${b.body.id}`, { method: 'DELETE' });
    assert.equal(del.status, 200, 'delete user B');

    const c = await createUser(api, `seqC-${uniq()}`);
    assert.equal(c.status, 200, 'create user C');
    assert.equal(c.body.id, b.body.id + 1, 'id is not reused after delete');
});

test('insert returns the new id (lastInsertRowid ↔ RETURNING)', async () => {
    const { api } = server;

    const chore = await api('/api/chores', {
        method: 'POST',
        body: JSON.stringify({ title: `idChore-${uniq()}`, description: '', clam_value: 3 }),
    });

    assert.equal(chore.status, 200);
    assert.equal(chore.body.success, true);
    assert.equal(typeof chore.body.id, 'number');
    assert.ok(chore.body.id > 0);
});

test('upsert: settings INSERT OR REPLACE keeps one row and updates the value', async () => {
    const { api } = server;
    const key = `char_test_${uniq()}`;

    const first = await api('/api/settings', {
        method: 'POST',
        body: JSON.stringify({ key, value: 'v1' }),
    });
    assert.equal(first.status, 200, 'first write');

    const second = await api('/api/settings', {
        method: 'POST',
        body: JSON.stringify({ key, value: 'v2' }),
    });
    assert.equal(second.status, 200, 'second write (upsert)');

    const settings = await api('/api/settings');
    assert.equal(settings.status, 200);
    assert.equal(typeof settings.body, 'object');
    // INSERT OR REPLACE / ON CONFLICT DO UPDATE must leave exactly one value.
    assert.equal(settings.body[key], 'v2', 'value reflects the second write');
});

test('FK ON DELETE CASCADE: deleting a chore removes its schedules', async () => {
    const { api } = server;

    const chore = await api('/api/chores', {
        method: 'POST',
        body: JSON.stringify({ title: `cascadeChore-${uniq()}`, description: '', clam_value: 1 }),
    });
    assert.equal(chore.status, 200);
    const choreId = chore.body.id;

    const schedule = await api('/api/chore-schedules', {
        method: 'POST',
        body: JSON.stringify({ chore_id: choreId, duration: 'day-of', crontab: '0 9 * * 1', visible: 1 }),
    });
    assert.equal(schedule.status, 200, 'create schedule');
    const scheduleId = schedule.body.id;

    const before = await api(`/api/chore-schedules/${scheduleId}`);
    assert.equal(before.status, 200, 'schedule exists before delete');

    const del = await api(`/api/chores/${choreId}`, { method: 'DELETE' });
    assert.equal(del.status, 200, 'delete chore');

    const after = await api(`/api/chore-schedules/${scheduleId}`);
    assert.equal(after.status, 404, 'schedule cascade-deleted with its chore');
});

test('JSON column round-trip: per-device settings persist and read back', async () => {
    const { api } = server;
    const device = `char-device-${uniq()}`;

    const put = await api(`/api/devices/${device}/settings`, {
        method: 'PUT',
        body: JSON.stringify({ weatherZipCode: '12345', enabledWidgets: ['calendar', 'weather'] }),
    });
    assert.ok([200, 201].includes(put.status), `PUT device settings (got ${put.status})`);

    const get = await api(`/api/devices/${device}/settings`);
    assert.equal(get.status, 200, 'GET device settings');
    assert.equal(typeof get.body, 'object', 'settings JSON deserialized to an object');
    // NOTE: exact key-shape assertions are intentionally deferred (see todo below)
    // until the golden snapshot of device-settings serialization is captured.
});

// =============================================================================
// Coverage map — to be filled in as the abstraction lands (Phase 1 completion)
// =============================================================================

// API-boundary golden snapshots (normalize volatile ids/timestamps):
test('TODO: golden snapshots for chores CRUD', { todo: 'capture normalized response snapshot' });
test('TODO: golden snapshots for chore-history + clam totals', { todo: true });
test('TODO: golden snapshots for prizes CRUD', { todo: true });
test('TODO: golden snapshots for devices/tabs CRUD', { todo: true });
test('TODO: golden snapshots for widget-assignments layout JSON', { todo: true });
test('TODO: golden snapshots for calendar-sources CRUD', { todo: true });
test('TODO: golden snapshots for photo-sources CRUD', { todo: true });
test('TODO: golden snapshots for admin-pin set/verify/exists', { todo: true });

// Below-API SQL semantics that cannot surface purely via the HTTP API. These will
// target the persistence PORT once it exists (Phase 2+), so they can run on both
// engines:
test('TODO: transaction ROLLBACK leaves no partial writes (tab reorder/renumber, device copy-from)', { todo: 'assert via port adapter once it exists' });
test('TODO: FK index present on chore_history.chore_schedule_id (schema 15)', { todo: 'introspection check on both dialects' });
test('TODO: sequence setval correctness after SQLite→Postgres data copy', { todo: 'Phase 7 data-migration validation' });
test('TODO: deep JSON round-trip equality for tabs.config_json and devices.device_settings_json', { todo: true });
