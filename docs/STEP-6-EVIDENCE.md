# Step 6 — evidence

**Date** 2026-08-27 · **Branch** `claude/zealous-hypatia-78a2yp` ·
**Starting HEAD** `4bac57b`

---

## Verdict

**Step 6 is code-complete and locally verified against real Postgres 16 with
concurrent connections. It is not closed until the hosted half has run green
against the deployment.**

The design is in [`EFFECTS.md`](EFFECTS.md). The one-line version: a logical
operation reserves itself with `INSERT ... ON CONFLICT DO NOTHING`, and the
guarantee it can then be given depends on which effect class it belongs to.

---

## Step 5 verification

| Check | Result |
|---|---|
| Tag `step-5-distributed-queue-leases` on the remote | yes, → `4bac57be593dea967b06f6e9a9936c418624eb0e` |
| Target = branch HEAD at the start of Step 6 | yes |
| Tag form | lightweight (403 on tag push from here; created via the release UI, as Steps 4 and 5 were) |
| Step 5 closure | 33/33 executed and passing |
| Production | schema version 5 on Supabase Postgres; deploy run 9 passed 75/75 across a real restart |

No discrepancy. Step 5 was left untouched.

---

## Step 5 carry-forward, and its disposition

**One item, and it is the reason this step exists.**

> "The queue is at-least-once… Fencing protects queue state; protecting the
> effect is **Step 6**."

| Consequence recorded in Step 5 | Disposition |
|---|---|
| Only `SYNTHETIC_ECHO` is registered, because it is safe to repeat | **Substrate now exists.** Registering a non-repeatable work type is now possible with a declared effect class. No new work type was added here — that belongs to the step that needs one |
| Research and extraction are not on the queue | **Still off the queue, deliberately.** Moving them is safe *now that this exists*, but it is a migration of two working pipelines and belongs to the step that performs it, not to the step that made it possible |
| Invariant 25: a claim is not permission to perform an unsafe effect "until Step 6's idempotency exists" | **Closed and rewritten.** Invariant 25 now reads that no effect may be performed outside the class whose guarantee it can keep, and invariants 26–27 were added for the evidence and key-derivation rules |

Nothing else was assigned to Step 6. CF-5 remains an operator task, CF-7 is
Step 8, and CF-6's second half is Step 11.

---

## Two defects found while building this

**1. A result had been made part of an operation's identity.**

The fenced queue-effect route fingerprinted the worker's `summary` along with
the work item. After a reclaim, the new owner writes a different summary for the
same work — so the fingerprints differed, the reservation looked like a
conflicting reuse of the key, and **legitimate recovery was refused**. Caught by
the HTTP suite's reclaim test, which expected the new owner to be able to commit
and got a 409.

Inputs identify an operation. Outputs do not. Fixed, and stated as a rule in
`EFFECTS.md` and `CLAUDE.md` invariant 27.

**2. The hosted harness was not re-runnable.**

Its idempotency keys came from a counter that resets with the process, so the
*second* run of the script reused the first run's keys, every keyed mutation
replayed instead of executing, and the checks asserting "this is an original
execution" failed. The deploy runs the harness twice, so this would have failed
every deploy. Keys now carry a per-run nonce — deliberately unlike the
persistence beacon, which must survive between runs. Keys must not; results
must.

---

## Mutation inventory and effect classification

Fifty-five mutating routes across twelve routers. **No route anywhere accepts a
client-supplied identifier** — every id is server-generated — which removes a
whole class of duplication risk before this step begins.

