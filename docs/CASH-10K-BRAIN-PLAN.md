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

## 9. Limitations that remain

- **Research throughput is the binding constraint, and it is outside this change.**
  - In the hour to 19:54Z, the free lane completed 14 items and accepted 0. The providers answered with HTTP 503/429 errors 48 times.
  - The free-AI screens failed 26 of 36 answers in 24h.
  - Research in flight was 27, against a grant of 13.
  - Path questions sat at 21 open against a cap of 8.
  - The scaling assignment owns this. No paid API may be added.
- **Outreach capacity is the owner's fact.** Until the goal states it ("N emails a day"), no reading can be a probability.
- **Constructed openings need a deep dive** before they carry a price. Until then they are evidence, not work.
- **Old anime evidence is still in the pool.** It is filed honestly as found, and the goal's limits and the plan judge it.

