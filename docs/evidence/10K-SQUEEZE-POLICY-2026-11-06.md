# SQUEEZE goals sell, they do not test (2026-11-06)

Owner's order, 2026-11-06: a SQUEEZE goal — a time-constrained cash target —
has no separate market-testing phase. Released in #589 (`22167cb`, Deploy
42310570604, machine replaced 23:28Z, after Postgres suite 42308915983).

## On production (Goals `plan` 42314588796, goal `wst_7b4fcbb5f2384f31b6c3`)

- `policy SQUEEZE`: a cash target with a deadline.
- `market test` lines: none. Before #589 the same reading listed
  `market test cop_665f0a84… up to 50` and a next test "A bounded offer test …
  Fewer agreements than the plan needs downgrades it."
- `sale cop_665f0a845f984d168461 up to 50 [PERSON]` — the one opening a
  responsible offer can be made on today (reachable buyer, offer, price,
  outlay inside $375), linked PURSUES so the goal's money limits bind it.
- `next step [PERSON] Sell "Artisanal Sudoku …": offer it to its reachable
  buyers at … for an actual sale, contract or deposit.` The blocker is the
  standing CONTACT_BUYER permission — a blocker on the sale, not a test phase.
- The selection fix still holds: 18 found + 12 constructed estimates
  compared, 9 refused; best 1.6% of worlds (coverage), p50 232, p90 6 477.

Only one opening is sellable now because the others lack a quoted offer,
price or known outlay on their card. Under SQUEEZE_QUALIFICATION they need
nine facts rather than sixteen to be offered, and the operator's research now
asks only those; each one that becomes offerable joins the sales, best
contribution first, up to six at once.