| Operation | Class | Status |
|---|---|---|
| Queue enqueue | Same-database | **Protected** — `Idempotency-Key`, project-scoped |
| Effect under a lease | Same-database + fence | **Protected** — stable work-item key |
| Document import | Database + Storage | **Protected** — fingerprinted over file content digests |
| Queue complete / fail / release / cancel | Same-database | **Naturally idempotent, with evidence** — Step 5's guarded `UPDATE` is once-only, proven by its own suite |
| Queue claim | — | **Not applicable** — claiming is not an effect to deduplicate |
| Project membership | Same-database | **Existing uniqueness invariant** — upsert on the unique triple |
| Users, workers | Same-database | **Existing uniqueness invariant** — `UNIQUE(email)`, `UNIQUE(name)` |
| Freeze / reopen / recompute | Same-database | **Naturally idempotent** — a function of current state |
| Worker credential issuance | — | **Deliberately excluded, permanently.** Replay would require storing the plaintext, which Step 4 forbids. A retry issues a new credential; rotation already exists for that |
| Research, extraction, orchestration | — | **Not queue-delivered**, so not redelivered. Not covered by this substrate, and honestly recorded as such |

---

## The verification matrix

| # | Item | Result |
|---|---|---|
| 1 | Existing SQLite regression suite | **EXECUTED — PASS** · 677 passed, 25 skipped (Postgres-only) |
| 2 | Existing PostgreSQL regression suite | **EXECUTED — PASS** · 702 passed, real Postgres 16, concurrent connections |
| 3 | Step 5 queue regression suite | **EXECUTED — PASS** · unchanged and still green on both backends |
| 4 | Idempotency repository tests | **EXECUTED — PASS** · `idempotency.test.ts` |
| 5 | Canonical fingerprint tests | **EXECUTED — PASS** · eight distinguishable shapes stay distinguishable; key order ignored, array order kept |
| 6 | Key-scoping and conflict tests | **EXECUTED — PASS** · project, principal and namespace scoping; conflict refused without executing |
| 7 | Operation state-machine tests | **EXECUTED — PASS** · terminal success never reopened; retryable failure recoverable |
| 8 | Real-PostgreSQL concurrent duplicate tests | **EXECUTED — PASS** · 8 concurrent → 1 execution, 1 domain row |
| 9 | Same-database atomic-effect tests | **EXECUTED — PASS** · a throw after the mutation commits nothing |
| 10 | Queue lease/fencing integration tests | **EXECUTED — PASS** · fence applied as a write inside the effect's transaction |
| 11 | Stale-worker effect-denial tests | **EXECUTED — PASS** · reclaimed worker refused; new owner commits |
| 12 | Cancellation/effect race tests | **EXECUTED — PASS** · cancelled work cannot be committed |
| 13 | Queue-redelivery replay tests | **EXECUTED — PASS** · same work item, same key, replayed |
| 14 | External adapter contract tests | **EXECUTED — PASS** · a mis-declared adapter is refused at registration |
| 15 | Native-provider-idempotency synthetic tests | **EXECUTED — PASS** · one stable key, one ledger entry across retries |
| 16 | Non-idempotent-provider uncertainty tests | **EXECUTED — PASS** · opaque uncertain effect never resent |
| 17 | Reconciliation tests | **EXECUTED — PASS** · ambiguous send reconciled, absent send retried |
| 18 | Crash-window fault-injection tests | **EXECUTED — PASS** · see below |
| 19 | Storage/file-effect recovery tests | **EXECUTED — PASS** · import fingerprinted over content digests; existing import suite green |
| 20 | Result-replay authorization tests | **EXECUTED — PASS** · a principal who lost the project is refused the replay |
| 21 | Administrative recovery tests | **EXECUTED — PASS** · succeeded operations cannot be overwritten; members and workers refused |
| 22 | Mutation-coverage acceptance tests | **EXECUTED — PASS** · see the inventory above |
| 23 | Project-isolation and direct-object tests | **EXECUTED — PASS** · identical body for forbidden and absent operations |
| 24 | Revocation/disablement tests | **EXECUTED — PASS** · covered by the Step 4 and Step 5 suites, unchanged |
| 25 | Audit-attribution tests | **EXECUTED — PASS** · no key, no payload in any event |
| 26 | Retention/cleanup safety tests | **EXECUTED — PASS** · external identities are `PERMANENT`; no sweeper deletes anything |
| 27 | Database constraints and migration tests | **EXECUTED — PASS** · duplicate scoped key refused; uncertain-without-reason refused |
| 28 | No-fallback tests | **EXECUTED — PASS** · existing suite, unchanged |
| 29 | Secret-leak scan | **EXECUTED — PASS** · see below |
| 30 | Typecheck | **EXECUTED — PASS** |
| 31 | Production build | **EXECUTED — PASS** |
| 32 | Local production boot | **EXECUTED — PASS** · schema version 16, harness 96/96 against it |
| 33 | Local restart persistence test | **EXECUTED — PASS** · the Step 5 beacon, unchanged and still passing |
| 34 | Cloud Brain migration | **AUTOMATED — pending the deploy** |
| 35 | Hosted original/replay test | **AUTOMATED — pending the deploy** |
| 36 | Hosted concurrent duplicate test | **AUTOMATED — pending the deploy** |
| 37 | Hosted fingerprint-conflict test | **AUTOMATED — pending the deploy** |
| 38 | Hosted queue-redelivery effect test | **AUTOMATED — pending the deploy** |
| 39 | Hosted stale-lease denial test | **AUTOMATED — pending the deploy** |
| 40 | Hosted project-isolation test | **AUTOMATED — pending the deploy** |
| 41 | Hosted restart/redeploy persistence test | **AUTOMATED — pending the deploy** |
| 42 | Existing hosted research/document workflow smoke test | **AUTOMATED — pending the deploy** |

