const test = require('node:test');
const assert = require('node:assert/strict');
const nodeIcal = require('node-ical');
const CalendarSyncService = require('../services/calendarSync');

function buildFixtureIcs() {
    return [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//HomeGlow Regression Test//EN',
        'BEGIN:VEVENT',
        'UID:test-language-param@example.com',
        'DTSTAMP:20260501T120000Z',
        'DTSTART:20260501T130000Z',
        'DTEND:20260501T140000Z',
        'SUMMARY;LANGUAGE=en-US:Meeting title',
        'DESCRIPTION;LANGUAGE=en-US:Desc text',
        'LOCATION;LANGUAGE=en-US:123 Main St',
        'END:VEVENT',
        'END:VCALENDAR',
    ].join('\r\n');
}

test('normalizeIcsTextValue handles node-ical parameterized values', () => {
    const service = new CalendarSyncService({}, () => null);

    assert.equal(service.normalizeIcsTextValue('plain'), 'plain');
    assert.equal(service.normalizeIcsTextValue({ val: 'param-value', params: { LANGUAGE: 'en-US' } }), 'param-value');
    assert.equal(service.normalizeIcsTextValue(42), '42');
    assert.equal(service.normalizeIcsTextValue(null), null);
    assert.equal(service.normalizeIcsTextValue(undefined), null);
});

test('normalizeAllDayEnd subtracts one day for all-day events', () => {
    const service = new CalendarSyncService({}, () => null);
    const result = service.normalizeAllDayEnd(new Date('2026-05-02T00:00:00.000Z'));
    assert.equal(result.toISOString().slice(0, 10), '2026-05-01');
});

test('fetchICSEvents normalizes SUMMARY/DESCRIPTION/LOCATION to strings', async () => {
    const fixture = buildFixtureIcs();
    const parsed = nodeIcal.sync.parseICS(fixture);
    const vevent = Object.values(parsed).find((item) => item && item.type === 'VEVENT');

    assert.ok(vevent, 'expected one VEVENT in fixture');
    assert.equal(typeof vevent.location, 'object');

    const service = new CalendarSyncService({}, () => null);

    const originalFromUrl = nodeIcal.async.fromURL;
    const originalExpandRecurringEvent = nodeIcal.expandRecurringEvent;

    nodeIcal.async.fromURL = async () => parsed;
    nodeIcal.expandRecurringEvent = () => null;

    try {
        const events = await service.fetchICSEvents({ id: 'fixture', url: 'http://example.invalid/test.ics' });

        assert.equal(events.length, 1);
        assert.equal(events[0].title, 'Meeting title');
        assert.equal(events[0].description, 'Desc text');
        assert.equal(events[0].location, '123 Main St');
        assert.equal(typeof events[0].title, 'string');
        assert.equal(typeof events[0].description, 'string');
        assert.equal(typeof events[0].location, 'string');
    } finally {
        nodeIcal.async.fromURL = originalFromUrl;
        nodeIcal.expandRecurringEvent = originalExpandRecurringEvent;
    }
});

test('getCachedEvents maps cached rows with source metadata', async () => {
    const path = require('node:path');
    const fs = require('node:fs');
    const { createKnex } = require('../db/knex');
    const dbFile = path.join(__dirname, '.tmp', `calsync-${process.pid}-${Date.now()}.db`);
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    const knex = createKnex({ engine: 'sqlite', filename: dbFile });
    require('objection').Model.knex(knex);

    await knex.schema.createTable('calendar_sources', (t) => {
        t.integer('id').primary();
        t.text('name');
        t.text('color');
        t.integer('enabled').defaultTo(1);
    });
    await knex.schema.createTable('calendar_events_cache', (t) => {
        t.integer('source_id');
        t.text('event_uid');
        t.text('title');
        t.text('start_time');
        t.text('end_time');
        t.text('description');
        t.text('location');
        t.integer('all_day');
    });

    await knex('calendar_sources').insert({ id: 1, name: 'Family', color: '#123456', enabled: 1 });
    await knex('calendar_events_cache').insert([
        {
            source_id: 1,
            event_uid: 'evt-1',
            title: 'Title 1',
            start_time: '2026-05-01T10:00:00.000Z',
            end_time: '2026-05-01T11:00:00.000Z',
            description: 'Desc 1',
            location: 'Loc 1',
            all_day: 0,
        },
        {
            source_id: 999,
            event_uid: 'evt-2',
            title: 'Title 2',
            start_time: '2026-05-02T10:00:00.000Z',
            end_time: '2026-05-02T11:00:00.000Z',
            description: null,
            location: null,
            all_day: 1,
        },
    ]);

    const service = new CalendarSyncService({}, () => null);

    try {
        const mapped = await service.getCachedEvents('2026-05-01', '2026-05-03');

        assert.equal(mapped.length, 2);

        assert.equal(mapped[0].source_name, 'Family');
        assert.equal(mapped[0].source_color, '#123456');
        assert.equal(mapped[0].all_day, false);

        assert.equal(mapped[1].source_name, 'Unknown');
        assert.equal(mapped[1].source_color, '#6e44ff');
        assert.equal(mapped[1].all_day, true);
    } finally {
        await knex.destroy();
        for (const suffix of ['', '-wal', '-shm']) {
            try { fs.rmSync(`${dbFile}${suffix}`, { force: true }); } catch (_) { /* ignore */ }
        }
    }
});

