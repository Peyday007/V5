# $10K objective — consolidated result (2026-11-02, evening)

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
