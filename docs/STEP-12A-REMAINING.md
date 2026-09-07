# The single remaining-conditions checklist

One list, driven to completion. Updated in place rather than appended to, so
there is never a question of which copy is current.

Two standards are being tracked, and they are not the same thing:

- the **twenty-two gates** `scripts/step12a-acceptance.ts` derives from
  production rows, which is what `npm run step12a:acceptance` exits 0 on;
- the **seventeen conditions** frozen in
  `docs/STEP-12A-ACCEPTANCE-SCENARIO.md`, carried forward unchanged by
  `docs/STEP-12A-ACCEPTANCE-SCENARIO-2.md`.

Mutation 14 closed the three places where a gate was **weaker** than the
condition it reports on (§50). Where the two still differ, the condition wins.

---

## The approval interaction

The default Needs you surface presents a complete research permission and one
**Approve**. The owner already supplied the purpose and bounds; requiring them
to enter those again, or showing four numeric controls as the primary
experience, is not the agreed interaction. **Change limits** reveals optional
edits, hidden until asked for. Viewing the card never creates a grant. Approval
uses the authenticated route, and an active grant keeps its withdrawal path.

The proposal derives its purpose from the project and its 2/1/12/3 limits from
the server's own constants. The bounded-rollout expiry is exactly
`2026-10-06T00:00:00.000Z` — not extended on refresh, not widened to unlimited,
and not converted to the end of the day. It can be changed explicitly, with UTC
labelled. Changing projects resets unsaved edits, so one project's permission is
never submitted against another.

**The status has to agree with the card.** An outstanding approval counts as the
decision it is, in the briefing sentence and the nav badge. Both previously
counted `russell_human_requests` rows only, so the briefing read "You are not
needed" above an approval that gated everything.

### Who verified what

Recorded separately because the prepared patch's own note claimed more coverage
than its tests carry, and an inherited claim is still a claim.

**From the prepared patch** (`a046486`, unchanged): one approval without
configuring anything; editing optional and reflected in what is being approved;
a purpose and expiry required if the owner clears them; and the server proposing
the same name and fixed expiry while creating nothing.

**Added here** (`a5c93a5`), because the patch's note listed them and its tests
did not contain them: the exact body `Approve` submits, asserted from the
request rather than the screen; the stored row read back at the server, expiry
included; the class of work and the money stated on the card; the detail hidden
until asked, with `aria-expanded`; an edited ceiling reaching the request; a
server refusal shown in its own words with the decision still on offer; and the
briefing and badge never contradicting an outstanding approval.

Local verification: `npm run build` clean; **1,756 tests** pass.

**Deployed** as mutation 16, run `34158835836` from `a5c93a5`: typecheck, tests,
build, deploy, hosted verification before a real unannounced restart and again
after it. Confirmed on the live bundle — *Change limits*, *Approve*, *Research
only* and *No paid API spending* all present; the old form's *Allow this* and
*Until when? Leave this empty* both gone; and `/api/russell/.../authority`
answers 401 to an anonymous caller.
No production grant, deployment, acceptance result or fleet change is implied.

The objective remains completing the connected 12A journey and its live
acceptance. This correction does not reset that work or add acceptance gates.

## What the whole thing is now waiting on — current

Two owner actions, both inside Russell, neither of them configuration.

### 1. Answer the Needs You decision: **Stop this work**

`rhr_b63a5478249e4b508803` is open on `rms_8e96b5f246464c069451`. The mission was
launched from a placeholder specification (§54.2), its packet holds no
fragments, no claims and no audits, and there is nothing in it to file.

**Choose "Stop this work."** Mutation 18 stops offering "Record what could not
be settled" on a packet with nothing to record — but this request was written
before that, so it still carries both choices on its row. Clicking the other one
is now refused at the transition with the reason, and the request stays open
rather than being marked answered; nothing is damaged either way, but Stop is
the answer that finishes it.

Stopping settles the mission's reservation, leaving **one of the two** the
standing authority allows.

### 2. Send the two frozen messages, in order, in the same conversation

Both are in `docs/STEP-12A-ACCEPTANCE-SCENARIO-2.md` §6, measured against the
merge floor before being frozen. Wait for Russell to answer the first before
sending the second, so the capture exists for the second to be judged against.

### The older list, kept

## What the whole thing was waiting on

The two owner actions below remain required. The approval-card correction
prepared after mutation 15 must ship before asking the owner to perform them:

1. **A standing research authority for Deal Dispatch**, granted by the owner in
   **Russell, under "Needs you"**. Without it every judged idea parks —
   correctly — and conditions 7 to 15 cannot run at all.

   It was briefly on the operator console, which was a mistake: §22's rule that
   the console holds the button is about *machines*, and 12A took that console
   off the normal route. Mutation 15 moved it. Nobody is sent to `/operator` for
   this.
