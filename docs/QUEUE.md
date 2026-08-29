# The distributed work queue

How Brain hands work to workers across more than one instance, and — the part
worth reading twice — exactly what it does and does not promise.

---

## The one idea

**A claim is a compare-and-swap on a generation number.**

```
1. read candidates, and each one's current lease_generation
2. UPDATE work_items SET ... lease_generation = lease_generation + 1
    WHERE id = ? AND lease_generation = ?
3. changes === 1  ->  you own it
   changes === 0  ->  somebody else does; try the next candidate
```

Two workers can both read generation 7 and both attempt the swap. Exactly one
matches, because the winner made it 8 before the loser's statement ran. The
loser is not an error, is not retried against that row, and moves on.

Everything else in this document follows from that.

## Why it is not `SELECT ... FOR UPDATE`

Because the compare-and-swap is already correct, and it is correct on both
backends with one code path.

`FOR UPDATE SKIP LOCKED` is available on Postgres and is deliberately unused.
Outside a transaction its row locks are released the moment the statement ends,
so it would skip nothing and mean nothing. Inside a transaction it genuinely
reduces contention — every worker gets a distinct row on the first try instead
of stampeding the head of the queue — but it pays for that by holding locks
across the batch, and it makes the two backends behave differently in a way that
has to be reasoned about separately forever.

The fleet this serves is one worker in Step 8 and a handful in Step 11.
Stampede is not its problem. One claim path, provable on both databases, is.

**SQLite** reaches the same guarantee from the other direction: its writers are
serialised, so two attempts happen one after the other and the second sees the
advanced generation. It is not pretending to have Postgres's primitives; it does
not need them.

## Fencing

The generation is also the fencing token.

Every ownership-sensitive operation — heartbeat, complete, fail, release — is a
single guarded `UPDATE` whose `WHERE` clause carries the whole proof:

```sql
WHERE id = ? AND state = 'LEASED' AND worker_id = ? AND lease_id = ?
  AND lease_generation = ? AND lease_expires_at > ?
```

`worker_id` comes from the **authenticated principal**, never from the request
body. There is no read-then-write window for a race to live in.

A worker whose lease expired while it was busy comes back holding generation 7
against a row now on 8, and matches nothing. It cannot resurrect the item,
overwrite the new owner's result, or report success for work somebody else is
already redoing.

The same clause is what makes every one of these take effect immediately:

| What happened | Why the stale owner now matches nothing |
|---|---|
| The lease expired | `lease_expires_at > ?` is false |
| Another worker reclaimed it | `lease_generation` advanced |
| The work was cancelled | state is `CANCELLED`, and the generation advanced |
| It completed or failed | state is terminal |
| The worker was disabled | authentication fails before the statement runs |
| Its credential was revoked | authentication fails before the statement runs |
| Its membership or scope was removed | eligibility is re-read every request |

## The state machine

```
                 enqueue
                    │
                    ▼
   ┌────────────► QUEUED ◄──────────────┐
   │                │                   │
   │             claim                  │ retryable failure or expiry
   │                │                   │ reclaim while attempts remain;
   │                ▼                   │ release, always
   │             LEASED ────────────────┘
   │            /   │   \
   │  complete /    │    \ fail (attempts exhausted, or not retryable)
   │          /   cancel  \
   ▼         ▼      │      ▼
 (release) SUCCEEDED│    FAILED
                    ▼
                CANCELLED
```

