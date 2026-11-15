# Lens Q (Surge B) — can a reconstructed estimate ever satisfy a plan?

Read-only investigation, 2026-11-14, tree at 058a9b2 (branch claude/brain-intelligence-recovery-s0dl4l).
Defects already listed in docs/PLANNING-RECOVERY-2026-11-14.md (Q-1…Q-9, C-1…C-15, RC-1…RC-8) are not re-reported.

## Verdict in one paragraph

**No.** EVIDENCED_PORTFOLIO cannot be reached for any opening, and the reason is structural, not weak evidence.
A COMPARABLE conversion estimate built from three independent sourced comparables of n=200 each is
reconstructed correctly. It is exported as an EMPIRICAL distribution and counts toward basis PROBABILITY. It is then
refused twice, at two independent gates:
1. **Assurance** (`quant/portfolio.ts:1027`) reads its "sample" as the **number of studies** (3), not the
   information they carry (600 events). It also demands ≥ 20 such studies and puts a Wilson bound on *reach*
   over that count. Even a reach of 100% then needs at least 25 independent studies (reach 1.0, n=3 gives a lower bound of 0.53).
2. **The chain** (`goals/plan.ts:549`). CONVERSION passes only when `close.provenance === 'HISTORICAL'`.
   ECONOMICS and SETTLES_IN_TIME pass only when `value !== null`, and every inferred input has value null.

The other evidence sources are refused too:
- **Brain's own measured close rate (the HISTORICAL lesson path).** It is not `established()` in the portfolio and it states no sample.
- **Brain's own TRANSFERABLE Instantly record.** It is relabelled `UNKNOWN`.
- **An evidenced volume (the fixed count that MARKET_VOLUME requires).** It makes the sample "unstated".

The link that each input type passes is exactly the link that the assurance or basis gate then fails. The two are
mutually exclusive by construction. MEASURED_RECORD can only be fed by earlier ACCEPTED plans, so it is a
bootstrap deadlock. Only TARGET_MET can ever be ACCEPTED.

## Reproduction (ran, then deleted)

`tests/zz-lensQ-repro.test.ts` was copied into tests/, run with vitest (6/6 pass), and **deleted afterwards**. A copy is kept at
`/tmp/claude-0/-home-user-V5/ee4d8d9c-4857-5ee6-ac4e-f365ba02baf5/scratchpad/lensQ-repro.test.ts`.
(node_modules was empty, so `npm ci --ignore-scripts` was run. Other investigators were installing at the same time, and
the TAR warnings came from that overlap. No repo files were changed by me. The dirty `goals.yml` and `scripts/knowledge-census.ts` are not mine.)

| step | result |
|---|---|
| close: 3 sources, COUNT 40/200, 46/200, 36/200, same mechanism, other industry (immaterial), distinct lineage | tier **COMPARABLE**, p10 .137 / p50 .205 / p90 .294, τ = 0.30 (the floor), `distributionJustified` true, export **EMPIRICAL / EVIDENCE**, `established()` true, `inferred.observations` = **3** |
| one repeatable opening: price/days/cost/capital fixed EVIDENCE, respond and close inferred as above, volume fixed EVIDENCE 500, 100 emails/day stated | basis **PROBABILITY**, reach **1.00**. `sampleSizeOf` is **undefined** (a fixed volume is BEHAVIOURAL), so assurance is CALIBRATION_UNAVAILABLE |
| same, volume given as inferred (obs 600) | `sampleSizeOf` = 3. Assurance: `"sample size 3 is under 20"`, researchNeeds **[]**. `judgeAcceptance` gives **CANDIDATE_ONLY**, with text "the 100% is share of scenarios covered, not a probability" (it contradicts basis PROBABILITY) |
| same, with production's chain (close is EVIDENCE, not HISTORICAL) | shortfall: "chain is incomplete: buyers who have actually agreed to it" |
| close = Brain's own lesson (HISTORICAL 0.15–0.26, "40 of 200 agreed") | `established()` **false**, basis **COVERAGE**, unestablished `['close rate']` |
| `readRate("…200 qualified leads, 20% converted (n=200).")` | `{kind:'POINT', value:0.2}`: the sample is dropped, so the rate reads as unsized (4 events, bounds only) |
| Wilson lower bound (z = 1.645) | reach 1.0: n=3 → .526, n=20 → .881, n=25 → .902. Reach .97 with n=600 → .956 |

