const crypto = require('crypto');
const { encrypt, decrypt, isEncryptionConfigured } = require('../utils/encryption');
const { Setting, GoogleAccount, GoogleOauthState } = require('../db/models');

const GOOGLE_SCOPES = [
    'openid',
    'email',
    'profile',
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata',
    'https://www.googleapis.com/auth/photospicker.mediaitems.readonly',
];

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

const CLIENT_ID_KEY = 'GOOGLE_CLIENT_ID';
const CLIENT_SECRET_KEY = 'GOOGLE_CLIENT_SECRET_ENC';
const REDIRECT_URI_OVERRIDE_KEY = 'GOOGLE_REDIRECT_URI_OVERRIDE';

async function getSetting(key) {
    const row = await Setting.query().findById(key);
    return row ? row.value : null;
}

async function setSetting(key, value) {
    await Setting.query().insert({ key, value }).onConflict('key').merge();
}

async function getOAuthConfig() {
    const clientId = (await getSetting(CLIENT_ID_KEY)) || '';
    const clientSecretEnc = (await getSetting(CLIENT_SECRET_KEY)) || '';
    const redirectUriOverride = (await getSetting(REDIRECT_URI_OVERRIDE_KEY)) || '';
    return { clientId, clientSecretEnc, redirectUriOverride };
}

async function getOAuthStatus() {
    const { clientId, clientSecretEnc, redirectUriOverride } = await getOAuthConfig();
    return {
        has_client_id: !!clientId,
        has_client_secret: !!clientSecretEnc,
        client_id_preview: clientId ? clientId.slice(0, 16) + (clientId.length > 16 ? '...' : '') : '',
        redirect_uri_override: redirectUriOverride,
        encryption_configured: isEncryptionConfigured(),
    };
}

async function saveOAuthConfig({ clientId, clientSecret, redirectUriOverride }) {
    if (clientId !== undefined) {
        await setSetting(CLIENT_ID_KEY, (clientId || '').trim());
    }
    if (clientSecret !== undefined && clientSecret !== null && clientSecret !== '') {
        await setSetting(CLIENT_SECRET_KEY, encrypt(clientSecret.trim()));
    }
    if (redirectUriOverride !== undefined) {
        await setSetting(REDIRECT_URI_OVERRIDE_KEY, (redirectUriOverride || '').trim());
    }
}

async function clearOAuthSecret() {
    await setSetting(CLIENT_SECRET_KEY, '');
}

async function deriveRedirectUri(request) {
    const override = await getSetting(REDIRECT_URI_OVERRIDE_KEY);
    if (override && override.trim()) return override.trim();

    const forwardedProto = request.headers['x-forwarded-proto'];
    const forwardedHost = request.headers['x-forwarded-host'];
    const host = forwardedHost || request.headers.host;
    const proto = forwardedProto || request.protocol || 'http';
    if (!host) throw new Error('Could not determine redirect URI from request.');
    return `${proto}://${host}/api/connections/google/callback`;
}

async function pruneOldStates() {
    const knex = Setting.knex();
    await knex('google_oauth_states')
        .whereRaw("datetime(created_at) < datetime('now', '-15 minutes')")
        .del();
}

async function createAuthState(redirectUri, returnUrl) {
    await pruneOldStates();
    const state = crypto.randomBytes(24).toString('base64url');
    await GoogleOauthState.query().insert({
        state,
        redirect_uri: redirectUri,
        return_url: returnUrl || null,
    });
    return state;
}

async function consumeAuthState(state) {
    await pruneOldStates();
    const row = await GoogleOauthState.query().findById(state);
    if (row) {
        await GoogleOauthState.query().deleteById(state);
    }
    return row;
}

async function buildAuthUrl({ redirectUri, state, loginHint }) {
    const { clientId } = await getOAuthConfig();
    if (!clientId) throw new Error('Google Client ID is not configured.');

    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: GOOGLE_SCOPES.join(' '),
        access_type: 'offline',
        include_granted_scopes: 'true',
        prompt: 'consent',
        state,
    });
    if (loginHint) params.set('login_hint', loginHint);
    return `${AUTH_ENDPOINT}?${params.toString()}`;
}

async function exchangeCodeForTokens({ code, redirectUri }) {
    const { clientId, clientSecretEnc } = await getOAuthConfig();
    if (!clientId || !clientSecretEnc) {
        throw new Error('Google OAuth credentials are not configured.');
    }
    const clientSecret = decrypt(clientSecretEnc);

    const body = new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
    });

    const res = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Token exchange failed: ${res.status} ${errText}`);
    }
    return await res.json();
}

async function fetchUserInfo(accessToken) {
    const res = await fetch(USERINFO_ENDPOINT, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Failed to fetch userinfo: ${res.status} ${errText}`);
    }
    return await res.json();
}

