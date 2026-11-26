# 30-question intelligence test (2026-11-26)

**The question.** Can Brain build credible, executable business plans once it is given enough verified real-world information?

**The goals.** The test used the three failed goals of evaluation run `dec1125c`. Their exact words are in the probe outputs.

- **p02:** "I have a DJI Mavic 3 and my FAA Part 107 license, I'm in Phoenix. I want to clear $4,500 from drone work in the next 60 days. I can spend $1,500 and I can fly about 20 hours a week."
- **p06:** "Seattle. I have zero money to invest and I need $500 within 7 days. I can put in 15 hours this week. Figure out the fastest legit way."
- **p10:** "I want a business that does $20,000 in the next 90 days and keeps going after. I'm in Minneapolis, I have $5,000 to fund it, and I can't put any hours in myself at all, so it has to run without me. Choose whatever you think works."

**Where the data is.** Every number below is recomputed from `docs/intelligence-test-2026-11-26/` by
`node scripts/intelligenceTestCheck.mjs all`.

**What was built.** Nothing new. The test ran through the existing read-only evaluation script `scripts/planningEval.ts` on
production (`planning-eval.yml`), with three changes:

- **A `questions` command.** Brain's production models list the research questions. They are framed exactly as Brain's own scouting ask (`directionPrompt`): the owner's words, the date, the limits and the feasibility rules. No direction or strategy is supplied. When findings are present, the same command lists the follow-up questions.
- **A larger `probe` batch, passed as a file.** It records how many findings were supplied and how many were shown, and dumps the exact route ask.
- **An optional finding cap.** It measures what the proposer's 40-finding cap (`FINDINGS_SHOWN`) loses.

**How it ran.** Planning used Brain's own code on production models: `routeContext`, `routePrompt`, `parseRoutes`, `critiquePrompt` and `applyCritique`, with gpt-oss-120b first and the free fallback second. Nothing was written to the database.

## Method

1. **Questions (Phase 1).** Brain's production model wrote 30 questions per goal, with no strategy given (`questions/pXX.q.json`; raw logs `questions/*.raw.txt`).
2. **Research (Phase 2).** Nine live-web workers ran in parallel, three per goal with ten questions each. Each followed `PROTOCOL.md`: search, open the page, quote it verbatim, mark what was not found as UNANSWERED (`research/r_pXX_[abc].json`).
3. **Verification.** A program, not a model, did this (`tools/verify.py`). It downloaded every cited page again and accepted a fact only if its quote appears in that page's text: an exact match, or at least 60% of its 4-grams. Facts whose quote was not found, or whose page could not be read again here, are category B and were **not** delivered (`verified/v_pXX.json`).
4. **Delivery and planning (Phase 3).** Verified facts went to `probe` through the same findings interface production uses (`findingsOf`). There were two arms:
   - **cap:** production as it is, which shows at most 40 findings.
   - **all:** no cap.
5. **Follow-ups (Phase 4).** Brain's model was shown every verified fact and asked for the open questions whose answers could change the plan (`questions/pXX.fq.json`).
   - Workers first ruled out the questions the facts already answered or that could not change a decision.
   - They then researched up to 12 of the rest, in Brain's order (`research/r_pXX_f.json`).
   - The new facts were verified the same way, and the final probes ran with them listed first, the order production uses for findings.
6. **Control.** The identical final prompt (all findings) was answered by a stronger model, Claude Sonnet, as the planner. This separates information failures from reasoning-model failures.
7. **Grading (Phase 5).** One independent grader per goal, blind to which arm produced which output (labels shuffled; key in `grading/grade_key_pXX.json`). Each output was scored on ten criteria in `GRADING.md` and given a verdict:
   - **USABLE**
   - **CREDIBLE_INCOMPLETE**
   - **NOT_USABLE**

   Every failure was classified A–E.

Brain's own production research ran beside this as the baseline (`planner/pXX.trace.txt`, read about 6 hours after the goals were created). The goals are unchanged.

