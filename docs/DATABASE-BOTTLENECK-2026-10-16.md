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

## The host itself (Supabase's metrics endpoint, read 10:37:35Z)

Brain's connection report now reads Supabase's own Prometheus endpoint with
the service-role key it already holds. One full reading succeeded; the next
two got `504` from the endpoint (Supabase's exporter timing out), which is a
symptom too. The counters cover the host's whole uptime, from 2026-10-05 to now
(~10.6 days):

| reading | value | what it says |
|---|---|---|
| `MemTotal` | **455 MB** | this is a **Nano** instance (0.5 GB), not Micro |
| `MemAvailable` | 105 MB | Postgres has `shared_buffers=280 MB`, beside Storage, PostgREST, the pooler and the exporter |
| CPU `iowait` | **486 801 s = 26.6 %** of all CPU time | 4.6× the time spent in user + system (106 618 s) |
| CPU `steal` | 836 s | the shared CPU is not the limit |
| root disk (`nvme0n1`) | **3.75 TB read**, 296 M reads (~323/s average), busy ~32 % | not Postgres data |
| data disk (`nvme1n1`) | 260 GB read, 199 GB written | Postgres; cache hit is 99.85 % |

**The host is memory-starved and paging.** Postgres's own reads are served
from cache (99.85 %), yet the root disk has read 3.75 TB in ten days. That is
memory thrash: the OS evicting and re-reading because 455 MB is not enough for
Postgres plus the services Supabase runs beside it. Waiting on that disk is a
quarter of all CPU time. When the IO budget runs out, everything on the host
stalls together:
- single-row writes take minutes;
- Storage answers `544 DatabaseTimeout`;
- the metrics endpoint answers `504`.

**Brain does not cause the condition.** At 10:27Z Brain was not running, because
the deploy had stopped it and it was booting. Supabase Storage still answered
`544 DatabaseTimeout` for over two minutes. In a healthy window, Brain's write
load is about 50 MB of WAL an hour, and from 10:37 to 10:57 it was 4 MB.

**Brain does amplify it.** Any scan larger than RAM evicts the whole cache. One
was found and bounded: the self-model scan that runs on every deployment counted
each account's fires over the 661 MB `bin_events` heap, up to 120 s each (#214).

## Conclusion

| question | answer |
|---|---|
| Is Brain's steady load the bottleneck? | **No.** ~50 MB WAL/h; far below any tier's baseline |
| Is Brain-side waste remaining? | Four measured wastes removed (#210, #211, #214; #212 minor). The effect-transaction design (§6) and cold-start token scans remain, by decision |
| Is the host the bottleneck? | **Yes, confirmed by the host's own counters**: 455 MB RAM, 26.6 % iowait, 3.75 TB of root-disk reads |
| Upgrade needed? | **Yes.** Nano → **Small** (2 GB, 1 000 IOPS / 22 MB/s baseline), ~$15/mo list; on a paid org the $10 compute credit already pays for Nano/Micro, so ~**$5/mo net** (the 1.19 GB database and 8 GB disk indicate a paid plan; a free-plan org would first need Pro). Micro (1 GB, $0 net) is the minimum; Small is recommended because Storage, PostgREST, the pooler and Postgres share the RAM |

Resizing restarts the database for a few minutes. Brain rides that out by
itself (§18's boot retry and the 503-retryable paths). It is the owner's
decision and spending (invariant 18), and nothing was resized here.

## Brain-side waste found and removed

| # | waste | measured | change | PR |
|---|---|---|---|---|
| 1 | `latestSnapshots` read a project's whole rank history (89 636 rows, ~32 MB) to keep one row per path | R1: 284 calls in 8 h, mean 5.8 s, max 37.8 s | newest row per path only (`NOT EXISTS`, served by `idx_monetization_snapshots_path`) | #210 |
| 2 | `applyValidationAnswers` read the card once per claim per field, the fragment once per claim, and re-ran the citable-claims join once per claim | R1: 219 825 single-field card reads, 82 503 fragment reads in 8 h | card once per opportunity (re-read after each write), fragment once per pass, ruled-out from the claims already loaded; `applyProposal` reads the card once | #210 |
| 3 | every document existence check was its own `storage.search` on Brain's Postgres | R1→R2: largest server-time consumer (927 calls, 70 s in 16 min); 389 283 since 10-05 | one listing per folder for a recompute's prefetch; same answer, never a cache; a store that does not answer leaves the folder UNKNOWN | #211 |
| 4 | the connection report read `pg_stat_statements` texts seven times per run | R3: the report's queries were the largest temp writers listed — **122 MB over 29 calls, about 4 MB per call**. An earlier reading of mine took the cumulative figure as per-call (~100 MB); it was not, and #212's commit message repeats that error | numbers read without texts; texts fetched once, for the rows printed. A cheaper read, but a minor saving | #212 |
| 5 | the self-model scan (every deployment) counted each account's `DISPATCH_SENT` rows over the 661 MB `bin_events` heap | 10:46Z: 2 calls, max 120.6 s (the statement timeout) | counted up to 1 000 ("1000 or more") | #214 |

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