2. **The frozen message, sent by a person into a new conversation.** Condition 1
   is "one human message, one turn"; a row inserted by a script is not that.

Then one authorized deployment: `ACCEPTANCE_SCOPE.conversationId` re-pinned to
the new conversation, with the old value moved to `PREVIOUS_SCOPES` rather than
deleted, per scenario 2 §5.3.

### Mutation 14 is deployed

Run `34097522616` from `e7a9be5`: typecheck, 1,721 tests, build, deploy, hosted
verification before a real unannounced restart and again after it — every step
green. The five joined transitions, the Ideas decision controls and the three
strengthened gates are live.

### The conversation id is no longer something to hand over

`chain-watch` reads the chain from inside the machine. It could not run when it
was written — `BRAIN_DATABASE_URL` is a Fly secret rather than a repository one,
so a CI checkout cannot reach the database — and it was not in the image
mutation 14 deployed. Mutation 16 carried it, so the anchor conversation, its
turns, its ideas and their merges are readable at any moment without anybody
reading an id off a screen.

---

## The gates

`READY` means the machinery exists and is deployed, and the gate is waiting only
on the run. It is **not** a claim that the gate will pass — that is what the run
decides.

| Gate | State | Waiting on |
| --- | --- | --- |
| A01 shell identity | READY | the live read |
| A02 conversation route | READY | the run |
| A03 route correction | READY | the run |
| A04 irrelevant text creates nothing | READY | the live read |
| A05 dedupe, `method = 'SEMANTIC'` | READY | the run — producer built in §49, gate tightened in §50 |
| A06 stored judgment, override supersedes | READY | the run — route built in §49, control in §50 |
| A07 probe bounds | READY | the run |
| A08 coverage before work | READY | the run |
| A09 authority and budget | READY | **the grant**, then the run |
| A10 mission pipeline | READY | **the grant**, then the run |
| A11 independent audit | READY | three sessions on the run's orchestration |
| A12 writeback | READY | the run |
| A13 automatic follow-on | READY | the run — producer built in §49; a worker declaring one is its own decision |
| A14 human decision, same mission resumes | READY | the run — park built in §49, gate corrected in §50 |
| A15 recovery | READY | the live read |
| A16 Deal Dispatch freshness | READY | derived at read time |
| A17 privacy and authorization | READY | the live read |
| A18 earlier baselines | READY | the live read |
| A19 delivery ledger | RECORDED | runs `34097522616`, `34146782575`, `34158835836` in the ledger, `EXPECTED` 16; reads clean once the scope-pin deployment brings the image level with the tree |
| A20 usable read surfaces | READY | the live read |
| A21 living project map | READY | the live read |
| A22 fast chat routing | DEFERRED | excluded from the denominator by prior authorization |

## The seventeen conditions

| # | Condition | State |
| --- | --- | --- |
| 1 | One human message, one turn | waiting on the message |
| 2 | Correct context attachment | waiting on the run |
| 3 | Meaningful candidate capture | waiting on the run |
| 4 | Deterministic **and** semantic dedupe | reachable since §49; unreachable before it |
| 5 | Stored priority and reason; an override supersedes | reachable since §49; controls in §50 |
| 6 | Bounded probe within its envelope | waiting on the run |
| 7 | Accepted-current coverage before a mission | waiting on the grant |
| 8 | Atomic authority/budget reservation | waiting on the grant |
| 9 | Exactly one mission, orchestration and bin | waiting on the grant |
| 10 | Authentic Routine dispatch and check-in | waiting on the run |
| 11 | Research → audit → filing → citations | waiting on the run |
| 12 | Three authentic sessions, truthful tier | waiting on the run |
| 13 | Accepted terminal state | waiting on the run |
| 14 | Exactly-once writeback | waiting on the run |
| 15 | Exactly-once follow-on launch | reachable since §49; unreachable before it |
| 16 | Visible on every surface | merge visibility added in §50 |
| 17 | Genuine park and **same-mission** resume | reachable since §49; gate corrected in §50 |

---

## Two readings that cost time, recorded so they are not repeated

**`step10 report` does not see this chain.** It is scoped to
`step-10-acceptance prj_361119f7fd344fda8558` and reported 97 bins, all
terminal — a completely healthy answer about a completely different project.
Deal Dispatch's Russell bins are not visible through it, so "is the judgment
bin in flight or stuck" cannot be answered with the tooling currently deployed.
`chain-watch` shows candidates, probes, missions and requests, and deliberately
not bins.

That is a real gap and it is **not** being closed mid-run: extending
`chain-watch` would make the one remaining authorized deployment something
other than scope-pin-only. It is recorded for Step 12B instead.

