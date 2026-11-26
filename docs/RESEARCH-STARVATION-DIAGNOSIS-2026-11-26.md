# Is Brain's planning starved of real-world information? (2026-11-26)

The hypothesis under test: Brain's planning intelligence can already produce good plans, and its
research system has not been supplying the outside information that intelligence needs.

Everything below is measured on production. Three fresh goals that failed were used, all from the
dec1125c run (created 19:28Z, read about 4.5 hours later):

- **p02:** a Phoenix drone pilot.
- **p06:** Seattle, $500 in 7 days with $0.
- **p10:** Minneapolis, $20k in 90 days with no owner hours.

The trace and the probe were run with the read-only `trace` and `probe` commands in
`scripts/planningEval.ts` on branch `claude/research-hypothesis`.

## Part 1: information trace

| step | p02 | p06 | p10 | all |
|---|---|---|---|---|
| research fragments planned | 6 | 6 | 4 | 16 |
| research attempts made (free-lane items) | 2 (both handed back) | 2 | 0 | 4 |
| fragments completed | 0 | 1 (+1 blocked: required lane empty) | 0 | 1 (6%) |
| web search results found | 18 | 6 | 0 | 24 |
| pages successfully read | 2 | 3 | 0 | 5 (21% of found) |
| claims extracted | 0 | 3 | 0 | 3 |
| claims passing verification | 0 | 3 | 0 | 3 (100% of extracted) |
| verified claims relevant to the goal | 0 | 0 | 0 | **0** |
| EVIDENCE facts on the goal's openings | 0 | 0 | 0 | 0 |
| findings in the route proposer's input | 0 | 1 (irrelevant) | 0 | 1 |

Across Brain in the last 24 hours, the search requests broke down as follows:

| provider | answered | refused | other |
|---|---|---|---|
| DuckDuckGo | 328 | 770 (70%) | — |
| Firecrawl | 5 | — | 27 at its daily ceiling |
| keyed Google | — | — | not configured |

**Where information stops.** The first stop is execution: 14 of 16 fragments were still queued after about 4.5 hours, and
only 1 completed. Of the work that did run, search and reading lost most of the rest, through refused
searches and unreadable or off-topic pages.

**The p06 finding.** The only "finding" that reached a proposer was an absence statement from an
unrelated round: "no county forestry department pays for a timber slot".

## Part 2: controlled comparison

Both arms used the same production models (gpt-oss-120b), Brain's own route prompt, parser and
critic, and wrote nothing. Grading was blind and independent.

- **A:** the findings production research had delivered.
- **B:** 16–19 verified live-web facts per goal, drawn from 52 pages that were actually opened, each
  with its quote, delivered through the same findings interface. No routes were supplied.

| goal | A credible/total | A usable | B credible/total | B usable |
|---|---|---|---|---|
| p02 | 3/4 (unpriced) | no | 3/3 | **yes**: hail-damage roof inspection at $350; price and demand cited |
| p06 | 1/5 | no | 0/1 | no |
| p10 | 1/5 | no | 0/1 | no |

Usable plans went from 0/3 (A) to 1/3 (B).

### How B failed on p06 and p10

The facts were present. The production model mishandled them in three ways:

- **It ignored relevant facts.**
  - p06 was given same-day gig cash-out, plasma payouts and day-labour rates, and still returned a
    digital menu.
  - p10 was given monthly commercial snow contracts and rental-cleaning facts.
- **It mis-cited facts.**
  - A labour-gig listing was cited as the channel, the volume and the demand for an email service.
  - A building-permit count was cited as demand for site mapping.
  - A platform's billing timing was cited as the time a homeowner pays.
- **It broke stated limits.**
  - p10: 0.5 owner hours per deal against zero hours, reaching $14.7k of the $20k target.
  - p06: a $40 contractor paid out of $0.

The same prompt answered by a stronger model gave a credible direction on 10/10 goals versus 5/10
for gpt-oss (2026-11-25). With live web search, the stronger model wrote 7/10 usable plans.

## Part 3: the answer

**Information.** Yes: the planner has been reasoning without outside information. Across these
three goals, 0 relevant facts reached planning. That is a 100% loss between "research planned"
and "planner input":

- 94% of planned fragments never completed (14 of 16 still queued after 4.5 hours).
- 79% of found pages were never read.
- 100% of what survived verification was irrelevant to the goal.

**Effect of supplying facts.** Supplying the facts materially improved the outcome on the same
model, from 0/3 to 1/3 usable plans, and turned unpriced guesses into cited, priced routes.

**Sufficiency.** Facts alone are not sufficient. With them, the production model still failed 2 of
3 goals on reasoning: it ignored facts, mis-cited facts and broke limits.

**Diagnosis.**

1. **Primary shared blocker: research delivery.** It stops every plan from ever reaching
   "usable". It is structural and shared across goals:
   - fragments are not executed;
   - searches are refused;
   - there is no keyed search key;
   - the routine workers that can read the web are not members of the evaluation projects.
2. **Second blocker, exposed once facts arrive: the reasoning model.** gpt-oss mishandles facts
   that a stronger model uses correctly.

Fixing only one of the two leaves Brain near 0–33%.

## Corrections made within the architecture (branch `claude/findings-integrity`)

- **Absence statements are no longer shown as findings.** NEGATIVE_EXISTENCE claims and
  absence/disqualifier lanes are excluded from what the route proposer is shown.
- **A citation must come from a lane that can support the figure** (`GROUND_LANES`). A labour-gig
  listing can no longer become a route's channel, buyer count or price evidence.

## What needs the owner

- Keyed search: `BRAIN_SEARCH_API_KEY` and `BRAIN_SEARCH_ENGINE_ID`.
- Project membership for the routine workers: `admin access grant`.
- Optionally, the strong route model: `ANTHROPIC_API_KEY` with `BRAIN_ROUTE_MODEL`.

