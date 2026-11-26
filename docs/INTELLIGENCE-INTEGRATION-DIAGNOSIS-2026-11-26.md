# Does Brain's intelligence work as one system? (2026-11-26)

This is a diagnosis only. Nothing was repaired, built or benchmarked to produce it.

## Sources

**Production, read on 2026-11-26 between 01:47Z and 01:53Z:**
- `brain_operator_goals` and `brain_operator_goal_plan` for `wst_db2e2e0e5204477692d5`, Cash Mode 4 ($5k a month).
- `brain_operator_knowledge` and `brain_operator_capacity`.
- The hourly operations report `ops-report.20261126T01`.

**Model inputs and outputs:** the logs of eight read-only route probes that another session had already run on production revision `c52d6d3`:
- Planning-evaluation workflow runs 45734353734, 45735602666, 45736422198, 45736675836, 45737137017, 45737417473, 45737483565 and 45737781209.
- Cases dec1125c p02, p06 and p10.
- These logs show each model's reply, which model answered, and what the critique did.

**Code:** a read-only map of the goal path, with the key claims spot-checked.

**Not repeated:** the research-supply measurements are in `RESEARCH-STARVATION-DIAGNOSIS-2026-11-26.md`. Route generation is covered in `PLANNING-ROUTE-GENERATION-2026-11-25.md` and `PLANNING-9-10-INVESTIGATION-2026-11-24.md`. They are cited here, not re-measured.

## 1. What exists on the goal path

| faculty | where | status on the goal path |
|---|---|---|
| Objective intake | `industry/construction/intent.ts:900` `readObjective`; `objectiveAssist` | invoked |
| Route proposer, scout and critic | `goals/routeProposal.ts:1722` `proposeGoalRoutes` | invoked; 6-hour cadence |
| Goal discovery lenses | `cash/discovery.ts:1096` `openGoalDiscovery` | invoked |
| Constructed arrangements (§81, §93) | `plan.ts:6163` `goalArrangements` → `cash/construct.ts` | invoked; deterministic |
| Industry kernel | `russell/loop.ts:2226` | invoked |
| Validation dives | `cash/validation.ts:1238` | invoked; starved (§4.4) |
| Research execution, director and gate | `research/packetRunner.ts`, `research/intelligence/*`, `submission.ts:316` | invoked; starved |
| Harvest and evidence join | `discovery.ts:2132` → `routeEvidence.ts:115` → `answers.ts:445` | invoked |
| Knowledge library (§122) | `knowledge/pipeline.ts:274` → `knowledge/apply.ts:182` | invoked; feeds arrangements only |
| Quantitative planner, reconstruction and plan set | `plan.ts:2469` `readGoalPlan` | invoked |
| Investment committee (§117) | `goals/committee.ts:669`; specialists in `committeeSpecialists.ts` | rule roles invoked; model specialists `NOT_RUN` |
| Operator (Hermes, §106) | `operator/run.ts:218`, `director.ts` | invoked; works on engineering (§4.8) |
| Operations report | `domain/operationsReport.ts` | invoked hourly |
| Strong route model | `routeProposal.ts:1255` `strongRouteModels` | present; inert because no key or model is set |
| Self-improvement loop (§87, §111) | `improvement/loop.ts:1678` | off unless its switch is on |
| Realize and faculties, `reasoningController`, Sellbird | `realize/*`, `research/reasoningController.ts`, `agents/sellbird.ts` | not on the goal path |

## 2. Each handoff, classified by evidence

### Connected and demonstrably working together

These are proven on production.

- **Owner's words → route proposer and critic.**
  - p02 (probe 45737417473): the gpt-oss reply's owner profile reads "FAA Part 107 licensed drone pilot", "DJI Mavic 3", Phoenix, $1,500.
  - Its route is drone aerial packages for ARMLS real-estate agents, at $150.