| | p02 | p06 | p10 |
|---|---|---|---|
| fragments queued / completed | 6 / 0 | 6 / 1 (+1 blocked) | 6 / 0 |
| claims accepted | 0 | 3 (1 shown, irrelevant) | 0 |

**Search capacity, Brain-wide, last 24 h:**

- **DuckDuckGo:** 357 searches answered and 785 refused (69% refused).
- **Firecrawl:** 7 answered and 29 refused at Brain's own ceiling.
  - Brain's configured ceiling is `dailyCeiling: 15` credits a day (`server/services/integrations/registry.ts`), where a scrape costs 1 credit and a search 2. That ceiling sits inside Firecrawl's free tier.
  - No credits were bought and no ceiling was raised.
- **Keyed Google:** not configured.

**Why the experiment used session workers.** At those rates production cannot research 30 questions a goal:

- This experiment opened about 350 pages and needed roughly 500 searches.
- That is about 1,350 Firecrawl credits, or about 90 days at the current ceiling.
- Brain's own queue completed 1 of 18 fragments.

So the experiment used session live-web workers that keep Brain's research contract, verified their output mechanically, and delivered it through Brain's own interface.

## Results per goal

| | p02 (drone pilot) | p06 ($0, 7 days) | p10 (0 hours, $20k) |
|---|---|---|---|
| Questions generated | 30 | 30 | 30 |
| Questions answered with verified live-web evidence (fully / partly) | 5 / 23 (28 with ≥1 verified fact) | 5 / 21 (26) | 10 / 20 (30) |
| Questions with no verified fact | 2 | 4 | 0 |
| Facts extracted → verified against the re-read page | 91 → 79 | 108 → 83 | 111 → 96 |
| Unique sources actually read (URLs opened by workers; distinct sources behind verified facts) | 113; 50 | 139; 61 | 95; 60 |
| Additional questions generated (Phase 4) | 30 | 30 | 30 |
| Follow-ups already answered / no decision value / researched | 12 / 1 / 17 (12 researched, 5 left) | 17 / 1 / 12 | 6 / 10 / 14 (12 researched, 2 left) |
| Follow-up facts verified | 32 | 28 | 39 |
| Relevant facts delivered into Brain's reasoning input: production cap (final) | **40 of 111** | **40 of 111** | **40 of 135** |
| Same, uncapped arm (final) | 105 of 111 | 111 of 111 | 126 of 135 |
| Final independently graded plan, production as it is (final, cap) | NOT_USABLE (D): critic dropped all 6 routes | NOT_USABLE (D): parser kept no route | **CREDIBLE_INCOMPLETE** (C) |
| Final, uncapped | NOT_USABLE (D) | NOT_USABLE (D) | NOT_USABLE (D) |
| Round 1, cap / uncapped | CREDIBLE_INCOMPLETE (C) / CREDIBLE_INCOMPLETE (C) | NOT_USABLE (D) / NOT_USABLE (D) | NOT_USABLE (D) / NOT_USABLE (E) |
| Strong-model control (same prompt, all facts) | NOT_USABLE (D) | NOT_USABLE (D) | CREDIBLE_INCOMPLETE (A) |

The uncapped arm's shortfall (105/111 and 126/135) is `findingsOf`'s near-duplicate filter. That filter compares only the first 160 characters, so it drops facts that differ only later in the text.

### Feasible opportunities discovered (the graders' reading of the verified facts)

**p02**

- **The strongest opportunity is selling per-listing drone photo and video packages directly to Phoenix listing agents at $200–250.**
  - **Price:** PropPhoto $129–300 per shoot; Fullview's $249 Phoenix package.
  - **Demand:** 27,427 active listings and 5,155 closings in October 2026; 52% of agents use drone media.
  - **Channels:** ARMLS Preferred Photographer (free until January 2027), a PropPhoto listing (9 drone photographers listed in Arizona), direct outreach, and Facebook real-estate leads at $13.74 each.
  - **Cost:** $1M liability insurance at $62 a month.
  - **Arithmetic:** about 20–25 jobs reaches $4,500 net.