test('parseEventColor extracts a valid hex and rejects anything else', () => {
    const service = new CalendarSyncService({}, () => null);

    assert.equal(service.parseEventColor(JSON.stringify({ eventColor: '#dc2127' })), '#dc2127');
    assert.equal(service.parseEventColor(JSON.stringify({ eventColor: null })), null);
    assert.equal(service.parseEventColor(JSON.stringify({ googleEventId: 'x' })), null);
    assert.equal(service.parseEventColor(JSON.stringify({ eventColor: 'red' })), null);
    assert.equal(service.parseEventColor('not json'), null);
    assert.equal(service.parseEventColor(null), null);
});

test('getCachedEvents surfaces per-event color and leaves it null otherwise', async () => {
    const path = require('node:path');
    const fs = require('node:fs');
    const { createKnex } = require('../db/knex');
    const dbFile = path.join(__dirname, '.tmp', `calcolor-${process.pid}-${Date.now()}.db`);
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    const knex = createKnex({ engine: 'sqlite', filename: dbFile });
    require('objection').Model.knex(knex);

    await knex.schema.createTable('calendar_sources', (t) => {
        t.integer('id').primary();
        t.text('name');
        t.text('color');
        t.integer('enabled').defaultTo(1);
    });
    await knex.schema.createTable('calendar_events_cache', (t) => {
        t.integer('source_id');
        t.text('event_uid');
        t.text('title');
        t.text('start_time');
        t.text('end_time');
        t.text('description');
        t.text('location');
        t.integer('all_day');
        t.text('raw_data');
    });

    await knex('calendar_sources').insert({ id: 1, name: 'Family', color: '#123456', enabled: 1 });
    await knex('calendar_events_cache').insert([
        {
            source_id: 1, event_uid: 'recolored', title: 'Recolored',
            start_time: '2026-05-01T13:00:00.000Z', end_time: '2026-05-01T14:00:00.000Z',
            description: null, location: null, all_day: 0,
            raw_data: JSON.stringify({ googleEventId: 'a', colorId: '11', eventColor: '#dc2127' }),
        },
        {
            source_id: 1, event_uid: 'default-color', title: 'Default',
            start_time: '2026-05-02T13:00:00.000Z', end_time: '2026-05-02T14:00:00.000Z',
            description: null, location: null, all_day: 0,
            raw_data: JSON.stringify({ googleEventId: 'b', colorId: null, eventColor: null }),
        },
    ]);

    const service = new CalendarSyncService({}, () => null);

    try {
        const mapped = await service.getCachedEvents();

        assert.equal(mapped.length, 2);
        assert.equal(mapped[0].event_color, '#dc2127');
        assert.equal(mapped[0].source_color, '#123456');
        assert.equal(mapped[1].event_color, null);
        assert.equal(mapped[1].source_color, '#123456');
    } finally {
        await knex.destroy();
        for (const suffix of ['', '-wal', '-shm']) {
            try { fs.rmSync(`${dbFile}${suffix}`, { force: true }); } catch (_) { /* ignore */ }
        }
    }
});

test('fetchGoogleEvents resolves colorId to a hex via the Google palette', async () => {
    const googleCalendar = require('../services/googleCalendar');
    const googleConnection = require('../services/googleConnection');

    const originalGetAccount = googleConnection.getConnectedAccount;
    const originalListEvents = googleCalendar.listEvents;
    const originalListEventColors = googleCalendar.listEventColors;

    googleConnection.getConnectedAccount = () => ({ id: 'acct-1' });
    googleCalendar.listEventColors = async () => ({ '11': '#dc2127' });
    googleCalendar.listEvents = async () => ([
        {
            id: 'evt-recolored', status: 'confirmed', summary: 'Recolored',
            start: { dateTime: '2026-05-01T13:00:00Z' },
            end: { dateTime: '2026-05-01T14:00:00Z' },
            colorId: '11',
        },
        {
            id: 'evt-default', status: 'confirmed', summary: 'Default',
            start: { dateTime: '2026-05-02T13:00:00Z' },
            end: { dateTime: '2026-05-02T14:00:00Z' },
        },
    ]);

    try {
        const service = new CalendarSyncService({}, () => null);
        const events = await service.fetchGoogleEvents({ id: 1, url: 'primary' });

        assert.equal(events.length, 2);
        assert.equal(events[0].raw.colorId, '11');
        assert.equal(events[0].raw.eventColor, '#dc2127');
        assert.equal(events[1].raw.colorId, null);
        assert.equal(events[1].raw.eventColor, null);
    } finally {
        googleConnection.getConnectedAccount = originalGetAccount;
        googleCalendar.listEvents = originalListEvents;
        googleCalendar.listEventColors = originalListEventColors;
    }
});

test('fetchGoogleEvents leaves color null when the palette is unavailable', async () => {
    const googleCalendar = require('../services/googleCalendar');
    const googleConnection = require('../services/googleConnection');

    const originalGetAccount = googleConnection.getConnectedAccount;
    const originalListEvents = googleCalendar.listEvents;
    const originalListEventColors = googleCalendar.listEventColors;

    googleConnection.getConnectedAccount = () => ({ id: 'acct-1' });
    googleCalendar.listEventColors = async () => ({});
    googleCalendar.listEvents = async () => ([
        {
            id: 'evt-recolored', status: 'confirmed', summary: 'Recolored',
            start: { dateTime: '2026-05-01T13:00:00Z' },
            end: { dateTime: '2026-05-01T14:00:00Z' },
            colorId: '11',
        },
    ]);

    try {
        const service = new CalendarSyncService({}, () => null);
        const events = await service.fetchGoogleEvents({ id: 1, url: 'primary' });

        assert.equal(events[0].raw.colorId, '11');
        assert.equal(events[0].raw.eventColor, null);
    } finally {
        googleConnection.getConnectedAccount = originalGetAccount;
        googleCalendar.listEvents = originalListEvents;
        googleCalendar.listEventColors = originalListEventColors;
    }
});