- **Gated findings → proposer and critic.**
  - p06 (45736422198): the route's `priceAnchor` cites F2, a Casa Latina day-labour rate from the findings.
  - The controlled comparison in `RESEARCH-STARVATION-DIAGNOSIS` showed that supplied findings changed outcomes: usable plans went from 0/3 to 1/3.
- **Committee → acceptance.**
  - Production reading of `wst_db2e…`: committee `FAIL`, QUANT critical.
  - QUANT's finding: "rebuilt from proven facts alone … at most $320" against a simulated $30,940.
  - It blocks acceptance, and it is right to.
- **Knowledge library → arrangement buyer counts.**
  - 84 `PLAN_INPUT_CHANGED` and 89 `CONSTRUCTION_FACT` applications.
  - 80 buyers are linked to Census counts.
  - It is connected and it moves numbers. Whether those numbers are right is in §4.5.

### Connected, but not meaningfully influencing decisions

- **The hourly report's own diagnosis.**
  - It says: "Survived 12 reports unchanged — reconsider the diagnosis rather than repeating it".
  - The same hour: Hermes "Goals inspected 0", "strategy changes 0", and one decision, a Factory dispatch fix.
- **Committee questions.**
  - Its OPERATOR role asked "when buyers of … pay" for two legs.
  - In production, `answeredBy: []`: the questions go out as research into a 2,063-item queue and do not come back.
- **Knowledge contradictions.**
  - 1 unresolved: 3,570 vs 71,964 for "firms sending year-end gifts".
  - Read only by `contradictionCounts`, so they are display only.
  - `notePlanEffects` (plan.ts:6192) only records.
- **Plan → route ask.**
  - The ask is given only `heldTitles` (plan.ts:5877).
  - It gets no verdict, no failed constraints and no binding factor.
- **The operations report's choice of model.**
  - "STRONGER MODEL: NO — … the plan's shortfall is evidence, not reasoning."
  - That is computed from Hermes' tool-call success alone (`domain/operationsReport.ts:327-336`).
  - The measured route-model gap (Claude credible on 10/10 goals, gpt-oss on 5/10, 2026-11-25) never enters the call.

### Present but unused

- **Route `rethink` lessons** are written to `operator_learnings` (`routeProposal.ts:1911`), and `routeContext` reads no learnings.
  - The only reader is the operator's optional history tool (`operator/actions.ts:108`).
  - Calibration lessons (`calibration.ts:520`) have the same fate.
- **The owner profile the model writes on every ask** is kept only in event detail and has no reader. It is re-derived on each ask.
- **The strong route model** (`strongRouteModels`) is empty: `BRAIN_ROUTE_MODEL` and an Anthropic key are not set.
- **Committee specialists** read `"specialists":{"state":"NOT_RUN"}` on the production reading.
- **Research slots:** "278 launchable idea(s) have a free slot" beside 2,063 waiting (capacity read 01:47Z).
- **Realize and faculties, and `reasoningController`:** no caller on the goal path.

### Broken or obstructed handoffs

- **Primary model → proposal.**
  - In the 8 production probes, the primary model (gpt-oss-120b on the GPU) failed the proposal turn in 4 of 8:
    - 3 returned `content:""` with `error:null`: 45736675836, 45737483565 and 45737781209;
    - 1 got HTTP 524 after 125 s: 45735602666.
  - It also failed one critique turn: `critique_unreadable … chars:0` (45737137017).
  - The fallback (`free:auto/best-coding`) answered each time.
- **Fallback → owner profile.**
  - In all 4 fallback replies, the owner's refusals came out as "no physical work, no travel, no deliveries, no meeting customers, no performing services".
  - In two of them the owner's words state no refusal at all. p06 is "I can put in 15 hours this week".
  - The prompt says "never invent it" (routeProposal.ts:395), but it also lists `OPERATING_MODEL_SENTENCE` among the owner's LIMITS (routeProposal.ts:343). The fallback model copies Brain's standing rule into the owner's profile.