- **Secondary:** network missions (Zeitview $125–225 a job, FlyGuys pays within 14 days) to fill idle hours.
- **Ruled out by the evidence:**
  - Construction surveying: A.R.S. 32-101 makes aerial topographic mapping registered land-surveying work.
  - Stock footage: too slow and too small.

**p06**

- **The strongest opportunity is that the owner works as a TaskRabbit Tasker in Seattle.**
  - Same-day bookings, a $31/hr average and fixed per-task pricing allowed.
  - Payouts arrive 1–3 business days after a task.
  - 15 hours yields about $465–525, which is 90–100% of the target.
  - Tasker approval time was never researched.
- **Every brokerage route Brain proposed is contradicted by the evidence:**
  - Upwork pays out in 10 days.
  - Fiverr clears in 14 days.
  - Fiverr requires the buyer to prepay on the platform.
  - DesignCrowd contests take 7–14 days per phase.
  - Facebook Marketplace bars service listings.
  - Craigslist charges $5 to post, which $0 capital cannot pay.

**p10**

- **The strongest opportunity is a subcontracted Meta-ads management retainer of about $1,000 a month, sold to small businesses by cold email.**
  - **Pricing:** agencies charge 10–20% of ad spend or about £1,000 a month; 48% of small businesses budget $1,000 a month or more.
  - **Fulfilment:** an Upwork freelancer at about $25/hr.
  - **Acquisition:** about $153 per booked meeting and $100–500 per client.
  - **Arithmetic:** about 8 clients.
  - **Open gap:** a paid closer is needed and no fact prices one.
- **Ruled out by the evidence:** ad-funded dropshipping. The cost per sale is $36.76–51 against about $20 of margin.

**Who found the strongest opportunity**

- **p02:** Brain found it in both round-1 arms. In the final arms, Brain's own critic dropped it.
- **p06:** no output found it, Brain or control.
- **p10:** Brain found it only in final-cap, with unsupported pricing. In round-1 uncapped the parser rejected it before anyone could see it.

### First remaining blocker per goal

- **p02 — Brain's critic rejects the right route by misreading the facts (D).**
  - It treated net-30 or pay-at-shoot payment as outside a 60-day window.
  - It costed Facebook ads for 230 buyers instead of about 23.
  - In 3 of 4 final proposer calls gpt-oss returned an empty reply, so a weaker fallback model planned instead.
- **p06 — the opportunity was never asked about (A, upstream of research).**
  - Brain's 30 questions and 30 follow-ups were all about brokering email triage, logos and CSV cleanup to Seattle businesses.
  - None asked about the owner's own paid gig work.
  - The proposer never proposed it, even when the TaskRabbit facts were shown.
- **p10 — the decisive facts were cut by the 40-finding cap (C).**
  - Agency pricing, cold-email cost per client and small-business budgets were cut. The follow-up facts, all about e-commerce, filled the 40 slots.
  - The closer's cost was never found (A).
  - Where every fact was shown, the parser (round 1) or a misreading critic (final) left the owner with no plan.

## Failure classification (15 graded outputs: 12 from Brain's production planner, 3 from the control)

| Category | Brain outputs | Control |
|---|---|---|
| USABLE | 0 / 12 | 0 / 3 |
| CREDIBLE_INCOMPLETE | 3 / 12 (p02 R1 ×2, p10 final-cap) | 1 / 3 |
| A: information never found | 0 as main cause | 1 |
| B: found, not verified (23 + 30 + 18 facts; held back) | 0 as main cause | 0 |
| C: verified, not delivered (40-finding cap, near-duplicate filter) | 3 | 0 |
| D: delivered, misinterpreted (proposer or critic) | 8 | 2 |
| E: downstream mechanical failure | 1 (parser OWNER_FIT rejected both routes) | 0 |

**Measured mechanical failures in Brain's production planner**

- **gpt-oss-120b returned empty content on 6 of 12 route asks.** The fallback model planned instead.
  - When asked for questions, it timed out with HTTP 524 at about 125 s on 2 of 3 first runs.
  - The free fallback model answered instead.
