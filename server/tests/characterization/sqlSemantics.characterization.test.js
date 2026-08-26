// Golden-master characterization tests for the data persistence layer.
//
// Purpose: lock in the OBSERVABLE behavior of the current SQLite-backed API so the
// identical suite can be re-run unchanged after every task of the Knex + Objection
// migration. The suite is the parity gate: a task is only "done" when this output
// is still green.
//
// Migration phases this suite guards (see the implementation plan):
//   Task 1  capture golden master (raw better-sqlite3)   <- these tests
//   Task 2  add Knex + Objection (no behavior change)     -> rerun, must match
//   Task 3  v14 baseline migration + baseline adoption    -> rerun, must match
//   Task 4  knex.migrate.latest() is startup authority    -> rerun, must match
//   Task 5-12 domain-by-domain async/Objection conversion -> rerun after each
//   Task 13 decommission legacy data layer                -> rerun, must match
//
// Most assertions live at the HTTP API boundary on purpose: that boundary is
// engine- and ORM-agnostic, so the SAME assertions verify raw SQLite today and
// Knex/Objection (and a future Postgres) later with zero edits. The cases
// concentrate on behaviors most likely to regress during the async conversion:
// sequences, upsert, insert-returning-id, FK cascade/SET NULL, JSON round-trip,
// and multi-statement TRANSACTION atomicity (reorder / renumber / copy-from).

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
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

function createChore(api, title, clamValue = 0) {
    return api('/api/chores', {
        method: 'POST',
        body: JSON.stringify({ title, description: 'desc', clam_value: clamValue }),
    });
}

async function createTab(api, device, label, icon = 'star') {
    return api(`/api/devices/${encodeURIComponent(device)}/tabs`, {
        method: 'POST',
        body: JSON.stringify({ label, icon, show_label: true }),
    });
}

// =============================================================================
// SQL semantics — the behaviors most likely to regress (precise, engine-agnostic)
// =============================================================================

test('sequence continuity: auto-increment ids advance and are never reused', async () => {
    const { api } = server;

    const a = await createUser(api, `seqA-${uniq()}`);
    const b = await createUser(api, `seqB-${uniq()}`);

    assert.equal(a.status, 200, 'create user A');
    assert.equal(b.status, 200, 'create user B');
    assert.equal(typeof a.body.id, 'number');
    assert.equal(typeof b.body.id, 'number');

    // Consecutive inserts increment by exactly 1.
    assert.equal(b.body.id, a.body.id + 1, 'second insert id == first + 1');

    // Deleting the latest row must NOT cause id reuse on the next insert.
    const del = await api(`/api/users/${b.body.id}`, { method: 'DELETE' });
    assert.equal(del.status, 200, 'delete user B');

    const c = await createUser(api, `seqC-${uniq()}`);
    assert.equal(c.status, 200, 'create user C');
    assert.equal(c.body.id, b.body.id + 1, 'id is not reused after delete');
});

