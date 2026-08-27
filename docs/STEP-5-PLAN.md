# Step 5 — implementation map

Written before any code was edited, as the brief requires. It records what
already exists and will be reused, what is being added, and — the part that
decides whether this step stays honest — what is deliberately not being built.

**Branch** `claude/zealous-hypatia-78a2yp` · **Starting HEAD** `b8ce108`

---

## 0. Reconciliation of current state

| Fact | Value |
|---|---|
| Branch | `claude/zealous-hypatia-78a2yp`, worktree clean |
| Local HEAD = remote HEAD | `b8ce1089ddff5de93197b14e3067c62d8cd8ba14` |
| Step 4 tag | `step-4-identities-access-control` → `b8ce108` |
| Step 4 tag form | **lightweight, not annotated** — see the note below |
| Step 3 tag | `step-3-cloud-brain-foundation` → `8b378ff`, annotated, untouched |
| Step 4 closure | 25/25 criteria executed and passing; matrix in `STEP-4-EVIDENCE.md` |
| Production | `northline-brain.fly.dev`, schema version 4, Postgres + bucket, verified in deploy run 7 |
| Migration checksums | line-ending independent since `e7d6e22`; self-healing for legacy byte checksums |
| This environment's reach | **no route to Supabase or the deployment** (`CONNECT` 403), re-confirmed |

**On the tag form.** Step 4's tag is lightweight rather than annotated because
pushing a tag from this environment is refused with HTTP 403, so it was created
through the GitHub release UI instead. It names the right commit and the
evidence matches production, so this is not the "tag does not match production"
discrepancy the brief says to stop for. It is recorded here rather than fixed:
the brief also says not to move or recreate an accurate Step 4 tag.

**Consequence for Step 5.** Every live proof has to run from somewhere that can
reach the deployment. That is already solved: `scripts/verify-hosted.ts` runs
inside the container on every deploy and asserts against the public URL. Step 5
extends it rather than inventing a second mechanism.

---

## 1. What already exists, and what will be reused

**Identity and authorization — reused unchanged, and treated as authoritative.**
`workers`, `worker_credentials`, `project_memberships` with per-membership
`scopes`, `users`, `user_sessions`, and `identity_events`. Authorization is
decided in `services/identity/policy.ts` and applied in `routes/helpers.ts`;
Step 5 adds entries to both rather than writing checks into route handlers.

**The database abstraction — reused, and it decides the claim algorithm.**
`Database.run` returns `RunResult.changes`, reported identically by
`node:sqlite`, `better-sqlite3` and `pg`. That single fact is what lets one
guarded `UPDATE` be the atomic claim on both backends. `Database.transaction`
pins a Postgres client and nests through savepoints. The dialect translator
rewrites `?` → `$n` and `rowid` → `seq`; it does **not** rewrite vendor syntax,
so anything Postgres-only must be branched on `db.dialect` explicitly.

**`research_jobs` — reused as-is, and the reason the queue is not called
`jobs`.** It already means something precise: the execution container that
carries bundled research fragments to a provider, bound to
`research_orchestrations` by a `NOT NULL` foreign key. It is not a general
work queue and must not be bent into one.

**The two in-process queues — left alone, deliberately.**
`services/research/queue.ts` and `services/documents/queue.ts` are arrays and
`Map`s in one process. They are the reason `fly.toml` pins one machine and the
reason Step 3 recorded CF-6. Step 5 builds the distributed substrate beside
them; **it does not port research or extraction onto it.** Moving real,
quota-spending, non-idempotent work onto an at-least-once queue before Step 6
exists is precisely the mistake the brief forbids, and rewriting two working
pipelines would risk existing behaviour for no Step 5 criterion.

---

## 2. Naming

`work_items` and `work_leases`.

`jobs` is taken by research. `runs` is taken by layer runs. `work` is already
this repository's word for the thing a principal is asked to do — the planner
returns the next action, and the existing worker scope for finishing one is
`work:complete`. A queued unit is a **work item**; one period of owning it is a
**lease**.

---

## 3. Schema

### `work_items` — the durable queue record, one row per unit of work

Identity and routing: `id`, `project_id` (FK, cascade), `work_type`,
`priority`, `available_at`, `target_worker_id` (nullable, FK, set null).

Content: `payload` (JSON, validated per `work_type`), `required_scopes` (JSON
array), `correlation_id`.

State: `state`, `attempt_count`, `max_attempts`.

Ownership: `lease_generation` (monotonic fencing token), `lease_id`,
`worker_id`, `lease_credential_id` (attribution only — never a secret),
`leased_at`, `heartbeat_at`, `lease_expires_at`.

Outcome: `result_ref` (a reference to a canonical Brain record),
`result_summary` (bounded, sanitised), `failure_category`, `cancelled_reason`,
`completed_at`.

Provenance: `created_by_type`, `created_by_id`, `created_at`, `updated_at`.

