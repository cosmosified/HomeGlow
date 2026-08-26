// Grep-guard: enforces that the runtime data layer goes through Objection/Knex.
//
// Raw better-sqlite3 access (db.prepare/db.exec/db.transaction/new Database) is
// permitted ONLY inside the delimited "LEGACY SCHEMA UPGRADE" block in index.js
// (retained under Option A to lift pre-v14 SQLite databases to the v14 baseline
// before Knex adopts them). Everywhere else — route handlers, helpers, services —
// must use Objection models or the bound Knex instance.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const serverDir = path.resolve(__dirname, '..', '..');

const BEGIN = '=== BEGIN LEGACY SCHEMA UPGRADE';
const END = '=== END LEGACY SCHEMA UPGRADE ===';

test('index.js: no raw better-sqlite3 usage outside the delimited legacy upgrade block', () => {
    const src = fs.readFileSync(path.join(serverDir, 'index.js'), 'utf8');

    const beginIdx = src.indexOf(BEGIN);
    const endIdx = src.indexOf(END);
    assert.ok(beginIdx !== -1, 'legacy upgrade BEGIN marker must be present');
    assert.ok(endIdx !== -1 && endIdx > beginIdx, 'legacy upgrade END marker must be present after BEGIN');

    // Everything outside the delimited legacy block.
    const outside = src.slice(0, beginIdx) + src.slice(endIdx);

    const forbidden = [
        { re: /\.prepare\(/, name: 'db.prepare(' },
        { re: /\bnew Database\(/, name: 'new Database(' },
        { re: /\bdb\.exec\(/, name: 'db.exec(' },
        { re: /\bdb\.transaction\(/, name: 'db.transaction(' },
        { re: /\bdb\.pragma\(/, name: 'db.pragma(' },
    ];
    for (const { re, name } of forbidden) {
        assert.equal(re.test(outside), false, `raw DB op "${name}" must not appear outside the legacy upgrade block`);
    }
});

test('service files use no raw better-sqlite3', () => {
    const servicesDir = path.join(serverDir, 'services');
    for (const file of fs.readdirSync(servicesDir).filter((f) => f.endsWith('.js'))) {
        const src = fs.readFileSync(path.join(servicesDir, file), 'utf8');
        assert.equal(/\.prepare\(/.test(src), false, `${file} must not use raw db.prepare(`);
        assert.equal(/\bnew Database\(/.test(src), false, `${file} must not construct a raw better-sqlite3 Database`);
    }
});
