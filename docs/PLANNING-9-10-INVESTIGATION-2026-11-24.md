# Fresh-request planning: the 9-of-10 investigation (2026-11-24)

The owner's goal: Brain returns a usable plan on at least 9 of 10 fresh, feasible
requests given only the objective and his normal constraints. A pass is a plan he could
start without supplying the strategy or repairing it; a candidate, a correct verdict or a
list of questions earns nothing on a feasible request. Run: 2026-11-24 20:33Z–00:33Z,
base revision `406c60d` (deployed), repairs released in #1291 and #1292.

## The two answers

**On course to 9/10? No.** Objective only, Brain produced 0 usable plans on 46 fresh
feasible requests (0/10 dev, 0/30 sealed, 0/6 live production goals). The bench rounds of
11-21..11-23 (first-read 87–97%) measure the planner on worlds whose opening, buyer, price,
fulfiller and close rate are filed for it; the owner's requests fail before that, at
choosing a route. The repairs made here raise the planner's handling of a supplied route
(below) but do not touch route selection, so the known repairs do not cover the gap.

**Time to verified 9/10:** best estimate ≈ 70 h from 20:33Z on 11-24 (≈ Thu 11-27 13:30
Detroit), plausible 40–150 h; the central figure rests on two unmeasured durations
(objective-driven discovery's build and production research per iteration). See §5.

## 1. Measurement

- **Requests.** An independent reviewer (no access to the code) wrote 40 feasible requests
  in the owner's voice (10 dev, 30 later used as "unseen") with a hidden reference route and
  a must-have list each; a second reviewer wrote a sealed 30 (f01–f30). Direction spread:
  ~45% open (Brain chooses), ~30% hint, ~25% named business; $500–$60k, one-off and monthly;
  7–180 days; capital none / small / $10k+; owner hours 0 / few / 10 / 20 / unstated.
- **Runner.** The existing `planningReliability` runner (`readGoalPlan` on its own database),
  cases with `openings: []` for objective-only. Production: `brain_operator_goal_plan` on the
  six live cash goals.
- **Grader.** The existing comparator plus the owner-usable level added here (COMPLETION-SPEC
  §3b, `gradeUsable`). The verdict level reads the planner's own stance, which needs a
  measured close rate or signed buyers — never true of a fresh request — so it scored every
  startable plan a refusal. Correction kept apart from improvement: on 40 supplied routes the
  old comparator reads 0/40 before and after; the corrected one reads the base at 1/40.

## 2. Where the route is lost

| stage | what has to happen | measured |
|---|---|---|
| A. intake | the objective's words become amount, deadline, capital, hours | base: 12/40 and 15/30 phrasings refused or misread; now 70/70 |
| B. route selection | Brain picks a concrete offer, buyer, channel, fulfiller for *this* objective | 0/46 — objective-only readings are a generic "buyers to be found" research list, identical across objectives; production openings are marketplace scraps shared by every goal in a project |
| C. facts | price, market size, dated demand, settlement, cost established for the route | production: 0 of 6 goals has an evidenced buyer and price; 5 goals created 11-19 have 13–15 research items READY with 0 attempts; research slots: 938 ideas waiting, 937 at the grant's at-once ceiling |
| D. planner | supplied route → startable plan inside the limits | after repairs: dev 9/10, unseen 24/30 (corrected comparator) |

Diagnostic replay (the reviewer's route supplied one fact at a time, dev set): opportunity
only or with an evidenced price → "cannot reach the target" (no fulfiller, cost or timing
to compute reach); + fulfiller, cost, settlement → still CURRENT_DEMAND and MARKET_VOLUME;
+ a dated demand signal alone or + a sized market alone → no; **both together → usable**
(the two only work together). + a measured close rate → the planner's own EXECUTABLE.

## 3. Repairs and their measured effect

Existing diff report (`bench/diff.ts`, now with the owner-usable block), base `406c60d` →
repaired, same requests:

| set | owner-usable before → after | net | recovered / regressed |
|---|---|---|---|
| objective only, dev 10 | 0 → 0 | +0 pp | 0 / 0 |
| supplied route, dev 10 | 1 → 9 | +80 pp | 8 / 0 |
| supplied route, unseen 30 | 0 → 24 | +80 pp | 24 / 0 |
| public suite 40 (fam/ho/mv) | 36 → 36 | +0 pp | 0 / 0; critical 0 |
| sealed 30, objective only | 0 → 0 | +0 pp | errors 15 → 0 |

1. Settlement: "0 days" / same-day / at-checkout read as unknown (`readSettlementDays`).
2. Market volume: a count named as buyers by its own clause; compound buyer nouns listed
   with commas; "5 million" read as 2; "U.S." and "501(c)(3)" cutting the noun phrase.
3. Objective reader, two batches: "Build/get/want $X a month", "$6k collected", "using at
   most $500", "put up to $500 into it", "this week", "by the end of January", a bare "12k",
   offer prices beside the target; plain-spoken "I don't have any money to put in" / "I'm
   not doing any of the work" read as no limit and now read as a limit of nothing; vague
   figures read at their low end.
4. Bench: the owner-usable level and its diff block (grader correction, not planner).

Residual planner failures on the 30 unseen supplied routes: market sizes stated as licence
counts or flows ("4,000 new authorities every month"), a one-step "sell to measure" plan
with no delivery or collection (r28, r30), an opening never considered (r40, a regulated
notary service), a consumer marketplace read as unsized (r38).

## 4. What closes the gap, in order

1. **Route selection from the objective** (stage B, critical path): discovery's questions
   are a fixed set per deliverable kind (`PLAY_BUCKETS`, `QUICK_PLAY_BUCKETS`); nothing in an
   objective — the business named, the industry hinted, the deadline or capital — becomes a
   research question. Extend `discovery.ts`'s buckets with objective-derived ones (the named
   offer and buyer; for open requests, Brain's proved deliverables × the objective's limits),
   each asking for price, market size, a dated demand sign, fulfiller and settlement.
2. **Research for evaluation goals** (stage C): the 5 newest goals got no attempts in 5 days.
   Brain's own allocation must give planning-evaluation goals research capacity.
3. Planner residuals (stage D), above.
4. Production verification: 10 dev requests as goals, iterate, then 30 sealed.

## 5. Forecast

Deadline planner (`brain_deadline_plan`, 3 workers, measured Deploy p80 35 min / 22% fail,
Postgres p80 28 min / 13% fail): critical path discovery build → release → production dev
run → diagnose → repair → release → dev run → final 30 → report, 33 h with its measured CODE
p80 (18 min, from small Factory tasks). Adjusted for what that measure cannot see: the
discovery build ≈ 8 h, three production iterations rather than two (first-read scores on
new bench sets took ~4 rounds to pass 90%), research ≈ 9 h an iteration if prioritized
(unmeasured — no production research duration is on record for this work).

- Best estimate ≈ 70 h from the start (4 h done + 10 h build + 1.3 h release + 3 × 14 h
  iterations + 12 h final verification).
- Range 40 h (2 iterations, research 6 h each) – 150 h (5 iterations, research unprioritized).
- What settles it: the first production dev run after the discovery build (≈ 15 h in). If it
  yields ≥ 6/10 usable, the central estimate holds; ≤ 3/10 means route construction needs a
  redesign and the upper end applies.

Accelerators, each with the work it shortens:
- **Workers:** 3 is useful (build, planner residuals, production research ops); the staffing
  curve is flat beyond 3 (33.2 h at 3 and 4).
- **Research capacity for evaluation goals:** research is ~60% of the critical path; giving
  the evaluation goals priority over the 938-idea backlog is worth ≈ 12–20 h.
- **The 11 idle Claude routines** (reserved for Brain improvement, §84) on evaluation research:
  ≈ 15–25 h, since it is Brain-improvement work and runs beside the free lane.
- **A faster GPU: no** — the free lane is held to its share of the database pool (21 of 24
  slots), not by the card.
- Automatic (Factory) repairs: ≈ 2–3 h, only on the off-path planner residuals.
