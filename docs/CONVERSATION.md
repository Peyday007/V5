# Conversation — the fast lane, the money, and the teacher loop

Every Russell reply before this was carried by a Cowork Routine: a bin, a
dispatch, an activation, three minutes. That proved the execution path and it
is not a conversation. This is the seam for a direct, streamed reply — and,
far more importantly, the boundary around what such a reply is allowed to cost
and allowed to decide.

Nothing here is switched on. The deployed Brain has no API key, no provider
configuration, no enabled model and no spend authorization, so every turn still
goes to the fleet exactly as it did. That is the correct state until somebody
authorizes otherwise, and it is the state the tests assert.

---

## 1. One Russell, three speeds

| Lane | Carried by | For |
| --- | --- | --- |
| `FAST` | a direct model, streamed | discussion, recall, navigation, explanation, brainstorming, provisional connections |
| `DEEP` | a stronger direct model | abstraction, conflict, uncertainty, consequence |
| `WORK` | the existing fixed-subscription Routines | research, planning, implementation, synthesis, audit, filing, canonical writeback |

The interface presents one continuous Russell. There are no separate
personalities and a person is never asked which model they would like.

`services/conversation/lanes.ts` decides, from the turn's own text and facts
the server already holds. **Nothing a model says about itself contributes**: a
fast model that could declare a turn simple could route its way around the
boundary.

Escalation is a closed vocabulary — `ASKED_TO_DO_WORK`, `NEW_MAJOR_IDEA`,
`CONFLICTS_WITH_KNOWLEDGE`, `LOW_CONFIDENCE`, `HIGH_STAKES`,
`SPENDING_OR_IRREVERSIBLE`, `COMPLEXITY`, `ASKED_FOR_DEEP_CHECK` — because
these are counted, compared and shown to a person, and a reason invented at the
call site is a reason nobody can act on.

**Recall is not an instruction.** The first version of the verb list contained
a bare `decide`, which sent *"what did we decide about the fee?"* — pure recall,
the exact thing the fast lane exists for — to a three-minute activation. Verbs
are now matched as phrases, and a turn that opens by asking about the past
suppresses the work escalation. It does **not** suppress the others: *"what did
we decide about the licence?"* is still a legal question and still takes the
stronger lane.

What the fast lane may never do is listed in `FAST_LANE_MAY_NOT` and enforced
at each guarded service rather than in that list. A list some other module has
to remember to consult is a policy engine, and §21 already refused to grow one.

---

## 2. The spending boundary

**Discussion of pricing did not install a key and does not grant spending.**

Five things must all be true before one token is bought:

1. an adapter with a credential (`adapter.ready()`);
2. a `spend_authorizations` row that is **enabled**, in force, and not expired;
3. a **ceiling above zero** — a ceiling of zero is a permission to spend
   nothing, which is a refusal;
4. a model in that authorization's **explicit** `allowed_model_ids`; and
5. a **known, versioned price** for it.

Each failure has a name (`NO_CREDENTIAL`, `NOT_AUTHORIZED_TO_SPEND`,
`CEILING_REACHED`, `MODEL_UNAVAILABLE`) and each name has a sentence a person
reads. There is no branch anywhere that treats a missing row as permission.

### The ledger

    UNIQUE (authorization_id, period_key)
    CHECK  (held_micros + settled_micros <= ceiling_micros)

A reservation is a **compare-and-swap on `spend_ledger.generation`**, carrying
the arithmetic in the same `WHERE` clause that makes the commit. Two callers
may both read a total with room in it; exactly one `UPDATE` matches. That is
the third time this codebase has needed the same primitive — the queue's
`lease_generation`, the fleet's `fire_generation`, and now this — and the same
reason each time: **the claimant does not supply the value it is compared
against.**

The `CHECK` is what makes the guarantee true rather than merely tested. A test
asserts it directly, by writing past the application straight at the row.

### Four rules that are easy to get wrong

- **The worst case is reserved, not the expected case.** Maximum billable
  input and the model's maximum output, at the pricing version in force. An
  expected-value reservation lets concurrent calls collectively exceed a
  ceiling each of them individually respected.
- **An unknown price fails closed.** Never a guess, never a default, never the
  last price seen.
- **An unknown outcome keeps its hold.** Step 6's rule applied to money: a
  timeout is not evidence that nothing was spent, and neither is a reset from a
  provider that may already have done the work. Only a refusal that provably
  never reached the provider releases a hold.