Constraints that make impossible states unrepresentable rather than merely
untested:

- `state IN ('QUEUED','LEASED','SUCCEEDED','FAILED','CANCELLED')`
- a lease exists **iff** the state is `LEASED`: every non-`LEASED` row must have
  `lease_id`, `worker_id` and `lease_expires_at` all null, and every `LEASED`
  row must have all three set
- `attempt_count >= 0`, `max_attempts >= 1`, `lease_generation >= 0`
- `priority` bounded

Indexes: the claim path `(state, project_id, priority, available_at,
created_at, id)`, the expiry path `(state, lease_expires_at)`, and reporting
paths `(project_id, state)` and `(worker_id, state)`.

### `work_leases` — append-only attempt history

`id`, `work_item_id` (FK, cascade), `project_id`, `attempt_number`,
`lease_generation`, `worker_id`, `credential_id`, `claimed_at`, `expires_at`,
`last_heartbeat_at`, `heartbeat_count`, `ended_at`, `outcome`, `detail`
(bounded), `request_id`.

`UNIQUE (work_item_id, lease_generation)` is the database-level statement of
the whole design: a generation is issued exactly once, so two simultaneous
claims cannot both become owners even if every layer above were wrong.

Heartbeats update a counter and a timestamp on the current lease row rather
than appending an event each time. A heartbeat every few seconds across a fleet
would otherwise be the largest table in the database and would bury the denials
worth reading.

---

## 4. State machine

```
                 enqueue
                    │
                    ▼
   ┌────────────► QUEUED ◄──────────────┐
   │                │                   │
   │             claim                  │ retryable failure, or
   │                │                   │ expiry reclaim, while
   │                ▼                   │ attempts remain
   │             LEASED ────────────────┘
   │            /   │   \
   │  complete /    │    \ fail (attempts exhausted)
   │          /   cancel  \
   ▼         ▼      │      ▼
 (release) SUCCEEDED│    FAILED
                    ▼
                CANCELLED
```

Terminal states are `SUCCEEDED`, `FAILED`, `CANCELLED`. None is claimable.
Cancellation is reachable from `QUEUED` and `LEASED` and wins deterministically:
it advances `lease_generation`, so a late completion, failure or heartbeat from
the previous owner matches nothing and is refused.

Every transition names its allowed source states, the actor type permitted, the
lease proof required, and its history and audit consequence. The transition
table goes in `docs/QUEUE.md`.

`available_at` exists solely for immediate eligibility and bounded retry
backoff. It is not a scheduler and Step 10 is not being started.

---

## 5. The claim algorithm

Correctness rests on a compare-and-swap, not on a lock:

1. Resolve the worker from the authenticated principal. Read its live
   memberships and scopes — never from anything the caller sent.
2. Select candidates the worker is eligible for: `state='QUEUED' AND
   available_at <= now`, **or** `state='LEASED' AND lease_expires_at <= now`
   (an expired lease is claimable work), within the worker's authorized
   projects, matching `target_worker_id` when one is pinned. Ordered by
   `priority DESC, available_at, created_at, id` for determinism.
   Deliberately without `FOR UPDATE SKIP LOCKED`: outside a transaction those
   locks are released as the statement ends and skip nothing, and inside one
   they trade held locks for contention avoidance this fleet does not yet need.
3. Filter to items whose `required_scopes` are a subset of what this worker
   actually holds in that project.
4. For each candidate, attempt the swap:

```sql
UPDATE work_items
   SET state = 'LEASED', worker_id = ?, lease_id = ?, lease_credential_id = ?,
       lease_generation = lease_generation + 1,
       attempt_count   = attempt_count + 1,
       leased_at = ?, heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
 WHERE id = ? AND lease_generation = ?
   AND available_at <= ?
   AND (state = 'QUEUED' OR (state = 'LEASED' AND lease_expires_at <= ?))
```

`changes === 1` means this worker won. `0` means another worker advanced the
generation first — not an error, just the next candidate. Two workers reading
generation *N* can both attempt; exactly one can match.

The attempt count and the fencing generation advance in the same statement that
takes ownership, so neither can advance twice or fail to advance.

No database transaction is held open while a worker performs work. The
transaction covers the swap and the history row, and ends.

**SQLite** gets the same statement and the same guarantee by a different route:
its writers are serialised, so the two attempts happen one after the other and
the second sees the advanced generation. There is one claim code path and it is
provable on both backends, which is worth more than a second, faster one.

An empty queue returns an empty list. That is a normal answer, not an error.

---

## 6. Leases, fencing and time

Every ownership-sensitive operation — heartbeat, complete, fail, release —
is a single guarded `UPDATE` whose `WHERE` clause carries the whole proof:
work-item id, `lease_id`, `lease_generation`, `worker_id` from the
*authenticated principal*, `state = 'LEASED'`, and `lease_expires_at > now`.
`changes === 1` or the operation is refused. There is no read-then-write window
for a race to live in.

