// schemaId 21 — prize store instances.
//
// Knex port of the legacy module server/migrations/schema21-prizeOffers.js.
//
// Mirrors the chores model: `prizes` is the definitions ledger (kept forever in
// Prize Management); a prize_offers row is one redeemable instance a parent has
// placed in the store. Lifecycle:
//   available -> requested (kid asks) -> redeemed (parent approves; clams
//   deducted, one-time: gone from the store)
// Decline/cancel returns requested -> available. Cost is read live from the prize
// definition at approval; the ledger row snapshots the prize name.

const { createTableIfMissing, setLegacySchemaId } = require('../migrationHelpers');

const SCHEMA_ID = 21;

const PRIZE_OFFERS_DDL = `
    CREATE TABLE IF NOT EXISTS prize_offers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prize_id INTEGER NOT NULL REFERENCES prizes(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'available',
        requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        requested_at TEXT,
        redeemed_at TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
`;

exports.up = async function up(knex) {
    await createTableIfMissing(knex, 'prize_offers', PRIZE_OFFERS_DDL);
    await knex.raw('CREATE INDEX IF NOT EXISTS idx_prize_offers_status ON prize_offers(status)');
    await setLegacySchemaId(knex, SCHEMA_ID);
};

exports.down = async function down(knex) {
    await knex.raw('DROP INDEX IF EXISTS idx_prize_offers_status');
    await knex.schema.dropTableIfExists('prize_offers');
    await setLegacySchemaId(knex, SCHEMA_ID - 1);
};
