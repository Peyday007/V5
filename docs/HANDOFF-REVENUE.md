# Handoff — overnight revenue integration (2026-10-01)

Branch `claude/v5-overnight-revenue-hxf1gz`, based on `production` @ `0041975`
(which is what production serves: `SERVING_REVISION 00419753…`, read 15:43Z).
Nothing here is deployed. A person merges it into `production`; `Deploy` ships it.

## What the branch carries

| Source | What it does for the commercial journey |
| --- | --- |
| PR #69 (`fcp_0de77e…`) | A crashed or timed-out external effect is reconciled, never resent |
| PR #71 (`fcp_7f9811…`) | A hold in another currency no longer reduces this sprint's deployable cash |
| PR #42 (`fcp_943652…`) | Brain records "contacted the buyer" only on a provider receipt (`cash/effects.ts`) |
| PR #45 (`fcp_a90370…`) | A person records quote / invoice / payment-accepted after the first move |
| PR #46 (`fcp_89c081…`) | Re-offer, exhaust and archive controls on the Cash page |
| PR #48 (`fcp_316b42…`) | Commit spend under the grant, release it, settle it, from the Cash page |
| PR #44 (`fcp_a147a6…`) | An idea parked for want of research authority resumes when the grant exists |
| PR #43 (`fcp_57fc1d…`) | Every research kernel opens a question and records its round atomically |
| `bcfac5c` (new) | A READY/EXECUTING piece shows a sendable offer composed only from its card, refusing with a named list when a load-bearing field is blank; owner view only |
| `06877c5` (new) | "Money is in" (`COLLECTED`) refuses until a `SETTLEMENT` on that opportunity, net of refunds, is on the ledger; the page records a payment and a settlement per piece |