| Transition | From | Who | Proof required | Effect |
|---|---|---|---|---|
| enqueue | — | project ADMIN or Brain admin | — | `QUEUED`, generation unchanged |
| claim | `QUEUED`, or `LEASED` with an expired lease | worker with `queue:claim` and the item's `required_scopes` | current generation | `LEASED`; attempt +1; generation +1; new lease id; new attempt row |
| heartbeat | `LEASED` | the owner, `queue:heartbeat` | lease id + generation | expiry extended from now; counter on the current attempt |
| complete | `LEASED` | the owner, `queue:complete` | lease id + generation | `SUCCEEDED`; attempt closed `SUCCEEDED` |
| fail (retryable, attempts left) | `LEASED` | the owner, `queue:complete` | lease id + generation | `QUEUED` with backoff; attempt closed `FAILED` |
| fail (otherwise) | `LEASED` | the owner, `queue:complete` | lease id + generation | `FAILED`; attempt closed `FAILED` |
| release | `LEASED` | the owner, `queue:complete` | lease id + generation | `QUEUED`, always; the attempt is given back; closed `RELEASED` |
| cancel | `QUEUED` or `LEASED` | project ADMIN or Brain admin | — | `CANCELLED`; **generation +1**; open attempt closed `CANCELLED` |
| reclaim | `LEASED`, expired | any eligible worker | previous generation | as claim; previous attempt closed `EXPIRED` |

Terminal states are `SUCCEEDED`, `FAILED` and `CANCELLED`. None is claimable and
none can be moved out of.

**Cancellation wins.** It advances the generation, which is precisely why:
whatever the current owner does next presents the old one and matches nothing.

## Expiry and recovery

Correctness does not depend on any process staying alive.

An expired lease is *claimable work* — the claim query selects
`state = 'LEASED' AND lease_expires_at <= now` alongside `QUEUED` rows — so the
next worker to ask recovers it. `sweepExpiredLeases()` exists for metrics and
visibility, and if it never runs, nothing is lost and nothing is stuck.

Reclaim advances the generation, issues a new lease id, binds the new worker,
closes the previous attempt as `EXPIRED`, and keeps it. Attempts are bounded by
`max_attempts`; exhaustion is a deterministic terminal failure.

**A release is not an attempt.** It returns the item to `QUEUED` whatever the
budget says, and decrements the count, because the budget exists to bound
redelivery that nobody chose — a crash, an expiry, a failure. A worker handing
an item back cleanly is the behaviour the worker contract asks for when an
allowance runs out mid-item, and it used to be the thing that killed the item:
the first real research packet lost a verification exactly that way. Failing and
expiring still count, so a poisonous item is still bounded by the same number.

Restart, redeploy and an empty local disk change nothing, because none of this
is on local disk.

## Time

Lease decisions use the Brain's own clock — never a worker-supplied time —
through a single function, `queueNow()` in `server/repos/workQueue.ts`.

It is deliberately **not** the database's clock. Timestamps in this project are
ISO-8601 text in both backends by design (see `CLOUD.md`), and reaching for
`now()` or `CURRENT_TIMESTAMP` would add a fifth difference between the two
schemas for a benefit measured in milliseconds.

The assumption is therefore that Brain instances agree on the time to within far
less than a lease duration. Fly machines run NTP. The exposure is bounded by the
lease length, and the failure mode if it is ever wrong is a lease reclaimed
early or late — **not a lease with two owners**, because ownership is decided by
the generation swap and not by the clock.

## Authorization

Four worker scopes, all enforced today: `queue:read`, `queue:claim`,
`queue:heartbeat`, `queue:complete`.

Creating and cancelling work is **not** among them. That is a human authority
derived from the project roles, expressed as `ADMIN` entries in the policy
table. A leaked worker credential can perform work; it cannot invent work for
the fleet.

Enforcement runs through `authorizeProject` in `routes/helpers.ts`, which every
project-scoped route already calls. `requireWorkItem` reads the item, then
authorizes the project **the row says it belongs to** — so guessing an id from
another project returns the same 404, with the same body, as an id that never
existed.

Eligibility is rebuilt from live memberships on every request, which is what
makes revocation take effect on the next call rather than at the next sign-in.

## What the database refuses

Enforced as constraints, so they are impossible rather than merely untested:

- a lease exists **iff** the item is `LEASED` — no `QUEUED` row naming an owner,
  no `LEASED` row without one
- `state` within the enum; `priority` 0–9; `attempt_count >= 0`;
  `max_attempts >= 1`; `lease_generation >= 0`
- `UNIQUE (work_item_id, lease_generation)` on the attempt history — a
  generation is issued exactly once per item. If every layer above were wrong
  and two claims both believed they had won, the second insert would fail rather
  than produce two owners.

