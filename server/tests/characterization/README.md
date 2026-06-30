# Characterization Tests (Persistence Golden Master)

These tests pin down the **observable behavior of the current SQLite-backed data
layer** so it can be preserved while the persistence abstraction and PostgreSQL
support are built. See [`docs/db-abstraction-and-postgres-plan.md`](../../../docs/db-abstraction-and-postgres-plan.md).

## The idea

Write the suite once against today's SQLite (the "golden master"), then **re-run the
exact same tests, unchanged, after every phase** and against every engine. A phase
is only "done" when this suite still passes identically.

```
Phase 1  capture golden master (SQLite)        ← these tests
Phase 2  port + SQLite adapter                  → rerun, must match
Phase 3  make all DB calls async                → rerun, must match
Phase 4  repository layer + dialect helper      → rerun, must match
Phase 5  Postgres adapter + baseline schema     → rerun against Postgres, must match
Phase 6  CI matrix (sqlite + postgres)          → this suite is the parity gate
Phase 7  data migration                         → rerun against migrated Postgres
```

## Why the assertions live at the HTTP API boundary

The HTTP API is engine-agnostic, so the same assertions verify SQLite now and
Postgres later with **zero edits**. The cases focus on the SQL behaviors that differ
between dialects and are most likely to regress during the refactor:

- **sequence continuity** — ids advance and are never reused (catches a missed
  Postgres `setval()`),
- **upsert** — `INSERT OR IGNORE/REPLACE` ↔ `ON CONFLICT`,
- **insert-returning-id** — `lastInsertRowid` ↔ `RETURNING`,
- **FK `ON DELETE CASCADE` / `SET NULL`**,
- **JSON column round-trip**.

## What is intentionally stubbed (`todo`)

Some behavior can't be observed purely through the API (e.g. transaction **rollback**
leaving no partial writes, or the presence of an FK index). Those are marked `todo`
and will target the persistence **port** once it exists (Phase 2+), so they too can
run on both engines. Full-CRUD response snapshots are also stubbed as `todo` to make
the remaining coverage explicit.

## Running

```bash
cd server
npm test                 # runs all suites, including these
npm run test:coverage    # c8 coverage to find unguarded SQL paths
```

Each test file boots its own backend against a throwaway SQLite file via
[`../helpers/serverHarness.js`](../helpers/serverHarness.js) and cleans it up
afterward (use `HOMEGLOW_TEST_KEEP_ARTIFACTS=1` to keep the DB for inspection).

## Coverage checklist (Phase 1 completion target)

- [x] sequence continuity (auto-increment)
- [x] insert returns new id
- [x] upsert (settings)
- [x] FK cascade (chore → chore_schedules)
- [~] JSON round-trip (smoke; deep equality is `todo`)
- [ ] golden snapshots: chores, chore-history/clams, prizes, devices/tabs,
      widget-assignments, calendar-sources, photo-sources, admin-pin
- [ ] transaction rollback (tab reorder/renumber, device copy-from) — via port
- [ ] FK index presence on `chore_history.chore_schedule_id` (schema 15) — via introspection
- [ ] sequence `setval` correctness after SQLite→Postgres copy (Phase 7)
