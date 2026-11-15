# Adversarial findings — capabilities that work on fixtures and do nothing on production's data shape

Read-only investigation of branch `claude/brain-intelligence-recovery-s0dl4l` @ cba32d2, measured against the production
plan read (`plan-0008/goals.txt`, serving revision 7a8b565) and the census in `docs/INTELLIGENCE-RECOVERY-2026-11-14.md`.
Severity: CRITICAL = a released or "REPAIRED" capability is inert on production; MAJOR = it runs but on production's
shape produces a wrong or misleading result; MINOR = narrow.

---

## F1. TRANSFER can never fire on production: no production writer makes `captureMechanism` an EVIDENCE fact — CRITICAL

- Gate: `server/services/cash/construct.ts:313` (`evidencedCapture` = card facts `field='captureMechanism' AND kind='EVIDENCE'`)
  → `heldPrecedents` `construct.ts:120-133` requires an opening in **both** `evidencedPayer` and `evidencedCapture`.
  The standing kernel's transfer asks use the same function: `server/services/industry/transfer.ts:69`.
- Production writers of `captureMechanism`: only `validation.ts:2484-2501` (a *proposal*), stored by
  `recordRecommendationFact` at `validation.ts:2642` → kind `RECOMMENDATION`; `answers.ts:1066` → `RECOMMENDATION`;
  `opportunities.ts:329/353` → `RECOMMENDATION`/`PERSON`. The field is `BRAIN_PROPOSES` (`card.ts:311`), and
  `operate.ts:400-406` says BRAIN_PROPOSES fields "never become needs", so no research answer (`answers.ts:449`, the
  only `kind:'EVIDENCE'` writer for card fields via needs) and no dive lane (`FIELD_BY_LANE`, `validation.ts:2016-2039`,
  has no capture lane) ever writes it as EVIDENCE.
- Fixture: `tests/surgeBMechanismTransfer.test.ts:82-84` inserts `captureMechanism` with `kind:'EVIDENCE'` by hand.
- Production evidence: census "arrangements … transferred 0"; the plan's construction produced no TRANSFER pathway.
- Consequence: W-8 ("REPAIRED on branch"), G2 (eval case passes), S-12's transfer widening and the kernel's no-goal
  transfer asks are all unreachable on production. Fix shape: accept RECOMMENDATION capture composed from an EVIDENCE
  payer (that is exactly what validation.ts composes it from), or test the precedent on payer EVIDENCE + mechanism.

## F2. Research-filed construction facts (W-5/W-6) have no consumer on the path that cut 0 of 404 — CRITICAL

- Writer: `industry/expand.ts:875-945` `fileEconomicFact` → `repos/construction.ts:113` `recordClaimFact`.
- Only consumers: `industry/construction/service.ts:286` (`goalConstruction`, §92), called from `routes/goals.ts:283,297,339`
  and `goals/objectivePlan.ts:566`, which returns early unless the goal names an industry (`objectivePlan.ts:564`).
  `openWorld.ts:282` (probe) reads goal facts only (`listConstructionFacts(g.id)` with no project), so it ignores every
  research fact (workstream_id NULL) — MINOR on its own.
- The $10K plan's arrangements (`cash/construct.ts` `heldEvidence` :418-446) price from `cash_opportunities.price_cents`
  only; `goalScenario.ts` never reads `construction_facts` (grep: no import of `repos/construction.ts` in `cash/`,
  `goals/`, `quant/`).
- Production: construction_facts 0; even when the kernel writes them, the 404 arrangements' "no price of its own"
  (P-ADMIT) cannot be cured by them. W-5's purpose (price the map's roles) does not reach the goal model.

## F3. Construction facts will rarely be written at all on production — MAJOR (CRITICAL if no standing grant / sprint)

