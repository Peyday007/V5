# $10K objective — consolidated result

## 2026-11-03: corrected to remote operation (this supersedes the plan sections below)

**Owner, 2026-11-02:** *"I DO NOT WANT TO PERFORM PHYSICAL WORK … This must become a permanent rule throughout Brain."*

### The standing rule, now part of Brain

`server/domain/operatingModel.ts`:
- **No physical work by the owner:** no travel, deliveries, distribution, meeting customers, performing services, or running a physical operation.
- **Physical work stays in scope only when an independent supplier or subcontractor performs it** and Brain coordinates it online.
- **Geography is a business choice, never the owner's location.**

| Stage | Where | What it does |
|---|---|---|
| Discovery questions, every kernel | `cash/discovery.ts`; `sprintGoalLine` for industry, dealflow, puzzle, feeds | States the rule and the national/international instruction |
| Before research is spent | `cash/worthResearching.ts` | `SCREENED_OUT: OWNER_PHYSICAL_WORK`. Covers dives, card questions and withdrawal of open questions |
| Construction | `cash/construct.ts` | Brain never "produces" a physical need |
| Delivery and terms | `cash/answers.ts` | Withheld with the PHYSICAL bar |
| Goal plan and ranking | `cash/goalScenario.ts` | Excluded, with the reason "needs the owner's physical work" |

PRs:
- **#445** — the rule.
- **#447** — calibrated on production's own openings.
- **#448** — every kernel's questions.
- **#449** — a full-suite test that used a surplus-lot opening.
- **#450** — gig work the operator would do itself.

**Verified on production** (`f890d15`; Goals run 41561426910, Cash report 41561429752):
- The goal plan's considered openings fell from 23 to **17**. Removed: four sneaker resales and a StockX resale (goods the owner would ship), a gig-driving opening, and a school district (government).
- None of the remaining 17 needs the owner's physical work.
- The industry map shows the local subject retired with its reason, and three remote subjects seeded.
- `INDUSTRY_ROUND_OPENED=8`: all four kernel slots are live. The remote subjects rank next (250) and open as slots free. Tests are in `tests/operatingModel.test.ts`, `tests/goalPlan.test.ts` and the RES-6 tests in `tests/cashKernelProgress.test.ts`.

**Production changes made through the admin console:**
- The local physical-services subject seeded on Nov 2 is retired (`ind_b1bec01e…`, with its reason recorded).
- Three remote subjects are seeded:
  - AI receptionist and missed-call automation for home-service businesses (`ind_236ff807…`);
  - done-for-you AI marketing services for small businesses (`ind_22979ce6…`);
  - online lead generation and referral brokerage for independent contractors.

### Construction → opening: the 03:50Z check-in (Cash report 41574595927, Goals 41574598841, serving `3583c0c`)

