// schemaId 18 — DB-backed plugin (custom widget) store.
//
// Knex port of the legacy module server/migrations/schema18-pluginsTable.js.
//
// Widget HTML used to live on the container's ephemeral image layer
// (/app/widgets) and was wiped on every image upgrade; tasks.db is bind-mounted,
// so plugins stored here survive. plugin_id / manifest_json are reserved for
// manifest plugins and stay NULL for plain HTML widgets.

const fsSync = require('node:fs');
const path = require('node:path');

const { createTableIfMissing, setLegacySchemaId } = require('../migrationHelpers');

const SCHEMA_ID = 18;

const PLUGINS_DDL = `
    CREATE TABLE IF NOT EXISTS plugins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plugin_id TEXT UNIQUE,
        filename TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        manifest_json TEXT,
        source TEXT NOT NULL DEFAULT 'upload',
        original_url TEXT,
        installed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
`;

// One-time import of any widgets still on disk (pre-upgrade installs on this
// container, or local dev). Registry entries whose file is gone cannot be
// recovered — the HTML only ever lived on the image layer.
async function importWidgetsFromDisk(knex) {
    const widgetsDir = path.join(__dirname, '..', '..', 'widgets');
    const registryPath = path.join(__dirname, '..', '..', 'widgets_registry.json');

    let registry = [];
    try {
        registry = JSON.parse(fsSync.readFileSync(registryPath, 'utf-8'));
        if (!Array.isArray(registry)) registry = [];
    } catch {
        registry = [];
    }
    const registryByFilename = new Map(registry.map((entry) => [entry.filename, entry]));

    let diskFiles = [];
    try {
        diskFiles = fsSync.readdirSync(widgetsDir).filter((file) => file.endsWith('.html'));
    } catch {
        diskFiles = [];
    }

    let imported = 0;
    for (const filename of diskFiles) {
        try {
            const content = fsSync.readFileSync(path.join(widgetsDir, filename), 'utf-8');
            const entry = registryByFilename.get(filename);
            const row = {
                filename,
                name: entry?.name || filename.replace('.html', ''),
                content,
                source: entry?.source === 'github' ? 'github' : 'upload',
                original_url: entry?.originalUrl || null,
            };
            // Omitted rather than set to NULL so the column default
            // (CURRENT_TIMESTAMP) applies, matching the legacy COALESCE.
            if (entry?.uploadedAt) row.installed_at = entry.uploadedAt;

            const inserted = await knex('plugins').insert(row).onConflict('filename').ignore();
            imported += Array.isArray(inserted) ? inserted.length : Number(inserted || 0);
        } catch (fileError) {
            console.warn(`Could not import widget ${filename}:`, fileError.message);
        }
    }

    const orphaned = registry.filter((entry) => !diskFiles.includes(entry.filename));
    if (orphaned.length > 0) {
        console.warn(
            `${orphaned.length} registry entr(ies) had no HTML file on disk and could not be imported: ` +
            orphaned.map((entry) => entry.filename).join(', ')
        );
    }
    console.log(`Imported ${imported} widget(s) from disk into the plugins table.`);
}

exports.up = async function up(knex) {
    const created = await createTableIfMissing(knex, 'plugins', PLUGINS_DDL);
    // Only import on the run that creates the table. A database that already has
    // `plugins` has either been through this import or is being managed by the
    // running app, and re-reading the disk there could resurrect widgets the
    // operator deleted.
    if (created) {
        await importWidgetsFromDisk(knex);
    }
    await setLegacySchemaId(knex, SCHEMA_ID);
};

exports.down = async function down(knex) {
    await knex.schema.dropTableIfExists('plugins');
    await setLegacySchemaId(knex, SCHEMA_ID - 1);
};
