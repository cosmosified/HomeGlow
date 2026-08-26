# Characterization Tests (Persistence Golden Master)

These tests pin down the **observable behavior of the current SQLite-backed data
layer** so it can be preserved while the data layer is migrated from raw
`better-sqlite3` to **Knex migrations + the Objection.js ORM**.

## The idea

Write the suite once against today's raw-SQL SQLite implementation (the "golden
master"), then **re-run the exact same tests, unchanged, after every task** of the
migration. A task is only "done" when this suite still passes identically.

```
Task 1   capture golden master (raw better-sqlite3)        <- these tests
Task 2   add Knex + Objection, no behavior change           -> rerun, must match
Task 3   v14 baseline migration + baseline adoption         -> rerun, must match
Task 4   knex.migrate.latest() is the startup authority     -> rerun, must match
Task 5-12 domain-by-domain async/Objection conversion       -> rerun after each
Task 13  decommission the legacy data layer                 -> rerun, must match
Task 14  tooling / CI / docs                                -> CI runs this suite
```

## Why most assertions live at the HTTP API boundary

The HTTP API is engine- and ORM-agnostic, so the same assertions verify raw SQLite
now and Knex/Objection (and a future PostgreSQL) later with **zero edits**. The
cases focus on the behaviors most likely to regress during the async conversion:

- **sequence continuity** — ids advance and are never reused,
- **upsert** — `INSERT OR IGNORE/REPLACE` semantics,
- **insert-returning-id** — `lastInsertRowid` (and later `RETURNING`),
- **FK `ON DELETE CASCADE` / `SET NULL`**,
- **deep JSON column round-trip** (`tabs.config_json`, `devices.device_settings_json`),
- **multi-statement transaction atomicity** — tab reorder, tab renumber, and
  device copy-from must commit as a single unit.

## Transaction rollback

The validated public API offers no clean way to force a fault midway through the
reorder/renumber/copy-from transactions, so the **rollback** guarantee
("a transaction that throws persists nothing") is asserted directly against
`better-sqlite3` in `sqlSemantics.characterization.test.js`. When those handlers
are rewritten on `Model.transaction` / `knex.transaction` (Task 11), the same
all-or-nothing contract must hold.

## Running

```bash
cd server
npm test                 # runs all suites, including these
npm run test:coverage    # c8 coverage to find unguarded data paths
```

Each suite boots its own backend against a throwaway SQLite file via
[`../helpers/serverHarness.js`](../helpers/serverHarness.js) and cleans it up
afterward (use `HOMEGLOW_TEST_KEEP_ARTIFACTS=1` to keep the DB for inspection).

## Coverage checklist (Task 1 completion target)

- [x] sequence continuity (auto-increment, no reuse after delete)
- [x] insert returns new id
- [x] upsert (settings)
- [x] FK cascade (chore -> chore_schedules)
- [x] chores full CRUD
- [x] chore-history + derived clam totals (single completion + duplicate rejection)
- [x] calendar-sources create/list (+ invalid-type rejection)
- [x] photo-sources create/list (+ invalid-type rejection)
- [x] admin-pin exists/set/verify/clear
- [x] deep JSON round-trip (device settings + tab layout config)
- [x] transaction atomicity: tab reorder
- [x] transaction atomicity: tab renumber on delete
- [x] transaction atomicity: device copy-from
- [x] transaction ROLLBACK leaves no partial writes (direct better-sqlite3 contract)
