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

## What the whole thing is now waiting on

Everything scoped is waiting on the same two facts, and neither is a code
change:

1. **A standing research authority for Deal Dispatch**, granted by the owner in
   the operator console. Without it every judged idea parks — correctly — and
   conditions 7 to 15 cannot run at all.
2. **The frozen message, sent by a person into a new conversation.** Condition 1
   is "one human message, one turn"; a row inserted by a script is not that.

Then one authorized deployment: `ACCEPTANCE_SCOPE.conversationId` re-pinned to
the new conversation, with the old value moved to `PREVIOUS_SCOPES` rather than
deleted, per scenario 2 §5.3.

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
| A19 delivery ledger | PENDING | mutation 14's run id recorded, `EXPECTED` 13 → 14 |
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
