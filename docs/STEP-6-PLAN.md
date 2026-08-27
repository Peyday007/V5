# Step 6 — implementation map

Written before any code was edited, as the brief requires.

**Branch** `claude/zealous-hypatia-78a2yp` · **Starting HEAD** `4bac57b`

---

## 0. Reconciliation of current state

| Fact | Value |
|---|---|
| Branch / worktree | `claude/zealous-hypatia-78a2yp`, clean |
| Local HEAD = remote HEAD | `4bac57be593dea967b06f6e9a9936c418624eb0e` |
| Step 5 tag | `step-5-distributed-queue-leases` → `4bac57b`, **lightweight** (403 on tag push from here; created via the release UI, as Step 4's was) |
| Step 5 closure | 33/33 executed and passing; live evidence in deploy runs 8 and 9 |
| Production | `northline-brain.fly.dev`, Supabase Postgres, schema version 5 |
| This environment's reach | **no route to the deployment or Supabase** — live proof runs through the deploy workflow, as in Steps 4 and 5 |

Step 5 is genuinely closed and its tag matches production, so there is no
discrepancy to stop for.

---

## 1. Step 5 carry-forward assigned to Step 6

**One item, and it is the reason this step exists.**

> "The queue is at-least-once, not exactly-once. A lease can expire after a
> worker performed an effect and before it recorded completion, so the item is
> redelivered and the effect repeats. Fencing protects queue state; protecting
> the effect is **Step 6**." — `QUEUE.md`, `STEP-5-EVIDENCE.md`, `CLAUDE.md` §19

Its concrete consequences, all of which Step 6 must resolve or keep honest:

- only `SYNTHETIC_ECHO` is registered, because it is safe to repeat;
- research and extraction are not on the queue for the same reason;
- `CLAUDE.md` invariant 25 says a claim is not permission to perform an unsafe
  effect "until Step 6's idempotency exists".

Nothing else in the Step 5 register is Step 6's. CF-5 remains an operator task,
CF-7 is Step 8, and CF-6's second half (a second machine, and the in-memory
sign-in throttle) is Step 11.

---

## 2. Mutation inventory

Fifty-five mutating routes across twelve routers. **No route anywhere accepts a
client-supplied identifier** — every id is `newId()` server-side — which removes
a whole class of duplication risk before this step begins.

### Effect classes

**A — same-database.** The domain mutation and the idempotency outcome can
commit in one transaction.

| Operation | Today | Step 6 |
|---|---|---|
| `POST /projects/:id/work` (enqueue) | duplicates freely on retry | **protected** — the representative Class A effect |
| `POST /runs/:id/complete`, `/fail`, `/start` | run state transitions | **protected** |
| `POST /work/:id/complete`, `/fail`, `/release`, `/cancel` | already fenced and once-only by Step 5's guarded UPDATE | **naturally idempotent, with evidence** — Step 5's tests already prove a second call changes nothing |
| `POST /work/claim` | atomic CAS; a repeat claims different work | **not applicable** — claiming is not an effect to deduplicate |
| `POST /admin/projects/:id/members` | `ON CONFLICT ... DO UPDATE` upsert | **protected by an existing uniqueness invariant** |
| `POST /admin/users`, `/workers` | `UNIQUE(email)`, `UNIQUE(name)` | **protected by uniqueness** — a retry fails rather than duplicating |
| `POST /admin/workers/:id/credentials` | issues a one-time secret | **deliberately excluded** — see §7 |
| `POST /layers/:id/freeze`, `/reopen` | transactional, state-guarded | **naturally idempotent, with evidence** |
| `POST /projects/:id/recompute` | derives state from rows | **naturally idempotent** — a pure function of current state |
| audits, evidence, findings | append-only records | **protected** via the same engine where a retry would duplicate |

**B — database plus private Storage.**

| Operation | Today | Step 6 |
|---|---|---|
| `POST /projects/:id/import` | content-hashed, duplicate-checked, `UNIQUE(project_id, canonical_name)` | **protected** — the representative Class B effect |
| `/import-source`, `/import/resolve`, `/archive-import` | same helpers | **protected by the same path** |
| `POST /runs/:id/result-file` | writes then registers | **protected** |
| `POST /documents/:id/reprocess` | supersedes, appends a run | **naturally idempotent** — extraction runs are append-only and superseding is idempotent |

The existing import is *nearly* right: it hashes the bytes, looks for a document
with that hash, and checks the object actually exists before treating it as a
duplicate. Two things are still wrong under concurrency, and they are exactly
what §12 is about:

1. **Check-then-write.** Two simultaneous identical imports both pass the
   duplicate check. `uniqueCanonicalName` then picks *different* non-colliding
   names for each, so the `UNIQUE` constraint never fires and both succeed.
2. **The object is written before the row exists.** A crash in between leaves an
   orphan in the bucket with nothing referencing it.