- **Critic → routes.**
  - The final ranked list was empty in 6 of 8 probes: the single route was dropped and nothing survived.
  - The drops rest on the critic's own assertions, which nothing checks. p10, three probes: "fails WINDOW: first snow events typically occur in December, well after the 90-day window ends", written for a window that starts in late November. December is inside it.
  - The snow-contract route the critic dropped is the direction the controlled comparison's verified facts pointed to.
  - Whether `critiqueAndRevise`'s single replacement ask ran is not visible in the probe output. That is unknown.
- **Knowledge library → buyer identity.**
  - Buyers that are sentence fragments get Census counts. Production applications:
    - "Requesters" → NAICS 5182 Data Processing, 18,544–83,545;
    - "Canon is a merchant that pays for ecommerce platform services as documented…" → NAICS 4541, 54,707;
    - "Named clients publicly reviewed" → NAICS 5416, 371,758–1,894,424.
  - Each one then reads "buyers established … the next research round asks for conversion". A wrong match closes the buyer question and redirects research.
- **Arrangement constructor → plan set.**
  - 426 candidates, 49 distinct, 377 collapses.
  - Signatures are built from tokenized claim text, for example `risk=are client marketplace one pay project safe upwork who` and `risk=100 50 co go homeowner neighbor ops organize safe so solar united`.
- **Research supply.** Already measured elsewhere, and still true at 01:00Z:
  - 1,977 queued;
  - the oldest wait is 126,955 min;
  - fragments complete at 6% for evaluation goals.
- **Refuted claims → proposer.** `projectEvidenceClaims` (`repos/research.ts:1186`) filters `accepted = 1` but not `contradiction_state`, so a refuted claim can still be shown as a finding. This is proven in code; the production effect is unmeasured.

### Unknown because evidence is insufficient

- Whether research retrospectives (`guidance.ts:38`) change worker output.
- Whether the scout→refuted loop changes later asks in production: few dives complete.
- Whether `cashOutcomeLessons` would change the quant. There are no cash outcomes; $0 has been collected.
- Whether the self-improvement switch is on in production. This credential cannot read deficiencies or experiments.

## 3. Answers to the eight questions

1. **What exists.** About fifteen faculties (§1). Twelve are on the goal path.
2. **What is invoked.**
   - Invoked: intake, proposer and critic, discovery, construction, the industry kernel, the planner, rule-based committee roles, the knowledge pass, Hermes and the report.
   - Unused or inert: the strong route model, committee specialists, rethink and calibration lessons, the owner profile, realize and faculties, `reasoningController`, and research slots beside waiting work.
3. **Does the next system receive the information?**
   - Partly. Findings, owner words and committee verdicts are received.
   - Lessons, owner profiles, committee questions, plan verdicts sent to the route ask, and knowledge contradictions are not.
4. **Does it change decisions?** Where received, yes: findings changed routes (0/3 → 1/3), and the committee blocks acceptance. But two things undercut that:
   - The final say on every route ask belongs to whichever model answers last, the critic. Its unchecked assertions remove the routes the findings produced.
   - Half the time the answering model is the fallback.
5. **Unnecessary limits.**
   - `OPERATING_MODEL_SENTENCE` and `REMOTE_AI_FOCUS` are appended to every discovery round (`discovery.ts:1304`, `questionFor`) and to every route ask, whatever the goal's own words offer. The route ask lifts the rule only when `ownerLabourOffer`'s regex matches.
   - So discovery asks for "work this operation can run entirely online" for a licensed drone pilot (p02) and for an owner offering 15 hours (p06).
   - A single critic veto, with a 6-hour cadence before the next ask (`ROUTE_PROPOSAL_EVERY_MS`).
   - Findings are capped at 40 (p02: 79 supplied, 40 shown).
   - Other fixed caps: `MAX_LIVE_GOAL_ROUNDS` 3, `MAX_VALIDATION_ROUNDS` 2, `ROUTES_PER_DAY` 6, and 12 fixed `GOAL_LENSES`. Most are defensible; the two above are not.
