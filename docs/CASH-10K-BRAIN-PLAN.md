# The $10K plan, produced by Brain itself — goal `wst_7b4fcbb5f2384f31b6c3`

Assignment of 2026-11-03 17:20Z: make Brain's own chain produce the plan
(free research → verified evidence → discovery → construction → demand
estimation → quantitative evaluation → combined plan → ranked opportunities →
more research). This file records what was connected, what production now
shows, and the honest verdict. Every number below is copied from a production
read (`Goals` / `Cash report` / `Admin` workflow runs, linked), not computed
here.

## 1. Previously disconnected components, now connected

| Link | Before | Now | Where |
|---|---|---|---|
| Quant engine → customer demand | Volume was a 1–200 sweep and "buyers offered" a strategy choice; the quant engine inferred only days-to-cash, cost share, capital share and Brain's own close outcomes | Each opening's demand is built world by world: outreach/day × share × selling days → Poisson(reply) → Binomial(close), capped by market volume; price, cost and timing from the same worlds | `server/services/goals/portfolio.ts` (#467) |
| Quant portfolio optimiser → goal plan | `quant/portfolio.ts` (joint probability, shared risk groups, capital recycling, spending ceiling) had no caller | Called on every plan read with the goal's limits; its best combination decides which openings take the simulation's slots and which openings path research asks about first | `goalScenario.ts`, `pathResearch.ts` (#467) |
| Free research → conversion evidence → quant | Reply/close rates were never a research question; `close` only read Brain's own outcomes | New researched card field `conversionRates`; path research asks it for every opening the plan rests on; `readRate` turns a cited sentence into a reply or close observation that the quant engine pools as comparable evidence | `engineCard.ts`, `pathResearch.ts`, `quant/knowledge.ts` (#467) |
| Construction → opening | Constructed rounds got accepted evidence (e.g. 14 of 15 claims) but no claim carried an opening type, so the harvest filed **0 openings from 15 rounds** | An accepted `demand_pattern` claim (two dated examples, gated) from a constructed round is filed as a `RECURRING_OUTSOURCED_WORK` opening, which its profile already said it is | `repos/research.ts` `signalledClaims` (#470) |
| Goal search ↔ free lane | Focus (a Routine-protecting switch) capped constructed rounds at 2, stopped lens rounds, and gave the goal 0 spare capacity — although under brain-only mode the Routines never take this research and the free lane had idle slots | Under brain-only mode a non-Brain project's goal search is bounded by the free lane's measured spare, not the Routine cap | `cash/researchRoom.ts`, `cash/discovery.ts` (#470) |
| Prior research → Brain | The $15,740 plan's research lived in `fast-cash/10k/*.md`, outside Brain | Its buyer populations, needs and suppliers are seeded on the industry map (25 subjects, 7 sectors, origin SEED, "not yet verified by Brain"); construction composes arrangements from them and the free lane researches each through the evidence gate. No projection was imported | `fast-cash/10k/seed-industry-map.txt`, `cash seed-industry --text-b64` (#467, #468) |
| Owner's new limits → goal | before-proof $300 | $375 per arrangement before proof, $750 a week tied up, $3,000 in all — the quant engine refuses an arrangement over $375 and starts the portfolio with $750 | Goals `target` run 41686112711 |

| Construction ↔ Postgres | A constructed question carrying the operating rule, exclusions and parts sorted to a 2,776-byte fingerprint; Postgres refused the index entry and no constructed round could open | Long fingerprints end in a sha256 of the whole statement | `repos/russellCandidates.ts` (#473) |
| Goal-found opening → deep dive | The 7 constructed openings sat NOT_STARTED behind 68 older openings | An opening a goal's own search found takes the first band of the dive order | `cash/validation.ts` (#474) |

## 2. What Brain discovered and constructed itself (production)

- **Seeded map → designs.** From the 25 seeded subjects, construction now composes **404 arrangements** (BROKER 73, PRODUCE 256, SUBCONTRACT 42, POOL 9, REFERRAL 24; 229 with a SAFE worst case). Every one of them meets the goal's five target properties (no capital at risk, prepaid fulfilment, short time to cash, repeatable, shared fixed cost). Among them are designs for HVAC/plumbing/roofing firms, firms sending year-end gifts, local businesses sharing a direct-mail postcard, homeowners booking seasonal services, and senior-living activity directors (Goals plan run 41709859679, "constructed" section).
- **Constructed rounds → openings.** The 15 earlier constructed rounds now file **7 openings** (`RECURRING_OUTSOURCED_WORK`). Two are the pooled residential-solar purchase design (Solarize programmes in Oregon, Massachusetts and Connecticut), `cop_c8545be42d1e4444acec` plus a duplicate it recognised. Four are anime-production outsourcing patterns. One North Carolina Solarize instance was screened out for needing on-site installation (Goals construct runs 41709631526 and 41715265100).
- **New round from the widened cap.** A new constructed round opened (`mx-b4e95cfe287b`, a pooled-buyer brokerage, idea `rcn_2aade485eaf04842889b`). It is waiting on research capacity.

## 3. Customer-demand estimates from the quant engine (production)

Production Goals plan run 41709859679; the engine read every modelled opening:

- **Assumed outreach.** Outreach is swept at 10–60 contacts a day, because nobody has stated it on the goal.
- **Reply and close rates.** Reply rates come out at a p50 of about 0.074–0.077. Close rates come out at a p50 of about 0.26, from the bounds swept until research supplies published rates.
- **Every opening Brain holds is a one-off.** Each one is a single named buyer, contacted once. Deals are p10/p50/p90 = 0 / 0 / 1.
- **Revenue p90 by opening.**

| Opening | Revenue p90 | Days to cash | Status |
|---|---|---|---|
| FIFA resale seat | $3,450 | — | refused: ties up $500 > $375 |
| Animation production (`cop_903c3dc6`) | $1,500 | — | refused: capital unknown, up to $1,499 |
| Coachella resale | $649 | — | refused: capital unknown, up to $649 |
| Puzzle Society crossword | $500 | 4.9 | refused: ties up $500 |
| GitHub bug bounty (×3) | $250 each | — | refused: ties up $10,000–$30,000 |
| Home-improvement renewal | $159 | 4.9 | kept; price, reply, close, cost, volume and capital not established |
| Wicked resale | $147 | 9.3 | kept |
| Artisanal Sudoku | $50 | 4.9 | kept |
| Destined resale | $50 | 8.6 | kept |

- **Constructed openings are not modelled yet.** The 7 constructed openings enter the model only after their deep dive establishes who pays and at what price. The dive order now puts them first.

## 4. Strongest opportunities

Ranked by the quant engine's best combination (7 one-offs inside the limits):

1. Home-improvement renewal.
2. Artisanal Sudoku.
3. Destined resale.
4. Wicked resale.
5. Depositphotos licence.
6. Verblio content.
7. Rev transcription.

None is a repeatable line. The strongest designs for the target are the constructed, repeatable ones that are still in research. They fit all five target properties:
- AI receptionist and missed-call setup for home-service firms.
- Corporate-gift brokerage with supplier drop-ship.
- Shared-cost postcard.
- Pooled residential purchase.
- Senior-living activity licences.

## 5. Combined expected revenue and downside

The best combination settles **p10 $0 · p50 $50 · p90 $225** by the deadline, with capital short in 0% of worlds and over the $3,000 ceiling in 0% of worlds. Downside is $0 settled with nothing lost: every member ties up ≤ $375 and the portfolio starts with $750.

## 6. Supported probability of reaching $10,000

**0%** of tested worlds. This is coverage, not a probability: outreach a day, reply and close rates, and most prices are bounds, not evidence. The search covered 255 combinations, with shared outreach treated as one risk factor (correlation 0.5, declared).

## 7. Does the plan meet 90%?

**No.** It is not close on the openings Brain holds. To reach 90%, several repeatable lines need established prices, volumes and published reply/close rates, plus a stated outreach capacity. The engine shows the 10th percentile would have to rise from $0 to $10,000. Brain keeps searching:
- **Goal search:** it is not stopped at NOT_VIABLE.
- **Constructed rounds:** these now open within the free lane's capacity.
- **Deep dives:** dives on goal-found openings go first.
- **Path research:** it asks for `conversionRates`.

## 8. Engineering merged, deployed and verified

| PR | What | Deployed | Verified on production |
|---|---|---|---|
| #467 | Quant demand + portfolio in the goal plan; `conversionRates`; construct diagnostics; seed tree | Deploy 41686088934 | Plan runs 41690555553, 41709859679 print the quant reading |
| #468 | Seed data | — (data) | Admin run 41690384979 seeded 25 subjects |
| #469 | Goals workflow allows `construct` | workflow | Construct runs succeed |
| #470 | Constructed patterns filed as openings; focus no longer throttles the free lane's goal search | Deploy 41696218793 | 7 openings filed from constructed rounds |
| #473 | Fingerprint fits Postgres; harvest read; construct shows filings | Deploy 41705841772 | Construct run 41709631526 opened a round |
| #474 | Goal-found openings dived first | Deploy 41711702599 | Construct run 41715265100 on 0f97f5e |
| #476 | Goal research +2 queue priority; goal dives may run beside the Routine-only ceilings | Deploy 41726679510 | Second goal dive started 22:29Z (`cop_b48acecb`) |
| #478 | Goal ideas judged and launched first; idea backlog printed | Deploy 41734906156 | Goals construct 41739941397 printed the backlog |
| #481 | Up to 5 goal ideas judged per tick | Deploy 41743589279 | Both goal dives judged by 00:46Z; `cop_d9ed5f7` mission RUNNING 01:15Z |
| #488 | One release or failure per lease; a provider outage never spends an item's attempts | Deploy 41766360668 | Reproduced: the second release of an item replayed `ALREADY_RECORDED` and its lease expiry spent the attempt. 15 items now held through the 503/429 run instead of failing |

### What was actually limiting research (2026-11-03 21:00Z–11-04 01:15Z)

The "26 in flight against 13" was never the dive limit. It counted every unfinished research packet. Dives in flight were **0**, and each stage had its own stall:

| Stage | What production showed | Cause | Fix |
|---|---|---|---|
| Dive slot | Room 1, limited by `OPERATOR` (`BRAIN_CASH_RESEARCH_MAX=1`) and by routable Routine surfaces; one unrelated dive held the slot 7.5 h | Both limits protect Routine time, but under brain-only mode the dives are the free lane's | #476: up to 3 goal dives beside them, inside the grant |
| Free-lane order | Goal work waited behind one-off pricing questions; providers answering 503/429 | Queue order, not concurrency | #476: +2 queue priority for goal research; no concurrency raised |
| Judging | Both dives sat CAPTURED for 1.5 h; 119 unjudged ideas, 1 judged per ~13-minute tick | FIFO at one per tick on a contended database | #478 goal first, #481 five goal judgments per tick |
| Launch | Judged dives waited for a grant slot (14 live of 13) held by path questions | Grant full; launch goal-first since #478 | First slot that freed went to `cop_d9ed5f7` |
| Free lane | Three goal dives settled BLOCKED: "a research work item for this fragment finished without recording anything" | Provider 503/429 failures exhausted the screens' attempts: a release under a new lease replayed the first (`ALREADY_RECORDED`), and three strikes failed the item | #488. Since 02:46Z the free providers have answered nothing (48 errors an hour, 0 accepted), and the held items wait out the outage |

## 9. Limitations that remain

- **The free models are the speed limit.** In the hour to 19:54Z, the free lane completed 14 items and accepted 0, with 48 provider 503/429 errors. That is why concurrency was not raised. The scaling assignment's controller sizes concurrency from those errors.
- **Outreach capacity is the owner's fact.** Until the goal states it ("N emails a day"), no reading can be a probability.
- **Constructed openings need a deep dive** before they carry a price. Until then they are evidence, not work.
- **Old anime evidence is still in the pool.** It is filed honestly as found, and the goal's limits and the plan judge it.

## 10. Final production reading (2026-11-04 19:30Z)

The dives that the slot fixes released have now settled. Their results come from the refinement report (runs 41885263516–41892133617 and the settle read after them) and Goals plan run 41895802443.

### The pooled residential-solar opening (`cop_c8545be`)

**Status: BLOCKED.**
- **Screen 1:** recorded nothing. This was during the provider outage.
- **Screen 2:** accepted one claim, which says the Connecticut Solarize page is unavailable. A second claim was refused because its geography did not match.
- **Payer lane:** no accepted claim.

### Three anime-outsourcing openings

**Status: BLOCKED. No payer was established for any of them.**
- **`cop_b48acec`:** its full verification accepted 11 of 11 claims, but none named a payer.
- **The other two:** their screens recorded nothing.

### Construction continues

There are 21 constructed rounds: 2 OPEN, 2 HARVESTED, 17 ABANDONED.
- **New openings:** a shared direct-mail (EDDM) round filed two new openings, `cop_664cef80` and `cop_9546b330`.
- **Order:** they are goal-found, so they dive first.

### The plan

**Verdict: NOT_VIABLE (POOL_INSUFFICIENT). Brain keeps searching.**
- **Openings:** 17 considered, 8 in the simulation.
- **Best combination:**
  - reaches $10,000 in 0.0% of worlds;
  - settled p10 $0 · p50 $50 · p90 $225.
- **Constructed openings:** none enters the model yet. None has an established payer and price.
- **Next test:** a bounded offer test on Artisanal Sudoku, within $375.

### What limited the dives, and the fixes (all deployed)

| PR | Defect seen in production | Fix |
|---|---|---|
| #493 | Screens that recorded nothing during the outage were treated as a failed stage one | STAGE_ONE_FAILED only when the screen recorded claims |
| #494 | Eligible goal dives were not queued while the grant was full | Queue them; Russell launches goal-first inside the grant |
| #496 | Three queued anime dives took every goal-dive place, so pooled solar never queued | Only launched goal dives count against the cap |
| #497 | 13/13 grant slots were held by pricing packets with no pass for 3–15 h, renewed every tick | A packet unmoved for 6 h stops holding its slot and is readmitted when it moves. The grant went from 13/13 to 8/13 and the goal dives launched |

No concurrency was raised. The free lane is still the pace:
- **Last hour:** 1 accepted of 5 completed, with 47 provider errors.
- **Failures:** sources answering 403/404/DNS.
- **Scaling:** the controller lowered concurrency on database saturation. That belongs to the scaling assignment.

### Check-in at 22:32Z

The constructed EDDM shared-postcard opening `cop_664cef8` has started its dive (round 2), but its research has not launched yet.
- **First screen:** recorded nothing.
- **Second gate:** queued.

**Not a defect: grant holds over 13.** At 22:30Z there were 21 live holds and at 06:45Z there were 26, both against `maxConcurrent=13`.
- **Cause:** the grant's concurrency follows the research surfaces on record (`discoveryConcurrencyFor` = max(13, surfaces)). Holds admitted while it was higher outlast a fall back to 13. This is by design, not a ceiling bypass.
- **#504:** proves that a hold readmitted under #497 never goes over the ceiling.
- **10:46Z:** 11/13.

### 2026-11-05 10:46Z: every constructed screen asked a question it could not answer

The EDDM opening `cop_664cef8` settled BLOCKED in round 3. Its claim: "No published source names the specific payer for the 1Vision EDDM service; the source only describes the types of businesses."

The pooled-solar, anime and EDDM openings all ended the same way. The stage-one screen asks "who actually pays for this specific opening, named in a published source", and it forbids naming a kind of buyer. A recurring arrangement has many payers, so that question has no answer.

**Fix.** A `RECURRING_OUTSOURCED_WORK` opening is now screened by asking for:
- at least one buyer that a published source names as having paid for this kind of work, with a date;
- the published channel that reaches more such buyers.

The payer lane still takes a named instance, so no bar moves.

### 2026-11-05 15:20Z: #522's ruled-out wording was read backwards

After #522, the first recurring screen (`cop_779c9f02`, a directory of 3,720 corporate-gift suppliers) filed "Buyers can still buy it from a supplier like us." in the `ruled_out` lane.
- **Cause:** the question said "whether buyers can still buy it … or a published rule excludes us; if so, submit that one fact in the ruled_out lane", which can be read as "if they can still buy it".
- **Result:** Brain recorded the opening as DISQUALIFIED.
- **Fix:** the question now asks only for the stopped-or-excluded fact, and says that "still bought" is not a ruled_out fact. A test holds both.
- **Not recovered:** `cop_779c9f02` keeps its recorded disqualifier. A dive does not overwrite a published fact by asking again, and new evidence reaches it through discovery.

### 2026-11-06 01:35Z: where the chain stands

- **What changed since 11-05 16:30Z.** Four fixes are live:
  - #527: the ruled_out wording.
  - #532: dives start before the cheap screen.
  - #538, from another session: document-name lookups are read once per pass, down from about 50,000 an hour to about 7,300.
  - Production's pool waits are mostly 0 ms again.
- **Still limiting.** Brain keeps entering SHEDDING, and while it sheds no optional dive starts.
  - Now 3–5 overload failures in 120 s, down from 500.
  - The cause is the application's own event loop, which stalls for up to 59 s in the dispatch and factory ticks. The stalls drop connections, and the dropped connections read as database overload.
  - The ticks belong to other sessions.
  - Eligible constructed openings still waiting: `cop_e28aa4e`, `cop_6632c4a`.
- **First constructed opening with an accepted payer claim: `cop_1e58c63d` (shared services / GBS).**
  - The claim does not name a buyer: "The shared services market is expected to grow significantly from 2026 to 2033".
  - The gate accepted it, but it establishes no payer.
  - The plan does not consider the opening: there is no price buyers are shown to pay.
- **Plan (Goals plan run 42145735469).**
  - Verdict: NOT_VIABLE (POOL_INSUFFICIENT).
  - 17 openings considered, 8 simulated.
  - Best combination: 0.0% of worlds reach $10,000; settled p10 $0 · p50 $50 · p90 $225.
  - No constructed opening is modelled yet.
