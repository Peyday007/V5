# The database bottleneck, 2026-10-16

What was measured, what Brain changed, and what the readings say about the
Supabase host. Every figure below is from a production connection report
(`npm run report:connections`, run through the `Connection report` workflow)
or a pull request's own tests. Nothing here is estimated.

## Readings

| reading | when (UTC) | serving | what it is |
|---|---|---|---|
| R1 | 05:47:57 | `1c61b18` | one process, 21:30 → 05:47 (8 h) |
| R2 | 06:04:23 | `1c61b18` | same process, 16.4 min after R1 |
| R3 | 07:43:15 | `56b3417` | first process after release of #210/#211, in a stall |

### Brain's own load in a healthy window (R1 → R2, 985 s)

`pg_stat_statements` and `pg_stat_wal` are cumulative, so the difference is a rate:

| quantity | in 16.4 min | per hour |
|---|---|---|
| WAL written | 14 MB | ~50 MB |
| blocks read from disk | 29 140 (228 MB) | ~0.8 GB |
| temp files written | 168 MB | ~0.6 GB |
| transactions committed | 66 539 | ~240 k (≈ 68/s, includes Supabase's own) |
| top server-time statement | `storage.search` 927 calls, 70 s | — |

Supabase's published baseline for a Micro instance (which this is:
`max_connections=60`, `shared_buffers≈280 MB`) is 11 MB/s and 500 IOPS. Brain's
healthy-window demand is a small fraction of that, and server time across all
statements in the window was well under one core.

### The stall (R3, ~07:20 → 07:53)

- Single-row writes with **no pool wait** took minutes: `INSERT INTO bin_events`
  101 s, `SELECT COUNT(*) FROM system_components` (736 rows) 34 s,
  `SELECT * FROM factory_campaigns …` 120 s (the statement timeout).
- No lock waits between sessions. Brain's event loop p99 21 ms.
- Supabase's own exporter (`SELECT sum(calls) … FROM pg_stat_statements`) was
  31 s active, and the metrics endpoint did not answer within 15 s.
- It began during the release's hosted verification, as on 10-13, 10-14 and
  10-15: a burst of work against a host that then stops executing.

This is the same signature as 2026-10-13 (`LWLock:WALWrite`, `IO:DataFileRead`,
Storage `544 DatabaseTimeout`): the host, not Brain's pool, is where the time
goes once a burst starts.

## Brain-side waste found and removed

| # | waste | measured | change | PR |
|---|---|---|---|---|
| 1 | `latestSnapshots` read a project's whole rank history (89 636 rows, ~32 MB) to keep one row per path | R1: 284 calls in 8 h, mean 5.8 s, max 37.8 s | newest row per path only (`NOT EXISTS`, served by `idx_monetization_snapshots_path`) | #210 |
| 2 | `applyValidationAnswers` read the card once per claim per field, the fragment once per claim, and re-ran the citable-claims join once per claim | R1: 219 825 single-field card reads, 82 503 fragment reads in 8 h | card once per opportunity (re-read after each write), fragment once per pass, ruled-out from the claims already loaded; `applyProposal` reads the card once | #210 |
| 3 | every document existence check was its own `storage.search` on Brain's Postgres | R1→R2: largest server-time consumer (927 calls, 70 s in 16 min); 389 283 since 10-05 | one listing per folder for a recompute's prefetch; same answer, never a cache; a store that does not answer leaves the folder UNKNOWN | #211 |
| 4 | the connection report's own `pg_stat_statements` reads spilled ~100 MB of temp files each | R3: the four largest temp writers in the database were the report's queries | numbers read without texts; texts fetched once, for the rows printed | #212 |

Each has a test on both backends (`tests/databaseWaste.test.ts`,
`tests/storage.test.ts`).

## What was not changed, and why

- **Effect transactions holding a connection while they recompute** (R1:
  `effects/engine.ts` 525 transactions, total 1 265 s, max 120 s). This is §6's
  stated design decision (atomic layer state with the recorded audit).
  Changing it is a consistency decision, not a fix.
- **The 45-day token-history scan** after a restart (cold per-process cache).
  An index that would serve it is a build on a 121 MB write-hot table, which
  §61 forbids in the boot path.