- `INDUSTRY_ROUND_OPENED=8` and `INDUSTRY_FINDINGS_ABSORBED=4`, both unchanged since 01:40Z.
- All four kernel slots hold live questions: Agriculture, Animation, and by rank the two Nov-2 seeds.
- The three remote seeds wait at rank 250 for a free slot.
- Construction still composes 247 arrangements from the old map.
- Of 14 constructed rounds, none has filed an opening: 11 abandoned, 2 harvested empty, 1 open.
- **Status:** unblocked (#441–#443) and running, **not yet demonstrated**. Nothing is failing: the industry kernel's log line records any failure (#442), and none appeared.

### Construction → opening: the 09:54Z check-in (Cash report 41614832497, free-lane report 41615182345, serving `edb6c66`)

- Unchanged since 01:40Z: `INDUSTRY_ROUND_OPENED=8`, `INDUSTRY_FINDINGS_ABSORBED=4`. The same four kernel rounds still hold every slot.
- **Why:** the owner's §84 order (2026-11-03) reserves paid Claude routines for Brain improvement, so all cash research runs on the free-model lane (§85).
- **That lane in the last 24h:**
  - 2 packets filed;
  - 17 of 31 claims accepted;
  - fragments: 21 submitted, 80 failed its own quote-and-cite checks.
- The kernel rounds will settle at that pace, and the remote seeds open only after them.
- **Brain enforces this in SQL:** its claim path refuses play-research items to Claude workers, so no session can do this research in its place.
- **What would speed it** is the owner's call, not a session's:
  - allow cash-goal research on Claude routines (`admin brain-only off`), or exempt goal-critical rounds;
  - or improve the free models' answers until they survive Brain's checks.

### The rebuilt plan

The plan is in `docs/CASH-10K-PLAN.md`; the model is `fast-cash/10k/plan-model-remote.ts`. Five online lines:

1. AI receptionist and missed-call setups for home-service firms
2. Holiday campaign builds
3. Corporate gift brokerage, with suppliers shipping to each recipient
4. Business-level trigger lists
5. Puzzle licence packs

Lead-ads brokerage was modelled and **dropped**: it lowers contribution.

**Verdict: $10k settled by Nov 27 is not supported.**
- Best portfolio: **p50 $3.0k** settled (p10 $1.7k, p90 $5.0k), keeping about $1.4k.
- The binding constraint is about **10 interested conversations** from the ~900 outreach touches available by Nov 23, against about **41 needed**.
- Closing the gap needs about 4–5 more warmed mailboxes, a warm network, or counting December. That is stated as a requirement, not assumed.

---

## 2026-11-02 (evening), superseded where it conflicts with the above

Goal `wst_7b4fcbb5f2384f31b6c3`: $10,000 of settled cash by Nov 27, with $300 at risk before income and $3,000 committed in total. **$0 collected so far.**

## 1. The completed plan

The plan is in `docs/CASH-10K-PLAN.md`. Brain's scenario engine computes it from `fast-cash/10k/plan-model.ts`; the run's output is in `plan-model-output.txt`.

**Seven lines**, all sold in the owner's own metro and prepaid or paid on the day:

- A. Holiday light installs
- B. Prepaid tree delivery with January removal, plus wreaths
- C. Fall cleanup
- D. A 5,000-home co-op postcard mailer, sold as a threshold presale
- E. Client gift boxes for local businesses
- F. Wreath fundraiser brokerage to churches, scouts, clubs and HOAs
- G. Remote large-print puzzle packs

**Where to sell.** The market is chosen by execution access and cash timing, not an assumed state:

- New online sellers' payouts land after Nov 27: Etsy about 14 days after each sale, Stripe 7–14 days after the first charge, Teachers Pay Teachers in December.
- Prepaid, in-person sales settle the same day.
- Prices use national published benchmarks and are re-checked for the actual metro on day 1.

**Results**

| Measure | Collected |
|---|---|
| Sweep, all lines, 3,000 hangers | p10 $8.3k · p50 $12.4k · p90 $16.9k |
| Share of tested conditions reaching ≥$9k | 85% (coverage of tested conditions, not a probability) |
| Base case (mid-evidence) | **$15.7k** ($12.2k without the mailer) |
| Adverse case (low end of every benchmark; mailer refunded) | **$4.35k** |

Under adverse conditions, $8k is **not** supported; the gap is $3.65k. Only all five gap-closers together reach $10.4k:

1. the mailer fills to its minimum;
2. a second batch of 3,000 hangers;
3. 160 businesses contacted instead of 80;
4. gift-box orders at the median email reply rate;
5. one more organisation signs on.

## 2. The opportunities and their economics

Each line's buyer, price evidence, fulfilment, cash needed, payment timing, capacity, uncertainty and kill test is in `docs/CASH-10K-PLAN.md` §2. The sources are in `fast-cash/10k/research-*.md`.

- **Money out before any income:** about $250.
- **What moves the result most:** door-hanger response (rank correlation 0.82 with contribution), then the booking rate (0.32).

## 3. Engineering completed this session (merged and deployed)

| PR | What it fixed | Production evidence |
|---|---|---|
| #413, #414 | Validation ladder A–F with market tests; 8-opening portfolio; exclusions applied before research; buyer-diverse construction; domain speculation excluded | Ladder line printed; 8 openings simulated; excluded list includes DOMAIN_SPECULATION |
| #438 | A goal plan's "too small to matter" judgement screens every research spender | Deployed on `c27e0ab` |
| #439 | The plan read prints its phase timings | Production trace: shared frontier 38.7 s of 52 s |
| #440 | A plan read is one read: 841 → 96 statements for 150 openings | Production plan read went from timing out at 15 minutes (run 41507873358) to 52 s (run 41520558648) |
| #441 | The industry kernel runs under database pressure; seeded subjects are scanned before bootstrap sectors | Serving `055738f`; the seeded subject entered the kernel's top asks |
| #442 | Industry kernel failures are recorded instead of swallowed | Production log: `industry kernel prj_22fb…: open: … violates check constraint "industry_rounds_check"` |
| #443 | No CAPITAL round for an opening that is off the industry map; one failing ask no longer stops the others | `INDUSTRY_ROUND_OPENED` 4 (lifetime) → **8** on the first ticks after release (Cash report 41539191683, `811bf1c`) |

## 4. Do Brain's capabilities work together?

- **Goal plan → ladder → next action:** works on production. The plan names a C-stage market test and its exact blocker.
- **Quant engine on a real plan:** works. The $10K plan runs through `runScenarioModel` and is labelled a sweep.
- **Construction → opening:** the chain was broken at its source, and that is now repaired on production. Not yet demonstrated end to end.
  - **What was wrong:** for weeks, every tick's first industry ask (a capital round for the off-map Campo opening) failed `industry_rounds_check`. The exception ended the batch and the tick swallowed it, so the map never grew past one seeded subject: 37 sectors, two ever scanned. Construction composes from the map, so every arrangement used the same anime production-committee buyers.
  - **Now:** after #443, four kernel rounds opened at once, filling all four slots.
  - **Which subjects:** Agriculture and Animation show "a question is running". By the allocator's order, the other two are the highest-ranked seeds (rank 250). That is inferred: the report's listing is truncated, and Brain's MCP endpoint was unavailable to confirm it.
  - **Still to come:** research has to answer those rounds and construction has to compose from the new buyer populations. That takes hours to days, so the opening step is not yet demonstrated in production.

## 5. Assumptions that still need validation

These are the tests in `docs/CASH-10K-PLAN.md` §6:

| Assumption | Test | By |
|---|---|---|
| Door-hanger response ≥0.75% | At least 11 responses from the first 1,500 | Nov 9 |
| Booking rate ≥35% | Share of responses that pay a deposit | Nov 9 |
| Mailer slots sell | ≥3 paid slots by Nov 6, ≥8 by Nov 12 | Nov 6 / Nov 12 |
| Gift boxes sell | ≥2 quote requests from 40 contacts | Nov 10 |
| Tree and wreath costs | Written supplier prices | Nov 6 |
| An organisation signs on | ≥1 of 30 | Nov 12 |
| Local prices match national figures; legal | Local price re-read; state contractor-registration rule; sales-tax licence | Nov 3 |

## 6. Shortest path from plan to transactions

1. Owner: open a Square account.
2. Print 1,500 door hangers (≤$190).
3. Hand them out and message 100 personal contacts on Nov 4.

None of the plan waits on Brain's email or invoicing integrations.

## What changed in how the work is done

**Why the work kept fragmenting into tiny steps.** The cost of checking each step was about an hour:

- Every change went to production alone: a PR, then a Deploy of about 35 minutes (Postgres suite plus four test shards), then a check through the Goals workflow.
- That Goals read itself took 1–15 minutes, ran one at a time behind other sessions, and was cancelled when they queued.
- By the end it timed out entirely, because a plan read issued 841 statements.
- The commercial plan waited on Brain's research pipeline to file openings. Its constructed rounds had filed none, because the industry map they compose from was never researched.

**What changed in this session:**

1. **The plan stopped waiting on the pipeline.** Three research workstreams ran in parallel, and the plan was computed with Brain's own scenario engine locally. No deploy was on the plan's critical path.
2. **Changes were batched by functional path.**
   - Plan, research and the materiality screen went out as one PR.
   - The read fix went out as one PR.
   - The kernel fix went out as one PR.
3. **The check everything depends on was repaired first** (#440, 841 → 96 statements). Each later check now takes about 1 minute instead of timing out.
4. **The cause of construction's narrowness was found at its root and fixed** (#441–#443), instead of tuning the ranking further.
   - #442 made the silent failure visible.
   - The next production log named the constraint.
   - #443 fixed it with one condition, without a schema change.

**One mechanism behind the tiny steps sat in the code: silent `catch {}` blocks around tick passes.** A pass that failed every tick looked like a pass that had nothing to do, so each session diagnosed symptoms one at a time (narrow construction, then ranking, then focus) instead of the failure. #442 recorded the kernel's failure, and the root cause showed up in the first log read after release.
