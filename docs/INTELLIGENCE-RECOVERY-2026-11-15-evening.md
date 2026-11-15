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
