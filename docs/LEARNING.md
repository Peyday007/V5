# Learning from outcomes

Brain preserved a great deal of history and changed almost nothing because of
it. `research_retrospectives`, `deal_observations` and the puzzle lessons were
all derived carefully and all ended the same way: shown to a reader, never
applied. This is the path from a measured result to a changed decision.

Code: `server/services/learning/`, `server/repos/learning.ts`,
`server/domain/learning.ts`, migration `092_outcome_learning.sql` /
pg `083_outcome_learning.sql`. Surface: `/learning` in Russell, a line in the
Home briefing, and `npm run report:learning` (`closeout-report.yml`
`what=learning` on production).

## The path

```
work Brain did (rows)                         services/learning/observe.ts
   │  outcome row: result, work performed?, blocker class, measures
   │  each measure MEASURED | ESTIMATE | WORKER_CLAIM | JUDGMENT | UNKNOWN
   ▼
prediction made when Brain decided           outcome_predictions (RECORDED)
   │  or reconstructed from the launch event (RECONSTRUCTED, labelled)
   ▼
lessons, derived on every read               services/learning/lessons.ts
   │  CONDITIONS lesson: from attempts that did no work
   │  SUBJECT lesson: from attempts that did work, by independent source
   │  below the floor → ANECDOTE, shown, changes nothing
   ▼
the decision that reads them                 services/learning/advise.ts
   │  called by startValidations before it launches deep dives
   │  every change written to outcome_decisions with default, chosen,
   │  lesson key, fingerprint and the outcome ids it rested on
   ▼
watches on facts live goals depend on        services/learning/watch.ts
   │  research grant, healthy surfaces, the active lesson
   │  a change → what changed + what Brain proposes → Russell's briefing
   ▼
recurring blockers → capability proposals    services/learning/capability.ts
      IMPLEMENT | CONNECT_SERVICE | PERSON, each with viability, cost in
      measured units or UNKNOWN, and a first test; a person decides; an
      IMPLEMENT decision can submit the composed objective to the factory;
      verification reads only attempts launched after the change went live
```

## What it refuses

- **An attempt that never touched its subject is not evidence about the
  subject.** It is evidence about the conditions. The result class
  `NOT_ATTEMPTED` and `work_performed = 0` keep the two apart, and subject
  lessons read only attempts that did work.
- **One result is not a rule.** Subject lessons need `PATTERN_FLOOR` (2)
  independent observations, where openings found by the same discovery packet
  count once. Below the floor a lesson is an anecdote: shown, and inert.
- **No manufactured rates or savings.** Unknown measures carry no value and
  say what would measure them. A capability's value is "not measured" until a
  dive has actually produced one.
- **A lesson changes little.** The strongest effect of a conditions lesson is
  one probe instead of full slots; of a subject lesson, a kind of opening
  moved later in the queue. Nothing is refused and no bar moves.
- **Corrections destroy nothing.** Withdrawing a lesson or an outcome appends
  a row; the next decision stops using it and every decision that already did
  is flagged `restsOnWithdrawnLesson`.

## The first real result (2026-09-23)

Read from production (Cash Mode 1, `prj_22fb4fec295f403a8a22`, serving
`222f8fd`) through the read-only reports: 26 deep dives. The two launched on
2026-09-17 did research (4 and 2 passes) and parked on a person. Every one of
the 24 launched from 2026-09-21 06:34 onward recorded **zero research passes**:
the packet stopped at `NEEDS_HUMAN` seconds after it was created, and the
launcher kept filling both slots every time the six-hour stall freed them.

The recorded refusal, identical on the earliest (`orc_51370d393d144cd9baea`,
2026-09-21), a middle (`orc_94d6b7cfdee24095a655`) and the latest
(`orc_56c29a5cab1e4e41822e`, 2026-09-23) packet — the rest are inferred from
the same compiled question and the same zero-pass stop, and the fixture says
which is which:

> The proposed plan falls outside the preauthorized envelope: fragment
> "opening-validation" instructs the researcher to telephone call …

Commit `e5882ae` (2026-09-21 04:00Z) added "…and whether the only published
route to the buyer is a telephone call" to every deep-dive question. `whether`
sits 51 characters before the phrase; the plan screen's governor window was 40.

- **Changes a later decision:** the streak lesson (22 settled, 24 once the two
  running dives stall) replaces "launch 2" with "probe 1", then waits while a
  probe is out or until a new revision or 24 hours.
- **Must not support a broad conclusion:** the two dives that did research are
  both `PRICING_OR_INFORMATION_ASYMMETRY` and both came from discovery packet
  `orc_8adf57cff129492ca837` — one independent observation. And the 13
  refused dives on that signal (15 once the two running ones stall) are set
  aside, not read as failures of the kind of opening.
- **Capability proposal:** the refusal recurs 22 times on 22 openings;
  `CONNECT_SERVICE` is not viable (no outside service answers Brain's own plan
  screen), `PERSON` costs 22 approvals so far and one per future dive,
  `IMPLEMENT` is recommended. The fix, carried in this V5 build rather than a
  factory campaign because approving a campaign is a person's decision, is the
  embedded-question rule in `services/research/actorScope.ts`. Verification
  is armed: once a person records the change as live, the first attempt
  launched afterwards that performs research marks it `VERIFIED_SOLVED`; one
  that hits the same refusal marks it `NOT_SOLVED`.

`tests/fixtures/production-deep-dives-2026-09-23.json` holds the transcribed
rows and their provenance; `tests/outcomeLearning.test.ts` replays them and
drives a real deep dive through the real tick.