6. **Duplication and contradiction.**
   - Six generators produce openings: route proposer, discovery lenses, arrangement constructor, pathway constructions, open-world and role lenses, and operator research rounds.
   - Five readers interpret the owner: `readObjective`, `objectiveAssist`, the model's per-ask profile, `ownerLabourOffer` and `ownerBrief`.
   - Four rule sets judge feasibility: `ROUTE_RULES`, `worthResearching`, the `goalScenario` exclusions and the committee roles.
   - Nothing arbitrates among them. One production reading (`wst_db2e…`) holds four different "best" answers:
     - the chosen strategy, `only_o1` (HubSpot reseller);
     - the acceptance candidate, HVAC + Agorapulse (`QUANT_PORTFOLIO`);
     - the reconstruction's best, cold-email mailboxes plus a retainer (93% coverage);
     - and, from the hourly report, a binding factor of REPLY, while acceptance blames an unknown price and the committee blames volume and price.
7. **Reconsideration.**
   - Detected but not acted on: the report flags its own 12-hour repetition, and Hermes changes no strategy.
   - Recorded but not read: rethink and calibration lessons.
   - Asked but not answered: committee questions.
   - The one working loop is scout refutation, where `DISQUALIFIED_FIELD` becomes the refuted list. It is starved of dives.
8. **Alignment with the owner's objective.**
   - The owner's words reach the proposer and discovery. They do not reach validation dives (card fields only), the arrangement constructor or the knowledge pass.
   - Hermes spent the hour on a Factory dispatch fix while the plan's binding constraint sat unchanged for 12 reports.
   - 4 of 6 live cash goals read `next: "[NOBODY] Brain judges each idea on its next pass"`: no faculty owns the goal's next step.

## 4. Common mechanisms (most failures first)

1. **No shared per-goal working state.**
   - Each faculty re-reads raw rows and writes its conclusion to a store of its own: `operator_learnings`, event detail, `construction_facts`, knowledge contradictions, `ROUTE_RANK_FIELD`, committee needs, the report.
   - The conclusions of one faculty are not the inputs of the next.
   - This explains:
     - lost rethinks;
     - an owner profile re-derived each time, and fabricated by the fallback;
     - four "best" strategies and three binding diagnoses in one reading;
     - unanswered committee questions;
     - a report that sees its own repetition while Hermes does not;
     - the `[NOBODY]` next step.
2. **A model's single reply is final, and its competence is never measured on the work.**
   - An empty reply is not an error, so the turn falls to a weaker model.
   - A critic's unsourced assertion drops the only route.
   - Model adequacy is judged by tool-call success.
   - This explains the 4/8 primary failures, the invented refusals, 6/8 asks ending with nothing, the false WINDOW drops, and "stronger model: NO".
3. **Standing rules injected as prompt text instead of one goal-resolved constraint set.**
   - The owner-physical sentence and `REMOTE_AI_FOCUS` are added everywhere, and the per-goal lift exists in one place only.
   - Weak models turn the rule into the owner's refusals, and discovery searches online-only work for owners who offered labour.
   - The same rule is re-implemented by regex in three gates (`goalScenario.ts:3086`, `worthResearching.ts:270`, `answers.ts:722`).
4. **Evidence supply** (already diagnosed).
   - Every evidence-gated faculty idles: dives, the committee's questions, acceptance and the scout loop.
   - The only fast "evidence" source, the knowledge library, fills buyer counts by fuzzy wording matches and marks them established.
5. **Parallel generators and selectors with no arbiter** (6, 5 and 4, as listed in §3 question 6).
   - It multiplies candidates: 426 candidates collapse to 49 distinct ones.
   - It produces contradictions, rather than concentrating effort on the one strategy the evidence supports.

