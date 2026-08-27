# Idempotency and safe concurrent effects

Step 5's queue is **at-least-once**. A worker can perform an effect, lose its
lease or its connection before recording completion, and the item is delivered
again. This is how that stops meaning "twice".

---

## The one idea

```
UNIQUE (scope_hash, key_fingerprint)
```

A logical operation reserves itself with `INSERT ... ON CONFLICT DO NOTHING`.
Exactly one caller inserts a row. Everyone else — a double click, a retried
request, a second Brain instance, a redelivered queue item — changes zero rows,
reads the row they collided with, and finds out what to do instead of doing it
again.

The arbiter is the database, not a mutex. A process-local lock would be correct
on one machine and quietly wrong the moment there were two.

---

## ⚠ There is no universal exactly-once

That promise is not honestly available across every provider, and a system that
claims it is lying about at least one of them. The guarantee is **per effect
class**, and every effect must declare which class it is:

| Class | Guarantee | How |
|---|---|---|
| **Same-database** | Exactly once | The mutation and the success record commit in one transaction |
| **Database + Storage** | Exactly one canonical document | Content-digest identity, reserve before write, recover after any crash |
| **External, native idempotency** | Exactly once, by the provider | One stable provider key across every retry and attempt |
| **External, reconcilable** | Never repeated blindly | After an ambiguous send, ask the provider what it did and attach the answer |
| **External, opaque** | At most one automated attempt | An unknown outcome stops at `UNCERTAIN` and waits for a person |

Flattening these into one word called "idempotent" is the failure this
document exists to prevent.

### What is not evidence

- **A timeout is not evidence** that the effect did not happen.
- **A connection reset** after the request was written is not evidence.
- **An error response** from a provider that already accepted the work is not
  evidence.

The only evidence is a receipt, or the provider's own answer when asked. An
effect whose outcome is unknown is recorded as unknown.

---

## Identity

### Request-driven operations

An `Idempotency-Key` **header**. Never a query parameter — query strings are
written to proxy logs, kept in browser history and forwarded in `Referer`. A key
in the query string is **refused**, not ignored: ignoring it would leave the
caller believing they had idempotency when they did not.

Charset `[A-Za-z0-9._~-]`, 8–255 characters. The key does not need to be secret
— nothing is authorized by holding one — and **only a digest of it is stored**,
because a table of caller-supplied strings is a liability the first time
somebody puts something sensitive in one.

### Scope

```
scope_hash = sha256("v1|" + brain + "|" + projectId + "|"
                         + namespace + "@" + version + "|" + principalScope)
```

Every input is a **server-controlled fact**. Nothing the caller sent
contributes — not a principal field, not a worker id, not a project in the body.
The same visible key therefore cannot collide across projects or operation
types, and holding a key is never a way to reach a project.

`principalScope` is declared by the namespace: `PRINCIPAL` when two people doing
the same thing are two different intents, `PROJECT` when they are one.

### Queue-driven effects

Derived from the **work item** and the operation namespace, and from nothing
that changes between attempts:

> not the lease id, not the attempt number, not the fencing generation, not the
> credential, not the request id, not the process, not the clock

Every one of those differs on the retry, and **a key that differs on the retry
is not an idempotency key**. That stability is what makes a redelivered item
find the effect it already performed.

---

## Fingerprinting

A key says "these are the same operation". The fingerprint checks whether that
is true. Without it, a caller could reuse a key with different input and be
handed the previous operation's result — which is not idempotency, it is a
mix-up with a confident name.

`JSON.stringify` answers a different question. `{"a":1,"b":2}` and
`{"b":2,"a":1}` are the same request and different strings; `{}`, `{"n":null}`,
`{"n":""}`, `{"n":false}` and `{"n":0}` are five different requests that common
normalisations happily collapse. So values are encoded with their type, object
keys are sorted, strings are length-prefixed, and every distinguishable shape
gets a distinguishable encoding.

The scheme is **versioned** and the version is stored beside every fingerprint,
so a future change cannot silently reinterpret old records.

**A result is never part of an identity.** Two workers may legitimately report
different summaries for the same work item; including the summary made a
reclaimed item's new owner look like a conflicting request and blocked
legitimate recovery. Inputs identify; outputs do not.

Reusing a key with a different fingerprint is **refused, never executed**, and
the refusal does not disclose the earlier payload.

---

## The state machine

```
              reserve (INSERT ... ON CONFLICT DO NOTHING)
                        │
                        ▼
                    RESERVED ──────────► SUCCEEDED   (replayable, terminal)
                     │  │  │
      retryable      │  │  └────────────► UNCERTAIN   (needs a person)
      failure  ◄─────┘  │
      (recoverable)     └────────────────► FAILED      (terminal)
```

Terminal success is never reopened by an ordinary retry. `UNCERTAIN` is only
left by an authorized human resolution — never automatically, and never because
a timeout elapsed.

---

## Concurrency

The reservation commits in **its own transaction**, separately from the
execution. Sharing one would make a second caller's `INSERT` block for as long
as the first caller's work took, turning a duplicate request into a held lock.

The **execution and the transition to `SUCCEEDED` do share a transaction**, and
that is what makes "either both or neither" true rather than aspirational:
there is no moment between the domain mutation and the success record.

No database transaction is ever held open while an external provider is called.

