# Three defects a member's browser showed and no row did

Everything in this file is a reading rather than a description. Where a
production figure appears it names the command that produced it.

---

## 1. Why an ordinary member was told there was nothing to see

### The exact cause

`GET /api/projects/:projectId/cash` resolved through `requireProject`, which is
`decideProjectAccess(principal, projectId, 'READ')`. Four facts, none of them a
bug on its own, compose into the failure:

1. the shared frontier is a **project** — `services/cash/root.ts` resolves it
   and the production root is `prj_22fb4fec295f403a8a22` (`cash-mode-1`);
2. a person who joined the Brain holds **no `project_memberships` row** on it,
   because nobody grants one and the point of a shared frontier is that they
   should not need one;
3. `decideProjectAccess` therefore answers `NOT_A_MEMBER`, which invariant 23
   renders as the same 404 a missing project gives — correctly, and at a door
   where absent-versus-forbidden was not the question being asked;
4. **a Brain administrator reaches every project by design**, so the owner saw
   the frontier and the failure was invisible from the only screen anybody was
   looking at.

The screen's sentence — *"There is nothing here for you to see. That is the same
answer a project that does not exist gives, on purpose."* — was the client
faithfully rendering a 404 it had no way to tell apart from a real one.

### The boundary was already written down

`services/cash/root.ts` opens by saying discovery is one shared frontier and
that **separation begins when a validated opportunity becomes an execution
job**, because that is the first moment there is anything private to separate.
§31 settled the same question one boundary out: a validated finding belongs to
the Brain. The membership implemented the opposite — discovery private,
execution wherever the project happened to put it.

### Before and after

| | before | after |
| --- | --- | --- |
| Owner / Brain administrator | full view | full view, unchanged |
| Member of the root project | full view | full view, unchanged |
| **Enrolled member, no membership** | **404, same body as a missing project** | **shared frontier** |
| Worker principal | 404 | 404, same body — refused **by type** |
| Anonymous | 401 | 401 |
| Invalid session | 401 | 401 |
| Disabled account | 401 | 401 |
| Any other project | 404 | 404, same body — `decideProjectAccess`, untouched |

`services/cash/access.ts` is the whole of the change and it decides three
things: the subject is the **server-resolved** root and never a project id a
caller chose; a genuine authenticated person may read it; everything else falls
through to `decideProjectAccess` unchanged.

### What crosses, and what does not

`services/cash/shared.ts` is a **second projection**, built from the columns it
names, rather than a filter over the owner's view. A field added to
`cash_opportunities` next month is absent from it until somebody writes it in —
the failure mode is a missing fact rather than a leaked one.

Shared: opportunity identity, mechanism, industry, state, availability, the
accepted claim it came from with its publisher's dated signal, the packet /
fragment / round, qualification progress **by field name**, the roadmap, open
capability needs, and activity **counted by kind**.

Private: every commercial term's value, every money figure, the ledger, the
position, the forecast, the grant's ceilings and spend, the next action, the
outcome, the stop rule, and the decisions review.

One rule in a sentence: **a signal is what a publisher said; a price is what
this operation would charge.**

A claimed opportunity is **redacted rather than hidden** — `availability` says
`CLAIMED`, which is what another member needs in order not to research the same
opening, and nothing about whose job it is.

---

## 2. The capacity count, and where 1 / 4 came from

### The two readings, at one instant

`fleet show` on production, 2026-09-18T00:19:41Z:

```
FLEET
  accounts    4
  routines    9
  target      4
  candidates  7 considered, 4 eligible now
```

The Cash page, at the same time: `Claude capacity accounts 1 / 4 HEALTHY`.

### Why they disagreed

`cashReadiness` counted **accounts**. The dispatcher fires **Routines**. §23's
own first distinction — *an account is not a Routine* — and production runs all
four research Routines under **one** account:

```
Brain Research A  ENABLED  target=4
    Brain Research A     trig_01CBLu5oCZziEwznw5q9xU7g  fires=321 refusals=2 no-shows=0
    Brain Research 1-B   trig_01TT7u3m4T6JW14vjwsK9qHm  fires=24  refusals=0 no-shows=0
    Brain Research 1-C   trig_01QbxS8dWTcqV3zoEhx9wBen  fires=25  refusals=0 no-shows=0
    Brain Research 1-D   trig_015aYoUwidycXymZ2xxWBC5B  fires=25  refusals=0 no-shows=0
    V1-oak  RETIRED  trig_0137jBhBj9fwHCM13Aaf7DTN  fires=0
    V1-oak  RETIRED  trig_01YJpttXm67Nft6gcUUnXQAS  fires=21 refusals=21
friend-2  ENABLED  target=2
    V2  QUARANTINED  trig_01HR74TmLtm8L21sh2Xryqhq  fires=12
        "sessions complete without checking in operator hold"  (2026-09-05T17:15:23Z)
verify-hosted-account-a   trig_verify_hosted_a  secret=VERIFY_HOSTED_NEVER_SET  (not routable)
verify-hosted-account-b   trig_verify_hosted_b  secret=VERIFY_HOSTED_NEVER_SET  (not routable)
```