## Payloads

A queue item describes Brain-authorized work. **It is never a command to
execute**, and there is deliberately no work type meaning "run this".

Each work type declares a validated payload schema and keeps only the fields it
declares — anything else a caller sends is dropped rather than stored. Payloads
are capped at 16 KB. Never a credential, never a duplicated document, never
model context that has a canonical home.

## ⚠ At-least-once, not exactly-once

**This is the most important paragraph in this document.**

A lease can expire after a worker performed an effect and before it recorded the
completion. The item is then redelivered and **the effect happens again**.

Fencing protects the *queue state*. It does not and cannot protect the *effect*.

Therefore, until **Step 6** provides idempotency keys and an effect ledger:

- the only work this queue may carry is work that is safe to perform more than
  once;
- exactly one work type is registered — `SYNTHETIC_ECHO` — and that is the
  honest consequence of the boundary, not an unfinished list;
- **a successful claim is not permission to perform an unprotected
  non-idempotent external effect.**

Registering a research or extraction type here before Step 6 exists would mean a
redelivered item spending the user's quota a second time. That is the bug this
boundary exists to prevent.

## Operating it

```
POST   /api/projects/:id/work           enqueue            project ADMIN
GET    /api/projects/:id/work           list               READ  · queue:read
GET    /api/projects/:id/work/metrics   safe counts        READ  · queue:read
GET    /api/work/:id                    item + attempts    READ  · queue:read
POST   /api/work/claim                  claim              WRITE · queue:claim
POST   /api/work/:id/heartbeat          extend             WRITE · queue:heartbeat
POST   /api/work/:id/complete           succeed            WRITE · queue:complete
POST   /api/work/:id/fail               fail               WRITE · queue:complete
POST   /api/work/:id/release            hand back          WRITE · queue:complete
POST   /api/work/:id/cancel             cancel             project ADMIN
```

**This is not the remote MCP interface.** Step 7 builds that, and it will call
the same repository functions rather than reimplementing the concurrency.

Metrics are scoped to one authorized project on purpose: a global count would
tell a member of one project how busy the others are.

## Auditing

Enqueue, claim, completion, failure, release, cancellation and authorization
denials are written to `identity_events` — beside the sign-ins, because "which
principal took this work" is the same question as "who did what".

**Heartbeats are not audited.** A fleet heartbeating every few seconds would
bury every event worth reading. The current attempt row carries a count and a
last-seen timestamp instead: the same evidence, without the volume.

No payload, credential, session or provider output is ever written to an event.

## Recovery

| Situation | What to do |
|---|---|
| Work looks stuck in `LEASED` | Check `lease_expires_at`. Once it passes, the next claim reclaims it. Nothing to restart. |
| A worker died mid-work | Nothing. Its lease expires and the item is redelivered. |
| A poisonous item keeps failing | It stops itself at `max_attempts` and lands in `FAILED` with a category. |
| Work must stop now | Cancel it. Cancellation beats the current owner deterministically. |
| The database is unreachable | Every operation fails closed. There is no in-memory or local fallback in cloud mode, by design. |

## Rolling back

The Step 5 migrations (`015_work_queue.sql`, `pg-migrations/005_work_queue.sql`)
only add tables. Deploying an earlier image against a database that has them is
safe: nothing before Step 5 reads them.

Rolling the *schema* back means dropping `work_leases` then `work_items`, which
destroys the attempt history. Prefer redeploying the earlier image and leaving
the tables in place.

## What Step 5 did not build

Step 6's idempotency keys and effect ledger. Step 7's MCP. Step 8's real worker.
Step 9's research packet. Step 10's scheduling and workflow recovery. Step 11's
additional workers, capacity planning and fleet UI. Step 12's control centre.

`available_at` exists solely for immediate eligibility and bounded retry
backoff. It is not a scheduler.

Research and extraction were **not** migrated onto this queue. They keep their
in-process queues, for the at-least-once reason above, and because rewriting two
working pipelines would risk existing behaviour for no Step 5 criterion.
