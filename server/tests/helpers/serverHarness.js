// Reusable test harness that boots the HomeGlow backend against a throwaway
// SQLite database and exposes a small `api()` fetch helper.
//
// This is intentionally engine-agnostic: it only talks to the HTTP API, so the
// same characterization tests can run unchanged once a PostgreSQL adapter exists
// (Phase 5 of docs/db-abstraction-and-postgres-plan.md) by pointing the server at
// a different DB_ENGINE/DATABASE_URL.
//
// NOTE: this file is NOT named *.test.js, so `node --test` will not execute it as
// a test suite — it is a helper imported by the characterization tests.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const serverDir = path.resolve(__dirname, '..', '..');
const tmpDir = path.resolve(__dirname, '..', '.tmp');

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Build a fetch wrapper bound to a base URL that JSON-encodes request bodies and
// best-effort JSON-decodes responses.
function makeApi(baseUrl) {
    return async function api(pathname, options = {}) {
        const headers = { ...(options.headers || {}) };
        if (
            options.body !== undefined &&
            !headers['Content-Type'] &&
            !headers['content-type']
        ) {
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
        return { status: response.status, body, headers: response.headers };
    };
}

// Spawn `node index.js` with a temp DB and test-friendly env, wait until the API
// answers, and return handles for interacting with and stopping it.
async function startServer(options = {}) {
    fs.mkdirSync(tmpDir, { recursive: true });

    const port = options.port ?? 5600 + Math.floor(Math.random() * 300);
    const baseUrl = `http://127.0.0.1:${port}`;
    const dbPath =
        options.dbPath ?? path.join(tmpDir, `characterization-${process.pid}-${Date.now()}.db`);

    let logs = '';
    const child = spawn('node', ['index.js'], {
        cwd: serverDir,
        env: {
            ...process.env,
            PORT: String(port),
            DB_PATH: dbPath,
            TZ: 'UTC',
            // Keep the test deterministic: no cron, no outbound calendar sync.
            HOMEGLOW_DISABLE_BACKGROUND_JOBS: '1',
            HOMEGLOW_DISABLE_CALENDAR_SYNC: '1',
            // Deterministic 32-byte key so encrypted-secret endpoints work.
            ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
            ...options.env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (chunk) => {
        logs += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
        logs += chunk.toString();
    });

    const api = makeApi(baseUrl);

    const timeoutMs = options.timeoutMs ?? 30000;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (child.exitCode !== null) {
            throw new Error(`Server exited early (code ${child.exitCode}). Logs:\n${logs}`);
        }
        try {
            const response = await fetch(`${baseUrl}/api/test`);
            if (response.ok) {
                return {
                    baseUrl,
                    api,
                    dbPath,
                    getLogs: () => logs,
                    async stop() {
                        if (child.exitCode === null && !child.killed) {
                            child.kill('SIGTERM');
                        }
                        await delay(200);
                        if (!options.keepArtifacts && process.env.HOMEGLOW_TEST_KEEP_ARTIFACTS !== '1') {
                            for (const suffix of ['', '-wal', '-shm']) {
                                try {
                                    fs.rmSync(`${dbPath}${suffix}`, { force: true });
                                } catch {
                                    // best-effort cleanup
                                }
                            }
                        }
                    },
                };
            }
        } catch {
            // Server is still starting.
        }
        await delay(250);
    }

    child.kill('SIGTERM');
    throw new Error(`Server did not become ready within ${timeoutMs}ms. Logs:\n${logs}`);
}

module.exports = { startServer, makeApi, tmpDir };
