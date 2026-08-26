// Home Assistant connection (issue #57).
//
// Deliberately mirrors googleConnection.js: the credential is encrypted at rest
// in the settings KV table, the status helper returns booleans and previews but
// never the secret itself, and a fetch factory injects the bearer token
// server-side so it never reaches a browser.
//
// The token matters more than most. A Home Assistant long-lived access token
// grants full control of the home — lights, locks, alarm, cameras — so unlike
// the OpenWeatherMap key it must never be handed to the client. That is the
// reason weather moved server-side at all; see docs/reference/configuration.md.

const { encrypt, decrypt, isEncryptionConfigured } = require('../utils/encryption');
const { fetchTlsOptions, isCertificateVerificationSkipped } = require('../utils/outboundTls');
const { Setting } = require('../db/models');

const URL_KEY = 'HOME_ASSISTANT_URL';
const TOKEN_KEY = 'HOME_ASSISTANT_TOKEN_ENC';
const WEATHER_ENTITY_KEY = 'HOME_ASSISTANT_WEATHER_ENTITY';

const DEFAULT_WEATHER_ENTITY = 'weather.home';
const REQUEST_TIMEOUT_MS = 10000;

async function getSetting(key) {
    const row = await Setting.query().findById(key);
    return row ? row.value : null;
}

async function setSetting(key, value) {
    await Setting.query().insert({ key, value }).onConflict('key').merge();
}

// Accepts "http://homeassistant.local:8123" or a bare "homeassistant.local:8123",
// and returns a base with no trailing slash.
//
// A wrong scheme has to be rejected before the bare-host convenience kicks in.
// Prepending "http://" unconditionally turns "ftp://nope" into
// "http://ftp://nope", which URL parses quite happily as host "ftp" — so the
// scheme check would never fire and the operator would get a confusing
// unreachable-host error later instead of a clear one at save time.
const EXPLICIT_SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;

function normalizeBaseUrl(rawUrl) {
    const trimmed = String(rawUrl || '').trim().replace(/\/+$/, '');
    if (!trimmed) return '';

    const schemeMatch = trimmed.match(EXPLICIT_SCHEME);
    if (schemeMatch) {
        const scheme = schemeMatch[1].toLowerCase();
        if (scheme !== 'http' && scheme !== 'https') {
            throw new Error('Home Assistant URL must use http or https.');
        }
    }

    const withScheme = schemeMatch ? trimmed : `http://${trimmed}`;
    let parsed;
    try {
        parsed = new URL(withScheme);
    } catch (_) {
        throw new Error('Home Assistant URL is not a valid URL.');
    }
    if (!parsed.host) {
        throw new Error('Home Assistant URL is not a valid URL.');
    }
    return `${parsed.protocol}//${parsed.host}`;
}

async function getConfig() {
    return {
        baseUrl: (await getSetting(URL_KEY)) || '',
        tokenEnc: (await getSetting(TOKEN_KEY)) || '',
        weatherEntity: (await getSetting(WEATHER_ENTITY_KEY)) || DEFAULT_WEATHER_ENTITY,
    };
}

async function getHomeAssistantStatus() {
    const { baseUrl, tokenEnc, weatherEntity } = await getConfig();
    return {
        has_url: !!baseUrl,
        has_token: !!tokenEnc,
        url: baseUrl,
        weather_entity: weatherEntity,
        encryption_configured: isEncryptionConfigured(),
    };
}

// An empty/undefined token leaves the stored one alone, so the Admin Panel can
// save a URL change without the user re-entering the token. Passing null
// explicitly clears it.
async function saveConfig({ url, token, weatherEntity }) {
    if (url !== undefined) {
        await setSetting(URL_KEY, normalizeBaseUrl(url));
    }
    if (token === null) {
        await setSetting(TOKEN_KEY, '');
    } else if (token !== undefined && String(token).trim() !== '') {
        await setSetting(TOKEN_KEY, encrypt(String(token).trim()));
    }
    if (weatherEntity !== undefined) {
        const normalized = String(weatherEntity || '').trim();
        await setSetting(WEATHER_ENTITY_KEY, normalized || DEFAULT_WEATHER_ENTITY);
    }
}

async function clearConfig() {
    await setSetting(URL_KEY, '');
    await setSetting(TOKEN_KEY, '');
    await setSetting(WEATHER_ENTITY_KEY, '');
}