## The path, with file:line

1. **quant estimate.** `quant/knowledge.ts:792-843` `observationsFor`:
   - Close evidence comes from Brain's own lessons (COUNT) and from card facts `conversionRates` / `buyingEvidence`, read by `readRate` (:755).
   - `readRate` returns a POINT (unsized) or a RANGE, never a COUNT and never a `sampleSize`.
   - Context (:718) is {opportunity, mechanism, signal, industry, priceBand}. Only `mechanism` is material (:63-64).
   - Another mechanism is `broad` (MECHANISM tier, bounds only).

   `quant/pool.ts:136` `onScale`: an unsized POINT is worth 4 events and marked `unsized`. A RANGE is **not** marked unsized.

   `reconstruct.ts:202-231` COMPARABLE: the distribution is justified when there are ≥ 2 kept populations (or one direct) and they are not all unsized.
2. **Export.** `quant/export.ts:42`: EMPIRICAL with provenance EVIDENCE when justified, else RANGE (`ASSUMPTION` / `UNKNOWN`).
3. **goalScenario.** `cash/goalScenario.ts:356-376` `inferOr`:
   - Sets `value: null`, `distribution: EMPIRICAL`, `inferred.observations = est.used.length` (a count of studies).
   - The close rate from a lesson (:455-466) is HISTORICAL `{value:null, low, high}` with **no distribution**.
   - `respond` from a lesson is `known(1,'HISTORICAL')`.
   - Volume (:493-501) is fixed only from an EVIDENCE count; a RECOMMENDATION estimate is swept.
4. **goals/portfolio.ts.**
   - `established` (:291): EVIDENCE/HISTORICAL **and** (value set, or a non-RANGE distribution).
   - `unestablished` (:631): an opening's `justified` flag is true only when nothing is unestablished, and `basis` (:767) is PROBABILITY only when every member is justified.
   - `sampleSizeOf` (:248-266): inferred inputs give `observations`; a fixed or null BEHAVIOURAL input (respond/close/volume) gives undefined.
   - Repeatable with no stated outreach (:686) gives undefined.
5. **quant/portfolio.ts `assess`** (:1017-1077):
   - Every member needs `sample ≥ MIN_EVIDENCE_SAMPLE = 20` (:279).
   - It then takes a Wilson bound on `best.reach` with n = nMin (:1061-1066) and needs a lower bound ≥ 0.9.
   - researchNeeds is empty for a STATED and justified member (:1050).
6. **goals/plan.ts `judgeAcceptance`** (:723-835): basis must be PROBABILITY, the chain `missingLinks` (:768) must be empty, and the assurance must claim at least 90%.
   - `assuranceSample` (:850) regex-parses the reason string.
   - MEASURED_RECORD (:692-700) counts RECOMMENDABLE readings, which exist only after an ACCEPTED one.
7. **Chain** (`linkChecks`, :524-579). These are the checks that fail:
   - CONVERSION needs HISTORICAL (:549).
   - ECONOMICS needs `directCost.value` and `capital.value` (:561).
   - SETTLES_IN_TIME needs `daysToCash.value` (:566).
   - MARKET_VOLUME needs a fixed EVIDENCE volume (:612, `volumeEstablished` goalScenario.ts:548).
   - OFFER_AND_PRICE needs a non-inferred price (:539).
8. **Asymmetry.** :1074 uses a justified inferred `daysToCash.p10` to **refuse** a strategy (NOT_VIABLE), but the same estimate can never **establish** SETTLES_IN_TIME.
9. **Hermes challenge.** `planReady.ts` (domain :114-185; service :160) runs only after ACCEPTED, so no real plan is ever challenged through this path.

## Findings

### Q2-1 — EVIDENCED_PORTFOLIO is unreachable by construction (CRITICAL)
- **Where:** `goals/plan.ts:549,561,566,612` against `goals/portfolio.ts:248-266,291` and `quant/portfolio.ts:1027`.
- **Symptom:** No plan with a new buyer, an agreed sale, or a repeatable volume can ever be ACCEPTED, however strong its evidence.
- **Root cause:** Each input passes its link only in a representation that the basis or assurance gate rejects:
  - close: HISTORICAL with no distribution passes the link but fails `established` and the sample;
  - close: inferred EVIDENCE passes basis but fails the link;
  - volume: fixed EVIDENCE passes the link but its sample is undefined;
  - days/cost: fixed values pass the link but state no sample, inferred values fail the link.