**C / D / E — external providers.** No production route performs a protected
external effect today; research runs go through the provider layer and are not
queued. Step 6 therefore builds the **contract** and proves it with synthetic
adapters, exactly as §11 requires, and connects no provider.

---

## 3. Schema

### `idempotency_operations` — one row per logical operation

Identity: `id`, `scope_hash`, `key_fingerprint`, `namespace`, `namespace_version`.

Lineage: `project_id` (FK), `created_by_type`, `created_by_id`, `work_item_id`,
`lease_generation`, `correlation_id`.

Semantics: `request_fingerprint`, `fingerprint_version`.

State: `state` — `RESERVED | SUCCEEDED | FAILED | UNCERTAIN` — `attempt_count`,
`failure_category`, `uncertainty_reason`, `recover_after`.

Result: `result_ref`, `result_status`, `result_summary` (bounded, safe).

Times: `reserved_at`, `started_at`, `completed_at`, `created_at`, `updated_at`,
`retention_class`.

**`UNIQUE (scope_hash, key_fingerprint)`** — one operation per scoped key. This
is the whole duplicate-suppression mechanism: the reservation is an
`INSERT … ON CONFLICT DO NOTHING`, and losing it is how a duplicate discovers
the canonical operation.

The **raw key is never stored** — only a digest. A key is not required to be
secret, but storing it buys nothing and a store of user-supplied strings is a
liability.

### `effect_attempts` — append-only, one row per attempt

`id`, `operation_id` (FK, cascade), `attempt_number`, `executor_type`,
`executor_id`, `work_item_id`, `lease_id`, `lease_generation`, `adapter`,
`provider_key`, `phase` (`INTENT | SENT | CONFIRMED | FAILED | UNCERTAIN`),
`receipt_ref`, `receipt_meta` (safe, redacted), `started_at`, `ended_at`,
`outcome`, `detail` (bounded), `request_id`.

`UNIQUE (operation_id, attempt_number)`.

Constraints that make the important things impossible rather than untested:
a terminal state carries no `recover_after`; `SUCCEEDED` requires a result or an
explicit null-result marker; `UNCERTAIN` requires a reason; the state and
fingerprint version are within their enums.

---

## 4. Key identity and scoping

Request-driven operations take an **`Idempotency-Key` header**. Never a query
parameter — §5.1, and because query strings are logged by proxies and kept in
history. Charset `[A-Za-z0-9._~-]`, 8–255 characters, validated before use.

The scope is built from **server-controlled facts only**:

```
scope_hash = sha256("v1|" + brainBoundary + "|" + projectId + "|"
                         + namespace + "@" + namespaceVersion + "|"
                         + principalScope)
```

`principalScope` is declared by the namespace, not the caller: `PRINCIPAL` for
operations where two people doing the same thing are two different intents, and
`PROJECT` for operations where they are one. Nothing the client sent — no
principal, worker, project or namespace field — contributes.

The same visible key therefore cannot collide across projects or operation types.

**Queue-driven effects do not use a header.** Their logical effect key is derived
from the *work item* and the operation namespace — never from the lease id, the
attempt number, the fencing generation, the credential, the request id, the
process or the clock — so it is identical across worker replacement, lease
expiry, reclaim and restart. That stability is the entire point.

---

## 5. Canonical fingerprinting

`services/effects/fingerprint.ts`: a canonical encoding that sorts object keys,
tags types so `null`, `undefined`, `""`, `0` and `false` cannot collide, encodes
arrays positionally, and refuses cycles. Hashed with sha-256 and stamped with a
scheme version, so a future change to canonicalisation cannot silently
reinterpret old records.

Included: operation type and version, authoritative project and resource
lineage, the semantic input, file content digests where bytes matter,
preconditions and target versions.

Excluded: request ids, timestamps, credentials, cookies, tracing headers — every
transport-only field.

**Key reused with a different fingerprint → refuse.** No execution, no disclosure
of the previous payload, a safe conflict category, and an audited denial.

---

## 6. State machine and concurrency

```
                reserve (INSERT ... ON CONFLICT DO NOTHING)
                          │
                          ▼
                      RESERVED ──────────► SUCCEEDED   (replayable, terminal)
                       │  │  │
        retryable      │  │  └────────────► UNCERTAIN   (external, needs
        failure  ◄─────┘  │                              reconciliation)
        (back to          └────────────────► FAILED      (terminal)
         reserved,
         bounded)
```

Terminal success is never reopened by an ordinary retry. An uncertain external
effect is **never** converted to "did not happen" because a timeout elapsed.

The reservation is a database insert, not a process lock. Exactly one caller
inserts; every other equivalent caller reads the canonical row and either
replays the success, reports it in progress, or is refused for a conflicting
fingerprint. No transaction is held open while an external provider is called.

---

## 7. Deliberate exclusion: worker credential issuance

