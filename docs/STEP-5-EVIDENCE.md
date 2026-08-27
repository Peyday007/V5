# Step 5 — evidence

What was built, what was actually verified and by what means, and what could not
be verified from where it was built.

**Date** 2026-08-27 · **Branch** `claude/zealous-hypatia-78a2yp` ·
**Starting HEAD** `b8ce108`

---

## Verdict

**Step 5 is code-complete and locally verified against real Postgres with
concurrent connections. It is not closed until the hosted half has run green
against the deployment.**

The design is in [`QUEUE.md`](QUEUE.md). The one-line version: a claim is a
compare-and-swap on `lease_generation`, and that same generation is the fencing
token every later operation must present.

---

## Step 4 verification

| Check | Result |
|---|---|
| Tag `step-4-identities-access-control` exists on the remote | yes, → `b8ce1089ddff5de93197b14e3067c62d8cd8ba14` |
| Tag target = branch HEAD at the start of Step 5 | yes |
| Tag form | **lightweight, not annotated** |
| Step 4 closure report | 25/25 executed and passing |
| Production matches | schema version 4 on Supabase Postgres, deploy run 7, hosted verification 41/41 twice |

**On the tag form.** Pushing a tag from this environment is refused with HTTP
403, so the Step 4 tag was created through the GitHub release UI, which produces
a lightweight ref. It names the correct commit and the evidence matches
production, so this is not the "tag does not match production" discrepancy the
brief says to stop for. It was left alone rather than recreated, because the
brief also says not to move an accurate Step 4 tag.

---

## Step 4 carry-forward register, and its disposition

| # | Item | Assigned to | Disposition |
|---|---|---|---|
| CF-5 | "Migration of a real archive was never exercised." | operator task | **Still open, not Step 5's.** The tool exists and is tested; it needs an archive to run against |
| CF-6 | "More than one instance was not run and must not be." | **Steps 5 and 11** | **Step 5's half is closed.** The claiming, leases and fencing that make a second instance safe for queued work exist and are proven against real Postgres with concurrent connections. Running a second machine remains Step 11 — see below |
| CF-7 | "The real Antigravity worker is UNVERIFIED." | Step 8 | Correctly assigned elsewhere |

**CF-6 is closed by half, deliberately, and the other half is named.** Two
things still stop a second machine being turned on, and both are Step 11's:

1. **Research and extraction were not migrated onto the queue.** Their
   in-process queues remain per-instance. This is not an oversight — the queue
   is at-least-once, and moving quota-spending work onto it before Step 6 exists
   would mean a redelivered job spending the user's allowance a second time.
2. **The sign-in throttle is still an in-memory map per process.** Step 4
   recorded it as "deliberate until Step 5". On inspection it belongs to
   **Step 11** instead, and the correction is worth stating precisely rather than
   quietly acting on: the throttle is only *wrong* when more than one instance
   actually serves traffic, and no configuration in this repository can produce
   that until Step 11 deliberately scales out. Step 5's brief forbids building
   for a configuration that does not exist. It is recorded here so it cannot be
   lost, and `ROADMAP.md` names it in the "why one instance" section.

Nothing from Steps 6–12 was pulled into Step 5.

---

## A defect found while building, in code that predates Step 5

**Every resolver was an enumeration oracle.**

`routes/helpers.ts` refused a missing row with `No project with id "prj_abc".`
and a forbidden one with `No project with that id.` Both are 404s — so every
test asserting on the status passed, including `authorization.test.ts`'s own
isolation tests and Step 4's hosted check — while the **body** quietly confirmed
which ids exist. An attacker enumerating a Brain reads the message, not the
status.