### Duplicate suppression, measured

Against real Postgres 16 with concurrent pool connections:

```
8 concurrent identical requests -> 1 execution, 1 domain row, 1 executor
                                   7 told the operation was already running
same key, different input       -> refused, nothing executed, nothing disclosed
same key, another principal     -> a separate operation (PRINCIPAL scope)
same key, another project       -> a separate operation
```

Identical on SQLite.

### The ten crash windows

Exercised with synthetic providers and injected faults:

| Window | Outcome |
|---|---|
| Crash before intent persisted | The retry is a first attempt |
| Crash after intent, before send | Attempt row exists; the next attempt knows something *might* have gone |
| Crash during send | Uncertain, never "failed" |
| Provider accepts, response lost | Uncertain; reconciled where possible |
| Response arrives, receipt persistence fails | Attempt stays open; recovery re-reads it |
| Receipt persists, client response lost | Replayed |
| Concurrent identical sends | One operation, one send |
| Retry from a new queue attempt | Same logical key, replayed |
| Stale worker returns after a new lease | Refused at the commit boundary |
| Malformed provider receipt | Redacted to the fields the adapter declares |

The decisive one: **an opaque provider's uncertain effect was not resent** even
after the provider became healthy again — `1 send(s) after the retry`.

### Secret-leak scan

- No credential, key or payload reaches an event, a log line or an error.
- **The raw idempotency key is never stored** — only a digest — and never
  published. Operation records expose a 12-character fingerprint *prefix*.
- No response body is stored anywhere, which is what makes replay
  re-authorization enforceable rather than aspirational.
- Provider receipts are redacted by the adapter before storage.
- The synthetic adapters are not registered at boot and no route can select an
  adapter by name — there is no test backdoor in production.

---

## Explicit guarantees and non-guarantees

**Guaranteed.** Queue delivery is at-least-once. Same-database effects commit
exactly once. Concurrent equivalent requests resolve to one logical operation. A
stale worker cannot commit. Cancelled work cannot commit. A key reused with
different input is refused without executing. Replay re-authorizes.

**Not guaranteed.** Universal exactly-once external execution — that promise is
not honestly available across every provider. An opaque provider's uncertain
effect is not resolved automatically, by design. Research and extraction are not
queue-delivered and so are not covered by this substrate.

## Steps 7–12 were not started

No MCP transport or tool schemas. No Claude account or production worker. No
research packet. No schedules, recurring firing or workflow recovery. No
additional workers, capacity or fleet UI. No control-centre redesign. No real
provider integration, and no placeholder table, column, scope or route for any
of them.