## 5. Shared corrections that would lift several components at once

Each extends an existing owner; none is a new intelligence system.

| correction | extends | components it lifts |
|---|---|---|
| **A. One goal working record, read first and written last.** The resolved owner profile and constraints, the chosen strategy and its binding factor, open questions (committee and dive), lessons (rethink and calibration) and refuted directions. | the goal plan reading (`goal_plan_readings`) and `routeContext` | proposer, critic, discovery, dives, committee, Hermes, report |
| **B. Constraints resolved once per goal, passed as data.** The operating-model rule with the goal's labour or asset offer applied, its limits and exclusions. Every prompt and every regex gate reads that object instead of appending `OPERATING_MODEL_SENTENCE` or `REMOTE_AI_FOCUS`. | `domain/operatingModel.ts` (`operatingFit`, `ownerLabourOffer`) | discovery, proposer, critic, three regex gates |
| **C. A model turn is checked before it counts.** Empty content is an error, and the next capable model answers. A critic may drop a route only on a cited finding or a hard limit; an unsourced objection becomes that route's first dive question. Model adequacy is judged on route outcomes. | `critiqueAndRevise`, `applyCritique`, dive lanes, `operationsReport.ts:327` | proposer, critic, dives, report, model choice |
| **D. One selector.** The plan reading's chosen strategy is the single answer that acceptance, the committee, the report and Hermes read. Other generators submit candidates to it. | `readGoalPlan` | planner, committee, report, Hermes, constructor |
| **E. A knowledge link must name a real segment.** A Census count attached to a fragment-shaped buyer is an ESTIMATE that does not close the buyer question. | `knowledge/apply.ts` | knowledge library, arrangements, research targeting |

## 6. The smallest structural set

A, B and C. They address mechanisms 1–3, which account for most of the observed failures that are not the supply problem:
- lost lessons;
- fabricated owner refusals;
- empty-model fall-through;
- critic vetoes on false claims;
- contradictory selections;
- discovery working against the owner's offer;
- the unowned next step.

D is the natural consequence of A: A gives D somewhere to live.

E is small and independent.

Mechanism 4 (evidence supply) is already diagnosed. Its remaining remedies are owner items recorded in `RESEARCH-STARVATION-DIAGNOSIS-2026-11-26.md`: keyed search, worker membership, and optionally the strong route model's key.

## 7. Proven and still to test

| finding | status |
|---|---|
| The primary model failed 4/8 production proposal turns (empty or 524), and 1 critique turn was empty | **proven** (workflow logs) |
| The fallback model wrote Brain's standing rule as the owner's refusals (4/4 fallback replies) | **proven** (logs and prompt text at `routeProposal.ts:343`) |
| The critic dropped every route in 6/8 asks; p10 dropped three times on a false WINDOW claim | **proven** (logs) |
| Rethink and calibration lessons are never read by the proposer, discovery or the planner | **proven in code**; production read path absent |
| Committee questions unanswered; specialists `NOT_RUN` | **proven** (production reading) |
| One reading holds four different "best" strategies and three binding diagnoses | **proven** (production reading and report) |
| Knowledge library links fragment-shaped buyers to NAICS counts and marks them established | **proven** (production knowledge view) |
| The report's "stronger model: NO" ignores route quality | **proven in code** (`operationsReport.ts:327-336`) |
| Discovery appends online-only focus whatever the owner offered | **proven in code** (`discovery.ts:986`, `:1304`); production effect on p02 and p06 rounds **to test** |
| Refuted claims can reach the proposer | **proven in code**; frequency **to test** |
| The critic's replacement ask runs and helps | **unknown** |
| A–C would raise usable plans | **to test.** Cheapest test: replay the 8 logged probes with correction C applied (no new benchmark) |
| Research retrospectives, scout loop and outcome lessons have an effect | **unknown** (starved or no outcomes) |