**A restart is less dangerous to a live turn than it first looks.** A worker is
a Cowork session holding a lease recorded in the database, not in the Brain's
memory. Restarting the Brain makes MCP calls fail for a few seconds; it does not
kill the worker, and the lease survives. Waiting for a "quiet moment" that a
30-second tick never actually provides would have deferred the scope pin
indefinitely for a risk that is mostly imagined.

## Where the run actually got to — S12A-ACC-2

Read from production, not from a report. Every id below is a row.

| Condition | State | What the rows say |
| --- | --- | --- |
| 1 One human message, one turn | **PASS** | `rmsg_e86bc50020aa4833b183` USER 203 chars, answered by `rmsg_fca6315a4d1e4bd1bbc9`, both COMPLETE, one attempt |
| 2 Correct context attachment | **PASS** | `rcv_02d5312e9d41465a9e0f` on `prj_9d86dfaec863473cb498` |
| 3 Meaningful candidate capture | **PASS** | `rcn_85f9689b461c4972a1ba`, canonical, unmerged, in the anchor — not folded into the pre-existing permit idea scenario 2 §4 warned about |
| 4 Deterministic **and** semantic dedupe | **FAIL — repaired in 18** | the near-duplicate answered `ANSWER_ONLY`; the manifest never said a repeat is still a capture. §54.1 |
| 5 Stored priority and reason | **PASS** | `WORTH_DOING`, reason 50 chars, override=no |
| 6 Bounded probe | not reached | the judgment was not `cheapToReduce`, so no probe was called for — a worker's decision, not forced |
| 7 Coverage before work | **PASS** | the launch ran the archive check; `alreadyAnswered` false, decided by Brain |
| 8 Atomic authority/budget reservation | **PASS** | one reservation against `rgl_30e34d717d9f4b47a6a9`, approval `RUSSELL_STATE_LICENSING_V1` at 21:31:19.509Z |
| 9 Exactly one mission, orchestration and bin | **PASS** | `rms_8e96b5f246464c069451` / `orc_e1afa97f566d4b468373` / `bin_2922f249b95845ddb193`, one of each |
| 10 Authentic dispatch and check-in | **PASS** | `wkr_1cdd82cf…` assigned four times, heartbeat renewed, releases recorded with reasons |
| 11 Research → audit → filing | **FAIL — cause repaired in 18** | the assignment was the word "test"; 0 fragments, 0 claims, 0 audits. §54.2 |
| 12 Three sessions, truthful tier | not reached | no audit passes, because there was no research to audit |
| 13 Accepted terminal state | **PASS, in the direction that matters** | `BIN_COMPLETION_REFUSED` — the packet is `NEEDS_HUMAN`, which is not a state it files in |
| 14 Exactly-once writeback | not reached | nothing terminal to write back |
| 15 Exactly-once follow-on | not reached | no mission finished |
| 16 Visible on every surface | **PASS** | the park reached Needs You within a tick, count 1 |
| 17 Genuine park and same-mission resume | **park PASS, answers repaired in 18** | `rhr_b63a5478249e4b508803` OPEN, derived from the packet — but its explanation named a stop that had not happened, above a choice that could not act. §54.3 |

**The three failures are Brain's, they are diagnosed to the row, and none of
them is a worker behaving badly.** The worker released a corrupted manifest
three times rather than researching nonsense, and `requestCompletion` refused to
file. What was missing in every case was a check upstream.

**Nothing was forced.** No research was re-run to produce a better outcome, no
judgment was rewritten, and the mission's history is intact.

## The earlier reading, kept

## The run is under way — S12A-ACC-2

`chain-watch` on the anchor, run `34161633943` at 21:02:30Z.

```
STANDING AUTHORITY  1 grant(s)
  rgl_30e34d717d9f4b47a6a9  ACTIVE   Deal Dispatch discovery research
  missions 2 · fragments 12 · concurrent 1 · probes 3
  owner usr_14439966398243339341   granted 2026-09-07T20:53:22.449Z
  expires 2026-10-06T00:00:00.000Z

ANCHOR  rcv_02d5312e9d41465a9e0f   2026-09-07T20:53:45.528Z   turns=2
  rmsg_e86bc50020aa4833b183  USER    COMPLETE  chars=203
  rmsg_fca6315a4d1e4bd1bbc9  RUSSELL COMPLETE  chars=664

IDEAS  1
  rcn_85f9689b461c4972a1ba  CAPTURED  canonical=—  override=no  followOnOf=—
MERGES 0 · PROBES 0 · MISSIONS 0 · NEEDS YOU 0
LOOP  RUNNING  gen=10634  last error none
```

At 21:28 the near-duplicate had arrived and its turn was still pending a
worker:

