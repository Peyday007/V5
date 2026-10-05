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
They are both-or-neither, and the layer must be the goal's own project's.

A person sets them through the two doors that open a goal:
`POST /api/projects/:id/research-goals` takes `assignment` and `layerId`, and
`npm run admin -- research goal create … --assignment "…" --layer <name|id>`.
Without them a person starts each packet with `research start --goal`. Until
these two doors took the fields, nothing outside the tests could open a goal
that continues by itself, so the continuation pass was reachable by no shipped
entrance.

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
over `(purpose, state, research_considered_at)`, named columns, at most five
goals per pass, least recently considered first (see *Rotation* below):

1. A goal with a live (non-terminal) packet is left alone. A packet waiting on
   a person (`NEEDS_HUMAN`) is live.
2. A goal whose latest packet was cancelled is left alone.
3. A goal whose latest packet finished with every mandatory research
   requirement settled is left alone.
4. The archive is asked first, through `coverBeforeWork` (see *The archive
   marker* below for when it is not re-asked). When it already
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

### The archive marker

A goal the archive answers stays `ACTIVE`, so without more the pass would run
`inventoryProject` and `coverBeforeWork` for it on every tick for ever. When
`coverBeforeWork` says the archive fully answers a goal, the pass records the
marker that decision was made against in `russell_goals.research_archive_marker`.
Later passes recompute the marker with narrow indexed reads and skip both calls
while it is unchanged, with the reason `answered by the archive; unchanged since
<time>`. There is no timer and no recheck interval.

The marker is composed only of state that already moves when the inputs to the
decision move:

- the project's newest `project_events` row (every import, extraction and
  filing records one), via `idx_events_project`;
- the shared findings coverage reads: their count, the newest `updated_at`, and
  the earliest `valid_until` of an `ACTIVE` finding that is still ahead of
  Brain's clock, so a finding expiring changes the marker once the clock passes
  it;
- the goal's own `research_assignment` and `research_layer_id`.

A shared finding's eligibility also depends on its claim, so the writers of
what `ELIGIBLE_SQL` reads touch `shared_findings.updated_at` for that claim in
the same call: `markContradiction` (contradiction state), `decideClaim`
(accepted) and `updateFragment` when it moves a fragment's status. The other
columns it reads (`sourced`, `validation_state`, `source_url`, `derived`) are
written when a claim is inserted, before it can have been promoted. The marker
is written against the value read before coverage ran, so a change that lands
during the read is seen on the next pass. When the archive stops answering, the
marker is cleared.

### Rotation

Candidates are ordered `COALESCE(research_considered_at, ''), created_at, id`
(never-considered first; no `NULLS FIRST`, so SQLite and Postgres agree), and
`research_considered_at` is stamped with Brain's now on every goal the pass
looks at, whatever the outcome. Settled, answered or person-waiting goals
therefore cannot hold all five slots: every active goal is reached within
`ceil(goals / MAX_GOALS_PER_PASS)` passes, and a restart resumes from the
stamped rows. `MAX_GOALS_PER_PASS` is unchanged. Duplicate packets remain
impossible for the old reason: `startPacket` replays `round-<n>` on
`UNIQUE (goal_id, goal_packet_key)`.