Conflicts resolved: `Cash.tsx` (Actions: #45's authority-disabled controls + #46's
reoffer project picker), `cashApi.ts` (#48 `settleCommitment` + #45 `act` docs).

## Verification

- `npm run typecheck`: clean.
- `npm run test:impacted --base origin/production` (SQLite): 41 files, 970 passed,
  1 skipped — on the eight merged PRs. Then the settlement/offer changes:
  `cashMode`, `cashIntegrationPass`, `cashHttp`, `cashDeploymentSmoke`,
  `russellNervousSystem`, `step12bProduct`, `cashSection`, `cashOffer`,
  `sharedCashAccess` all green.
- Postgres impacted run: see the PR description for the result.
- After the launch-window fix (`5097b47`): typecheck clean; `test:impacted`
  (SQLite) 47 files, 1106 passed, 1 skipped; on Postgres the launch suites
  (`russellLaunchWindow`, `russellConnectedPath`, `russellIntegrationPass`,
  `russellState`, `cashPipelineRepair`) green.
- The full gate runs once on `production` after merge (`Postgres suite`, `Deploy`).

## The journey, as it now stands on this branch

discover → qualify (deep dive) → card → READY → **sendable offer** → person sends
it and records the first move → quote / invoice / payment accepted recorded →
delivering → **customer payment + settlement recorded on the piece** → money is in.
Every step after "READY" is a person acting outside Brain and Brain recording it
with references. Brain itself sends nothing: no messaging or invoicing adapter
is registered, so `SEND_A_MESSAGE` and invoicing read `MISSING`.

## What still prevents a first real commercial attempt

1. **Merge + deploy** this branch (a person; `production` is the only deploy path).
2. **A qualified opportunity.** Production reported 0 qualified / 0 ready (§47).
   Deep dives are bounded at 2 in flight; not raised tonight on purpose.
3. **A commercial authority grant** on the operating project, naming
   `CONTACT_BUYER`, `QUOTE_AND_INVOICE`, `ACCEPT_PAYMENT` — a person's decision
   on the Cash page.
4. **Provider choice** for Brain-performed messaging / invoicing (not established
   in the repo). Until chosen, the person sends the offer and Brain records it.
5. Production reading, 2026-10-01 15:44Z (`Cash report` run 36886582426, serving
   `0041975`): Cash Mode 1 (`prj_22fb4fec295f403a8a22`) ACTIVE, USD; research
   grant ACTIVE; **commercial authority ABSENT**; 100 ideas, all QUEUED. The report
   then died inside `cashRoadmap` on its own one-client pool's ten-second wait —
   fixed on this branch in `scripts/cash-report.sh` (the `factory.sh` remedy:
   sixty seconds of patience, not more clients). Opportunity/tier counts were not
   reached, so "0 qualified" is still the §47 reading, not tonight's.
   The refinement read (`Closeout report` run 36889235009, 16:05Z) never got a
   connection at all: `initDatabase` timed out on the ten-second default while
   the Brain held its own pooler clients. So *why the 100 ideas are QUEUED* is
   **not established** tonight. `closeout-report.yml` now passes
   `BRAIN_DATABASE_CONNECT_TIMEOUT_MS=60000` at the call site, which reaches the
   already-deployed image.
   **Then it answered** (run 36890242369, 16:14Z, serving `0041975`): 40
   openings, `NEEDS_PERSON=8 BLOCKED=32`, 0 of 2 slots in flight. All 32 BLOCKED
   are round 2 with `candidate=QUEUED mission=— passes 0/0`: the deep dive's idea
   never launched, and the six-hour stall backstop closed it. The report then
   calls them `ROUNDS_SPENT … the sources do not publish the rest`, which is not
   what happened — nothing was ever researched.
   **Cause, from the code:** `nextLaunchable` (`russell/loop.ts`) took
   `LIMIT 50` over *every* QUEUED candidate in the Brain and only afterwards
   dropped the ones it could not launch. A launched idea stays QUEUED by
   design, and one with no compiled spec is skipped silently, so ideas that
   already had a live/parked/DONE mission (re-launch is a no-op replay) filled
   the window and nothing behind them was ever looked at. Fixed on this branch
   (`nextLaunchable` filters on spec and on having no non-terminal mission in
   SQL; `repairLaunches` still repairs live missions on its own). Regression
   `tests/russellLaunchWindow.test.ts` fails on the old query, passes on both
   backends.
   **Not yet fixed, deliberately:** the 32 dives spent both rounds on stalls that
   researched nothing. Refunding the round before the launch fix is deployed
   would re-open a dive every six hours that still could not launch. Once the
   fix is live and dives are seen launching, the round budget for those 32 is a
   follow-up (count only rounds whose mission existed).
   **Also unestablished:** an idea refused for a whole-project reason (no grant,
   concurrency full) still occupies the window; not observed as the cause here.

## Not taken, deliberately

- PR #36 (Russell → software delivery back into the thread): sound, not on the
  money path; left for its own review.
- Remaining Factory PRs (#40–#87 not listed above): correctness work, not merged here.

## Next executable task

Merge this branch's PR, deploy, read `Cash report`, then grant commercial authority
and take the top qualified piece through the offer card.

## Post-#88 recovery run (2026-10-01, 19:40Z onward)

**#88 is not merged.** `production` is still `0041975`; the deployed Brain serves
`00419753…` (Cash report run 36916110318). Nothing below is live until a person
merges #88 and `Deploy` runs from `production`.

### Production, read 19:45Z (Cash Mode 1, `prj_22fb4fec295f403a8a22`)
- 40 opportunities: **40 SIGNAL, 0 CANDIDATE, 0 QUALIFIED, 0 READY_TO_TEST**.
- Deep dives: 32 `BLOCKED` with `candidate=QUEUED spec=yes mission=none yet`
  (the launch-window defect, confirmed per row), 8 `NEEDS_PERSON` with
  `mission=NEEDS_HUMAN`.
- Ideas: 100, all QUEUED. Research grant ACTIVE (concurrency 6); commercial
  grant ABSENT.
- 199 packets, **122 NEEDS_HUMAN**. 19 failed work items, ~14 of them
  `RESEARCH_SYNTHESIZE` exhausted on 2026-09-17..20 with
  `brain_submit_synthesis 'That call could not be completed'` — the storage-key
  defect §33 records as fixed and proven 2026-09-21. All ten discovery rounds
  are PARKED or RESEARCHING with `found=not counted yet`; the parked ones say a
  synthesis recorded nothing.

### Engineering on #88 since
- `49020fb` — `resumeUnlaunchedDives` (on the tick): a BLOCKED dive whose
  current idea is QUEUED with no mission is resumed in place; only rounds whose
  idea has no mission are given back (read from each
  `CASH_VALIDATION_STARTED`); earlier never-launched ideas are parked so they
  cannot launch orphan missions; one resume per idea; takes only free slots;
  `CASH_VALIDATION_RESUMED` records it. `tests/cashDiveResume.test.ts`, green on
  SQLite and Postgres. Repairs the 32 after deploy with no manual edits.

### Recovery in production that does not need #88
- `packets syntheses cash-mode-1` (read) then `packets recover-synthesis
  <workItem> --admin <owner>` for each eligible item: the existing, guarded
  transition for exactly this failure (reissues only an item that recorded
  nothing, checks the store for a stray upload, resets nothing, idempotent).

### Commercial authority — proposed, NOT granted (person decision)
Nothing is QUALIFIED yet, so the smallest grant that lets the first real test
run once one is:
- actions: `CONTACT_BUYER`, `QUOTE_AND_INVOICE`, `ACCEPT_PAYMENT`;
- `maxCommittedCents` 0, `maxPerActionCents` 0 — no owner capital moves;
- `maxConcurrent` 1–2 opportunities; expiry 30 days;
- deliberately excluded: `SPEND_FROM_ALLOWANCE`, `PURCHASE_TOOL_OR_DATA`,
  `ENGAGE_CONTRACTOR`, `RUN_PAID_TEST` — no planned test needs them.
`SEND_A_MESSAGE` / invoicing read MISSING (no provider), so even with the grant
a person sends and Brain records it with references.

### Synthesis recovery, done 20:07–23:21Z (no #88 needed)
`packets syntheses cash-mode-1` found 38 stopped syntheses:
- **13 ELIGIBLE → recovered** (`packets recover-synthesis`), each re-read as
  `ALREADY_RECOVERED`: packet SYNTHESIZING, bin READY, mission RUNNING, a
  replacement item QUEUED (e.g. `orc_2e3f04b7ae4042498ebd` →
  `wki_aa82d85f30bf406593e1` on `bin_b8cfb741825a4671bc31`).
- **12 BIN_EXHAUSTED** — need `step10 regrant <bin> --reason filing-defect`,
  a reason code this branch adds (`83993fd`), so after deploy.
- **13 ALREADY_FILED** — NEEDS_HUMAN for reasons other than the filing defect.

### Why the recovered work is not running (Fleet run 36941457265, 23:33Z)
`fleet explain-route bin_b8cfb741825a4671bc31` →
**`NO_SURFACE_SERVES_THIS_PROJECT`**. Of 19 Routines: 11 QUARANTINED (every
research surface on `wkr_1cdd82cfb2a54faf8edd` — Brain Research A, 1-B/C/D,
Airyn 2-A..D, V2 — plus Factory surface 1), 4 RETIRED, and the 4 Caleb 3-A..D
surfaces enabled but bound to `wkr_1db1193323454ee69bb1`, which holds no
membership on Cash Mode 1. In flight: 0.
**Not taken, deliberately:** granting Caleb's worker Cash Mode 1 would widen a
worker's reach into another person's private operation, and `fleet set-state
--to ENABLED` on eight rows would put each back three unanswered fires from
re-quarantine: the quarantine reads as *the worker identity stopped
answering* (§23), which is a Claude-side connector/Routine fix.
**Person action:** in the owner's Claude account, check the Routines behind
Brain Research A / 1-B..D (connector selected, repository attached, sessions
arriving), then `fleet set-state --kind routine --to ENABLED` one surface and
watch one fire arrive before the rest. The recovered bins resume by themselves.

## Single-surface recovery attempt (2026-10-02, 01:40Z)

- **#88 is still not merged.** `production` and `deployed/production` are both
  `0041975`; none of `5097b47` (launch window), `49020fb`
  (`resumeUnlaunchedDives`) or `83993fd` (`filing-defect`) is deployed.
- **Cause of the quarantine, read from Claude's own session records:** every
  owner research Routine (Brain Research A `trig_01CBLu5o…`, 1/B, 1/C, 1-D)
  uses the one `cloud-brain` connector (`78cc0603…`,
  `https://northline-brain.fly.dev/mcp`), and that connector starts every
  fired session as **`needs-auth`**, so `brain_check_in` does not exist in the
  session. First seen 2026-09-23 13:58Z (`cse_01NmwyTfxgENDEVkZPE8PV61`).
- **Test:** Brain Research A set `QUARANTINED → ENABLED` at 01:42:19Z; Brain
  fired it at 01:42:23Z (`cse_01Dr4HZkBfxz34eA1qbWhZG3`); the session reported
  `cloud-brain: needs-auth` and ended at 01:42:42Z without checking in. Set
  back to `QUARANTINED` at 01:43:07Z. One activation spent; no others enabled.
- **Person action:** reconnect `cloud-brain` at
  https://claude.ai/customize/connectors (sign in to Brain on the consent
  screen and approve worker `wkr_1cdd82…`). One reconnect covers all four
  Routines. Then re-run this test on Brain Research A only.

## Revenue execution run (2026-10-02) — stacked on #88

Branch `claude/revenue-execution-integration-i52sxq`, cut from #88's head
`a23884c`. Nothing here is deployed and nothing here needs #88 merged to be
reviewed; it composes with #88 because it is built on it. Nobody was
contacted, nothing was invoiced or charged, no grant was created, no provider
was chosen.

### Existing PRs, checked against #88's head
- **#42, #45, #48, #69**: each PR's own head (`75b0aad`, `d8459f7`, `a4cee0a`,
  `f8d0883`) is an ancestor of #88 (`git merge-base --is-ancestor`). Nothing of
  theirs is missing. Each can be closed once #88 merges; this branch adds what
  they did not cover (below).