- **A period's ceiling is copied when the period opens.** Lowering an
  authorization tomorrow does not make today's committed spending retroactively
  over budget.

### The key is not the permission

An `ANTHROPIC_API_KEY` in the environment enables nothing by itself. It is a
capability; the authorization row is the permission; and conflating them is how
a system starts spending because somebody set an environment variable.

---

## 3. No model name in the code

`llm_models` holds the provider's exact identifier, versioned pricing dated to
when it was true, the lane it is a candidate for, and an `enabled` flag that
defaults to off. `chooseModel` takes the cheapest row that serves the lane.

There is no model name anywhere in `services/conversation/`, which is the
point: the addendum is explicit that Haiku must not be hardcoded before
evidence compares it with Sonnet, and the way to keep that true is to have
nowhere to hardcode it. A production routing change is a row, not a deployment.

A deep turn never falls *down* to a fast model. If no deep model is configured
the turn goes to the Routines, which are stronger than the fast lane rather
than weaker.

### The benchmark, when it is authorized

The manifest is rows in `llm_models` — configurable official ids and current
versioned pricing — never aliases in business logic. The protocol is:
predeclare the rubric and thresholds; use frozen synthetic, redacted or
explicitly authorized cases; blind the answer identity for the strong review;
include a person's judgment where product meaning is involved. **No model may
grade itself into production.**

Measured per candidate: time to first token, total time, input/output tokens
and cost, project and idea attachment, retrieval precision, abstraction and
cross-project connection, willingness to challenge a weak idea,
unsupported-claim rate, correction rate after strong review, voice consistency,
user-visible usefulness.

---

## 4. The Context Hat

Not fine-tuned weights — nobody is training a model here, and pretending
otherwise would be the kind of claim this platform exists to refuse. It is the
practical equivalent: a bounded, ordered, authorized assembly compiled fresh
each turn from Russell's identity, the recent messages, the project's state,
accepted knowledge with its citations, open gaps, active work, and any
**accepted** standing instructions.

Three properties matter more than the content:

- **bounded** — a character budget spent in priority order, identity first;
- **authorized** — every source read through a boundary that already exists, so
  the hat cannot become a way to see round a refusal;
- **honest** — `omitted` is part of the result, because a grounded answer built
  on a truncated context is still a truncated answer.

---

## 5. The teacher loop

A fast answer may be reviewed later by something stronger. Two halves, and both
are the point.

**A review reads a manifest, not a conversation.** The manifest names the exact
message ids, may only name turns from its own conversation, inherits the
conversation's visibility, and carries the human and project scope a reviewer
must already be authorized for. `reviewerMayCarry` takes the review and the
surface's scope and nothing else — **capacity is not in the signature**, because
capacity is a scheduling fact and this is an authorization question, and the
moment they meet in one function the cheap answer wins. A friend's account with
spare capacity is still somebody else's account.

**A lesson becomes a proposal.** `proposeRule` has no `state` parameter, so
there is no call that creates an accepted rule. `standingInstructions` returns
`ACCEPTED` rules only: feeding a proposal to the model would make it effective
without the decision, which is the loophole the mechanism exists to close. A
rejected rule keeps its row and its reason.

Reviews are debounced by **conversation version**, enforced by a unique index
rather than a timer, so a busy conversation cannot fire a Routine after every
reply — which would recreate the latency problem the fast lane exists to solve,
and pay for it twice.

Classifications are the closed set `PASS | CORRECT | RESEARCH | PLAN | CAPTURE
| IGNORE`, matched exactly.

---

## 6. What is proved, and what is not

**LOCAL / CODE PROOF.** The lane decision, the reservation arithmetic, the
ceiling under concurrency, the database-level impossibility of over-commitment,
idempotent reservation, settlement from a usage report, unknown-outcome
handling, the context hat's bounds, manifest scoping, rule promotion, and the
turn path taking the fast lane without creating a bin — all tested, on both
backends.

**NOT PROVED.** No real provider has ever been called. `A22_FAST_CHAT_ROUTING`
is `NOT_RUN` and must stay `NOT_RUN` until a turn has actually taken the fast
lane against a real provider — which needs a key, an authorization and a
ceiling that nobody has granted. Adapter contract tests are code proof, not
live acceptance, and the distinction is the same one Step 3 drew between the
research engine passing its tests and a real job having run.