```
TURNS  4
  rmsg_e86bc50020aa4833b183  USER    COMPLETE  chars=203
  rmsg_fca6315a4d1e4bd1bbc9  RUSSELL COMPLETE  chars=664
  rmsg_8851902b76a344d4bc1f  USER    COMPLETE  chars=119
  rmsg_db75a5da08f9412c9905  RUSSELL PENDING
IDEAS 1 · MERGES 0 · PROBES 0 · MISSIONS 0
```

and the first candidate was still unjudged 35 minutes after capture. That is
consistent with its planning bin waiting for a worker rather than with anything
being wrong — every stage here is one Cowork activation, and §22 already records
that the largest single block of elapsed time in Step 9 was a packet sitting in
a queue. It is reported as *waiting*, not as *stuck*: the difference is whether
a bin exists, and see above for why that is currently unanswerable.

**The grant is exactly the approved proposal**, expiry included — the instant,
not the end of its day and not unlimited.

**Condition 3's shape holds so far.** One candidate, `canonical_candidate_id`
null, in the anchor conversation, with no merge row. Scenario 2 §4 named the
way this could have gone wrong — a first capture folding into the pre-existing
permit idea `rcn_23e70baee1ba47478c28`, which would make condition 3
unsatisfiable and condition 4 untestable, and would be a fault in the scenario
rather than in Brain. It did not happen.

What is **not** yet decided: the candidate carries no priority and no reason, so
`judgeCandidate` has either not run or has asked a worker and is waiting. That
is the next thing to watch, not a result.

## Production, read after mutation 16

`chain-watch`, run `34160122219` at 20:37:48Z — the first time it has been able
to run at all, since mutation 16 is the deployment that carried it into the
image.

```
PROJECT  Deal Dispatch  prj_9d86dfaec863473cb498
STANDING AUTHORITY  0 grant(s)
  none — every judged idea will park, correctly, until one exists.

CHAIN FROM  rcv_35d5b0340fc4479fa443          (S12A-ACC-1, intact)
  rmsg_d10b82a9b724401c8127  USER    COMPLETE  chars=207
  rmsg_b56979f1d6fd4839a3ff  RUSSELL FAILED
  rmsg_52239a165ecc44ba9287  RUSSELL COMPLETE  attempt=2
  rmsg_4752e7f351aa4570a822  RUSSELL COMPLETE  attempt=3
IDEAS 0 · MISSIONS 0 · NEEDS YOU 0

LOOP  RUNNING  gen=10585  last error none  per tick: launches 1 · events 50
```

Four things worth stating from it:

- **No grant exists.** Nothing was created on anyone's behalf while this was
  being built.
- **ACC-1 is whole** — the original message, the refused first attempt, and both
  retries, with their attempt numbers. The three-attempt ceiling is spent and is
  not being reset; ACC-2 is a different question, not a fourth try.
- **The loop is healthy**, has run within the second, has no recorded error, and
  is permitted to launch. A loop that is `RUNNING` and allowed to launch nothing
  reads identically to one with nothing to do, which is why the bounds are
  printed.
- **The project id is `prj_9d86dfaec863473cb498`.** An earlier note in this
  session quoted `prj_b8002f50902e4a6eb2da`, which is the id in a local
  development database and does not exist in production. Corrected here rather
  than left to mislead the next read.

## The fleet, read from production after the deployment

`fleet show`, run `34100003866` at 08:19:49Z. Unchanged, as required:

```
primary   ENABLED  target=2
    V1    ENABLED  worker=wkr_1cdd82cf…  secret=BRAIN_ROUTINE_TOKEN
          fires=66  refusals=0  no-shows=0  in-flight=1
friend-2  ENABLED  target=2
    V2    QUARANTINED  secret=BRAIN_ROUTINE_TOKEN_2
          fires=12  refusals=0  no-shows=0  in-flight=0
```

V2 stays quarantined. V1 is healthy on both counters that can condemn a
surface — a refusal is not misconduct and never quarantines, and the no-show
counter has been credited from arrivals since Step 11 closed. The two
`verify-hosted-*` accounts have never had their secrets set and are reported as
not routable, which is what that state is for.

## What is deliberately not being done

- **The grant is not created by a script.** §22's rule that the console has the
  button — "a machine that could create its own work could also create work
  nobody asked for" — is the same rule that makes a script-minted grant a
  loophole rather than a shortcut. The authority is the owner's act.
- **The frozen message is not inserted.** Condition 1 asks for a person's
  message; a row is not one.
- **`S12A-ACC-1` is untouched.** Its conversation keeps every message, attempt
  and outcome, and §38–§46 record how it failed. The scope pin moves it to
  `PREVIOUS_SCOPES`; nothing is deleted.
- **No research outcome is forced.** Whether a worker declares a follow-on,
  names a duplicate, or judges an idea worth doing is the worker's decision, and
  a scenario that cannot fail has not been passed.
