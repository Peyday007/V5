# The replacement Step 12A acceptance scenario — S12A-ACC-2

Declared **before** it is run, and before its scope is pinned, for the reason
the first one gave: a standard chosen after a result is not a standard.

The first run, `S12A-ACC-1`, is **not deleted, not edited and not reinterpreted.**
`docs/STEP-12A-ACCEPTANCE-SCENARIO.md` stands, its conversation
`rcv_35d5b0340fc4479fa443` keeps every message, attempt, proposal and outcome,
and `docs/STEP-12A-EVIDENCE.md` §38–§46 record exactly how it failed. It is the
historical evidence for three real defects, and it is worth more as that than it
would be as a passing run.

---

## 1. Why a replacement rather than a fourth attempt

The frozen question spent all three attempts it is allowed, on three different
defects:

| attempt | outcome | cause |
| --- | --- | --- |
| 1 | `FAILED` | `MISSING_REQUIRED_PART` — the manifest never stated six required fields |
| 2 | `COMPLETE`, no effect | `RUN_PROBE` accepted and executed by nothing |
| 3 | `COMPLETE`, `captureDeclined` | the capture gate judged the worker's statement instead of the person's question |

The ceiling is not being reset, raised, or worked around through a different
parent. All three causes are now repaired; what is missing is a question that
has attempts left.

## 2. What changes, and what deliberately does not

**Unchanged:** the seventeen conditions, the layer expected
(`Discovery Logic`), the probe envelope (`GENERAL_LIGHT_PROBE_V1`), the bounds,
and every falsification rule in §4 of the original. The standard is the same
standard.

**Changed:** the subject, and only so that legitimate deduplication is
*testable* rather than accidental. See §4 — this is the one place where reusing
the permit subject would corrupt the run rather than merely repeat it.

## 3. The frozen inputs

### The human message, exactly

> Do the counties we care about publish property tax assessment rolls in a form
> we could actually consume — a bulk download or an API — and on what terms? I
> want to know before we lean on it for valuation.

### The near-duplicate, for semantic dedupe

Sent **only after the first has been captured**, deliberately reworded so a
fingerprint cannot match it:

> Asking again another way: is assessment roll data available anywhere in bulk
> or by API, and are we permitted to use it?

**Expected:** no second candidate. It resolves to the first by semantic
comparison, with a `russell_candidate_merges` row whose `method` is `SEMANTIC`.

### Attachment

Project **Deal Dispatch**, layer **`Discovery Logic`** — *How we find
opportunities*. Assessment rolls are a source of opportunities, not a pricing
input, so an attachment to Monetization Logic or Qualification Logic **fails
condition 2**, exactly as in the first scenario.

## 4. How deduplication against existing candidates is evaluated

This is the part the first scenario did not have to think about, and it must be
settled in advance because the archive is no longer empty.

Deal Dispatch already holds **`rcn_23e70baee1ba47478c28`** — the permit-data
idea captured on 2026-09-04, now judged `PARKED`. The frozen permit question
would plausibly and *correctly* merge into it, and a run whose first capture
merged instead of creating would leave condition 3 unsatisfiable and condition 4
untestable. That is a defect of the scenario, not of Brain.

So:

- **Condition 3 requires a new canonical candidate**, `canonical_candidate_id IS
  NULL`, whose `conversation_id` is the anchor. A merge here fails it.
- **A merge into any pre-existing candidate is a scenario failure, not a Brain
  failure**, and is reported that way. The remedy is a subject genuinely outside
  the archive — which is why the subject changed.
- **Condition 4 requires exactly the opposite**: the near-duplicate must produce
  a merge, `method = 'SEMANTIC'`, onto the candidate created by the first
  message. A second canonical candidate fails it.
- Both are judged against the **chain**, walked from the anchor by foreign key,
  so a similar candidate elsewhere in the Brain neither satisfies nor breaks
  anything.
- The archive check is expected to return **not answered** for the first
  message. If `judgeCandidate` parks it as already answered, that is a *pass* of
  §13 and a fail of this scenario's premise, and it is reported as the premise
  being wrong rather than quietly re-run with different words.

## 5. Preconditions, all of which must hold before the first message

1. Mutation 13 deployed: the capture gate reads the person's message, and the
   operator console can grant a standing authority.
2. **A standing research authority exists for Deal Dispatch**, granted by the
   owner through the console, with the limits they approved. Without it every
   judged idea parks — correctly — and conditions 7 through 15 cannot run.
3. `ACCEPTANCE_SCOPE.conversationId` re-pinned to the **new** conversation, in
   its own commit, *after* the message exists and *before* the reporter is
   trusted. The old value moves to `PREVIOUS_SCOPES` rather than being deleted.
4. A new conversation with **no prior history**, per §6 of the original.

## 6. What this document does not authorize

Nothing. Running it needs the owner's approval of the authority limits, then of
the deployment, then of the run itself. No expectation in it may change after a
result is seen; a scenario that cannot fail has not been passed.