test('insert returns the new id (lastInsertRowid -> RETURNING)', async () => {
    const { api } = server;

    const chore = await createChore(api, `idChore-${uniq()}`, 3);

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

    const chore = await createChore(api, `cascadeChore-${uniq()}`, 1);
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

// =============================================================================
// Domain CRUD golden assertions
// =============================================================================

test('chores: full CRUD lifecycle', async () => {
    const { api } = server;
    const title = `chore-${uniq()}`;

    const created = await createChore(api, title, 7);
    assert.equal(created.status, 200);
    const id = created.body.id;

    const list = await api('/api/chores');
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.body));
    const found = list.body.find((c) => c.id === id);
    assert.ok(found, 'created chore appears in list');
    assert.equal(found.title, title);
    assert.equal(found.clam_value, 7);

    const updated = await api(`/api/chores/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: `${title}-edited`, description: 'd2', clam_value: 9 }),
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.success, true);

    const del = await api(`/api/chores/${id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.equal(del.body.success, true);

    const delAgain = await api(`/api/chores/${id}`, { method: 'DELETE' });
    assert.equal(delAgain.status, 404, 'second delete is 404');
});

test('chore-history + clam totals: completing a chore awards clams to the user', async () => {
    const { api } = server;

    const user = await createUser(api, `clamUser-${uniq()}`);
    assert.equal(user.status, 200);
    const userId = user.body.id;

    // clam_value > 0 so this is NOT a "regular" (0-clam) chore and the
    // all-regular-chores-done daily bonus does not fire — keeps the math exact.
    const chore = await createChore(api, `clamChore-${uniq()}`, 5);
    assert.equal(chore.status, 200);

    const schedule = await api('/api/chore-schedules', {
        method: 'POST',
        body: JSON.stringify({ chore_id: chore.body.id, user_id: userId, duration: 'day-of', crontab: '0 9 * * 1', visible: 1 }),
    });
    assert.equal(schedule.status, 200);
    const scheduleId = schedule.body.id;

    const date = '2026-01-15';
    const complete = await api('/api/chores/complete', {
        method: 'POST',
        body: JSON.stringify({ chore_schedule_id: scheduleId, user_id: userId, date }),
    });
    assert.equal(complete.status, 200);
    assert.equal(complete.body.success, true);
    assert.equal(complete.body.clam_total, 5, 'clam_total == single completion clam_value');

    // Balance is derived from chore_history and surfaces on the user row.
    const users = await api('/api/users');
    assert.equal(users.status, 200);
    const me = users.body.find((u) => u.id === userId);
    assert.ok(me);
    assert.equal(me.clam_total, 5, 'derived clam_total on user equals 5');

    // Completing the same schedule/date again is rejected (no double award).
    const dup = await api('/api/chores/complete', {
        method: 'POST',
        body: JSON.stringify({ chore_schedule_id: scheduleId, user_id: userId, date }),
    });
    assert.equal(dup.status, 409, 'duplicate completion is 409');
});

test('calendar-sources: create and list', async () => {
    const { api } = server;
    const name = `cal-${uniq()}`;

    const created = await api('/api/calendar-sources', {
        method: 'POST',
        body: JSON.stringify({ name, type: 'ICS', url: 'https://example.com/feed.ics', color: '#123456' }),
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.success, true);
    assert.equal(typeof created.body.id, 'number');

    const list = await api('/api/calendar-sources');
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.body));
    const found = list.body.find((s) => s.id === created.body.id);
    assert.ok(found, 'created calendar source appears in list');
    assert.equal(found.name, name);
    assert.equal(found.type, 'ICS');
    assert.equal(found.enabled, 1);

    const invalid = await api('/api/calendar-sources', {
        method: 'POST',
        body: JSON.stringify({ name: 'bad', type: 'NOPE', url: 'x' }),
    });
    assert.equal(invalid.status, 400, 'invalid type rejected');
});

test('photo-sources: create and list', async () => {
    const { api } = server;
    const name = `photo-${uniq()}`;

    const created = await api('/api/photo-sources', {
        method: 'POST',
        body: JSON.stringify({ name, type: 'Immich', url: 'https://immich.example.com', api_key: 'secret-key' }),
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.success, true);
    assert.equal(typeof created.body.id, 'number');

    const list = await api('/api/photo-sources');
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.body));
    const found = list.body.find((s) => s.id === created.body.id);
    assert.ok(found, 'created photo source appears in list');
    assert.equal(found.name, name);
    assert.equal(found.type, 'Immich');

    const invalid = await api('/api/photo-sources', {
        method: 'POST',
        body: JSON.stringify({ name: 'bad', type: 'NOPE' }),
    });
    assert.equal(invalid.status, 400, 'invalid type rejected');
});

test('admin-pin: exists / set / verify / clear lifecycle', async () => {
    const { api } = server;

    const before = await api('/api/admin-pin/exists');
    assert.equal(before.status, 200);
    assert.equal(before.body.exists, false, 'no PIN initially');

    const set = await api('/api/admin-pin/set', {
        method: 'POST',
        body: JSON.stringify({ pin: '4321' }),
    });
    assert.equal(set.status, 200);
    assert.equal(set.body.success, true);

    const exists = await api('/api/admin-pin/exists');
    assert.equal(exists.body.exists, true, 'PIN exists after set');

    const good = await api('/api/admin-pin/verify', {
        method: 'POST',
        body: JSON.stringify({ pin: '4321' }),
    });
    assert.equal(good.status, 200);
    assert.equal(good.body.valid, true, 'correct PIN verifies');

    const bad = await api('/api/admin-pin/verify', {
        method: 'POST',
        body: JSON.stringify({ pin: '0000' }),
    });
    assert.equal(bad.status, 200);
    assert.equal(bad.body.valid, false, 'wrong PIN does not verify');

    const cleared = await api('/api/admin-pin', { method: 'DELETE' });
    assert.equal(cleared.status, 200);

    const after = await api('/api/admin-pin/exists');
    assert.equal(after.body.exists, false, 'PIN gone after clear');
});