- **Brain's critic dropped 14 of the 18 routes the parser kept.** At least 4 of the 14 were dropped on misreadings:
  - net 30 outside 60 days;
  - Dec 3–7 after a window ending in February;
  - a $5 fee the route never used;
  - an ordinary service agreement read as a payment risk.
- **The parser rejected 6 routes.**
  - Three of the rejections were correct: hours (2) and margin (1).
  - One was an unproved Brain deliverable.
  - Two were missing-field OWNER_FIT rejections.

## Answers

1. **Did supplying comprehensive research materially improve Brain?**
   - **On usable plans, no.**
     - It went from 0/3 (baseline) to 0/3 usable in every arm of this run.
     - The earlier 1/3 with externally supplied facts (2026-11-25) was not reproduced. Today's grader was stricter: it required costed insurance and an active channel for p02.
   - **On plan substance, yes, partly.**
     - Routes went from unpriced guesses, with zero relevant facts reaching production planning, to cited prices, channels and payment rails.
     - 3 of 12 Brain outputs became CREDIBLE_INCOMPLETE, against 0 before.
     - Research also correctly killed routes. Upwork, Fiverr and DesignCrowd payout holds killed the 7-day brokerage routes, and the CPA facts killed dropshipping.
   - **Follow-up research did not raise the grade.** Round 1 already reached CREDIBLE_INCOMPLETE on p02 in both arms. Final reached it only on p10-cap; final p02 fell to NOT_USABLE because the critic misread the facts.
2. **Were the previous failures primarily caused by insufficient information?**
   - **They began there:** production delivered 0 relevant facts on 2 of the 3 goals and 1 irrelevant fact on p06, because its research queue completes about 6% of fragments and 69% of searches are refused.
   - **But information was not the main cause once supplied.** With 79–135 verified facts per goal, the main failure of 8 of 12 Brain outputs was misinterpretation (D). The control model, given the same facts, also wrote no usable plan.
3. **What failures remain even when the information is sufficient?**
   - **(a) Question selection anchors on a strategy before research.** The p06 and p10 questions were already about brokering digital tasks and dropshipping, so the strongest path was never asked about.
   - **(b) The proposer ignores or misuses facts, or breaks limits.** It reported 445 sales from $3k at a $39 cost per sale, a 33% conversion, and an invented $10/hr subcontractor.
   - **(c) Brain's critic misreads facts and drops sound routes.** On p02-final, every route was dropped.
   - **(d) The production model is unreliable:** gpt-oss gave empty replies 50% of the time and timed out on questions.
   - **(e) Mechanical loss:** the 40-finding cap hides the newest-first tail, and the near-duplicate filter compares only the first 160 characters.
4. **What structural change, if any, is necessary?** Not a new intelligence system. Four changes to existing owners, in order:
   - **i. A reasoning model that holds the facts.** Production needs one for both the route ask and the critic. `BRAIN_ROUTE_MODEL` with an Anthropic key already exists in `strongRouteModels` and needs the owner's key. Most errors here were in the critic, which today is whichever model answered the route ask.
   - **ii. Findings chosen by relevance, not recency.** The route ask should see the findings by the field each one grounds and by question, with every verified finding available; not the 40 newest.
   - **iii. A question generator required to ask about the owner's own means and the simplest direct paths before any brokered or digital route.** For example, "can the owner be paid directly for work they can do now?" This would extend `directionPrompt`'s existing rule for stated skills to general means.
   - **iv. Research capacity** (owner): a keyed search provider, or a higher Firecrawl ceiling, and fragment execution. Without it no amount of reasoning improvement reaches production.

   Even with all four, the control showed that a stronger model alone gives 0/3 usable on these prompts. Point iii and the critic are needed as well.
5. **What is our measured progress toward 9/10?** None on this measure.
   - **Usable plans:** 0/3 here (0/3 baseline; 1/3 in yesterday's supplied-facts probe, not reproduced).
   - **Credible but incomplete:** at best 1/3 in each arm.
   - **What it shows:** information delivery is necessary but far from sufficient. The next measurable step is (i) and (ii) above, re-run on these same outputs with the same blind grader.