So: two accounts after the name-prefix filter, one with a proven Routine
(HEALTHY) and one holding a quarantined Routine (UNAVAILABLE) — `1`. Against a
denominator of `REQUIRED_CAPACITY_ACCOUNTS = 4`, a constant written when the
intended topology was four people with one account each. It was never a
measurement of anything.

### The real state of the four research Routines

All four are **ENABLED**, all four are bound to `wkr_1cdd82cfb2a54faf8edd`, all
four have their deployment secret present, and all four appear in the
dispatcher's candidate list. `4 eligible now` is correct. Nothing was wrong with
the fleet.

### `friend-2` — kept, not deleted

`V2` is **QUARANTINED** with the reason `sessions complete without checking in
operator hold`, recorded 2026-09-05T17:15:23Z. It stays exactly as it is:

- it keeps its row, its account, its worker binding, its 12 fires and its reason;
- it appears in the capacity reading as `UNAVAILABLE` with that reason shown at
  administrator depth;
- it is **not** presented as one of the friends' current Claude connections,
  because it is a legacy surface under a legacy account and the member journey
  registers its own;
- nothing here lifts the quarantine. §29 is explicit that clearing a health
  state so a reading looks better is weakening the control to satisfy the
  evaluator. `fleet set-state` is the answering transition and it is a person's.

Likewise the two `V1-oak` Routines: RETIRED, kept, and shown under **Retired
surfaces** rather than mixed into the live list.

### What replaced the count

One source — `fleetSnapshot()`, the same impure read `services/dispatch/loop.ts`
performs every tick — and **three labelled readings**:

