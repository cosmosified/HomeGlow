// schemaId 25 — re-encrypt legacy (AES-256-CBC) credentials onto the current
// AES-256-GCM scheme.
//
// Knex port of the legacy module
// server/migrations/schema25-unifyCredentialEncryption.js. Data-only: no DDL.
//
// The icon/photo/calendar credential columns below are the complete set of
// columns that were ever written with the old CBC scheme — Google and Home
// Assistant secrets were always on the current one.

const {
    encrypt,
    isEncryptionConfigured,
    isLegacyCiphertext,
    decryptLegacy,
} = require('../../utils/encryption');

const { setLegacySchemaId } = require('../migrationHelpers');

const SCHEMA_ID = 25;

const LEGACY_COLUMNS = [
    { table: 'calendar_sources', column: 'password', label: 'calendar source' },
    { table: 'photo_sources', column: 'api_key', label: 'photo source' },
    { table: 'photo_sources', column: 'password', label: 'photo source' },
    { table: 'photo_sources', column: 'refresh_token', label: 'photo source' },
];

// Collect the rows that are actually still legacy-shaped. Anything else is
// already on the current scheme, which is what makes a replay of this migration a
// no-op rather than a double-encrypt. Gathering first also means a fresh install
// (nothing to re-encrypt) never touches the encryption key at all.
async function findLegacyRows(knex) {
    const candidates = [];
    for (const { table, column, label } of LEGACY_COLUMNS) {
        // Tables are created by the baseline, but guard anyway so an unusual
        // install order cannot break the migration.
        if (!(await knex.schema.hasTable(table))) continue;
        if (!(await knex.schema.hasColumn(table, column))) continue;

        const rows = await knex(table)
            .select('id', 'name', { value: column })
            .whereNotNull(column)
            .andWhereNot(column, '');

        for (const row of rows) {
            if (!isLegacyCiphertext(row.value)) continue;
            candidates.push({ table, column, label, id: row.id, name: row.name, value: row.value });
        }
    }
    return candidates;
}

exports.up = async function up(knex) {
    const candidates = await findLegacyRows(knex);

    if (candidates.length === 0) {
        await setLegacySchemaId(knex, SCHEMA_ID);
        return;
    }

    // Re-encrypting needs a working key. The realistic way that fails is an
    // operator supplying a malformed ENCRYPTION_KEY. Skip rather than fail: the
    // legacy read path in utils/encryption keeps every stored credential usable,
    // and the operator can retry after fixing the key by rolling this migration
    // back (`npm run migrate:rollback`) or deleting its knex_migrations row.
    if (!isEncryptionConfigured()) {
        console.warn('Encryption key is not usable; leaving credentials in the legacy format.');
        console.warn('They remain readable. Fix ENCRYPTION_KEY (or remove it to auto-generate), then roll');
        console.warn(`back and re-run this migration (schema ${SCHEMA_ID}) to convert them.`);
        await setLegacySchemaId(knex, SCHEMA_ID);
        return;
    }

    let migrated = 0;
    let skipped = 0;

    for (const candidate of candidates) {
        const { table, column, label, id, name, value } = candidate;
        try {
            const plain = decryptLegacy(value);
            await knex(table).where({ id }).update({ [column]: encrypt(plain) });
            migrated++;
        } catch (rowError) {
            // That value was already unrecoverable — the key it was written with
            // is gone. Losing the rest of the migration to it would be worse, so
            // name it for the operator and move on; they re-enter that one
            // credential in the Admin Panel.
            skipped++;
            console.warn(
                `Could not re-encrypt ${column} for ${label} "${name}" (id ${id}): ${rowError.message}`
            );
            console.warn('Re-enter that credential in the Admin Panel.');
        }
    }

    console.log(`Re-encrypted ${migrated} stored credential(s)${skipped ? `, skipped ${skipped}` : ''}.`);

    await setLegacySchemaId(knex, SCHEMA_ID);
};

exports.down = async function down(knex) {
    // Deliberately does not re-encrypt back to AES-256-CBC. The legacy scheme is
    // the weaker one and its read path in utils/encryption is permanent, so the
    // only thing a downgrade would accomplish is re-introducing ciphertext
    // written under a hardcoded fallback key. Rolling back only un-records the
    // migration so it can be re-run.
    await setLegacySchemaId(knex, SCHEMA_ID - 1);
};
