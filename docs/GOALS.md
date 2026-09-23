# Goals

What it means for Brain to own a goal over time, and how to read one.

---

## The question it answers

A person gives Brain a goal, leaves, and comes back. They ask four things:

> What happened? What is happening now? What happens next? What needs me?

Brain already recorded every part of the answer — campaigns, missions, packets,
bins, requests, documents, audits — and before this a person had to open six
surfaces and join them by hand. A goal is that join, kept.

## What a goal is

**A workstream (the work register, `docs/WORK-REGISTER.md`) with four things a
person said and three decisions a person can make.** There is no new
orchestration object, no second queue, and no stored status.

| Stored | Whose words | Why it cannot be derived |
| --- | --- | --- |
| `intent` | the person, or the row it was filed from | What the goal is for. |
| `outcome` | the person | What counts as finished. |
| `owner_user_id` | the person | Whose it is. |
| `due_at` | the person | By when. |
| `commitment` | the person | `NONE`, `INTERNAL`, or `CUSTOMER` — owed to somebody outside. |
| `paused_*`, `cancelled_*` | the person | "Not now", and "not at all". |

Everything else is derived on every read (`server/services/goals/model.ts`):
the lifecycle, the linked work down to the bins, the dependencies, the waiting
condition, the next action and who performs it, the blockers with their
remedies and ages, the decisions a person must make, the evidence of what was
delivered, the authority it runs under, and what is still owed.

**A goal is complete when every piece of work it pursues says it delivered** —
a filed document, a finished mission, an attested merge, deployment or live
verification. Never because somebody said "done".

## How it keeps moving with nobody watching

The durable Russell tick calls `advanceGoals` (`services/goals/tick.ts`) every
pass. It does three things, each derived from rows and idempotent by them:

1. **Holds.** A paused or cancelled goal's live bins are held; so are an active
   goal's while a goal it depends on is unfinished. A held bin is neither fired
   by the dispatcher nor handed out by the assigner — the hold is in
   `claimableStateSql`, the one predicate every reader composes — and it keeps
   its lease, attempts, generation and events. A worker already inside a bin
   finishes what it is doing.
2. **Release.** When the reason stops being true — resumed, reinstated, the
   dependency completed — the hold is released on the next pass and the work
   continues where it stopped. **That is the whole of "resume": no stage
   button, no new prompt.**
3. **Allocation.** Each owner's goals are ranked and their live bins given the
   priority the rank maps to (8, 7, 6, then 5), so the dispatcher's and
   assigner's own `ORDER BY priority DESC` hands capacity out in the order the
   goals say. Capped at 8 so a conversation turn (9) is always answered first.
   A move of position is recorded, append-only, with the fact that moved it.

Routine recovery is not reimplemented here, because it already exists: an
expired lease is claimable work (§19), an unanswered fire is reopened (§24), a
packet's and a campaign's next stage are enqueued by their own ticks, and an
answered request is carried out by `resumeAnsweredRequest`. What the goal tick
adds is that a person's decision about a goal *means something* to that
machinery.

## Priority

Lexicographic, never a weighted score. The criteria, in order:

1. **Workable** — active and not waiting on another goal.
2. **Commitment** — owed to a customer, then committed internally, then none.
3. **Deadline** — earliest first; *no deadline sorts after any deadline*, because
   an unknown is never the favourable reading.
4. **Purpose** — pursuing money, clearing the way for money, a capability, long
   term.
5. **Unblocks** — how many other goals wait on it.
6. **Age** — set first.

The first criterion two goals differ on is the whole reason one is above the
other, and each goal carries that sentence.

**Ranked within an owner and a project.** Four people run four private
operations on one fleet, so one person's commitments never decide how much
capacity another person's work gets, and no rank can reveal how much work sits
in a project a reader cannot see.

## Interruption and correction

| Decision | What it causes | What it never does |
| --- | --- | --- |
| Pause | live bins held on the next tick | cancel, reset or spend an attempt |
| Resume | holds released; work continues | retry an effect — Step 6 still keys it by work item; `UNCERTAIN` effects are counted and never resent |
| Cancel | Brain stops pursuing; bins held, reinstatable | end a customer obligation or release committed cash — both are reported as still owed |
| Reinstate | holds released | reverse a separate pause |
| Change objective | the old words are kept on the event | stop work started under the old objective — supersede its links, which keeps their rows |
| Depends on | this goal's bins held until the other completes | accept a cycle, or a goal the caller cannot read |

## Needs You

A goal puts a decision in Needs You only when a person's authority, judgement,
access or resources are genuinely required:

* an open human request on a mission the goal pursues (answered on its own card);
* a change request nobody has approved;
* a campaign awaiting release;
* a pull request only a person can merge (Brain cannot, §27).

Each carries the proposed action, every available answer with what it causes,
what work waits on it, and what Brain does by itself afterwards. Private
requests stay in their owner's own Needs You.

## Reading it

**In Russell:** *Work* opens with Goals — the briefing across goals (delivered,
waiting on you, stuck longest, commitments), then every goal, each opening in
place to its intent, outcome, authority, position and why, decisions, blockers,
dependencies, linked work down to the bins, and evidence. *Home* carries the
headline and each active goal's next milestone. *Needs You* carries goal
decisions that are not already a request card.

**Over HTTP**, every route `requirePerson` (a worker is refused by type, reads
included) and scoped through `decideProjectAccess` with one 404 body for absent
and forbidden:

| Route | |
| --- | --- |
| `GET /api/goals` | briefing and every readable goal |
| `GET /api/goals/:id` | one goal, its events and its priority history |
| `POST /api/goals/:id/pause` `{reason}` | |
| `POST /api/goals/:id/resume` | |
| `POST /api/goals/:id/cancel` `{reason}` | |
| `POST /api/goals/:id/reinstate` | |
| `PATCH /api/goals/:id/terms` `{outcome, ownerUserId, dueAt, commitment}` | owner must be a project member |
| `POST /api/goals/:id/objective` `{intent, outcome}` | |
| `POST /api/goals/:id/depends-on` `{goalId}` | refuses cycles |

**On a terminal / in production:** `npm run goals -- show`, and the `Goals`
workflow (`.github/workflows/goals.yml`) for `show`, `file`, `pause`, `resume`,
`cancel`, `reinstate`, `depends`, `terms`. `file --from <row>` files real
recorded work as a goal with that row's own words as its intent — it composes
nothing.

## What it deliberately does not do

* No percentage, no progress bar, no score.
* No completion by assertion.
* No new work: releasing a hold makes already-authorized work claimable again.
* No automatic regrant of an exhausted bin — that stays an operator's decision
  (§38) and is named as the blocker's remedy.
* No priority above a conversation turn.