async function upsertGoogleAccount({ sub, email, name, picture, tokens }) {
    const knex = GoogleAccount.knex();
    const existing = await GoogleAccount.query()
        .select('id', 'refresh_token_enc')
        .where('google_sub', sub)
        .first();
    const expiresInSec = tokens.expires_in || 3600;
    const expiry = new Date(Date.now() + expiresInSec * 1000).toISOString();

    const accessEnc = encrypt(tokens.access_token);
    const refreshEnc = tokens.refresh_token ? encrypt(tokens.refresh_token) : (existing ? existing.refresh_token_enc : null);
    const scopes = tokens.scope || GOOGLE_SCOPES.join(' ');

    if (existing) {
        await GoogleAccount.query().findById(existing.id).patch({
            email,
            name,
            picture,
            access_token_enc: accessEnc,
            refresh_token_enc: refreshEnc,
            token_expiry: expiry,
            scopes,
            updated_at: knex.fn.now(),
        });
        return existing.id;
    } else {
        const inserted = await GoogleAccount.query().insert({
            google_sub: sub,
            email,
            name,
            picture,
            access_token_enc: accessEnc,
            refresh_token_enc: refreshEnc,
            token_expiry: expiry,
            scopes,
        });
        return inserted.id;
    }
}

async function getConnectedAccount() {
    const row = await GoogleAccount.query()
        .select('id', 'email', 'name', 'picture', 'token_expiry', 'scopes', 'created_at', 'updated_at')
        .orderBy('id', 'asc')
        .first();
    return row || null;
}

async function refreshAccessToken(accountId) {
    const knex = GoogleAccount.knex();
    const row = await GoogleAccount.query().select('refresh_token_enc').findById(accountId);
    if (!row || !row.refresh_token_enc) {
        throw new Error('No refresh token available for this Google account.');
    }
    const refreshToken = decrypt(row.refresh_token_enc);
    const { clientId, clientSecretEnc } = await getOAuthConfig();
    const clientSecret = decrypt(clientSecretEnc);

    const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
    });

    const res = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
    });
    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Token refresh failed: ${res.status} ${errText}`);
    }
    const tokens = await res.json();
    const expiresInSec = tokens.expires_in || 3600;
    const expiry = new Date(Date.now() + expiresInSec * 1000).toISOString();
    const accessEnc = encrypt(tokens.access_token);
    await GoogleAccount.query().findById(accountId).patch({
        access_token_enc: accessEnc,
        token_expiry: expiry,
        updated_at: knex.fn.now(),
    });
    return tokens.access_token;
}

async function getValidAccessToken(accountId) {
    const row = await GoogleAccount.query()
        .select('access_token_enc', 'token_expiry')
        .findById(accountId);
    if (!row) throw new Error('Google account not found.');
    const expiry = row.token_expiry ? new Date(row.token_expiry).getTime() : 0;
    if (Date.now() < expiry - 60 * 1000 && row.access_token_enc) {
        return decrypt(row.access_token_enc);
    }
    return await refreshAccessToken(accountId);
}

async function revokeAndDisconnect(accountId) {
    const row = await GoogleAccount.query()
        .select('access_token_enc', 'refresh_token_enc')
        .findById(accountId);
    if (!row) return;
    const tokens = [];
    if (row.refresh_token_enc) {
        try { tokens.push(decrypt(row.refresh_token_enc)); } catch (_) {}
    }
    if (row.access_token_enc) {
        try { tokens.push(decrypt(row.access_token_enc)); } catch (_) {}
    }
    for (const token of tokens) {
        try {
            await fetch(`${REVOKE_ENDPOINT}?token=${encodeURIComponent(token)}`, { method: 'POST' });
        } catch (err) {
            console.warn('Failed to revoke Google token:', err.message);
        }
    }
    await GoogleAccount.query().deleteById(accountId);
}

function createGoogleFetch(apiBase, serviceLabel) {
    return async function googleFetch(accountId, method, pathAndQuery, body) {
        // Call through module.exports so tests can stub getValidAccessToken.
        const accessToken = await module.exports.getValidAccessToken(accountId);
        const url = pathAndQuery.startsWith('http') ? pathAndQuery : `${apiBase}${pathAndQuery}`;
        const init = {
            method,
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: 'application/json',
            },
        };
        if (body !== undefined) {
            init.headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(body);
        }
        const res = await fetch(url, init);
        if (res.status === 204) return null;
        const text = await res.text();
        let parsed = null;
        if (text) {
            try { parsed = JSON.parse(text); } catch (_) { parsed = { raw: text }; }
        }
        if (!res.ok) {
            const msg = parsed && parsed.error && parsed.error.message ? parsed.error.message : `${serviceLabel} error ${res.status}`;
            const err = new Error(msg);
            err.status = res.status;
            err.details = parsed;
            throw err;
        }
        return parsed || {};
    };
}

module.exports = {
    GOOGLE_SCOPES,
    getOAuthStatus,
    saveOAuthConfig,
    clearOAuthSecret,
    deriveRedirectUri,
    createAuthState,
    consumeAuthState,
    buildAuthUrl,
    exchangeCodeForTokens,
    fetchUserInfo,
    upsertGoogleAccount,
    getConnectedAccount,
    refreshAccessToken,
    getValidAccessToken,
    revokeAndDisconnect,
    createGoogleFetch,
};
