# Surge B — evening record (2026-11-15)

## P-PLANSTALL: the $10K plan could not move (found 16:25Z)

**Symptom.** The last stored plan reading was at 03:47Z, while construction facts went 19→43 and constructed rounds 0→9.

**Cause.** The tick did read the plan. The reading never changed because `estimated arrangements: 0 of 404` reached the model.

**Repairs.**

| PR | What it fixes | Status |
|---|---|---|
| #937 | The tick treats a read that writes no row as a read, so the plan is no longer re-read on every pass and the scenario slot is no longer held | Deploy 1095 ✓ |
| #940 | Construction facts now price constructed arrangements: a FEE design's `a_value` is reconstructed; buyers are matched by `payerKey` | Deploy 1099 ✓ (all checks, Postgres included) |

**Production after #940** (read-only `goals plan`, 18:50Z):

| measure | before | after |
|---|---|---|
| reach | 23.1% | 46.7% |
| p50 | $0 | $15,000 |
| verdict | — | CANDIDATE_ONLY (correctly not certified) |

Constructed arrangements now enter the model. Pathways: 23 (11 found, 12 constructed).

## R-PREPAID (found 18:55Z, engineer assigned)

Most of the 46.7% rests on one constructed arrangement: Brain producing a ~$2.77M state utility-services contract, sourced from a PA PUC RFP.

The prepaid-fulfilment reconstruction zeroes its $881K direct cost. A public award pays in arrears, and the arrangement has no fulfiller and no channel.

This is a reasoning defect. The reach is labelled as coverage and nothing is certified, so it is not a false certification. It is still a misleading "strongest candidate".

The fix: the prepaid lever applies only where prepayment is evidenced. UNKNOWN payment terms are never read as favourable (invariant 39). The plausibility critic covers constructed arrangements.

## R-PREPAID verified on production (Deploy 1102, 20:4xZ)

`goals plan wst_7b4fcbb5f2384f31b6c3` after Deploy 1102 (0b92050):

- Prepaid fulfilment: "of 16 opening(s) with a direct cost: 0 shown paying before delivery (prepaid fulfilment tried), 9 paying in arrears". The $881K cost of the state-utility arrangement is no longer zeroed.
- The best reconstruction fell from 46.7% / p50 $15,000 (inflated) to **13.0% / p50 $17,471** (deposit + price×4 + 20 mailboxes for $372, every one labelled ASSUMPTION or ESTIMATE). As held: 9.2% / p50 $0.
- SCALE flags every reading that rests on the utility or VA arrangements ("needs $440,655 … 877× the $3,375 behind the plan").
- The CAPITAL binding line is present (money limits ×2 → 21.8%). Headroom is 18.2% with every factor favourable, which is STRUCTURAL: the openings held cannot reach the requirement.
- Acceptance stays CANDIDATE_ONLY. Verified.

## R-PORTFOLIO-COST (found in the same reading; repaired)

- **Symptom.** The pathway portfolio still led with three copies of the utility arrangement: "net p50 $10,000 · 100% of the gap". The quantitative model, on the same reading, called them implausible.
- **Root cause.** `pathways.ts` centres an unknown range by its geometric middle. For a cost of $0–$881,310 that is √(1e-6 × 881,310) ≈ $0.94, so the cost was collapsed to almost nothing and net ≈ price. The quant model centres the same cost arithmetically ($440,655). Two readers of one plan disagreed about the same fact.
- **Repair.**
  - A cost range touching zero is centred arithmetically (`costCentre`).
  - A pathway whose one-deal cost exceeds the money behind the plan, on an unproven price, is kept out of every combination (`unfundedDeal`, the SCALE critic's rule) and listed as `unfunded`.
  - Conversion keeps its geometric centre, which is the conservative direction for a quantity that multiplies.
- **Tests.**
  - New: `tests/goalPathways.test.ts` and `tests/program-ea512f54-repair-opp-04-1.test.ts`.
  - The sudoku fixture's direct cost was narrowed to $0–$10, because the old generic $0–$100 sweep on a $50 price now centres at $50.
- **Verification on production.** The leading combination no longer contains the arr_15871099b48b, a6b3115af393 or 035a07b10502 group, and they appear under `unfunded`.

Also seen in this reading:
- `[runpod] fallback to brain-a: runpod HTTP 404` and "breaker open". The RunPod endpoint answered 404 during the read and the free lane fell back.
- The model lane made 4 calls and all 4 failed with HTTP 429. The plan still completes without the model.
- The RunPod 404 is likely the balance (owner top-up, already in YOU DO). It is checked next.