---

## The fence, at the commit boundary

When work is performed under a queue lease, the first statement inside the
effect's transaction re-proves ownership **as a write**:

```sql
UPDATE work_items SET updated_at = ?
 WHERE id = ? AND state = 'LEASED' AND worker_id = ? AND lease_id = ?
   AND lease_generation = ? AND lease_expires_at > ?
```

`changes !== 1` aborts the transaction. A `SELECT` would leave a window between
the check and the commit; this does not. A worker whose lease expired, was
reclaimed, or whose work was cancelled commits nothing — and the effect and the
queue completion land together or not at all.

**Fencing applies at the commit boundary, not only at heartbeat.**

---

## External effects, step by step

1. **Reserve**, and persist *intent* — an attempt row, before anything is sent.
2. **Mark it SENT**, then send. Outside any transaction.
3. **Record what came back**, in its own short transaction.

Steps 1 and 2 are separate facts on purpose. "We were about to send" and "we
sent" differ, and after a crash that difference decides whether reconciliation
is needed.

| Outcome | What happens |
|---|---|
| Confirmed | Receipt stored (redacted by the adapter), operation succeeds |
| Rejected, retryable | Operation stays open; a later attempt may execute |
| Rejected, terminal | Operation fails for good |
| Uncertain, reconcilable | Ask the provider; attach what it says, or stay uncertain |
| Uncertain, opaque | **`UNCERTAIN`. Nothing automatic ever resends it.** |

### The provider key

Derived from the logical effect identity, and never from the attempt, lease,
generation, worker or request. **A provider key that changes between retries
de-duplicates nothing** — the single most common way a system with idempotency
keys still double-charges.

An adapter claiming native idempotency must state its key length limit: a
provider that silently truncates keys de-duplicates on a prefix, which is a
different guarantee from the one it advertises.

---

## Replay

**A replay re-reads and re-authorizes.** It does not return a stored response
body — nothing stores one. The operation keeps a *reference* to the canonical
record, and replay fetches it through the same authorization as any other read.

A principal who has since lost the project gets nothing, even though the
original request was allowed. Storing the response would have made that
impossible to enforce, which is why none is stored.

Secrets and one-time credentials are never replayed. **Worker credential
issuance is permanently outside this mechanism** — making it replayable would
require storing the plaintext, which Step 4 forbids. A retry issues a *new*
credential, which is correct: two credentials for one worker is a supported
state, and rotation exists for it.

---

## Administrative recovery

Project-scoped, administrator-only, reason required, audited. An administrator
may inspect operations and attempts, and resolve an `UNCERTAIN` one as either
succeeded (attaching a verified receipt) or failed.

It never deletes history, never overwrites a success, and never removes evidence
to make a retry possible. The record of the ambiguity survives its resolution,
because "we sent this, did not know what happened, and decided X" is what
somebody will want to read in six months.

Neither the key nor the request payload is ever published — only the key's
absence and a short fingerprint prefix.

---

## Retention

| Class | Kept for |
|---|---|
| `STANDARD` | Well beyond any realistic retry or redelivery window |
| `EXTENDED` | Longer-lived operations such as imports |
| `PERMANENT` | External effect identities — for as long as the same effect could be attempted again |

**Deleting a record must never make a successful effect silently repeatable.**
Cleanup is therefore an authorized maintenance action, not a background sweeper;
no scheduler is built here, that is Step 10.

---

## What is covered today

| Operation | Class | Status |
|---|---|---|
| Queue enqueue | Same-database | **Protected** — `Idempotency-Key` |
| Effect committed under a lease | Same-database + fence | **Protected** — stable work-item key |
| Document import | Database + Storage | **Protected** — fingerprinted over file digests |
| Queue complete / fail / release / cancel | Same-database | **Naturally idempotent** — Step 5's guarded `UPDATE` |
| Project membership | Same-database | **Uniqueness invariant** — upsert on the unique triple |
| Users, workers | Same-database | **Uniqueness invariant** — `UNIQUE(email)`, `UNIQUE(name)` |
| Freeze / reopen / recompute | Same-database | **Naturally idempotent** — a function of current state |
| Worker credential issuance | — | **Deliberately excluded**, permanently. See Replay |
| Research and extraction | — | Not on the queue. Not yet protected; see below |

---

## Explicit guarantees and non-guarantees

**Guaranteed.** Queue delivery is at-least-once. Same-database effects commit
exactly once. Concurrent equivalent requests resolve to one logical operation. A
stale worker cannot commit. Cancelled work cannot commit. A key reused with
different input is refused without executing. Replay re-authorizes.

**Not guaranteed.** Universal exactly-once external execution. An opaque
provider's uncertain effect is not resolved automatically — by design. Research
and extraction still run in-process and are not yet queue-delivered, so they are
not covered by this substrate; moving them onto the queue is safe *now that this
exists*, and belongs to the step that does it rather than to this one.

---

## Not built here

Step 7's MCP. Step 8's Claude worker. Step 9's research packet. Step 10's
schedules and workflow recovery. Step 11's fleet. Step 12's control centre.

No real provider is connected. The three synthetic adapters
(`services/effects/synthetic.ts`) exist to prove the contracts under fault
injection and are **not reachable from any route** — nothing registers them at
boot, and no HTTP surface can select an adapter by name.