`POST /admin/workers/:id/credentials` returns a plaintext secret exactly once,
and Step 4 made that unrecoverable by design.

Making it "replayable" would require storing the plaintext — which is precisely
what Step 4 forbids, and what the whole identity model exists to prevent. So it
stays outside the general replay mechanism, permanently, and the reason is
recorded rather than left as an oversight. A retry issues a *new* credential,
which is the correct behaviour: two credentials for one worker is a supported
state, and rotation already exists for it.

---

## 8. Queue, lease and fencing integration

The fence is applied at the **commit boundary**, not merely at claim or
heartbeat.

Inside the same transaction as the domain mutation, before anything is written,
a guarded statement re-proves ownership:

```sql
UPDATE work_items SET updated_at = ?
 WHERE id = ? AND state = 'LEASED' AND worker_id = ? AND lease_id = ?
   AND lease_generation = ? AND lease_expires_at > ?
```

`changes !== 1` aborts the transaction. This is a write, not a read, so there is
no window between checking and committing. A worker whose lease expired,
was reclaimed, or whose work was cancelled cannot commit — and the effect and
the queue completion land together or not at all.

A new attempt on the same work item computes the *same* logical effect key,
finds the operation, and replays the success rather than repeating it.

---

## 9. Storage protocol

Two changes to the import path, both aimed at the two defects named in §2:

1. **The operation is reserved before the object is written.** A retry finds the
   reservation and either replays the completed import or resumes it, instead of
   running the duplicate check again and losing the race.
2. **The object key is derived from the content digest**, so two concurrent
   identical imports address the same object rather than two, and a re-write is
   a no-op rather than a second copy.

Failure boundaries and their recovery, all tested:

| Crash point | State | Recovery |
|---|---|---|
| Before reservation | nothing | the retry is a first attempt |
| After reservation, before the object | `RESERVED`, no object | the retry re-writes; the digest key makes it identical |
| After the object, before the row | `RESERVED`, orphan object | the retry finds the object present and adopts it |
| After the row, before success | `RESERVED`, row exists | the retry adopts the row by canonical name |
| After success, response lost | `SUCCEEDED` | replayed |

Cleanup never deletes an object referenced by a successful operation. Missing
objects are reported, never presented as complete — the existing
`objectExists` check already refuses to treat a hash duplicate as usable when
its bytes are gone, and that behaviour is kept.

---

## 10. External adapter contract

`services/effects/adapter.ts` declares what an external effect type must state:
namespace, request schema, fingerprint inputs, whether the provider has native
idempotency, its key format and limits, whether authoritative reconciliation is
available and how to query it, safe receipt fields, timeout behaviour, retryable
versus terminal errors, uncertainty classification, and redaction.

Three **synthetic** adapters prove the three contracts, and no provider is
connected:

- **native-idempotent** — receives one stable provider key across every retry
  and attempt; a repeat returns the original receipt.
- **reconcilable** — no native key, but authoritative state can be queried;
  after an ambiguous send the engine asks the provider what happened and
  attaches the answer rather than resending.
- **opaque** — neither. One automated attempt per logical effect. An uncertain
  outcome becomes `UNCERTAIN` and **is never resent automatically**; it waits
  for an authorized human decision.

The provider key is derived from the logical effect identity. It must not
contain the lease id, attempt number or fencing generation, because those change
between retries and a key that changes is not an idempotency key.

---

## 11. Result replay, recovery and retention

**Replay re-authorizes.** Every retry is authenticated and the caller's *current*
authorization is checked again — a principal who has lost access does not get the
result because the original request was allowed. Secrets and one-time credentials
are never replayed.

**Administrative recovery** is the smallest surface that resolves an uncertain
effect: inspect, reconcile, attach a verified receipt, mark a confirmed failure,
or authorize a retry where policy permits. Project-scoped, administrator-only,
reason required, audited, and it never deletes history or overwrites a success.

**Retention** keeps successful operations well beyond any realistic retry or
redelivery window, and external business identities for as long as the effect
could be attempted again. Deleting a record must never make a successful effect
silently repeatable, so cleanup is an authorized maintenance command rather than
a background sweeper — no scheduler is being built here, that is Step 10.

---

## 12. Explicitly not being built

Step 7's MCP transport or tool schemas. Step 8's Claude worker. Step 9's research
packet. Step 10's schedules, recurring firing and workflow recovery. Step 11's
additional workers, capacity and fleet UI. Step 12's control centre.

No real provider integration. No speculative table, column, scope or route for a
later step.

**And no claim of universal exactly-once.** The guarantees are per class:
same-database effects commit exactly once; native-idempotent providers get one
stable key; reconcilable providers are asked rather than repeated; opaque
providers stop in `UNCERTAIN` and wait for a person. Queue delivery remains
at-least-once, and the documentation says so in those words.
