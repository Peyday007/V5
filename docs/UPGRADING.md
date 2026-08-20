# Upgrading, without losing your `data` folder

Your database, your documents, your backups and your runtime state all live
under `data/`. Nothing in this upgrade deletes, moves or rewrites any of it.

## What happens on first start

1. Brain takes a **backup of the database before migrating**, into
   `data/backups/brain-<timestamp>.db`. That happens automatically, before any
   schema change is applied.
2. Migrations 007–012 apply in order, each in its own transaction. A migration
   that fails rolls itself back and the app refuses to boot with the reason
   rather than serving a half-migrated database.
3. Every one of them only **adds** — new tables, and new columns on existing
   tables with defaults. No column is dropped, renamed or reinterpreted, so
   every row you already have keeps its meaning.

## The steps

```
git pull
npm install
npm run dev
```

Then read the boot banner. It prints the schema version, the migrations it
applied, and where the backup went:

```
Schema version  12
Migrations      applied 6 (7 archive_import, 8 evidence_reconciliation,
                9 jobs_and_provider, 10 findings_reconciliation,
                11 provider_models, 12 review_before_execution)
Backup          data/backups/brain-2026-08-20T03-29-51-652Z.db
```

`GET /api/health` says the same thing if you would rather read JSON.

## If something goes wrong

Stop the app and put the backup back:

```
copy data\backups\brain-<timestamp>.db data\brain.db
```

The documents under `data/projects/` are untouched by any of this, so restoring
the database restores the whole state.

## Notes

- **Do not run two copies of Brain against the same `data` folder.** SQLite in
  WAL mode tolerates concurrent readers, not two writers on one file; the second
  one corrupts the first's connection.
- The first start after the upgrade re-derives project state and rewrites
  `data/runtime/project-state.json`. That file is derived, never authoritative —
  if it ever disagrees with the database, it is the stale one.
- Nothing about your existing documents is re-imported or re-extracted. The new
  reconciliation reads them where they already are, on demand.