- **#36** (Russell software delivery back into the thread): not on the
  commercial path. Not taken.

### What was missing on #88, and is now built
1. **An UNCERTAIN commercial effect could only be settled from a console
   route.** `/operations/:id/resolve` has no client caller and needs an
   operation id nobody can find, because keys are stored only as digests.
   Commercial operations now carry a correlation Brain composes
   (`cash:<opportunity>:<action>:<occurrence>[:<retry>]`). The Cash page lists
   each piece's attempts and settles an unknown one with *Say what happened to
   this attempt*. "It happened" needs the provider's reference (and, for a
   payment, the amount). "It did not happen" closes it as FAILED. Route:
   `POST /api/cash/opportunities/:id/resolve-effect`.
2. **Crash after send was unreachable.** `runExternalEffect` never set
   `recover_after`, so a process that died mid-send left the operation
   `RESERVED`, and it read IN_PROGRESS for ever. `resumeAfterCrash` (#69) could
   only run in a test that wrote the column by hand. Each external attempt now
   arms a 15-minute lease (`armRecovery`); a later caller takes over and asks
   the provider. It never resends, except for a natively idempotent adapter.
3. **A provider refusal left no record.** It was a sentence in a tick report.
   It is now an open need (`effect-failed:`) carrying the provider's category
   and detail, and the piece does not move.
4. **Only CONTACT_BUYER could ever be Brain-performed.** QUOTE_AND_INVOICE
   (`cash.issue_invoice`, capability `ISSUE_AN_INVOICE`) and ACCEPT_PAYMENT
   (`cash.take_payment`, `TAKE_A_PAYMENT`) now have the same contract. Both read
   PRESENT only when a real adapter is registered for their namespace; none is
   registered, so both read MISSING in every deployment. The payload comes from
   the ledger, never from composition: an invoice is for the `PIPELINE_AGREED`
   amount, a payment for what is still outstanding. A confirmed payment also
   records a `CUSTOMER_PAYMENT` with the receipt as its verified reference.
   Settlement stays a separate entry.
5. **"Have Brain do it"** (`POST …/perform`, person-initiated). It asks the
   grant about the exact action, requires the capability to be PRESENT, and
   compares the page's `expectedOccurrence` (it never uses it to build the
   key). So a second press after the first was recorded is refused rather than
   becoming a second invoice. It also refuses while an earlier attempt at the
   same action is unknown. After a person says an attempt did not happen, the
   next press uses a new key (`…:<retry>`); a retryable refusal keeps its key.
