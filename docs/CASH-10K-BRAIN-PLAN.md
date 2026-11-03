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

_Sections 2–9 are filled from the production reads after #470 deploys._