async function isConfigured() {
    const { baseUrl, tokenEnc } = await getConfig();
    return !!baseUrl && !!tokenEnc;
}

// Calls through module.exports so tests can stub the transport.
async function homeAssistantFetch(method, apiPath, body) {
    const { baseUrl, tokenEnc } = await getConfig();
    if (!baseUrl) throw new Error('Home Assistant URL is not configured.');
    if (!tokenEnc) throw new Error('Home Assistant token is not configured.');

    const token = decrypt(tokenEnc);
    const url = `${baseUrl}${apiPath.startsWith('/') ? apiPath : `/${apiPath}`}`;

    const init = {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
        },
        // Home Assistant is almost always on the household's own network, often
        // behind a self-signed certificate. Accept one for a private address,
        // never for a public one (issue #139).
        ...fetchTlsOptions(url),
    };
    if (body !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
    }

    // HA usually lives on the LAN, so a hung socket should fail fast rather than
    // holding a weather request open until the client gives up.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    init.signal = controller.signal;

    let res;
    try {
        res = await fetch(url, init);
    } catch (err) {
        if (err.name === 'AbortError') {
            const timeoutError = new Error('Home Assistant did not respond in time.');
            timeoutError.status = 504;
            throw timeoutError;
        }
        const unreachable = new Error(`Could not reach Home Assistant at ${baseUrl}.`);
        unreachable.status = 503;
        unreachable.cause = err;
        throw unreachable;
    } finally {
        clearTimeout(timer);
    }

    if (res.status === 204) return null;

    const text = await res.text();
    let parsed = null;
    if (text) {
        try { parsed = JSON.parse(text); } catch (_) { parsed = { raw: text }; }
    }

    if (!res.ok) {
        // 401 is by far the most common real-world failure (expired or mistyped
        // long-lived token), so name it rather than surfacing a bare status.
        const message = res.status === 401
            ? 'Home Assistant rejected the access token.'
            : (parsed && parsed.message) || `Home Assistant error ${res.status}`;
        const err = new Error(message);
        err.status = res.status;
        err.details = parsed;
        throw err;
    }

    return parsed === null ? {} : parsed;
}

async function testConnection() {
    const { baseUrl, tokenEnc } = await getConfig();
    if (!baseUrl) return { ok: false, message: 'No Home Assistant URL is configured.' };
    if (!tokenEnc) return { ok: false, message: 'No Home Assistant token is configured.' };

    try {
        // GET /api/ is the documented health check; /api/config gives us the
        // version, which is worth showing so the operator can confirm they
        // reached the instance they meant to.
        await module.exports.homeAssistantFetch('GET', '/api/');
        let version = null;
        let locationName = null;
        try {
            const config = await module.exports.homeAssistantFetch('GET', '/api/config');
            version = config?.version || null;
            locationName = config?.location_name || null;
        } catch (_) {
            // Health check already passed; config is a nicety.
        }
        return {
            ok: true,
            message: locationName ? `Connected to ${locationName}.` : 'Connected to Home Assistant.',
            version,
            // Surfaced so the Admin Panel can say so rather than silently
            // trusting whatever certificate the LAN handed us.
            selfSignedAccepted: isCertificateVerificationSkipped(`${baseUrl}/api/`),
        };
    } catch (error) {
        return { ok: false, message: error.message || 'Connection failed.' };
    }
}

async function getState(entityId) {
    return await module.exports.homeAssistantFetch('GET', `/api/states/${encodeURIComponent(entityId)}`);
}

// Powers the Admin Panel's entity picker so the operator doesn't have to know
// their entity id by heart.
async function listWeatherEntities() {
    const states = await module.exports.homeAssistantFetch('GET', '/api/states');
    if (!Array.isArray(states)) return [];
    return states
        .filter((entry) => typeof entry?.entity_id === 'string' && entry.entity_id.startsWith('weather.'))
        .map((entry) => ({
            entity_id: entry.entity_id,
            name: entry.attributes?.friendly_name || entry.entity_id,
        }));
}

module.exports = {
    URL_KEY,
    TOKEN_KEY,
    WEATHER_ENTITY_KEY,
    DEFAULT_WEATHER_ENTITY,
    normalizeBaseUrl,
    getConfig,
    getHomeAssistantStatus,
    saveConfig,
    clearConfig,
    isConfigured,
    homeAssistantFetch,
    testConnection,
    getState,
    listWeatherEntities,
};