* `eligibleNow` — the dispatcher would fire it this instant;
* `proven` — a session Brain fired arrived, was handed a bin and finished it
  (`proveSurface`'s four rows);
* `waiting` — registered, and something an operator does is outstanding.

with the configured concurrency target named as a **target**. There is no
denominator that implies failure, because there is no measurement behind one.

The page reads **every** Routine rather than only the candidates: the snapshot
drops one whose secret is not deployed on purpose (§23: do not spend a fire
discovering it), and a surface waiting on its administrator must read as
*waiting* rather than vanish.

---

## 3. The identities on the People list

### What each row is

| Display name | What it is | Where it comes from |
| --- | --- | --- |
| `Hosted verification` | a member fixture for the hosted authorization checks | `scripts/verify-hosted.ts`, `verification-member@brain.invalid` |
| `Hosted verification owner` | the OWNER of the verification-scope project, deliberately **not** a Brain administrator so the isolation checks have something to isolate | `scripts/verify-hosted.ts`, `verification-owner@brain.invalid` |
| an older email identity | the account created before passkeys existed | the bootstrap administrator, or an account an administrator made |
| `friend-2` | **not a person at all** — a `fleet_accounts` row, i.e. a capacity account | `fleet register-account` |

The first two are recreated by every deploy. They were being counted as two of
the four people the sprint was waiting for, which made the count wrong in the
one direction that matters: it reported more of the team as present than were.

`friend-2` was never on the People list — it was on the *capacity* list, which
is a different question, and it is still there with its real state.

### The typed distinction

Migration 065 adds `users.kind` (`PERSON` | `SYSTEM`) and
`fleet_accounts.kind` (`CAPACITY` | `VERIFICATION`), following
`projects.purpose` from migration 028 and its comment: *declared, not inferred*.

- The backfill names the two `@brain.invalid` addresses and nothing else. A
  migration that guessed which existing accounts were real would be making
  exactly the judgement the column exists to stop being guessed.
- `verify-hosted.ts` declares `kind: 'SYSTEM'` and `kind: 'VERIFICATION'` at
  creation, so it is stated rather than recognised from now on.
- Unknown reads as the **machinery** value in both mappers. The two mistakes do
  not cost the same: leaving a real person off a list is a complaint, and
  counting a fixture as a person is the defect silently back.
- **Nothing is deleted.** Every one of those rows keeps its memberships, its
  history and its audit trail. `npm run admin -- people list` prints every
  identity with its kind, so "where did Hosted verification go" resolves to a
  column.

This replaces `name.startsWith('verify-hosted')`, which was a string comparison
standing in for a fact and stops working on the first row somebody names
differently.

---

## 4. Connecting a Claude account

### The credential model, traced before anything was built

`services/dispatch/fire.ts`:

```ts
export function resolveToken(secretName: string): string | null {
  return (process.env[secretName] ?? '').trim() || null;
}
```

A Routine's bearer is a **deployment secret**. Nothing in this repository can
write one — not a route, not a tick, not an administrator's session — and
`fleet_routines` keeps only the *name* of the variable plus a digest taken once
at registration. So one step belongs to a Brain administrator, and the design is
arranged around that rather than against it. **No second, weaker registration
route was invented beside the real one, and there is no column anywhere in
`capacity_connections` that could hold a credential.**

### The member's steps

On **People & capacity → My Claude connection**, every value in its own copy box:

1. **Connector** — the connector name Brain assigned, and the MCP URL. Add the
   custom connector in Claude; approve it on Brain's own consent screen.
2. **Routine** — the Routine name Brain assigned, the bootstrap repository to
   attach (`brain-worker-bootstrap`, which is what lets a fired worker read
   `.claude/settings.json` and call the connector's tools without stopping at a
   prompt), the connector to enable, and *schedule: off*.
3. **Trigger** — paste the `trig_…` id. An address, not a secret.
4. **Secret** — the name of the deployment variable, to send with the bearer to
   an administrator privately. The friend never opens Fly and is never given
   access to the owner's organisation.
5. **Probe** — one bounded `DETERMINISTIC_CHECK`.
6. **Healthy** — the session, the bin, and when it finished.

### The administrator's steps

1. **People & capacity → Claude connector link** beside that member: mints their
   worker identity, grants it the shared root, and issues a one-time invitation.
   It confers nothing on its own — a client holding it cannot read anything,
   call a tool or obtain a token until a person approves it.
2. **Diagnostics → Connections** lists every member's connection and the exact
   variable each is waiting on. No value of any kind.
3. `flyctl secrets set <THE_NAME>=<the bearer> --app northline-brain`.

Brain resumes from rows the moment it is set. Neither person repeats a step.

### The progress states

`NOT_STARTED` · `CONNECTOR_AUTHORIZED` · `ROUTINE_DETAILS_NEEDED` ·
`WAITING_FOR_ADMIN` · `CONFIGURED` · `PROBE_SENT` · `ARRIVED` · `HEALTHY` ·
`FAILED`

A `CHECK` constraint, not free text: a status a caller could write is a status a
caller could claim.

**HEALTHY is `proveSurface`'s four rows**, never a trigger id or a secret
existing. Brain fired it; a session arrived and was attributed to the bound
worker *from that same dispatch row*; it was handed a bin; the bin reached
`COMPLETE`.

### Resumability

Every transition is a guarded `UPDATE` naming what it moves from, and every
derived state is re-read from rows. A refresh resumes. A restart resumes. Two
tabs produce one effect. Re-submitting the same trigger id registers one
surface. A failed probe is retried against the **same** connection, account and
Routine.

### Two guards that were on the wrong value, found by re-reading the diff

- `setTrigger` compare-and-swapped on the connection's *state*, so a submission
  naming a **different** trigger matched, succeeded, and replaced a recorded one
  — while the refusal written for that case could never fire. It swaps on
  `trigger_ref IS NULL` now, and a different id is refused before anything is
  written.
- `sendProbe` created the bin and swapped the state afterwards, so two
  concurrent presses built two bins.

The replacement for the second one was **also wrong, and only Postgres could say
so**. It claimed the state — `WHERE state = ?`, with `?` the state the caller
had just read — which passes on SQLite because writers are serialized there, and
fails on Postgres because the second caller reads `PROBE_SENT` and then claims
`WHERE state = 'PROBE_SENT'`: the state it was claiming into. The CI Postgres
suite reported `expected 2 to be 1` on a tree whose SQLite suite was green.

What is claimed now is `probe_bin_id IS NULL` — the one value that means nobody
holds this yet and is never what a winner leaves behind — and the bin is made as
a **DRAFT** (`DISPATCHABLE_SQL` does not select one) so a loser retires a bin
that was never dispatchable. Verified both directions on a real local cluster:
the rejected version fails there, this one passes there and on SQLite.

---

## 5. What reading these pages does

Nothing. No enqueue, claim, replay, cancellation, registration, fire or
credential mutation — asserted against the queue, the bins and the fire
counters rather than stated in a comment.

Two things *are* written, and naming them exactly is better than a sentence that
is nearly true: the connection row that assigns a member their three names
(because a name that changed between two reads would be one somebody had already
pasted into Claude), and that connection's `state`, reconciled from rows.
Neither creates an account, a Routine, a worker, a credential or a bin.
