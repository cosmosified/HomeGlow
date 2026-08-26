// Knex CLI configuration. The `knex` binary (via the npm `migrate*` scripts)
// reads this file. It mirrors the runtime configuration built in db/knex.js so the
// CLI and the app agree on client, connection, and migrations directory.
//
// Engine is selected by DB_ENGINE (default 'sqlite'); DB_PATH overrides the SQLite
// file, DATABASE_URL is used for postgres. See db/knex.js for details.
const { knexConfig } = require('./db/knex');

module.exports = knexConfig();