Fragment execution capacity is owned by the coordinator (#1330 is deployed).

---

## Round 2 (2026-11-26 00:40–01:45Z): is starvation the root cause?

Evidence: `planning-eval.yml` `capacity` and `probe` commands (read-only) on
production revision c52d6d3; the probe sends the deployed route and critic
prompts to the deployed models (gpt-oss-120b on the GPU, free:auto/best-coding).
Variants change one thing at a time. Grades come from a blind grader working
from 15 shuffled samples (`grade4`).

### Research capacity, measured

| measure | value |
|---|---|
| Firecrawl ceiling in force | 15 credits/day (registry default; env not set) |
| Firecrawl account | 923 of 1,000 plan credits left, period 11-22 → 12-22 (its usage endpoint) |
| Firecrawl answered / ceiling-refused per day | 4–7 answered / 12–45 refused; ceiling hit 00:05–00:52Z daily |
| DuckDuckGo html+lite per day | ~170–330 answered, ~650–775 refused (≈70%) |
| Google Programmable Search | not configured (no key) |
| Free lane, last 24h | 5,148 items; 14,396 search results; 4,824 pages read from search, 1,107 from model; 2,300 submitted |
| Free-lane failures, last 24h | 2,848: 1,221 answers dropped by Brain's checks, ~1,300 "no readable source" |
| Claims accepted per day | 740–2,351 |
| Eval research queued | 840 items, priority 8–9 |
| of which serve cancelled goals | ~690 (dec1125, dev1–dev5), oldest 04:56Z 11-25 |
| of which serve live goals | dec1125b 79, dec1125c 60, dec1125d 9 |
| Eval fragment work finished per day | 261 succeeded + 139 failed |

Brain-wide, research capacity exists. The live goals did not get it: claims
are first-in first-out within a priority, and older cancelled-goal work at
priority 9 came first. Cancelling a goal holds its bins, and these items had
no bin. At ~400 eval items a day, a goal set at 20:00Z waits about two days.
This is the handoff that starved dec1125c (p10 never searched; 4 of 16
fragments attempted).

### The two B failures, classified

**p06 (Seattle, $500 in 7 days, 15 h, $0).**
1. *Missing information.* B's facts lacked activation and payout timing, and
   day-labour rates.
2. *Information not reaching the model correctly.* The route prompt opened
   with the standing rule "the owner does no physical work — no deliveries, no
   performing a service", and only then named the goal's labour offer. One
   model wrote those words as the owner's own refusals.
3. *Downstream rules.* Once the gap facts were supplied (35 facts), gpt-oss
   proposed plasma + deliveries + a labour shift. `parseRoutes` refused each
   one because it did not carry the whole $500 by itself inside 15 hours, and
   the critic dropped plasma as "far below $500". This happened in 3 of 3 runs.
4. *Fixes measured.* With the facts plus all fixes, 6 owner-performed routes
   survived (grade: 3 of 6 credible, about $420 realistic against $500, not
   usable). A repeat run gave 2 kept routes, about $350.
5. *Controls.* With the fixes but no facts, the routes were speculative online
   services (0 of 4 credible). With the facts but no fixes, no route survived.

**p10 (Minneapolis, $20k in 90 days, $5k, zero hours).**
1. *Downstream reader.* "I can't put any hours in myself at all" was not read
   as zero hours, so no hours check ran.
2. *Missing information.* Even after the gap research, there is no source for
   snow-lead cost, Minnesota plow subcontract rates or commercial contract
   prices.
3. *Reasoning failure despite information.* The proposer priced a season
   ($650–750) against a single job's labour. The critic said the snow season was
   "past" or "after the 90-day window" in late November in 4 of 5 runs, even
   with the window's end date written out, and called remote coordination of
   cleaners "physical presence".
4. *Model availability.* gpt-oss-120b returned empty content in 6 of 16 asks.
   This is likely its 4,000-token budget spent on reasoning; it is not proven.

### Corrections (branch `claude/owner-labour-consistency`)

1. A cancelled goal's research is claimed after all other work. It is not
   deleted, still runs on idle capacity, and returns to its place if the goal
   is reinstated (`stoppedGoalWorkItemSql`; `claimWork`, free-lane packet
   scans).
2. When a goal offers the owner's labour, the route prompt states one rule
   (`operatingModelSentenceFor`): unskilled work is allowed.
3. A route is refused on hours only when a single sale does not fit. The plan
   adds routes' hours (`withoutSpareOwnerWork`).
4. The critic is told the plan combines routes.
5. "can't/cannot put any hours in" reads as zero hours.
6. Prompts write out the window's last day.

### Grades (blind, grade4)

| | p02 | p06 | p10 | usable |
|---|---|---|---|---|
| A: Brain's own research | 2/4, $2.5k | 0/5, $100 | 1/5, $3k | 0/3 |
| B: facts supplied | 2/3, **usable** | 0/1, $0 | 0/1, $1.5k | 1/3 |
| B + gap facts, no fixes | — | 0 routes survive (3 runs) | 0 routes survive (2 runs) | 0/2 |
| B + gap facts + fixes | 2/3, **usable** (no regression) | 3/6, $420 | 0 routes survive (3 runs) | 1/3 |

### Verdict

Starvation is a **primary, proven cause in the live pipeline**:
- No decision-relevant fact reached the proposer for these three goals.
- The capacity went to cancelled goals' work.

It is **not the only cause**:
- With sufficient facts, p06 was blocked by three rule defects in Brain's own
  code, now fixed. It then reaches about 84% of its target.
- p10 shows an independent reasoning failure in the critic (season timing,
  operating-model misreading) and in the proposer (unit economics), on top of
  facts research could not find.