Preconditions, each read from code:
1. A kernel round must run: SPRINT (Cash Mode ACTIVE) or a live STANDING Russell goal other than the sprint's own
   (`industry/kernel.ts:154-196`); under STANDING, `databasePressure().state === 'SHEDDING'` opens nothing
   (`kernel.ts:249-265`) — production has repeatedly reported "Brain database saturated". Standing purposes are only
   BOOTSTRAP and MAP (`kernel.ts:113`).
2. The researcher must volunteer `structural_finding=UNIT_ECONOMIC|ROLE_TERMS` with a fact key from `FACT_KEY_LIST` and
   `structural_amount_cents` in hundredths. No kernel question asks for it: `questions.ts:78,109,191` ask for
   SUB_INDUSTRY / "the kind it is" / CAPITAL_*; the vocabulary exists only in the tool description
   (`mcp/researchTools.ts:1591-1608`, `domain/industry.ts:235-248`).
3. A buyer-qualified fact is refused unless a BUYER_TYPE node of exactly that lowercase name exists (`expand.ts:909-915`,
   `buyerNode` :852-866). Production holds 11 buyer types.
4. Only claims from orchestrations linked to an open kernel round's mission are read (`expand.ts:519-538`); the 16,786
   existing sourced claims are never back-filed.
- Production evidence: census 23:42Z — construction_facts 0, sectors/nodes/buyers unchanged 52/91/11 "no standing round
  has run since release". Fixtures submit UNIT_ECONOMIC claims directly.

## F4. P-ADMIT fix re-creates PRICE-POOL inside the simulation: uniform sweep across a 4–5 order-of-magnitude band — CRITICAL (misleading, not inert)

- `goalScenario.ts:1134-1136` builds `otherPrices` from every live opening with a payer and a price;
  `comparablePricesFor` (`:364-369`) uses the same sector only when ≥2 openings' `industry` string normalises equal to the
  arrangement's `sector`. Map-built arrangements take the map root's name (`construct.ts:326-331`, NAICS-style), and
  production opening `industry` strings are free text, so the fallback "every published price in this project" is the
  norm, not the exception.
- Production price set includes 15, 40, 100, 250, 1,000, 15,000 and 325,000 (×3) (plan-0008 `demand`/`pathway`
  lines). `sweptOverOtherPrices` (`:331-346`) sets `low=min, high=max`, no `distribution`, so the portfolio samples it
  uniformly (`portfolio.ts:478`, `:1246`): a dog-groomer arrangement draws a mean price of ~$160K per deal. Direct cost
  is then swept 0–60% of $325K and capital 0–$325K (`goalScenario.ts:242,278`).
- It cannot certify (provenance UNKNOWN), but it will dominate coverage/reach, the "leading combination", the
  "CHANGES PLAN" unknowns and the contribution ranking that decides which arrangement research asks next
  (`plan.ts:3230-3234`). This is S-13/PRICE-POOL again, now at admission. Test fixture band is 15–15,000
  (`tests/surgeBArrangementAdmission.test.ts:68-72`) and never checks reach.
- Fix shape: log-scale or empirical (the prices themselves) distribution, and a magnitude-compatibility bound, not
  uniform min–max.

## F5. Why only 11 of 418 live openings were considered — partly defensible; the waste is that the rest feed nothing — MAJOR

- Breakdown (plan-0008 "left out"): 282 "evidence only" (tier SIGNAL), 49 no price/revenue figure, 15 owner physical
  work, 9 goal exclusions, the rest closed or a one-off signal older than 30 days.
- SIGNAL = `captureMechanism` blank (`cash/tier.ts:361-380`); excluded at `goalScenario.ts:1075-1078`. The capture
  proposal is composed only when a payer card fact AND an offer scope exist (`validation.ts:2483-2484`) and only on a
  dive pass, so 282 openings never had a payer established. Excluding them as found openings is defensible
  (invariant 39).
- Not defensible: those 282 also feed neither construction (`construct.ts:335-347` takes buyer populations only from
  EVIDENCE-payer openings) nor transfers (F1), so 67% of the held world is inert in planning. 30-day staleness for
  one-offs (`goalScenario.ts:1099-1108`) is a cutoff, not decay — the W-12 decay repair was applied to quant
  observations, not here.