// =============================================================================
// JSON column round-trip (deep equality)
// =============================================================================

test('deep JSON round-trip: device_settings_json persists nested structures exactly', async () => {
    const { api } = server;
    const device = `json-device-${uniq()}`;

    const payload = {
        weatherZipCode: '12345',
        enabledWidgets: ['calendar', 'weather', 'chores'],
        interfaceColors: { primary: '#abcdef', secondary: '#012345' },
        screensaver: { enabled: true, mode: 'slideshow', timeoutSeconds: 300, nested: { a: [1, 2, 3], b: null } },
    };

    const put = await api(`/api/devices/${device}/settings`, {
        method: 'PUT',
        body: JSON.stringify(payload),
    });
    assert.ok([200, 201].includes(put.status), `PUT device settings (got ${put.status})`);

    const get = await api(`/api/devices/${device}/settings`);
    assert.equal(get.status, 200);
    assert.deepEqual(get.body.enabledWidgets, payload.enabledWidgets);
    assert.deepEqual(get.body.interfaceColors, payload.interfaceColors);
    assert.deepEqual(get.body.screensaver, payload.screensaver, 'deeply nested settings round-trip exactly');
});

test('deep JSON round-trip: tabs.config_json widget layout persists exactly', async () => {
    const { api } = server;
    const device = `json-tab-${uniq()}`;

    const assign = await api(`/api/devices/${device}/widget-assignments`, {
        method: 'POST',
        body: JSON.stringify({ widget_name: 'calendar', tabNumber: 1 }),
    });
    assert.equal(assign.status, 200);

    const patch = await api(`/api/devices/${device}/widget-assignments/layout`, {
        method: 'PATCH',
        body: JSON.stringify({
            widget_name: 'calendar',
            tabNumber: 1,
            layout_x: 2,
            layout_y: 3,
            layout_w: 4,
            layout_h: 5,
            settings: { showStartTimes: false, palette: { weekend: '#ff0000' } },
        }),
    });
    assert.equal(patch.status, 200);

    const tabs = await api(`/api/devices/${device}/tabs`);
    assert.equal(tabs.status, 200);
    const home = tabs.body.find((t) => t.number === 1);
    assert.ok(home);
    const config = JSON.parse(home.config_json || '{}');
    assert.ok(config.calendar, 'calendar layout stored under widget name');
    assert.equal(config.calendar.layout_x, 2);
    assert.equal(config.calendar.layout_y, 3);
    assert.equal(config.calendar.layout_w, 4);
    assert.equal(config.calendar.layout_h, 5);
    assert.deepEqual(config.calendar.showStartTimes, false);
    assert.deepEqual(config.calendar.palette, { weekend: '#ff0000' }, 'nested widget settings round-trip exactly');
});

// =============================================================================
// Transaction atomicity — locked in BEFORE the async conversion (Task 5-12) so a
// partial-commit regression in the Objection/Knex transaction rewrite is caught.
// =============================================================================

test('transaction (reorder): multi-statement tab reorder commits as a consistent unit', async () => {
    const { api } = server;
    const device = `reorder-${uniq()}`;

    // Home tab is number 1; create three more -> numbers 2, 3, 4.
    const a = await createTab(api, device, 'Alpha');
    const b = await createTab(api, device, 'Bravo');
    const c = await createTab(api, device, 'Charlie');
    assert.equal(a.body.number, 2);
    assert.equal(b.body.number, 3);
    assert.equal(c.body.number, 4);

    // Reorder the non-home tabs: request order [4, 2, 3] -> they become 2, 3, 4.
    const reorder = await api(`/api/devices/${device}/tabs/reorder`, {
        method: 'PATCH',
        body: JSON.stringify({ orderedTabNumbers: [4, 2, 3] }),
    });
    assert.equal(reorder.status, 200);

    const tabs = await api(`/api/devices/${device}/tabs`);
    assert.equal(tabs.status, 200);
    const numbers = tabs.body.map((t) => t.number).sort((x, y) => x - y);
    assert.deepEqual(numbers, [1, 2, 3, 4], 'no gaps or duplicate tab numbers after reorder');

    const byNumber = new Map(tabs.body.map((t) => [t.number, t.label]));
    // Charlie (was 4) is first in the request -> number 2; Alpha -> 3; Bravo -> 4.
    assert.equal(byNumber.get(2), 'Charlie');
    assert.equal(byNumber.get(3), 'Alpha');
    assert.equal(byNumber.get(4), 'Bravo');
});