This contradicts `CLAUDE.md` §17 in its own words ("the same 404 as a real
miss") and invariant 23.

Found by writing the equivalent assertion for work items and having it fail.

Fixed three ways: all nine resolvers now emit a message byte-identical to the
authorization refusal and never echo the id; `authorizeProject` carries a
comment saying that adding the id back *is* the bug; and three regression tests
compare the **bodies**, not the statuses — two in `authorization.test.ts` for
projects and layers, one in `queueHttp.test.ts` for work items. The hosted
harness was corrected the same way: its "indistinguishable" check compared only
statuses, which is how it passed against a real oracle.

Invariant 23 was amended to say "including the body of the refusal, not only
its status."

---

## What was built

| Area | Files |
|---|---|
| Schema | `db/migrations/015_work_queue.sql`, `db/pg-migrations/005_work_queue.sql` |
| Domain | `domain/types.ts` — states, outcomes, failure categories, rejections, row and view types |
| Repository | `repos/workQueue.ts` — enqueue, claim, heartbeat, complete, fail, release, cancel, sweep, metrics |
| Work types | `services/queue/workTypes.ts` — validated registry, one type |
| Authorization | `domain/types.ts` (4 scopes), `services/identity/policy.ts` (7 overrides), `routes/helpers.ts` (`requireWorkItem`) |
| Surface | `routes/work.ts`, mounted in `routes/index.ts` |
| Tests | `tests/workQueue.test.ts` (35), `tests/queueHttp.test.ts` (19), plus parity and oracle regressions |
| Hosted proof | `scripts/verify-hosted.ts` — 27 new checks, 68 total |
| Documentation | `docs/QUEUE.md`, `CLAUDE.md` §19 + invariants 24–25, `ROADMAP.md`, this file |

---

## The verification matrix

| # | Item | Result |
|---|---|---|
| 1 | Existing SQLite regression suite | **EXECUTED — PASS** · 627 passed, 25 skipped (Postgres-only) |
| 2 | Existing PostgreSQL regression suite | **EXECUTED — PASS** · 652 passed, real Postgres 16, concurrent connections |
| 3 | New queue repository tests | **EXECUTED — PASS** · `workQueue.test.ts`, 35 |
| 4 | Queue state-machine tests | **EXECUTED — PASS** · every transition and every refused transition |
| 5 | Atomic-claim concurrency on real PostgreSQL | **EXECUTED — PASS** · 8 workers × 12 items, and 8 racing for 1 |
| 6 | Multi-connection / multi-instance claim | **EXECUTED — PASS** · concurrent pool connections; exactly one lease per item |
| 7 | Lease issuance and fencing | **EXECUTED — PASS** · generation and attempt advance exactly once per claim |
| 8 | Heartbeat tests | **EXECUTED — PASS** · owner, foreign worker, guessed id, expired, bounded extension |
| 9 | Expiry and reclaim | **EXECUTED — PASS** · reclaim without a sweeper; new lease id and higher generation |
| 10 | Stale-owner rejection | **EXECUTED — PASS** · heartbeat, complete, fail and release all refused after reclaim |
| 11 | Completion / failure / retry | **EXECUTED — PASS** · once-only completion, backoff, terminal exhaustion, non-retryable |
| 12 | Cancellation races | **EXECUTED — PASS** · exactly one terminal winner against a completion |
| 13 | Worker authorization and scopes | **EXECUTED — PASS** · project, required scopes, no-scope refusal |
| 14 | Human administrative authorization | **EXECUTED — PASS** · member and worker both refused enqueue and cancel |
| 15 | Project isolation and direct-object | **EXECUTED — PASS** · identical body for forbidden and absent |
| 16 | Revocation / disablement during an active lease | **EXECUTED — PASS** · credential revoke and worker disable, both immediate |
| 17 | Queue audit attribution | **EXECUTED — PASS** · enqueue/claim/complete recorded; no payload in any event |
| 18 | Database constraint / integrity | **EXECUTED — PASS** · 9 impossible states refused, identically on both backends |
| 19 | Restart / redeploy persistence, locally | **EXECUTED — PASS** · queue state survives; nothing on local disk |
| 20 | Cloud no-fallback | **EXECUTED — PASS** · existing suite, unchanged and still green |
| 21 | Payload and secret-leak scan | **EXECUTED — PASS** · see below |
| 22 | Typecheck | **EXECUTED — PASS** |
| 23 | Production build | **EXECUTED — PASS** |
| 24 | Local production boot | **EXECUTED — PASS** · schema version 15, harness 68/68 against it |
| 25 | Cloud Brain backup and migration | **PENDING** · the deploy applies 005 at boot |
| 26 | Hosted authorized enqueue | **AUTOMATED — pending the deploy** |
| 27 | Hosted competing-worker atomic claim | **AUTOMATED — pending the deploy** · two real credentials over the edge |
| 28 | Hosted heartbeat / expiry / reclaim | **AUTOMATED — pending the deploy** |
| 29 | Hosted stale-owner denial | **AUTOMATED — pending the deploy** |
| 30 | Hosted project / scope denial | **AUTOMATED — pending the deploy** |
| 31 | Hosted completion / failure / cancellation | **AUTOMATED — pending the deploy** |
| 32 | Hosted restart / redeploy persistence | **AUTOMATED — pending the deploy** · the workflow restarts the machine and re-runs everything |
| 33 | Existing hosted research/document workflow smoke test | **AUTOMATED — pending the deploy** |

### Atomic claiming, measured

Against real Postgres 16 with concurrent pool connections:

```
8 workers race for 1 item      -> 1 claim,   1 distinct, 1 LEASED
8 workers race for 3 items     -> 3 claims,  3 distinct, 3 LEASED
8 workers race for 8 items     -> 8 claims,  8 distinct, 8 LEASED
8 workers x batch 5, 200 items -> 40 claims, 40 distinct, 40 LEASED
8 workers x batch 5, 4 items   -> 4 claims,  4 distinct, 4 LEASED
```

Zero duplicate ownership in every scenario, `attempt_count` and
`lease_generation` exactly 1 on every claimed row, and no duplicate attempt-history
rows. Identical results on SQLite.

### What the database itself refuses

Nine impossible states, refused identically on SQLite and Postgres: a `LEASED`
row without an owner or an expiry; a `QUEUED`, `SUCCEEDED` or otherwise
non-`LEASED` row still naming one; a state outside the enum; a priority out of
range; `max_attempts` of zero; a negative generation. Plus
`UNIQUE (work_item_id, lease_generation)`, which refuses a second attempt row
for a generation already issued.

### Secret-leak scan

- No credential, payload or provider output reaches an event, a log line or an
  error. The queue writes ids, categories and counts.
- The lease id is not published to readers — `GET /api/work/:id` reports
  `hasLease: true` and never the id itself, because it is proof of ownership and
  a reader with permission to look is not thereby the owner.
- Payloads are capped at 16 KB and reduced to the fields the work type declares;
  everything else a caller sends is dropped rather than stored.
- A work type meaning "run this" does not exist, and the registry is closed.

---

## What Step 5 does not claim

- **At-least-once, not exactly-once.** A lease can expire after an effect and
  before the completion is recorded, so the item is redelivered and the effect
  repeats. Fencing protects queue state. Protecting the effect is **Step 6**, and
  until it exists a successful claim is not permission to perform an unprotected
  external effect.
- **One registered work type.** `SYNTHETIC_ECHO`. That is the honest consequence
  of the boundary above, not an unfinished list.
- **Research and extraction still run per-instance.** Not migrated, for the same
  reason.
- **A second machine is not running.** Step 5 built the substrate; Step 11 turns
  it on, and owns the two items named in the carry-forward section.
- **Clock assumption.** Lease decisions use the Brain's clock, never a worker's,
  through one function. Instances are assumed to agree to within far less than a
  lease duration. If that were ever violated the failure is an early or late
  reclaim, never two owners — ownership is decided by the generation swap.

## Steps 6–12 were not started

No idempotency keys, effect ledger or exactly-once effects. No MCP server or
tool schema. No real Claude account or production worker. No end-to-end research
packet. No cron, schedule or workflow-level recovery. No additional workers,
capacity planning, subscription accounting, fleet controls or fleet UI. No
control-centre redesign.

No placeholder table, column, scope or route was added for any of them.
`available_at` exists solely for immediate eligibility and bounded retry
backoff, and there is no scheduler behind it.