6. **The page could not show a piece's execution.** The owner view carries
   `myCurrentWork.records[opportunityId]`, derived on read
   (`cash/record.ts`): actions with who performed them, agreed / paid / settled
   / outstanding from the ledger, Brain's attempts and their status, and what
   Brain could perform, with the reason where it cannot. The page also gains
   *Record the agreed amount* (`PIPELINE_AGREED`) beside payment and
   settlement. The member projection is unchanged.

The tick's contact path, the person's "have Brain do it" and a person settling
an unknown all go through one handler, `applyEffectOutcome`. Each records
under the same `actionKey`, so a race between them writes one row.

### Test evidence
- `npm run typecheck`: clean. `npm run build`: clean.
- `tests/cashCommercialJourney.test.ts` (in-process real router, real
  database, synthetic adapter only at the provider boundary): J01 READY → Brain
  contacts → agreed → Brain invoices → second press refused → Brain takes the
  payment → collect refused → settlement → COLLECTED, with every figure read
  from the server. Also J02 uncertain → no resend → reconciled once; J03 crash
  after send → taken over and reconciled, no resend; J04 person settles "it
  happened"; J05 "did not happen" → explicit retry; J06 refusal kept on a need;
  J07 no adapter → MISSING, nothing sent; J08 the page's own controls settle an
  unknown. Green on SQLite and on Postgres 16.
- Mutation checks: removing the recovery lease fails J03; removing the
  occurrence comparison fails J01 (a second invoice is sent).