## F6. Capital share inferred across mechanisms refuses priced openings as "established" — MAJOR (verify the pool)

- `goalScenario.ts:842` infers `capitalShare` from `quant/knowledge.ts` (fields requiredCapital/exposure, material
  `mechanism` only as a "broad" flag, `knowledge.ts:56,235`). `capitalAtStart` treats a justified inference as
  established (`portfolio.ts:826`) → refused at `portfolio.ts:956-957`.
- Production: price 15,000 → capital E 14,985; price 3,000,000 → capital E 2,682,728; three of the 11 refused
  ("ties up 325000 at its start" / 15000). Grant/RFP work with ~99.9% capital share looks borrowed from resale/auction
  openings. The `portfolio.ts:944-953` comment says this size bias was fixed in Nov-06; it returns via the inference.

## F7. Library counters: asked/evaluated/picked — conditional, not inert

- `evaluated_count`/`last_evaluation_picked`: `plan.ts:2707-2714` → `arrangementLibrary.ts:148-166`; written only for
  `arr_` ids in `portfolio.demand` and only when a reading is persisted (`plan.ts:2668`: skipped when the digest is
  unchanged). Production 0 because 0 were admitted (P-ADMIT). Will move once F4's admission is live.
- `asked_count`: `discovery.ts:1296` only after `openConstructedRound`, which requires Cash Mode ACTIVE
  (`discovery.ts:1235-1236` → `lifecycle.ts:511-531`) plus focus caps and rotation ("construct not its turn" in
  plan-0008). W-1 removed the sprint gate from the kernel only; every goal lens and constructed round is still
  sprint-gated. If the sprint winds down, asked_count, K-4 verdicts (`arrangementLibrary.ts:180-215`) and all goal
  research stop — CRITICAL in that state.

## F8. Hermes' new detectors (H2-3) on production's rows — MAJOR

- Stuck plan (`operator/director.ts:1299-1335`): needs the last 3 stored readings with byte-identical
  `acceptance.shortfalls`. A reading is stored only when the plan digest changes (`plan.ts:2668`), and shortfall strings
  embed reach percentages and opening titles (`plan.ts:885-943`; plan-0008 shortfall text). A truly stuck plan writes
  no new reading; a changed one usually changes its text. Fires only in the narrow middle.
- Unreported rounds (`director.ts:1347-1382`): reads only goal-prefixed `cash_discovery_rounds`; under no sprint there
  are none (F7), and kernel/standing rounds (`industry_rounds`, where A-O6 happened) are never read.
- Inventory (`director.ts:1226-1266`): works, but only for findings with no owner; the Surge B inventory names an owner
  stream on nearly every row, so it is quiet by construction rather than by health.

## F9. Not in the inventory at all

1. **§102 variable sweep is inert on production**: plan-0008 "variable sweep abandoned: no evaluation thread is running";
   `evaluatorPool.ts:173,198` never runs a sweep inline, and after `REPLACEMENTS_PER_WINDOW` failed thread boots the pool
   has no threads (`:136-143`). Explore ran "45 evaluation(s) on 1 thread"; history shows 115,856-variation sweeps on
   11-14 and none now. Owner: Surge A (pool), but the capability loss is unrecorded. CRITICAL.
2. **Model-sourced directions are 0**: "4 call(s), 16 method(s) proposed, 16 refused as off-shape · 2 of 4 failed:
   cheap lane HTTP 429". 100% off-shape refusal is a contract/parser mismatch with the production model, not chance.
   MAJOR.
3. **Class of defect**: gates on a card-fact *kind* (EVIDENCE) for fields whose only production writer writes another
   kind; fixtures insert the kind directly (F1). Suggest a guard test that, for every `kind === 'EVIDENCE'` gate, a
   production writer of that (field, kind) exists.
4. **Class of defect**: a new writer whose only consumer is off the path that failed (F2); and magnitude-heterogeneous
   pools swept uniformly (F4).
