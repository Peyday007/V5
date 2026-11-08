# $10K goal: the goal-to-transaction reasoning loop on production (2026-11-08)

Goal `wst_7b4fcbb5f2384f31b6c3` (project `prj_22fb4fec295f403a8a22`). §93 in
`docs/ARCHITECTURE-RECORD.md`; code `server/services/goals/pathways.ts`.
Each figure below is OBSERVED, read from a Goals `plan` run on production.
MODEL figures are coverage over swept bounds, not probabilities.

## Before (Goals 42440096724, 02:49Z, before #614)

- The plan read NOT_VIABLE: the 19 openings reach at most $250 of $10,000 at prices buyers are shown to pay. The best combination reaches the target in 1.4% of swept worlds, with a p50 of $0.
- Each opening was a list of missing chain links. No opening had a transaction model.
  - No transaction structure had been derived from the goal.
  - No missing link had been constructed.
  - No unknown was ranked by its effect on the plan.
- The next step was generic: "Discover, construct and research openings that can reach the 10000 USD."

## Releases

| PR | What | Deploy | Postgres suite |
|---|---|---|---|
| #614 | The loop | 42444539149 success | 42444532363 success |
| #615 | Constructed estimates enter it; resales are not price pages; `ONLY_AT_BEST_CONVERSION` | 42447611922 success | 42447606789 success |
| #616 | No sale without a named fulfiller; no transfer of a resale or a constructed design | 42449708840 success | 42449705195 success |

Each fix came from reading the loop's output on production (Goals 42446423985 and 42449194430), not from a synthetic case.

## After (Goals 42451409194, on #616)

**Backward from the goal (MODEL arithmetic over the declared bounds).**
- The goal needs $10,000 in 19 days. Outreach capacity is 10–60 prospects a day, swept because nobody has stated it.
- At the middle of the conversion bounds the plan already sweeps, direct outreach can carry the goal only with deals netting at least **$9,623 each**.
- 1–30 deal structures (netting $10,000 down to $333) are reachable only at the best conversion bound: `ONLY_AT_BEST_CONVERSION`.
- 100–1,000 deal structures (netting $100 down to $10) need 89–889 prospects a day even at the best conversion: `NEEDS_INBOUND_CHANNEL`.
- A recurring buyer pays once before the deadline.

So the decisive unknown is conversion, and only selling measures it. The search brief now tells every goal round to prefer buyers who are already asking.

**Transaction models.**
- 31 pathways: 19 found and 12 constructed estimates.
- Every field of every pathway carries a status: 121 PROVEN, 155 ESTIMATED, 158 UNKNOWN.
- 11 pathways have a reachable buyer; 5 have a named fulfiller.

**Constructed from partial evidence: 24 moves, 23 re-quantified variants.** None of these existed in executable form before. Examples:
- `cop_07c9bd8e908b42f49f9b` (Rev.com publishes $1.98/min for human transcription). Before, this was "no buyer" and "costs at least what it pays".
  - Now: compete for Rev's own buyers at 50–90% of its published price (ESTIMATED), with our cost UNKNOWN and not invented.
  - Or refer Rev's buyers for a 10–30% commission.
  - It must hit: about 722 sales at $1.39 (70% of $1.98) to carry a tenth of the gap.
- `cop_ef8dba9460474dc6994b` (Verblio at $0.06/word) and `cop_b1eb51e4932c43528d39` (a published $1.20 price) get the same supplier-price flip.
- `cop_665f0a845f984d168461` (Artisanal Sudoku, $50 a puzzle, one buyer): sell the same deliverable to the population of puzzle publications. It must hit 20 buyers like it to carry a tenth of the gap.
  - `cop_9fd24b12b74c46c58c38` (Puzzle Society) and `cop_5243df363ac144dc8e38` (GitHub bounty) get the same transfer.
- `cop_c385c9d99a0943a1bdd0` (Campo Brokers): change the transaction role, to a referral or the end buyer's price, to recover a margin.

**Shaping the search.**
- Unknowns are ranked by how far they move the plan. The top ones are the constructed reverse designs' price, which swings $286, and their conversion, which swings $238. Either could move them out of the leading combination.
- Pathways with those unknowns are researched first. Each research question now carries the figure its transaction must hit.

**Living portfolio (MODEL).**
- Leading combination: net p50 $24.72, p90 $10,000 (gross p50 $26.19), 0.2% of the gap at p50.
- If its largest correlated group fails, $19.23 remains.
- Fallback without that group: p50 $19.47.

**The method's own failures (now leading the goal round's instructions).**
- ACQUISITION_FAILURE: 8 of 16 priced pathways have no reachable buyer of ours.
- VOLUME_UNRESEARCHED: 16 pathways are small per sale and their buyer count is unknown.
- REPEATED_GAP: 14 of 19 openings fail the same way: nobody is named to fulfil them.

## Measures the owner asked for

- **Quality and completeness.** All 14 fields are modelled for each of the 31 pathways. 28% of facts are proven, 36% estimated and 36% unknown.
- **Reachable buyer and fulfilment evidence.** 11 of 31 pathways have a reachable buyer and 5 of 31 have a fulfiller.
- **Supported versus estimated economics.** Prices are PROVEN only for the GitHub bounty ($250). The rest are ESTIMATED: a person's figure, a listing or a reconstruction. Conversion is UNKNOWN on every pathway.
- **Time from starting evidence to a usable offer.** For a held opening the construction appears on the first plan read after release (minutes). It reaches the world when construction's half of the live cap frees. At 04:57Z, six constructed rounds were still researching, so the first `mx-pw…` round had not yet opened.
- **Effect on the goal portfolio.** The plan now names specific constructed transactions and the figures each must hit, where before it had only a generic "find more openings". The modelled reach has not moved, because no construction has come back from research yet.
- **Pathways that can proceed without further engineering.** 1: the Sudoku sale, blocked only by permissions and providers.
- **Remaining barriers to collected cash.**
  1. No standing CONTACT_BUYER, QUOTE_AND_INVOICE or ACCEPT_PAYMENT grant on the project, and no message provider or billing provider (owner, MISSING_AUTHORITY).
  2. Conversion is unmeasured. At the conversion bounds the plan sweeps, outreach alone cannot close $10,000 in 19 days unless deals net about $9,600 or buyers are already asking.
  3. 14 of 19 openings have nobody named to fulfil them.
  4. Commercial research runs only on the free lane (§84 brain-only mode).