test('transaction (renumber): deleting a middle tab renumbers survivors with no gaps', async () => {
    const { api } = server;
    const device = `renumber-${uniq()}`;

    await createTab(api, device, 'One'); // number 2
    await createTab(api, device, 'Two'); // number 3
    await createTab(api, device, 'Three'); // number 4

    const del = await api(`/api/devices/${device}/tabs/3`, { method: 'DELETE' });
    assert.equal(del.status, 200);

    const tabs = await api(`/api/devices/${device}/tabs`);
    assert.equal(tabs.status, 200);
    const numbers = tabs.body.map((t) => t.number).sort((x, y) => x - y);
    assert.deepEqual(numbers, [1, 2, 3], 'survivors renumbered consecutively (no gap left by deleted tab)');

    const byNumber = new Map(tabs.body.map((t) => [t.number, t.label]));
    assert.equal(byNumber.get(2), 'One', 'survivor One keeps relative order at number 2');
    assert.equal(byNumber.get(3), 'Three', 'survivor Three renumbered to 3');
});

test('transaction (copy-from): device copy replaces tabs and settings atomically', async () => {
    const { api } = server;
    const source = `copy-src-${uniq()}`;
    const dest = `copy-dst-${uniq()}`;

    // Source: two extra tabs + device settings.
    await createTab(api, source, 'SrcCal');
    await createTab(api, source, 'SrcPhotos');
    await api(`/api/devices/${source}/settings`, {
        method: 'PUT',
        body: JSON.stringify({ theme: 'dark', weatherZipCode: '99999' }),
    });

    // Dest: a different tab + different settings (should be fully replaced).
    await createTab(api, dest, 'DstOnly');
    await api(`/api/devices/${dest}/settings`, {
        method: 'PUT',
        body: JSON.stringify({ theme: 'light', weatherZipCode: '00000' }),
    });

    const copy = await api(`/api/devices/${dest}/copy-from/${source}`, { method: 'POST' });
    assert.equal(copy.status, 200);
    assert.equal(copy.body.success, true);

    const destTabs = await api(`/api/devices/${dest}/tabs`);
    assert.equal(destTabs.status, 200);
    const labels = destTabs.body.map((t) => t.label).sort();
    assert.deepEqual(labels, ['Home', 'SrcCal', 'SrcPhotos'], 'dest tabs replaced by source tabs (DstOnly gone)');

    const destSettings = await api(`/api/devices/${dest}/settings`);
    assert.equal(destSettings.status, 200);
    assert.equal(destSettings.body.theme, 'dark', 'device settings copied from source');
    assert.equal(destSettings.body.weatherZipCode, '99999');
});

test('transaction ROLLBACK: a throwing multi-statement transaction leaves no partial writes', () => {
    // The validated public API does not expose a way to force a fault midway
    // through reorder/renumber/copy-from, so this pins the BEGIN/COMMIT/ROLLBACK
    // contract those handlers rely on directly against better-sqlite3. The
    // Objection/Knex rewrite (Task 11) must preserve the same all-or-nothing
    // semantics — a transaction that throws must persist nothing.
    const db = new Database(':memory:');
    try {
        db.pragma('foreign_keys = ON');
        db.exec(`
            CREATE TABLE tabs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_name TEXT NOT NULL,
                number INTEGER NOT NULL,
                UNIQUE(device_name, number)
            );
        `);
        const insert = db.prepare('INSERT INTO tabs (device_name, number) VALUES (?, ?)');
        insert.run('dev', 1);
        insert.run('dev', 2);
        insert.run('dev', 3);

        const update = db.prepare('UPDATE tabs SET number = ? WHERE device_name = ? AND number = ?');
        const faultyTransaction = db.transaction(() => {
            update.run(10, 'dev', 1); // partial write
            update.run(11, 'dev', 2); // partial write
            throw new Error('boom'); // force rollback before completion
        });

        assert.throws(() => faultyTransaction(), /boom/);

        const rows = db.prepare('SELECT number FROM tabs ORDER BY number ASC').all().map((r) => r.number);
        assert.deepEqual(rows, [1, 2, 3], 'rolled-back transaction left the original numbers intact');
    } finally {
        db.close();
    }
});