- **Repair:** Give each input one representation, an `EvidencedInput {distribution, sample: {events, populations}, tier}`, read by both gates. In practice:
  - Make the lesson close an EMPIRICAL Beta(a+½, b+½) with `inferred.observations = contacts` (goalScenario.ts:458).
  - In `linkChecks`, accept `established(input)` for ECONOMICS and SETTLES_IN_TIME, judged on p90 cost and p90 days.
  - In `sampleSizeOf`, treat a sourced count (volume) or a contractual term as a fact, not BEHAVIOURAL.
  - Add a regression test proving that some evidenced fixture *can* reach ACCEPTED (none exists today; `planningAcceptance` only asserts refusals).

### Q2-2 — The "smallest real evidence sample" counts studies, not information (CRITICAL; artificial)
- **Where:** `goalScenario.ts:375` (`observations: est.used.length`), `quant/portfolio.ts:279,1061`.
- **Symptom:** Three n=200 comparables give "sample 3 < 20". 25 independent studies would be needed even at reach 100%.
- **Root cause:**
  - Unit confusion: the count of observations (and for COMPONENT, the sum of all children's `used`) is fed into a binomial interval on reach.
  - The interval also double-counts uncertainty: an EMPIRICAL predictive distribution already carries se + τ, so reach over worlds is already a predictive probability.
- **Repair:** Replace the Wilson-over-nMin step in `assess` with parameter-uncertainty propagation.
  - In an outer loop, draw each input's *parameter* from its sampling distribution (pooled mean ± se, plus τ for a new population).
  - Run the inner worlds as now.
  - Claim at least 90% when the 5th percentile of reach across outer draws is ≥ 0.9.
  - If an n is still wanted, use an event-equivalent effective sample `n_eff = p(1-p)/Var(p)` from the predictive sd. τ ≥ 0.3 caps comparables at about 70 events, which correctly limits transferred evidence.
  - Keep `MIN_COMPARABLE_POPULATIONS` as the population rule. Drop `MIN_EVIDENCE_SAMPLE = 20` populations, or restate it in events.

### Q2-3 — CONVERSION is defined as "Brain's own sales" only (HIGH; partly artificial)
- **Where:** `goals/plan.ts:111,549`.
- **Symptom:** A defensible comparable close rate never completes the chain. The next test is always a CONTACT_BUYER market test.
- **Root cause:**
  - The link label "buyers who have actually agreed to it" equates conversion evidence with Brain's own measurement.
  - This contradicts §95's "evidence or this Brain's own measurements" and the owner's 2026-11-03 order quoted at knowledge.ts:57.
- **Repair:** Add a `CONVERSION` state of TRANSFERRED. It passes when the close estimate is DIRECT, or COMPARABLE with ≥ 2 independent *sized* populations and n_eff over a stated threshold, with the tier carried into acceptance wording. HISTORICAL stays the stronger state and replaces TRANSFERRED as soon as it exists. Unsized-only or MECHANISM estimates still fail (principled).

### Q2-4 — Brain's own TRANSFERABLE outreach record is relabelled UNKNOWN (HIGH; artificial)
- **Where:** `goals/portfolio.ts:440-452` (`withMeasuredReply`, BINDS mode).
- **Symptom:** The best evidence §99 defines (Brain's own campaign, sound list) becomes a swept RANGE with provenance `UNKNOWN`, so "reply rate" is unestablished.
- **Root cause:** BINDS writes `provenance: 'UNKNOWN'` and no distribution.
- **Repair:** In BINDS mode, emit HISTORICAL with an EMPIRICAL Beta posterior on the opportunities and sends, and `inferred.observations = sent`. Keep CONTEXT_ONLY and NOISE as they are.

### Q2-5 — Sized published rates are read as unsized, and unsized RANGEs as precise (HIGH; both directions)
- **Where:** `knowledge.ts:755-775` (`readRate`), `pool.ts:154-161` (RANGE has no `unsized` flag, variance from width).
- **Symptom:**
  - "20% of 200 (n=200)" is worth 4 events and bounds only.
  - "closes 10–25%" (no sample) is worth about 57 trial-equivalents and can justify a distribution, even DIRECT with τ floor 0 when it sits on the target's own card.
- **Root cause:**
  - `readRate` never extracts a denominator.
  - A RANGE is read as sampling precision rather than between-population spread.
- **Repair:**
  - Parse "x of N", "n=N", "N leads/contacts/calls" next to the figure into COUNT or `POINT{sampleSize}`.
  - Mark a RANGE without a stated sample as unsized for `allUnsized`.
  - Read a range's width as τ (heterogeneity), not as v.

### Q2-6 — A failed threshold asks for the wrong thing, or nothing (HIGH)
- **Where:** `quant/portfolio.ts:1047-1055`; `goals/portfolioNeeds.ts:103`; `plan.ts` CONVERSION nextTest; `needsMoreOpenings`.
- **Symptom:** When the sample is below 20 the researchNeeds list is empty (shown in the repro). For unjustified members it asks for generic "market history (bid/win)". The plan's next step is "contact buyers" (blocked on CONTACT_BUYER), and the goal widens discovery. New openings carry the same structural refusal, so the goal loops.
- **Root cause:** Gate shortfalls are prose in `missing`. They are not typed needs that name the quantity, the tier needed, and the evidence that would satisfy it.
- **Repair:**
  - Have `assess` emit `{opportunityId, input, have: {tier, populations, n_eff}, need: {...}}`.
  - Route it through `sendNeeds` as a targeted research question, e.g. "two more independent sized close-rate populations for mechanism M", or "a sized denominator for source S".
  - Rank by the acceptance gap, beside EVPPI.

### Q2-7 — Reconstruction is used only to refuse, never to establish (MEDIUM; artificial asymmetry)
- **Where:** `goals/plan.ts:1074` against `:566`.
- **Repair:** Apply the symmetric rule. A justified inferred p90 inside the deadline establishes SETTLES_IN_TIME (marked transferred), just as p10 past the deadline refuses it. Do the same for ECONOMICS with the p90 cost share.

### Q2-8 — Verdict vocabulary cannot say "constructed with stated uncertainty" (MEDIUM)
- **Where:** `plan.ts:191` (ACCEPTED, CANDIDATE_ONLY, NO_CANDIDATE, NOT_SUPPORTED), `:100` (RECOMMENDABLE, NEEDS_EVIDENCE, NOT_VIABLE), `quant/portfolio.ts:228`.
- **Mapping to the requested statuses:**

  | requested status | current equivalent |
  |---|---|
  | CONFIDENCE VERIFIED | ACCEPTED (unreachable) |
  | NOT SUPPORTED | NOT_SUPPORTED (arithmetic only) |
  | QUANTITATIVELY CONSTRUCTED | none |
  | IMPROVEMENT REQUIRED | none |

  The last two are both collapsed into CANDIDATE_ONLY. The assurance RANGE status ("x–y%") is reachable only at ≥ 20 samples, so an evidenced plan prints "share of scenarios covered, not a probability" while basis says PROBABILITY. `candidateSentence` (:838) then says "a probability", so the reading contradicts itself.
- **Repair:**
  - Add acceptance statuses `CONSTRUCTED` (basis PROBABILITY, stated interval below the requirement) and `IMPROVEMENT_REQUIRED` (coverage, naming the inputs).
  - Always return an interval (from Q2-2's outer loop) with its evidence tier.
  - Map `planReady` to them.
  - Let Hermes challenge CONSTRUCTED plans, not only ACCEPTED ones.

### Q2-9 — MEASURED_RECORD is a bootstrap deadlock (MEDIUM)
- **Where:** `plan.ts:692-700,809`.
- **Root cause:**
  - Its cohort is RECOMMENDABLE readings, which exist only after ACCEPTED.
  - It needs ≥ 10 such outcomes, and Wilson z = 1.96 needs ≥ 35 perfect outcomes for a lower bound of 0.9.
  - It is pooled across all goals regardless of similarity.
- **Repair:**
  - Record outcomes for CONSTRUCTED plans too, keyed by tier.
  - Calibrate predicted versus realized (the forecast ledger already exists: `quant/forecast.ts`, `ledger.ts`) instead of the bare success rate.
  - Use calibration to widen or narrow the Q2-2 interval.

### Q2-10 — Shared parameter uncertainty is drawn independently per opening (MEDIUM; overclaim)
- **Where:** `goals/portfolio.ts:455-465` (sampler per opening, `rng` seeded by `one.index`), `knowledge.ts:861` (the same estimate is cached for openings in one context).
- **Symptom:** Two openings whose close rate came from the same comparables get independent draws of that rate, which invents diversification. Only the shared-outreach risk group is correlated, by the stated constant 0.5 (`SHARED_OUTREACH_CORRELATION`, :81).
- **Repair:** Key parameter draws by the estimate's identity (node key + lineage set) so openings share the same quantile per world, as `reconstruct.propagate` already does (reconstruct.ts:391).

### Q2-11 — Missing statistical safeguards (MEDIUM; principled additions)
- Predictive quantiles use a normal on 2–3 studies (`reconstruct.ts:81`). They should use Hartung–Knapp or a t with k−1 degrees of freedom; at k = 3, p90 uses 1.89 instead of 1.28.
- The DerSimonian–Laird τ is unstable at k ≤ 3.
- There is no publication or selection-bias discount for vendor and case-study conversion figures. Suggested: a source-class factor (ANECDOTAL or SECONDARY) on the mean, or a wider τ floor.
- The definition is not a material dimension. "conversion/bought/buy" (knowledge.ts:743) mixes visitor-to-purchase with lead-to-close, contrary to §79's "a different definition … is excluded". Add `measures` / `funnelStage` to the context and to `material`.
- Lineage is URL host+path (knowledge.ts:777). Two blogs restating one upstream study are not collapsed. Add an extracted `citesSource` to the lineage.
- The demand structure (Poisson × Binomial, `portfolio.ts:503-505`) is assumed, with no structural uncertainty.
- `effectiveSample` in the pool (`pool.ts:256`) is an effective study count, while COMPONENT takes the min over children and `used` the sum. The unit is inconsistent.

### Q2-12 — Fragile and stale (LOW)
- `assuranceSample` regex-parses prose (`plan.ts:852`).
- The docstring at `plan.ts:711-714` still says the Wilson bound is taken "over the worlds evaluated".
- §95 in the architecture record describes a gate that cannot pass, and no test asserts that it can.

## (b) Principled versus artificial refusals

**Principled (keep):**
- Unsized-only evidence is bounds only.
- A single comparable is bounds only.
- MECHANISM, ASSUMED and UNKNOWN are never a distribution.
- A material difference excludes an observation unless it is adjusted with a source.
- Lineage collapse.
- Simulated worlds are not evidence.
- An ASSUMED reconstructed move is never a probability.
- A RECOMMENDATION-kind volume is swept.
- Fulfilment needs a named party.

**Artificial (refuse defensible evidence for representation reasons):**
- Q2-1: mutually exclusive gates.
- Q2-2: study-count samples with a Wilson bound on reach.
- Q2-3: CONVERSION needs HISTORICAL.
- Q2-4: Brain's own TRANSFERABLE record becomes UNKNOWN.
- Q2-5 (the sized half): `readRate` drops the sample.
- Q2-7: used only to refuse.
- Q2-9: deadlock.

**Overclaims, in the other direction:**
- Q2-5 (the RANGE half): an unsized range treated as precise, and DIRECT for a benchmark on the target's own card.
- Q2-10: independent parameter draws.
- Q2-11: normal predictive, no selection-bias discount, definitional mixing.

## (c) / (d) Short answers

- **(c)** A plan is always *constructed*: a candidate is named, with reach and basis. But no status means "evidenced, interval x–y%, below 90%". Every non-arithmetic shortfall reads CANDIDATE_ONLY, and the uncertainty statement is lost to CALIBRATION_UNAVAILABLE (Q2-8).
- **(d)** No useful research is triggered. A failed threshold asks for nothing when the sample is below 20, generic bid/win history otherwise, or a CONTACT_BUYER test. Discovery widens with openings that hit the same wall, so it loops (Q2-6).

## Suggested order of repair

1. Q2-2, one representation of input sample plus outer-loop assurance.
2. Q2-1 and Q2-3, the link checks.
3. Q2-4.
4. Q2-5.
5. Q2-6.
6. Q2-8.
7. Q2-10 and Q2-11.

Add a regression test: an evidenced fixture (sized comparables, own measured reply, sourced volume) **reaches ACCEPTED**. The same fixture with unsized-only rates stays CONSTRUCTED.
