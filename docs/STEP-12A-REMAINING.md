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

## Approval interaction — implementation prepared, not deployed

The default Needs you surface must present a complete research permission and
one **Approve** action. The owner already supplied the purpose and bounds;
requiring them to enter those again, or displaying four numeric controls as the
primary experience, violates the 12A interaction requirement. **Change limits**
reveals optional edits. Viewing the card never creates a grant. Approval still
uses the authenticated route, and the active grant retains its withdrawal path.

The initial proposal derives its project name and 2/1/12/3 limits on the server.
Its bounded-rollout expiry is exactly `2026-10-06T00:00:00.000Z`; it is not
silently extended on refresh or converted to the end of the day. The form can
explicitly change it, with UTC labelled. Changing projects resets any unsaved
edits so one project's permission is never submitted to another by accident.

Local verification: production build (including typecheck) passed; 61 shell and
authority-surface tests passed. These cover opening without granting, approving
without typing, the exact submitted bounds and expiry, optional edits, refusal
without false success, existing withdrawal, and person/worker authorization.
No production grant, deployment, acceptance result or fleet change is implied.

The objective remains completing the connected 12A journey and its live
acceptance. This correction does not reset that work or add acceptance gates.

## What the whole thing is now waiting on

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

### One thing the owner has to hand over besides the two actions

The new conversation's id. `chain-watch` was built to find it without anybody
retyping anything, and then could not: `BRAIN_DATABASE_URL` is a Fly secret
rather than a repository one, so a CI checkout cannot reach the database and
the script has to run inside the machine — which means it has to be *in* the
machine, and it is not in the image mutation 14 deployed.

The scope-pin deployment carries it, and after that the chain is readable at
any moment. Until then the id comes from the browser: the conversation's own
address is `https://northline-brain.fly.dev/conversation/rcv_…`.

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
| A19 delivery ledger | RECORDED | run `34097522616` in the ledger, `EXPECTED` 14; will read clean once the scope-pin deployment brings the image level with the tree |
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