An old owner therefore cannot act after its lease expires, after another worker
reclaims, after its worker is disabled, after its credential is revoked, after
membership or scope is removed, after cancellation, or after any terminal state
— because in each case at least one term of that `WHERE` no longer matches.

**Clock assumption, stated once and localised.** Lease decisions use the Brain's
own clock through a single `queueNow()` function, never a worker-supplied time.
Timestamps are ISO-8601 text in both backends by deliberate design, and reaching
for `now()` / `CURRENT_TIMESTAMP` would introduce a fifth documented difference
between the two schemas. The assumption is that Brain instances have
NTP-synchronised clocks, which Fly machines do; the exposure is bounded by the
lease duration, and the brief permits an unavoidable assumption that is written
down and kept in one place.

This is fencing, not exactly-once execution. It prevents a stale owner mutating
queue state. It does not prevent a stale owner having already performed an
external effect. **That is Step 6, and Step 5's documentation will say so in
those words.**

---

## 7. Authorization

Four new worker scopes, all operational in this step and none reserved for a
later one: `queue:read`, `queue:claim`, `queue:heartbeat`, `queue:complete`.

Administering the queue — enqueue, cancel, requeue — is a human authority
derived from the existing project roles, so it adds no worker scope. It is
expressed as `ADMIN`-level entries in the policy `OVERRIDES` table, beside the
membership and project-definition entries already there.

Enforcement runs through `authorizeProject` in `routes/helpers.ts`, which every
project-scoped route already calls, so a queue route that forgets to authorize
cannot resolve a work item in the first place. A work item the caller may not
have returns the same 404 as one that does not exist.

---

## 8. Surfaces

Repository and domain services first, so Step 7 can expose them through MCP
without duplicating a line of concurrency logic. A narrow authenticated REST
contract exists for proof and operation, and is documented as *not* the MCP
interface.

`POST /api/projects/:id/work` (enqueue, ADMIN) · `GET /api/projects/:id/work`
(list) · `GET /api/projects/:id/work/metrics` · `GET /api/work/:id` (with
attempt history) · `POST /api/work/claim` · `POST /api/work/:id/heartbeat` ·
`POST /api/work/:id/complete` · `POST /api/work/:id/fail` ·
`POST /api/work/:id/release` · `POST /api/work/:id/cancel` (ADMIN).

No fleet UI. No change to the main application UI.

---

## 9. Work types

A registry keyed by `work_type`, each entry declaring a validated payload
schema. **One type exists in Step 5: `SYNTHETIC_ECHO`**, a bounded note that
proves the contract end to end without spending anything or touching a real
document.

This is not a placeholder for a later step — it is the honest consequence of
the at-least-once boundary. Until Step 6 protects external effects, a successful
claim is not permission to perform one, so the only work the queue may carry is
work that is safe to perform more than once. A queue item describes
Brain-authorized work; it is never a command to execute.

---

## 10. Expiry and recovery

Correctness does not depend on any process staying alive: an expired lease is
directly claimable by the claim statement above, so the next worker to ask
recovers it. A sweeper may be added for metrics and visibility, and if it never
runs, nothing is lost.

Reclaim advances the generation, issues a new lease id, binds the new worker,
closes the previous lease row as `EXPIRED`, and preserves it. Attempts are
bounded by `max_attempts`; exhaustion is a deterministic terminal failure.

Restart, redeploy and an empty local disk change nothing, because none of this
is on local disk.

---

## 11. Carry-forward from Step 4

- **CF-6** — "More than one instance was not run and must not be", assigned to
  Steps 5 and 11. Step 5 closes its first half: the claiming, leases and fencing
  that make a second instance *safe*. Actually running a second Fly machine
  remains Step 11. Multi-instance correctness is proven here with concurrent
  connections and separate processes against real Postgres, which the brief
  permits.
- **The in-memory login throttle**, which Step 4 recorded under "what Step 4
  does not claim" as "deliberate until Step 5". It is not in the register table
  and it is not queue work, but it is a genuine one-instance-only correctness
  item, and Step 5 is the step whose entire purpose is multi-instance
  correctness. It will be made database-backed **last**, after the queue is
  green, so that it can be deferred cleanly with a written reason if it
  endangers anything in the identity path.

No other register item is assigned to Step 5. CF-5 remains an operator task and
CF-7 remains Step 8.

---

## 12. Explicitly not being built

Step 6's idempotency keys, effect ledgers and exactly-once external effects.
Step 7's MCP server or tool schemas. Step 8's real Claude account or production
worker. Step 9's end-to-end research packet. Step 10's cron, schedules and
workflow-level recovery. Step 11's additional workers, capacity planning,
subscription accounting, fleet controls and fleet UI. Step 12's control-center
redesign.

No placeholder table, column, scope or route is added for any of them.

Research and extraction are not migrated onto the queue in this step, for the
reason given in section 1.
