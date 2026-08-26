// schemaId 22 — repeatable prizes + split cost.
//
// Knex port of the legacy module server/migrations/schema22-prizeRepeatSplit.js.
//
//   prizes.repeatable            definition-level toggle. Approving an offer of a
//                                repeatable prize returns it to the shelf instead
//                                of consuming it. Default 0 keeps the one-time
//                                behavior.
//   prize_offers.split_user_ids  JSON array of co-spender user ids (the requester
//                                is always a participant and is NOT in this list).
//                                At approval each participant pays
//                                floor(cost / participants); the remainder of an
//                                uneven split is silently discounted.

const { addColumnIfMissing, dropColumnIfPresent, setLegacySchemaId } = require('../migrationHelpers');

const SCHEMA_ID = 22;

exports.up = async function up(knex) {
    await addColumnIfMissing(knex, 'prizes', 'repeatable', 'INTEGER NOT NULL DEFAULT 0');
    await addColumnIfMissing(knex, 'prize_offers', 'split_user_ids', 'TEXT');
    await setLegacySchemaId(knex, SCHEMA_ID);
};

exports.down = async function down(knex) {
    await dropColumnIfPresent(knex, 'prize_offers', 'split_user_ids');
    await dropColumnIfPresent(knex, 'prizes', 'repeatable');
    await setLegacySchemaId(knex, SCHEMA_ID - 1);
};