- `test:impacted --base a23884c`: see the PR description for both backends.

### What remains

**Code gap**
- ~~An attempt that succeeded but whose recording was refused shows as
  UNRECORDED until a person presses again.~~ Closed in the follow-up below.
- Brain never invoices or takes payment on its own initiative. Only a person's
  press triggers either. That is deliberate (no signal establishes "the work is
  agreed and done"), not an omission.

**Provider / credential gap**
- No adapter exists for `cash.contact_buyer`, `cash.issue_invoice` or
  `cash.take_payment`. Choosing a messaging, invoicing or payment provider and
  supplying its credentials is the owner's decision. An adapter must declare its
  effect class (idempotent / reconcilable / opaque); `assertAdapterContract`
  refuses one that lies about it.

**Person-only authorization**
- A commercial authority grant on the operating project, naming
  `CONTACT_BUYER`, `QUOTE_AND_INVOICE` and `ACCEPT_PAYMENT`. The proposal above
  stands.
- Every external act until an adapter exists: the person sends, invoices and
  takes payment, and records each with its reference.

**Production integration**
- Merge #88, then this branch, into `production`; `Deploy` ships it.
  Production still serves `0041975`.

## Follow-up (2026-10-02): a confirmed effect always reaches the record

The last provider-independent gap: a provider confirmed an effect and Brain's
own record of it did not land. Before this, `applyEffectOutcome` returned
`PERFORMED_NOT_RECORDED` and kept nothing, so the receipt sat on a SUCCEEDED
operation and the page read UNRECORDED until somebody pressed again.

### The mechanism

- **Durable truth is the existing operation.** `idempotency_operations` already
  holds `state = SUCCEEDED`, the receipt in `result_ref`, and the correlation
  `cash:<opportunity>:<action>:<occurrence>[:<retry>]`. "Confirmed but not
  recorded" is derived: such an operation with no `cash_actions` row under
  `actionKey(opportunity, action, occurrence)` — or, for a payment, no ledger
  entry under `payment:<opportunity>:<receipt>`. No new table, no migration.
- **Send-time context is written before the send.** An operation keeps only a
  payload digest, so `sendCommercialEffect` now requires the authority it was
  sent under, the amount it moves and the piece's state, and appends one
  `CASH_EFFECT_INTENT` row to `cash_events` (append-only) before calling the
  provider, once per correlation.
- **Entry point: the durable tick.** `operate()` runs
  `reconcileConfirmedEffects(projectId)` immediately before
  `advanceWithinAuthority`, in every sprint state. It calls
  `recordConfirmedEffect`, the same function a send, a person's resolution and
  a replay use, so there is one meaning of a receipt.
- **No resend.** The reconciliation path calls no adapter at all. The tick
  also no longer reaches a READY piece that already has a contact on record
  (it retries only the transition), and a person's "reach the buyer" on such a
  piece is refused. A mutation that drops that guard sends a second message.
- **No duplicates.** The action is `ON CONFLICT DO NOTHING` on its request key
  and the payment on its idempotency key; the pass skips anything already
  complete, and writes `CASH_EFFECT_RECONCILED` only when it created a row.
  A second pass writes nothing (asserted by counting rows and events).
- **Authority after send.** The action is attributed to the grant in the
  intent, not to whatever is live now. `recordMoneyEvent` skips its second
  ACCEPT_PAYMENT check only when a SUCCEEDED take-payment operation in the same
  project carries exactly that receipt; anything else still meets the grant.
  A revoked grant still refuses every *new* effect — asserted.
- **State that no longer fits.** A contact on a piece that is still READY
  begins execution if that is allowed now; otherwise, and for any effect on a
  piece that is no longer executing or delivering, the action is recorded with
  no transition and an `effect-unapplied:` need says why. The contact need
  settles from the row once execution begins (the tick does it from the
  recorded contact when the grant allows); the others are a person's.
- **Operations from before intents existed** are attributed to a grant that
  covers the action now; with none, an `effect-unattributed:` need keeps the
  receipt visible rather than writing it against an authority nobody can name.

### Proof

`tests/cashEffectReconciliation.test.ts` (real routes, real tick, real DB;
synthetic adapter at the provider, one injected write failure for A and E):
A confirm-then-local-fail, B crash after confirmation (restarted adapter, no
send), C revocation in flight (invoice and contact), D archived in flight,
E payment once with no settlement plus a partial (action without ledger
entry) record, F second pass writes nothing. All seven fail against the
previous server code; unwiring the pass from the tick fails A, B and both E.
