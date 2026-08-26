// Home Assistant connection + secret containment (issue #57).
//
// The load-bearing assertion in this file is the redaction one. GET /api/settings
// is unauthenticated and returns the whole settings table, so a Home Assistant
// token stored there would be readable by every browser on the LAN and every
// plugin iframe — and that token controls the whole house. Encrypting it is not
// enough on its own; it must never be serialized out at all.
//
// The connection service itself is exercised in-process against a real temp
// SQLite database (Knex + Objection), the same way calendarSync.test.js does it.
// Every function that touches the database is async and takes no `db` handle:
// the data layer is reached through the globally bound Objection models.
const test = require('node:test');
const { describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const serverDir = path.resolve(__dirname, '..');
const tmpDir = path.resolve(__dirname, '.tmp');
const stamp = `${process.pid}-${Date.now()}`;
const keepTestArtifacts = process.env.HOMEGLOW_TEST_KEEP_ARTIFACTS === '1';

fs.mkdirSync(tmpDir, { recursive: true });

// The in-process service tests encrypt and decrypt for real. Pin the key (and
// the key file, which utils/encryption resolves at require time) into the temp
// directory so a test run never writes into server/data/.
const ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64');
process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
process.env.ENCRYPTION_KEY_FILE = path.join(tmpDir, `home-assistant-${stamp}.key`);

const { Model } = require('objection');
const { createKnex } = require('../db/knex');
const { decrypt } = require('../utils/encryption');
const homeAssistant = require('../services/homeAssistant');
const { Setting } = require('../db/models');

const SECRET_TOKEN = 'eyJhbGciOi.super-secret-long-lived-token.signature';

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function removeFiles(basePath, suffixes = ['', '-shm', '-wal', '-journal']) {
    for (const suffix of suffixes) {
        try { fs.rmSync(`${basePath}${suffix}`, { force: true }); } catch (_) { /* ignore */ }
    }
}

// --- the connection service, in process ------------------------------------

describe('the Home Assistant connection service', () => {
    const serviceDbFile = path.join(tmpDir, `home-assistant-service-${stamp}.db`);
    let knex;
    let fakeHomeAssistant;
    let fakeHomeAssistantUrl;

    before(async () => {
        knex = createKnex({ engine: 'sqlite', filename: serviceDbFile });
        Model.knex(knex);
        await knex.schema.createTable('settings', (t) => {
            t.text('key').primary();
            t.text('value');
        });

        // Stand-in Home Assistant. Authenticates on the bearer token so we can
        // prove the service sends it and that a wrong one surfaces as a 401.
        fakeHomeAssistant = http.createServer((req, res) => {
            res.setHeader('Content-Type', 'application/json');
            if (req.headers.authorization !== `Bearer ${SECRET_TOKEN}`) {
                res.statusCode = 401;
                return res.end(JSON.stringify({ message: 'Unauthorized' }));
            }
            if (req.url === '/api/') {
                return res.end(JSON.stringify({ message: 'API running.' }));
            }
            if (req.url === '/api/config') {
                return res.end(JSON.stringify({
                    version: '2026.7.1',
                    location_name: 'Test Home',
                    latitude: 43.0848,
                    longitude: -77.7522,
                }));
            }
            if (req.url === '/api/states') {
                return res.end(JSON.stringify([
                    { entity_id: 'weather.home', state: 'sunny', attributes: { friendly_name: 'Home' } },
                    { entity_id: 'light.kitchen', state: 'on', attributes: { friendly_name: 'Kitchen' } },
                ]));
            }
            if (req.url === '/api/states/weather.home') {
                return res.end(JSON.stringify({
                    entity_id: 'weather.home',
                    state: 'sunny',
                    attributes: { friendly_name: 'Home', temperature: 20, temperature_unit: '°C' },
                }));
            }
            res.statusCode = 404;
            res.end(JSON.stringify({ message: 'not found' }));
        });
        await new Promise((resolve) => fakeHomeAssistant.listen(0, '127.0.0.1', resolve));
        fakeHomeAssistantUrl = `http://127.0.0.1:${fakeHomeAssistant.address().port}`;
    });

    after(async () => {
        if (fakeHomeAssistant) {
            await new Promise((resolve) => fakeHomeAssistant.close(resolve));
        }
        if (knex) await knex.destroy();
        if (!keepTestArtifacts) removeFiles(serviceDbFile);
    });

    beforeEach(async () => {
        await Setting.query().delete();
    });

    const storedToken = async () => {
        const row = await Setting.query().findById(homeAssistant.TOKEN_KEY);
        return row ? row.value : null;
    };

    const saveWorkingConnection = () => homeAssistant.saveConfig({
        url: fakeHomeAssistantUrl,
        token: SECRET_TOKEN,
        weatherEntity: 'weather.home',
    });

    test('status reports an unconfigured connection without inventing one', async () => {
        const status = await homeAssistant.getHomeAssistantStatus();
        assert.equal(status.has_url, false);
        assert.equal(status.has_token, false);
        assert.equal(status.encryption_configured, true);
        // The default entity is reported even before anything is stored.
        assert.equal(status.weather_entity, homeAssistant.DEFAULT_WEATHER_ENTITY);
        assert.equal(await homeAssistant.isConfigured(), false);
    });

    test('saving stores the token encrypted and never echoes it back', async () => {
        await saveWorkingConnection();

        const status = await homeAssistant.getHomeAssistantStatus();
        assert.equal(status.has_token, true);
        assert.equal(status.url, fakeHomeAssistantUrl);
        assert.equal(status.weather_entity, 'weather.home');
        assert.equal(await homeAssistant.isConfigured(), true);

        // The token must not appear anywhere in the status payload.
        assert.ok(
            !JSON.stringify(status).includes(SECRET_TOKEN),
            'status response leaked the access token',
        );

        // ...and what landed in the settings table is ciphertext, not the token.
        const stored = await storedToken();
        assert.notEqual(stored, SECRET_TOKEN, 'token stored in plaintext');
        assert.equal(decrypt(stored), SECRET_TOKEN, 'stored token does not round-trip');
    });

    test('a blank token leaves the stored one alone; null clears it', async () => {
        // The Admin Panel edits the token blind, so saving a URL change must not
        // wipe a token the user did not retype.
        await saveWorkingConnection();
        const original = await storedToken();

        await homeAssistant.saveConfig({ url: 'http://elsewhere.local:8123' });
        assert.equal(await storedToken(), original, 'a URL-only save wiped the token');

        await homeAssistant.saveConfig({ token: '' });
        assert.equal(await storedToken(), original, 'a blank token save wiped the token');

        await homeAssistant.saveConfig({ token: null });
        assert.equal(await storedToken(), '', 'an explicit null did not clear the token');
        assert.equal(await homeAssistant.isConfigured(), false);
    });

    test('a bad URL is rejected at save time rather than at fetch time', async () => {
        await assert.rejects(
            () => homeAssistant.saveConfig({ url: 'ftp://nope' }),
            /http or https/,
        );
        // Nothing was written.
        const status = await homeAssistant.getHomeAssistantStatus();
        assert.equal(status.has_url, false);

        // A bare host is still accepted, and a trailing slash is trimmed.
        await homeAssistant.saveConfig({ url: 'homeassistant.local:8123/' });
        assert.equal(
            (await homeAssistant.getHomeAssistantStatus()).url,
            'http://homeassistant.local:8123',
        );
    });

    test('the connection test reaches Home Assistant with the stored token', async () => {
        await saveWorkingConnection();

        const result = await homeAssistant.testConnection();
        assert.equal(result.ok, true);
        assert.equal(result.version, '2026.7.1');
        assert.match(result.message, /Test Home/);
    });

    test('a bad token surfaces as a failed test rather than an exception', async () => {
        await saveWorkingConnection();
        await homeAssistant.saveConfig({ token: 'wrong-token' });

        const result = await homeAssistant.testConnection();
        assert.equal(result.ok, false);
        assert.match(result.message, /rejected the access token/);
    });

    test('an unreachable Home Assistant is a clear failure, not a hang', async () => {
        await saveWorkingConnection();
        // Port 1 is reserved and refuses immediately.
        await homeAssistant.saveConfig({ url: 'http://127.0.0.1:1' });

        const result = await homeAssistant.testConnection();
        assert.equal(result.ok, false);
        assert.match(result.message, /Could not reach Home Assistant/);
    });

    test('the entity picker lists only weather entities', async () => {
        await saveWorkingConnection();

        const entities = await homeAssistant.listWeatherEntities();
        assert.deepEqual(entities.map((e) => e.entity_id), ['weather.home']);
        assert.deepEqual(entities.map((e) => e.name), ['Home']);
    });

    test('reading an entity state goes through the authenticated connection', async () => {
        await saveWorkingConnection();

        const state = await homeAssistant.getState('weather.home');
        assert.equal(state.state, 'sunny');
        assert.equal(state.attributes.temperature, 20);
    });

    test('an unconfigured connection fails before it tries to fetch', async () => {
        await assert.rejects(
            () => homeAssistant.homeAssistantFetch('GET', '/api/'),
            /URL is not configured/,
        );

        await homeAssistant.saveConfig({ url: fakeHomeAssistantUrl });
        await assert.rejects(
            () => homeAssistant.homeAssistantFetch('GET', '/api/'),
            /token is not configured/,
        );

        // testConnection reports the same two states without throwing.
        await homeAssistant.clearConfig();
        assert.equal((await homeAssistant.testConnection()).message, 'No Home Assistant URL is configured.');
        await homeAssistant.saveConfig({ url: fakeHomeAssistantUrl });
        assert.equal((await homeAssistant.testConnection()).message, 'No Home Assistant token is configured.');
    });

    test('clearing the connection leaves nothing configured', async () => {
        await saveWorkingConnection();
        await homeAssistant.clearConfig();

        const status = await homeAssistant.getHomeAssistantStatus();
        assert.equal(status.has_url, false);
        assert.equal(status.has_token, false);
        assert.equal(await homeAssistant.isConfigured(), false);
        // A cleared entity falls back to the default rather than to empty.
        assert.equal(status.weather_entity, homeAssistant.DEFAULT_WEATHER_ENTITY);
    });
});

// --- the routes that must not serialize a secret ---------------------------
//
// These need the whole server, so they run against a spawned index.js. Only the
// route-level behavior is asserted here; the service behavior above is covered
// in process.

describe('settings routes never serialize a stored secret', () => {
    const testDbPath = path.join(tmpDir, `home-assistant-routes-${stamp}.db`);
    const port = 7900 + Math.floor(Math.random() * 300);
    const baseUrl = `http://127.0.0.1:${port}`;

    let serverProcess;
    let serverLogs = '';
    let routesHomeAssistant;
    let routesHomeAssistantUrl;

    async function waitForServerReady(timeoutMs = 30000) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            try {
                const response = await fetch(`${baseUrl}/api/test`);
                if (response.ok) return;
            } catch {
                // Server is still starting.
            }
            await delay(250);
        }
        throw new Error(`Server did not become ready within ${timeoutMs}ms. Logs:\n${serverLogs}`);
    }

    async function api(pathname, options = {}) {
        const headers = { ...(options.headers || {}) };
        if (options.body !== undefined && !headers['Content-Type']) {
            headers['Content-Type'] = 'application/json';
        }
        const response = await fetch(`${baseUrl}${pathname}`, { ...options, headers });
        const text = await response.text();
        let body;
        try {
            body = text ? JSON.parse(text) : null;
        } catch {
            body = text;
        }
        return { status: response.status, body };
    }

    const setSetting = (key, value) => api('/api/settings', {
        method: 'POST',
        body: JSON.stringify({ key, value }),
    });

    before(async () => {
        // Stand-in Home Assistant for the route tests below. Separate from the
        // in-process suite's fake, whose lifetime ends with that describe block.
        routesHomeAssistant = http.createServer((req, res) => {
            res.setHeader('Content-Type', 'application/json');
            if (req.headers.authorization !== `Bearer ${SECRET_TOKEN}`) {
                res.statusCode = 401;
                return res.end(JSON.stringify({ message: 'Unauthorized' }));
            }
            if (req.url === '/api/' ) {
                return res.end(JSON.stringify({ message: 'API running.' }));
            }
            if (req.url === '/api/config') {
                return res.end(JSON.stringify({
                    version: '2026.7.1',
                    location_name: 'Test Home',
                    latitude: 43.0848,
                    longitude: -77.7522,
                }));
            }
            res.statusCode = 404;
            res.end(JSON.stringify({ message: 'not found' }));
        });
        await new Promise((resolve) => routesHomeAssistant.listen(0, '127.0.0.1', resolve));
        routesHomeAssistantUrl = `http://127.0.0.1:${routesHomeAssistant.address().port}`;

        serverProcess = spawn('node', ['index.js'], {
            cwd: serverDir,
            env: {
                ...process.env,
                PORT: String(port),
                DB_PATH: testDbPath,
                TZ: 'UTC',
                HOMEGLOW_DISABLE_BACKGROUND_JOBS: '1',
                HOMEGLOW_DISABLE_CALENDAR_SYNC: '1',
                ENCRYPTION_KEY,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        serverProcess.stdout.on('data', (chunk) => { serverLogs += chunk.toString(); });
        serverProcess.stderr.on('data', (chunk) => { serverLogs += chunk.toString(); });
        await waitForServerReady();
    });

    after(async () => {
        if (serverProcess && !serverProcess.killed) {
            serverProcess.kill('SIGTERM');
            await new Promise((resolve) => {
                serverProcess.once('close', () => resolve());
                setTimeout(resolve, 5000);
            });
        }
        if (routesHomeAssistant) {
            await new Promise((resolve) => routesHomeAssistant.close(resolve));
        }
        if (!keepTestArtifacts) {
            removeFiles(testDbPath);
            removeFiles(process.env.ENCRYPTION_KEY_FILE, ['']);
        }
    });

    test('GET /api/settings redacts every stored secret', async () => {
        // Written straight to the settings table, so the raw token really is in
        // the database — the assertion is that it never comes back out.
        await setSetting('HOME_ASSISTANT_TOKEN_ENC', SECRET_TOKEN);
        await setSetting('WEATHER_API_KEY', 'owm-secret-key-abc123');
        await setSetting('GOOGLE_CLIENT_SECRET_ENC', 'pretend-ciphertext');

        const settings = await api('/api/settings');
        assert.equal(settings.status, 200);

        const serialized = JSON.stringify(settings.body);
        assert.ok(!('HOME_ASSISTANT_TOKEN_ENC' in settings.body), 'HA token key present');
        assert.ok(!('WEATHER_API_KEY' in settings.body), 'OpenWeatherMap key present');
        assert.ok(!('GOOGLE_CLIENT_SECRET_ENC' in settings.body), 'Google client secret present');
        assert.ok(!serialized.includes(SECRET_TOKEN), 'raw HA token leaked');
        assert.ok(!serialized.includes('owm-secret-key-abc123'), 'raw OpenWeatherMap key leaked');

        // Non-secret settings still come through.
        await setSetting('PROXY_WHITELIST', 'example.com');
        const after = await api('/api/settings');
        assert.equal(after.body.PROXY_WHITELIST, 'example.com');
    });

    // A wildcard search is the obvious way around a redaction that only covered
    // the plain GET.
    test('the settings search route redacts secrets too, even when asked for them', async () => {
        const search = await api('/api/settings/search', {
            method: 'POST',
            body: JSON.stringify(['WEATHER_*', 'HOME_ASSISTANT_*', 'GOOGLE_*']),
        });
        assert.equal(search.status, 200);
        assert.ok(!('WEATHER_API_KEY' in search.body), 'search leaked the OpenWeatherMap key');
        assert.ok(!('HOME_ASSISTANT_TOKEN_ENC' in search.body), 'search leaked the HA token');
        assert.ok(!JSON.stringify(search.body).includes(SECRET_TOKEN));
    });

    test('a blank write to a redacted setting leaves the stored value alone', async () => {
        // The Admin Panel edits these blind, so an untouched field submits "" on
        // every save. That must not wipe the key.
        await setSetting('WEATHER_API_KEY', 'owm-secret-key-abc123');

        const blank = await setSetting('WEATHER_API_KEY', '');
        assert.equal(blank.status, 200);
        assert.match(blank.body.message, /left unchanged/);

        // The value cannot be read back through the API by design, so prove it
        // survived by writing a real replacement and getting a different answer.
        const replaced = await setSetting('WEATHER_API_KEY', 'owm-replacement-key');
        assert.equal(replaced.status, 200);
        assert.ok(!/left unchanged/.test(replaced.body.message || ''));
    });

    test('GET /api/sun computes sunrise and sunset with no provider involved', async () => {
        const result = await api('/api/sun?lat=40.7128&lon=-74.0060');
        assert.equal(result.status, 200);
        assert.equal(typeof result.body.sunrise, 'number');
        assert.equal(typeof result.body.sunset, 'number');
        assert.ok(result.body.sunset > result.body.sunrise);

        const bad = await api('/api/sun?lat=notanumber');
        assert.equal(bad.status, 400);
    });

    // TODO removed: the route layer now uses the async, db-less service API, so
    // these run against the real /api/connections/homeassistant and /api/weather
    // routes rather than being covered only in process.
    // These exercise the route layer against a stand-in Home Assistant of their
    // own (the in-process suite's fake is already closed by the time they run).
    // The connection is written through PUT /api/connections/homeassistant so the
    // token lands encrypted — the first test in this describe writes
    // HOME_ASSISTANT_TOKEN_ENC as raw plaintext, which is deliberately not
    // decryptable and would break every fetch.
    const connectFakeHomeAssistant = () => api('/api/connections/homeassistant', {
        method: 'PUT',
        body: JSON.stringify({
            url: routesHomeAssistantUrl,
            token: SECRET_TOKEN,
            weather_entity: 'weather.home',
        }),
    });

    test('geocode falls back to Home Assistant\'s own location when it is the provider', async () => {
        assert.equal((await connectFakeHomeAssistant()).status, 200);
        await setSetting('WEATHER_PROVIDER', 'homeassistant');

        // No query: the household already told Home Assistant where it lives, so
        // auto dark mode should not need an OpenWeatherMap key to find out.
        const result = await api('/api/weather/geocode');
        assert.equal(result.status, 200);
        assert.equal(Math.round(result.body.lat * 100) / 100, 43.08);
        assert.equal(result.body.resolvedName, 'Test Home');

        await setSetting('WEATHER_PROVIDER', 'openweathermap');
    });

    test('status reports the stored provider separately from the effective one', async () => {
        await setSetting('WEATHER_PROVIDER', 'homeassistant');
        const status = await api('/api/connections/weather/status');

        assert.equal(status.body.configured_provider, 'homeassistant');
        assert.ok(
            ['openweathermap', 'homeassistant'].includes(status.body.configured_provider),
            'configured_provider must always be a selectable option',
        );

        await setSetting('WEATHER_PROVIDER', 'openweathermap');
        const back = await api('/api/connections/weather/status');
        assert.equal(back.body.configured_provider, 'openweathermap');
    });

    test('weather provider status explains what is missing', async () => {
        assert.equal((await connectFakeHomeAssistant()).status, 200);
        await setSetting('WEATHER_PROVIDER', 'homeassistant');
        const configured = await api('/api/connections/weather/status');
        assert.equal(configured.body.provider, 'homeassistant');
        assert.equal(configured.body.configured, true);

        await api('/api/connections/homeassistant', { method: 'DELETE' });
        const cleared = await api('/api/connections/weather/status');
        assert.equal(cleared.body.configured, false);
        assert.match(cleared.body.reason, /Home Assistant/);

        await setSetting('WEATHER_PROVIDER', 'openweathermap');
    });
});
