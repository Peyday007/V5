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
