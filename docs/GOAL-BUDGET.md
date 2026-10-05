# Research goals and their budget

A person approves a research goal once. After that Brain creates the packets
the goal needs, inside the goal's ceilings, without asking again.

## What a goal is

A research goal is a `russell_goals` row with `purpose = 'RESEARCH_GOAL'` and
`work_policy = 'CAPPED'`. It is invisible to every standing-authority reader, so
it never becomes Russell's standing grant. It carries what it is for:

- `research_assignment` — the question the goal researches;
- `research_layer_id` — the layer its packets file under.

Both are set by `createResearchGoal`'s optional inputs and are NULL on a
standing grant. A goal with no assignment, or no layer, is never continued.

## The ceilings, and who enforces each

| Ceiling | Enforced by | When |
|---|---|---|
| Packets | `reserveGoalPacket` reserves one as kind `MISSION`; `createOrchestration` settles it | before the packet exists |
| Fragments | `createFragments` charges the goal's fragment ceiling; a plan over it parks the packet at `NEEDS_HUMAN` naming the ceiling | when the fragments are created (settled at creation) |
| Deadline | `startPacket` for a new packet; `packetRunner` for fragments still `PLANNED` | on Brain's clock (`authorityNow()`), never a worker's |
| Money | pinned at zero on the goal row; `startPacket` refuses a budget claiming otherwise | always |

Raising any ceiling is a person's decision. Nothing in the continuation pass
raises one.

### Deadline semantics

After the deadline no new packet and no new fragment is created. Work already
queued may finish: rows already written are never touched, and an accepted
claim stays accepted.

### Money

`max_external_spend` is 0, paid overages are off, and `ALWAYS_PROHIBITED` is
unioned in. A goal cannot carry spend by any input.

## The continuation pass

`advanceResearchGoals()` (`server/services/research/goalContinuation.ts`) runs
once per Russell tick, inside a `try` so a failure never stops the tick.

For each active research goal with an assignment — one narrow indexed query
over `(purpose, state)`, named columns, at most five goals per pass, oldest
first:

1. A goal with a live (non-terminal) packet is left alone. A packet waiting on
   a person (`NEEDS_HUMAN`) is live.
2. A goal whose latest packet was cancelled is left alone.
3. A goal whose latest packet finished with every mandatory research
   requirement settled is left alone.
4. The archive is asked first, through `coverBeforeWork`. When it already
   answers the assignment nothing starts. Unused allowance is a ceiling, not a
   target; zero packets is a correct number.
5. Otherwise `startPacket` runs in `GOAL_BUDGET` mode with packet key
   `round-<n>`, where n is one more than the goal's packet count. Two passes, a
   retry, or a restart between reservation and creation compute the same key
   and produce one packet.

### When a ceiling stops it

`startPacket` throws `GoalBudgetExhausted`. That is not a failure: nothing was
created and nothing existing was touched. The pass raises exactly one
`russell_human_requests` row through `askHuman`, with
`resume_key = goal-budget:<goalId>:<ceiling>`, naming the ceiling and saying
that raising it is the person's decision. Repeated ticks find the same key and
create nothing more. While that request is open the goal is not retried.
Every accepted fragment, claim and filed report stays.
