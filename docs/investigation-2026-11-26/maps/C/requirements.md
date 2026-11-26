# Requirements map C — derived from the outcome

Investigation 2026-11-26. Derived only from the owner's outcome definition, working backward from *an independent grader marks this plan USABLE with zero critical mistakes*. No Brain code, docs or tests were read. Every requirement's *Brain implements* field is **TO BE RECONCILED**.

Counts: **89 requirements** (53 CRITICAL, 33 MAJOR, 3 MINOR), **32 handoffs**, **20 critical-mistake classes**, **186 dependency edges** (acyclic).

Files: `requirements.json`, `handoffs.json`, `critical_mistakes.json`, `graph.json` (nodes; edges of type `depends_on`, `handoff`, `causes_critical_mistake`).

## 1. What a USABLE plan is

| id | element | the plan must contain |
|---|---|---|
| U01 | Objective fidelity | Restates the objective exactly: metric (collected, settled cash unless the owner said otherwise), amount, window with real dates, capital, owner-involvement limit and every owner-stated constraint; adds no restriction the owner did not state (any system policy that limits the plan is disclosed as such); discloses interpretations of ambiguities. |
| U02 | One selected strategy, fully specified | What is sold, to which real buyer segment, at what price, through which acquisition channel, fulfilled how and by whom, paid by which mechanism on which terms. |
| U03 | Arithmetic that reaches the target | Unit economics with all material costs (fees, COGS, shipping, taxes, refunds, acquisition), a volume/funnel model from daily actions to collected cash with capacity limits, reaching the target in the expected case with a stated, derived confidence; every number internally consistent and recomputable. |
| U04 | Cash feasibility | A dated cash-flow schedule in which the balance never drops below zero given the stated capital, including prepayments, holds, reserves and settlement lags; peak capital need stated. |
| U05 | Time feasibility | A critical path with real dates covering every prerequisite (accounts, approvals, warm-up, supplier lead time, buyer cycle, delivery, settlement) such that enough cash is collected before the window ends, with slack stated. |
| U06 | Owner feasibility | Owner hours per week within the stated limit; every capability, licence, account or credential required is either held by the owner (per a record) or acquired by a planned step within budget and window. |
| U07 | Lawful and terms-compliant | No step breaks law in the relevant jurisdictions or a platform's terms (outreach, consumer protection, licensing, tax, data protection, marketplace and ad rules). |
| U08 | Evidence and assumptions | Every material figure traces to cited, applicable evidence, an owner input, or an explicit assumption; decisive assumptions are named with ranges and each has an early test. |
| U09 | Executable steps and a named first action | Ordered steps with actor, inputs, duration, dependencies, cost and done criteria; a first action that can start immediately with no unmet prerequisites. |
| U10 | Checkpoints, kill criteria and fallback | Dated leading indicators with thresholds and the response if missed, protecting remaining capital; a fallback where one is feasible. |
| U11 | Money commitments and approval | Each spend listed with amount, timing, reversibility and the approval it needs; total and peak within capital; no spend executes without owner approval. |
| U12 | Alternatives and honest confidence | Briefly states the strategies considered and why they lost; states confidence and open unknowns without overclaiming. |

**Rule.** USABLE = U01..U12 all satisfied AND zero critical mistakes (Q-CM01..Q-CM20). A plan with any critical mistake is not USABLE regardless of quality elsewhere.

## 2. Critical mistakes

| id | mistake | definition | caused by failure of |
|---|---|---|---|
| Q-CM01 | Arithmetic cannot reach the target | The plan's own volumes x contribution cannot produce the target, or contains an arithmetic error that, corrected, misses it. | Q-R021, Q-R040, Q-R041, Q-R043, Q-R044 |
| Q-CM02 | Wrong target metric | Plans to profit, bookings, GMV or invoiced amounts when the objective is collected revenue (or vice versa). | Q-R001, Q-R002, Q-R041, Q-R055 |
| Q-CM03 | Cash cannot settle inside the window | Revenue counted that will be held, on net terms, or paid out after the window ends. | Q-R002, Q-R014, Q-R041, Q-R046, Q-R047 |
| Q-CM04 | Capital exceeded or working capital ignored | Peak cash need exceeds available capital at some date; or MOQ/ad spend/prepayment exceeds it. | Q-R036, Q-R042, Q-R069, Q-R046 |
| Q-CM05 | Buyer does not exist or cannot be reached | Fabricated companies or contacts, a segment too small, or a channel that cannot reach it. | Q-R035, Q-R029, Q-R030, Q-R039 |
| Q-CM06 | Decisive figure fabricated or unsupported | A price, conversion rate, cost or lead time presented as fact with no applicable evidence. | Q-R028, Q-R029, Q-R030, Q-R034, Q-R045, Q-R054, Q-R026 |
| Q-CM07 | Requires a capability, licence or account the owner lacks | Step needs a licence, entity, merchant account, skill or audience the owner does not hold and the plan does not acquire. | Q-R003, Q-R049, Q-R007, Q-R051 |
| Q-CM08 | Owner involvement exceeds the limit | Owner hours or owner-only tasks exceed the stated involvement. | Q-R001, Q-R048, Q-R038 |
| Q-CM09 | Invented or dropped restriction | Plan obeys a restriction the owner never stated (e.g. a system policy presented as the owner's) or ignores one the owner did state. | Q-R001, Q-R004, Q-R017, Q-R055, Q-R010 |
| Q-CM10 | Unlawful or terms-of-service-breaking action | Spam, prohibited scraping, unlicensed regulated activity, fake reviews, fee circumvention, tax non-compliance. | Q-R007, Q-R050, Q-R039 |
| Q-CM11 | No named, executable first action | First action vague, dependent on unmet prerequisites, or absent; steps not executable. | Q-R066, Q-R067, Q-R051 |
| Q-CM12 | Timeline infeasible | Lead times, approvals, warm-up, buyer cycle or delivery cannot fit the window. | Q-R014, Q-R039, Q-R047, Q-R036, Q-R035 |
| Q-CM13 | Internal contradiction | Different values for the same quantity across sections, or narrative strategy differing from the computed one. | Q-R008, Q-R009, Q-R053, Q-R062, Q-R070 |
| Q-CM14 | Supplier or fulfilment cannot deliver | Supplier invented, capacity below required volume, fulfilment cost or quality omitted. | Q-R036, Q-R038, Q-R040 |
| Q-CM15 | Money committed without approval or outside ceiling | Plan or system spends before owner approval, beyond a ceiling, or double-commits on retry. | Q-R069, Q-R072, Q-R078 |
| Q-CM16 | Stale or superseded evidence used | A figure refuted or superseded during reasoning still drives the plan. | Q-R009, Q-R031, Q-R058, Q-R045 |
| Q-CM17 | Material cost omitted | Missing fees, taxes, refunds, acquisition or fulfilment cost that flips feasibility. | Q-R040, Q-R046, Q-R038 |
| Q-CM18 | Decisive unknown hidden or resolved favourably | Plan rests on an untested decisive assumption presented as fact, with no test or checkpoint; or confidence overstated. | Q-R023, Q-R026, Q-R044, Q-R068, Q-R073, Q-R080 |
| Q-CM19 | Plan for the wrong objective or corrupted output | Empty, truncated or garbled plan; plan answering another goal; model failure accepted as content. | Q-R010, Q-R056, Q-R070, Q-R071, Q-R079, Q-R082 |
| Q-CM20 | No plan or false infeasibility for a feasible objective | Goal never terminates, stalls, or reports infeasible because discovery/strategy failed. | Q-R006, Q-R016, Q-R018, Q-R019, Q-R060, Q-R083 |

## 3. Requirements by stage

### S01. Intake and interpretation

#### Q-R001 — Structured objective specification (CRITICAL)

- **Accomplish:** Turn the owner's free-text objective into a structured, versioned specification: target metric, amount, currency, window (start event, end date, timezone), capital available, owner-involvement limit, and every other stated condition, keeping the verbatim source span for each field.
- **Inputs:** owner objective text; current date
- **Outputs:** objective spec (fields + verbatim spans + confidence)
- **Correct when:** Every field cites a span of the owner's text or is marked UNSTATED; no field holds a value the text does not support; re-parsing the same text yields the same spec; a grader comparing spec to text finds no added or dropped condition.
- **Depends on:** —; **required by:** Q-R002, Q-R003, Q-R004, Q-R005, Q-R006, Q-R008, Q-R013, Q-R014, Q-R048, Q-R055
- **Failure modes:** model paraphrases '$10k revenue' as profit or bookings; window start assumed instead of read (creation vs approval); capital read as spendable budget when owner meant total exposure; empty/garbled parse accepted (see Q-R056); silent default fills an UNSTATED field
- **Recovery:** Re-parse with a validator that diffs fields against spans; unresolved fields become explicit interpretation decisions (Q-R002/Q-R005), never silent defaults.
- **Observe:** Replay objective texts through intake; diff spec fields against verbatim spans; count fields with no span.
- **Brain implements:** TO BE RECONCILED

#### Q-R002 — Target-metric semantics (CRITICAL)

- **Accomplish:** Decide precisely what counts toward the target: collected (settled, available) cash versus invoiced, booked, GMV, or profit; gross versus net of refunds; whether pass-through money (resold goods at cost) counts; whether returning the capital matters.
- **Inputs:** objective spec
- **Outputs:** metric definition with recognition rule and the alternative interpretations rejected
- **Correct when:** A written recognition rule exists (e.g. 'counts when funds are in the owner's account and not reversible within normal chargeback risk'), is applied identically by economics, timeline and plan, and any reading other than the literal one is shown to the owner in the plan.
- **Depends on:** Q-R001; **required by:** Q-R021, Q-R041, Q-R055
- **Failure modes:** 'collected revenue' treated as orders placed; marketplace payout lag ignored; revenue counted gross of refunds; different faculties use different metric definitions
- **Recovery:** Recompute economics and timeline against the single recognition rule; flag plan sections using another definition.
- **Observe:** Inspect metric definition record; check each plan figure labelled toward target uses its recognition rule.
- **Brain implements:** TO BE RECONCILED

#### Q-R003 — Owner capability and asset profile (CRITICAL)

- **Accomplish:** Capture what the owner has and can do: skills, licences, legal entity, jurisdiction, payment/merchant accounts, audiences, domains, inventory, tools, network, hours available, risk tolerance — each as known, unknown, or absent.
- **Inputs:** objective text; prior owner records; owner answers
- **Outputs:** owner profile with per-item status and source
- **Correct when:** Every capability a plan later relies on has status KNOWN-HELD with a source (owner statement or verified record); unknowns stay UNKNOWN and are never read as held.
- **Depends on:** Q-R001; **required by:** Q-R005, Q-R006, Q-R007, Q-R015, Q-R017, Q-R046, Q-R049
- **Failure modes:** assuming the owner has a Stripe account, an LLC, a sales skill or an audience; profile copied from another goal/owner; stale profile after owner's situation changed
- **Recovery:** Treat unknown as absent for planning, or add an acquisition step, or ask (if decisive, Q-R005).
- **Observe:** For each plan step, list required capabilities and check each against profile status and source.
- **Brain implements:** TO BE RECONCILED

#### Q-R004 — Constraint provenance: owner constraint vs system policy (CRITICAL)

- **Accomplish:** Tag every constraint with its origin: OWNER-STATED, LEGAL/PLATFORM-RULE, SYSTEM-POLICY (e.g. a default exclusion or a cost cap), or SYSTEM-ASSUMPTION. Only owner-stated and legal constraints may narrow the strategy space for this goal; system policies may limit how the system works but must not appear as the owner's restriction and must not silently exclude strategies.
- **Inputs:** objective spec; system configuration; legal findings
- **Outputs:** constraint register with provenance and scope (this goal only / global)
- **Correct when:** No strategy is excluded by a constraint whose provenance is not owner or law unless the exclusion is disclosed in the plan; a constraint from a previous goal does not bind this one; the plan's constraint list equals the owner-stated set plus disclosed legal ones.
- **Depends on:** Q-R001; **required by:** Q-R016, Q-R017, Q-R055
- **Failure modes:** system default ('no physical products', 'no industry X', 'email only') presented as owner restriction; a previous goal's constraint leaks; owner's stated constraint dropped because a policy contradicts it
- **Recovery:** Re-run screening with only legitimate constraints; disclose any policy that still limits the plan.
- **Observe:** List screened-out strategies with reasons; check each reason's constraint provenance.
- **Brain implements:** TO BE RECONCILED

#### Q-R005 — Ambiguity resolution with minimal owner involvement (MAJOR)

- **Accomplish:** For each ambiguity decide whether it is decisive (changes strategy feasibility or selection). Non-decisive: adopt the conservative reading and record it. Decisive and unresolvable from records: ask the owner one batched, precise question, while continuing other work.
- **Inputs:** objective spec; owner profile; decision-value estimates
- **Outputs:** interpretation decisions; at most a small batched owner question set
- **Correct when:** Owner questions are only about decisive items unanswerable from records; each recorded interpretation is visible in the plan; work on non-dependent branches is not blocked by a pending question.
- **Depends on:** Q-R001, Q-R003, Q-R023; **required by:** —
- **Failure modes:** asking many trivial questions (violates minimal involvement); guessing a decisive fact favourably; stalling all work on one question
- **Recovery:** Fall back to conservative interpretation and a plan variant per answer if the owner does not reply within a bound.
- **Observe:** Count owner questions per goal and classify each as decisive or not; check plan discloses interpretations.
- **Brain implements:** TO BE RECONCILED

#### Q-R006 — Objective feasibility pre-screen and honest infeasibility (MAJOR)

- **Accomplish:** Estimate early, from order-of-magnitude reasoning, whether the objective is plausibly reachable, and at the end report infeasible (with the closest achievable variant) rather than fabricate a plan.
- **Inputs:** objective spec; owner profile; environment model
- **Outputs:** feasibility prior; final feasibility verdict
- **Correct when:** On infeasible control objectives the system reports infeasibility with reasons; on feasible ones the prior does not prematurely stop search.
- **Depends on:** Q-R001, Q-R003, Q-R013; **required by:** —
- **Failure modes:** forced plan for an impossible target; premature 'infeasible' that ends search; verdict based on one weak strategy
- **Recovery:** Continue discovery while the prior is uncertain; final verdict only after selection (Q-R062).
- **Observe:** Include infeasible controls in evaluation; inspect verdicts and reasons.
- **Brain implements:** TO BE RECONCILED

#### Q-R007 — Jurisdiction and location determination (CRITICAL)

- **Accomplish:** Establish the owner's legal jurisdiction, tax residence and operating location (and buyers' locations) because law, payment rails, licences and tax depend on it; unknown is an answer that forces conservative choices.
- **Inputs:** owner profile; objective text
- **Outputs:** jurisdiction record with source or UNKNOWN
- **Correct when:** Every legal, tax, payment or licence conclusion names the jurisdiction it assumed, and that jurisdiction comes from a record; none is assumed by default.
- **Depends on:** Q-R003; **required by:** Q-R013, Q-R046, Q-R049, Q-R050
- **Failure modes:** US law assumed for a non-US owner; buyer jurisdiction ignored (GDPR for EU recipients)
- **Recovery:** Ask if decisive; else restrict to strategies lawful in all plausible jurisdictions.
- **Observe:** Check each legal/payment finding for a jurisdiction field and its provenance.
- **Brain implements:** TO BE RECONCILED

### S02. Shared per-goal understanding

#### Q-R008 — One shared per-goal understanding (CRITICAL)

- **Accomplish:** Maintain a single authoritative, versioned goal model (objective spec, metric rule, owner profile, constraint register, environment facts, opportunity set, strategies, assumptions, evidence links, economics, critique findings, current selection) that every faculty reads from and writes to; no faculty reasons from a private copy or from conversational memory.
- **Inputs:** outputs of all faculties
- **Outputs:** versioned goal model
- **Correct when:** Every faculty output records the goal-model version it read; at selection time all inputs to the decision reference the same version or a compatible later one; two faculties never hold conflicting values for the same fact without a conflict record.
- **Depends on:** Q-R001; **required by:** Q-R009, Q-R010, Q-R011, Q-R012, Q-R016, Q-R020, Q-R032, Q-R045, Q-R052, Q-R053, Q-R082, Q-R084
- **Failure modes:** faculties pass prose between each other and lose structure; economics uses a price the actor analysis revised; multiple 'current' strategies; state only in a chat transcript
- **Recovery:** Rebuild derived views from the goal model; reject writes that bypass it.
- **Observe:** For a goal, collect every faculty output and compare the version and values of shared facts.
- **Brain implements:** TO BE RECONCILED

#### Q-R009 — Change propagation and staleness (CRITICAL)

- **Accomplish:** When any fact, evidence item or assumption changes, mark every dependent computation (economics, rankings, plan sections) stale and recompute it before it is used.
- **Inputs:** goal-model change events; dependency links
- **Outputs:** stale flags; recomputed dependents
- **Correct when:** No released plan contains a value derived from a superseded input; the dependency closure of a change is recomputed within the run.
- **Depends on:** Q-R008, Q-R045; **required by:** Q-R058, Q-R061
- **Failure modes:** plan keeps an old conversion rate after research refuted it; recompute skipped after worker crash; dependency links missing so staleness not detected
- **Recovery:** Full recompute of the goal's derived state from inputs before release.
- **Observe:** Mutate one input in a replay; check that every derived figure using it changes or is flagged.
- **Brain implements:** TO BE RECONCILED

#### Q-R010 — Goal isolation and scoped knowledge reuse (CRITICAL)

- **Accomplish:** Keep each goal's owner-specific facts, constraints and evidence applicability separate; reuse only general market knowledge, explicitly scoped and re-checked for applicability.
- **Inputs:** goal models; shared knowledge base
- **Outputs:** scoped reads
- **Correct when:** No fact, constraint or figure in goal A's plan originates from goal B unless it is general knowledge marked as reused and applicability-checked; a plan always answers its own objective.
- **Depends on:** Q-R008; **required by:** Q-R076
- **Failure modes:** plan for the wrong objective after a worker picked up a mismatched item; another owner's assets assumed; cross-goal cache returns wrong-region figures
- **Recovery:** Invalidate contaminated items and recompute.
- **Observe:** Trace each plan fact's origin goal id.
- **Brain implements:** TO BE RECONCILED

#### Q-R011 — Assumption register (CRITICAL)

- **Accomplish:** Every non-evidenced belief used in reasoning is an explicit assumption with value/range, basis, sensitivity, status (untested/supported/refuted) and the decisions it affects.
- **Inputs:** strategy specs; economics
- **Outputs:** assumption records
- **Correct when:** Every plan figure not tied to evidence or owner input ties to an assumption record; refuted assumptions are not used.
- **Depends on:** Q-R008; **required by:** Q-R023, Q-R026, Q-R045, Q-R075
- **Failure modes:** assumptions embedded silently in prose; refuted assumption still feeding economics
- **Recovery:** Extract implicit assumptions from plan text in critique (Q-R054) and register them.
- **Observe:** Count plan figures without evidence/owner/assumption linkage.
- **Brain implements:** TO BE RECONCILED

#### Q-R012 — Durable, resumable reasoning state (MAJOR)

- **Accomplish:** Persist every intermediate step so a crash, restart or worker loss resumes from the last checkpoint without losing completed work or duplicating effects.
- **Inputs:** all step outputs
- **Outputs:** checkpoints
- **Correct when:** Killing any worker mid-run and restarting yields the same final plan class (modulo model nondeterminism) with no duplicated research effects and no lost evidence.
- **Depends on:** Q-R008; **required by:** Q-R078, Q-R079, Q-R081, Q-R082
- **Failure modes:** in-memory state lost on restart; resume re-runs completed research and doubles cost; partial writes leave inconsistent model
- **Recovery:** Transactional checkpoints; idempotent step keys; restart from last committed step.
- **Observe:** Fault-injection replay: kill workers at random steps and compare outcomes.
- **Brain implements:** TO BE RECONCILED

### S03. Economic environment

#### Q-R013 — Economic environment model (MAJOR)

- **Accomplish:** Build a dated model of the relevant environment: markets and demand the owner can reach, seasonality and events inside the window, platform and channel landscape, available payment rails, prevailing prices and costs, and regulatory regime for the jurisdiction.
- **Inputs:** objective spec; jurisdiction; research results
- **Outputs:** environment facts with evidence links and dates
- **Correct when:** Environment facts used in reasoning are evidenced and dated within a freshness bound appropriate to the fact; seasonality inside the window is considered.
- **Depends on:** Q-R001, Q-R007; **required by:** Q-R006, Q-R015, Q-R016
- **Failure modes:** model's training-era knowledge treated as current; holiday or seasonal effects inside window ignored; platform rules out of date
- **Recovery:** Refresh stale facts via research queue when they are decisive.
- **Observe:** Inspect environment facts for evidence and dates; check window calendar effects are listed.
- **Brain implements:** TO BE RECONCILED

#### Q-R014 — Calendar and time arithmetic (CRITICAL)

- **Accomplish:** Compute against the real calendar: today's date, window end, business days, holidays, weekends, payout schedules, shipping days and lead times.
- **Inputs:** current date; window; jurisdiction
- **Outputs:** calendar model used by timeline and cash-flow
- **Correct when:** All dates in the plan are real calendar dates consistent with the window; durations computed in business days where the counterparty works business days.
- **Depends on:** Q-R001; **required by:** Q-R021, Q-R041, Q-R042, Q-R047
- **Failure modes:** model's notion of 'today' wrong; 30 calendar days treated as 30 business days; payout on a bank holiday
- **Recovery:** Deterministic date computation; never model-generated dates.
- **Observe:** Recompute every plan date deterministically and diff.
- **Brain implements:** TO BE RECONCILED

#### Q-R015 — Owner-advantage mapping (MINOR)

- **Accomplish:** Identify what the owner's assets, skills, relationships and location make unusually cheap or fast, to steer discovery toward strategies the owner can execute quickly.
- **Inputs:** owner profile; environment model
- **Outputs:** advantage list
- **Correct when:** Discovery candidates include ones exploiting listed advantages; advantages are only those with KNOWN-HELD status.
- **Depends on:** Q-R003, Q-R013; **required by:** Q-R016
- **Failure modes:** imagined advantages; advantages ignored, yielding generic strategies
- **Recovery:** Re-seed discovery from advantages.
- **Observe:** Compare advantage list to candidate set.
- **Brain implements:** TO BE RECONCILED

### S04. Opportunity discovery

#### Q-R016 — Broad opportunity discovery without a fixed catalog (CRITICAL)

- **Accomplish:** Generate candidate opportunities across business-model classes (services, productized services, resale/arbitrage, brokering, digital products, local services, B2B, events, rentals, etc.) and industries, seeded by owner advantages and the environment, never limited to a predefined list.
- **Inputs:** goal model; advantage list; environment model; learned priors
- **Outputs:** opportunity candidate set with class labels and rationale
- **Correct when:** The candidate set spans several distinct business-model classes and industries; no industry or class is absent because of a system list; candidates for an objective unlike any seen before are still produced.
- **Depends on:** Q-R008, Q-R013, Q-R015, Q-R004; **required by:** Q-R017, Q-R018
- **Failure modes:** template overfit: same three strategies for every objective; catalog limited to what the system already 'knows how to do'; model mode collapse
- **Recovery:** Diversity prompts across classes; add candidates from different reasoning directions (backward from target, from owner assets, from buyer pain, from arbitrage gaps).
- **Observe:** Measure class/industry diversity of candidates per goal; compare across unfamiliar objectives.
- **Brain implements:** TO BE RECONCILED

#### Q-R017 — Conservative, revisitable hard-constraint screening (MAJOR)

- **Accomplish:** Screen candidates against hard constraints (capital, window, involvement, capability, legality) with cheap estimates, recording a reason per rejection; rejected candidates are kept and revisited if evidence changes.
- **Inputs:** candidate set; constraint register; owner profile
- **Outputs:** screened set; rejection records
- **Correct when:** Each rejection cites a constraint with legitimate provenance and an estimate; rejections based on an unknown are 'deferred', not 'rejected'; nothing is deleted.
- **Depends on:** Q-R016, Q-R004, Q-R003; **required by:** Q-R019
- **Failure modes:** good candidate rejected on a favourable-or-unfavourable guess; rejection reason is a system policy; candidates deleted so revision cannot recover them
- **Recovery:** Re-screen deferred candidates when unknowns resolve.
- **Observe:** Sample rejected candidates; check reason, constraint provenance, estimate.
- **Brain implements:** TO BE RECONCILED

#### Q-R018 — Generalization to unfamiliar objectives (CRITICAL)

- **Accomplish:** Discovery, strategy and research must not depend on objective-specific templates; they work for objective types (amounts, windows, capitals, constraints, industries) absent from development data.
- **Inputs:** objective spec
- **Outputs:** candidate sets for novel objectives
- **Correct when:** Performance on held-out objectives is not materially worse than on development objectives.
- **Depends on:** Q-R016; **required by:** —
- **Failure modes:** hard-coded strategy library; prompts tuned on the development set
- **Recovery:** Expand the reasoning procedure, not the template list.
- **Observe:** Compare usable rate on held-out vs development objectives.
- **Brain implements:** TO BE RECONCILED

### S05. Strategy generation

#### Q-R019 — Genuinely different strategies (MAJOR)

- **Accomplish:** Develop at least three surviving strategies that differ in buyer, offer, channel, or monetization mechanism, not paraphrases of one idea.
- **Inputs:** screened opportunity set
- **Outputs:** strategy set
- **Correct when:** Pairwise, strategies differ in at least one of buyer segment, offer, acquisition channel, or payment mechanism; a diversity metric is recorded.
- **Depends on:** Q-R017; **required by:** Q-R020
- **Failure modes:** three phrasings of 'cold-email agency services'; single strategy carried to selection
- **Recovery:** Regenerate with explicit exclusion of existing strategies' defining attributes.
- **Observe:** Compute strategy-attribute overlap per goal.
- **Brain implements:** TO BE RECONCILED

#### Q-R020 — Complete strategy specification (CRITICAL)

- **Accomplish:** Specify each strategy fully: offer, buyer segment, acquisition channel, price, fulfilment (who/how), payment mechanism and terms, cash timing, capital uses, owner tasks, required capabilities, key assumptions.
- **Inputs:** strategy hypothesis
- **Outputs:** strategy spec
- **Correct when:** All schema fields populated or explicitly UNKNOWN (which spawns an unknown, Q-R023); no strategy reaches economics with an empty leg.
- **Depends on:** Q-R019, Q-R008; **required by:** Q-R021, Q-R022, Q-R023, Q-R035, Q-R036, Q-R037, Q-R038, Q-R039, Q-R040, Q-R046, Q-R048, Q-R049, Q-R050
- **Failure modes:** no acquisition channel defined; fulfilment assumed to happen magically; payment mechanism missing
- **Recovery:** Complete the leg (Q-R022) or mark the strategy incomplete.
- **Observe:** Schema-validate strategy specs; count missing legs reaching economics.
- **Brain implements:** TO BE RECONCILED

#### Q-R021 — Backward decomposition from the target (CRITICAL)

- **Accomplish:** For each strategy, reason backward: target collected revenue -> required transactions at price -> required conversions -> required leads/contacts -> required daily actions and capacity, inside the window and the settlement lag.
- **Inputs:** strategy spec; metric rule; calendar
- **Outputs:** target decomposition
- **Correct when:** Decomposition arithmetic is deterministic and consistent with Q-R041; it states required daily volume and compares it to stated capacity.
- **Depends on:** Q-R020, Q-R002, Q-R014; **required by:** Q-R023, Q-R041
- **Failure modes:** forward-only storytelling with no volume math; ignores that last-week sales won't settle
- **Recovery:** Recompute in code; flag strategies whose required volume exceeds capacity.
- **Observe:** Replay decomposition numerically.
- **Brain implements:** TO BE RECONCILED

#### Q-R022 — Completion of partial strategies (MAJOR)

- **Accomplish:** A strategy with a missing or weak leg (e.g. no supplier, no channel) is completed by targeted search or combination with another strategy's leg, rather than silently passed or discarded.
- **Inputs:** incomplete strategy specs
- **Outputs:** completed specs or explicit abandonment with reason
- **Correct when:** Every incomplete strategy ends as completed, or abandoned with a recorded reason; none passes to selection incomplete.
- **Depends on:** Q-R020; **required by:** —
- **Failure modes:** good strategy dropped for a fixable gap; incomplete strategy selected
- **Recovery:** Spawn research for the missing leg.
- **Observe:** List strategies that changed completeness status and why.
- **Brain implements:** TO BE RECONCILED

### S06. Decisive unknowns and research planning

#### Q-R023 — Decisive-unknown identification (CRITICAL)

- **Accomplish:** For each strategy, determine which assumptions, across their plausible range, flip feasibility or ranking (sensitivity analysis), and mark them decisive.
- **Inputs:** strategy specs; assumption register; economics model
- **Outputs:** decisive unknowns with the decision they affect
- **Correct when:** Each decisive unknown has a documented range and shows that the decision differs at range ends; non-decisive unknowns are not researched heavily.
- **Depends on:** Q-R011, Q-R020, Q-R021; **required by:** Q-R005, Q-R024, Q-R025, Q-R026, Q-R044
- **Failure modes:** researching trivia while the conversion rate is guessed; decisive unknown never identified
- **Recovery:** Run sensitivity in code over every assumption.
- **Observe:** Re-run sensitivity analysis; compare against the system's decisive list.
- **Brain implements:** TO BE RECONCILED

#### Q-R024 — Research bounded by decision value (MAJOR)

- **Accomplish:** Prioritize research questions by expected change in the decision per unit cost/time, allocate a per-goal research budget, and stop researching a question when its answer can no longer change the decision.
- **Inputs:** decisive unknowns; budget; existing evidence
- **Outputs:** prioritized research queue entries with decision link and stop rule
- **Correct when:** Every research task names the decision it consumes and its expected value; research spend correlates with decision value; no task runs after its decision is settled.
- **Depends on:** Q-R023, Q-R032, Q-R083; **required by:** Q-R060
- **Failure modes:** unbounded research that never converges; fixed fragment counts regardless of gaps; budget spent on low-value questions; decisive question starved
- **Recovery:** Re-prioritize after each answer; cancel moot tasks.
- **Observe:** Inspect research tasks: decision link, value estimate, cancelled-after-moot count.
- **Brain implements:** TO BE RECONCILED

#### Q-R025 — Answerable research questions (MAJOR)

- **Accomplish:** Formulate each question specifically: the quantity, population, geography, time, acceptable source types and what answer would change the decision; examples in the question are not treated as boundaries.
- **Inputs:** decisive unknown
- **Outputs:** research brief
- **Correct when:** A brief states quantity, unit, scope and acceptance criteria; an independent reader could tell whether an answer satisfies it.
- **Depends on:** Q-R023; **required by:** Q-R027
- **Failure modes:** vague briefs return vague answers; brief over-narrowed to the example given
- **Recovery:** Rewrite brief after an unproductive round (Q-R033).
- **Observe:** Audit briefs against the schema.
- **Brain implements:** TO BE RECONCILED

#### Q-R026 — Unknowns never resolved favourably by default (CRITICAL)

- **Accomplish:** An unanswered fact stays UNKNOWN; it cannot make a strategy feasible or rank it higher. Unresolvable decisive unknowns become early, cheap tests (experiments) in the plan with thresholds.
- **Inputs:** research outcomes; assumption register
- **Outputs:** unknown status; plan test steps
- **Correct when:** No ranking or feasibility verdict uses an optimistic value for an unknown without a disclosed assumption and a test step; the plan contains a test for each unresolved decisive unknown.
- **Depends on:** Q-R023, Q-R011; **required by:** Q-R068, Q-R073, Q-R080
- **Failure modes:** timeout on research read as 'no problem'; missing price data replaced with optimistic guess; an untested decisive assumption presented as fact
- **Recovery:** Use pessimistic bound in ranking; add test-and-checkpoint steps.
- **Observe:** For each decisive unknown, check its status, the value used in ranking, and the plan's test step.
- **Brain implements:** TO BE RECONCILED

### S07. Research execution and evidence

#### Q-R027 — Research queue execution (MAJOR)

- **Accomplish:** Dispatch web search and page-reading tasks to asynchronous workers with leases, timeouts, retries, deduplication and result recording; failures are recorded as failures.
- **Inputs:** research briefs
- **Outputs:** research results or failure records
- **Correct when:** Every queued task reaches a terminal state (answered, unanswerable, failed, cancelled) within a bound; no task is held by two workers; no failure is recorded as an empty success.
- **Depends on:** Q-R025, Q-R081; **required by:** Q-R028, Q-R033, Q-R080
- **Failure modes:** task stuck forever; duplicate tasks; worker returns empty result marked complete; queue idle while tasks wait
- **Recovery:** Lease expiry and reassign; mark unanswerable after bounded attempts.
- **Observe:** Queue audit: task ages, terminal states, empty-success count.
- **Brain implements:** TO BE RECONCILED

#### Q-R028 — Source capture with provenance (CRITICAL)

- **Accomplish:** For each source: URL, retrieval time, retrieval state (read, paywalled, blocked, JS-only), content snapshot or hash, publisher and publication date.
- **Inputs:** fetched pages
- **Outputs:** source records
- **Correct when:** Every evidence claim links to a source record whose snapshot contains the cited passage; unreadable sources are recorded as unresolved, not inferred.
- **Depends on:** Q-R027; **required by:** Q-R029
- **Failure modes:** claim attributed to a page never read; snippet-only evidence; page content changed after capture with no snapshot
- **Recovery:** Refetch or try official alternative sources.
- **Observe:** Sample claims; verify passage is present in stored snapshot.
- **Brain implements:** TO BE RECONCILED

#### Q-R029 — Faithful evidence extraction (CRITICAL)

- **Accomplish:** Extract claims with quote, figure, unit, date, geography, segment and context from captured content; the extractor may not introduce numbers absent from the source.
- **Inputs:** source records; research brief
- **Outputs:** evidence claims
- **Correct when:** Every extracted number appears in (or is a documented transformation of) the cited passage; context fields populated.
- **Depends on:** Q-R028, Q-R056; **required by:** Q-R030
- **Failure modes:** hallucinated figures with real URLs; unit confusion (monthly vs annual); US figure applied to UK
- **Recovery:** Re-extract with entailment check; reject unsupported claims.
- **Observe:** Automated passage-number match and entailment check over claims.
- **Brain implements:** TO BE RECONCILED

#### Q-R030 — Evidence verification and quality grading (CRITICAL)

- **Accomplish:** Grade each claim for entailment, source type (primary/secondary/anecdotal), credibility, recency and applicability to the strategy's buyer, geography and time; require independent corroboration for decisive figures.
- **Inputs:** evidence claims
- **Outputs:** graded evidence
- **Correct when:** Decisive figures used in selection have at least the required quality grade or are labelled assumptions; applicability mismatch is flagged.
- **Depends on:** Q-R029; **required by:** Q-R031, Q-R034, Q-R035, Q-R036, Q-R037, Q-R039, Q-R046
- **Failure modes:** marketing page claims taken as market data; a single anecdote drives selection; outdated figure
- **Recovery:** Seek corroboration; downgrade to assumption.
- **Observe:** For each decisive figure, inspect grade and corroboration count.
- **Brain implements:** TO BE RECONCILED

#### Q-R031 — Evidence conflict handling without overwrite (MAJOR)

- **Accomplish:** When evidence conflicts, keep all items, record the conflict, and reconcile by applicability and quality with reasoning; new evidence never silently replaces old.
- **Inputs:** graded evidence
- **Outputs:** conflict records; reconciled value with range
- **Correct when:** Every conflict has a record and a resolution rationale; the value used is the reconciled one, with range reflected in uncertainty.
- **Depends on:** Q-R030; **required by:** Q-R058
- **Failure modes:** latest-write-wins; cherry-picking the favourable figure
- **Recovery:** Reopen reconciliation when new evidence arrives.
- **Observe:** List conflicts and their resolutions; check figures used match resolution.
- **Brain implements:** TO BE RECONCILED

#### Q-R032 — Reuse of existing evidence before new research (MINOR)

- **Accomplish:** Before dispatching research, query existing evidence and knowledge for applicable, fresh answers.
- **Inputs:** research brief; evidence store
- **Outputs:** reuse decision
- **Correct when:** A brief whose answer exists at sufficient quality and freshness is not re-researched; reuse records applicability check.
- **Depends on:** Q-R008; **required by:** Q-R024
- **Failure modes:** paying twice for the same answer; reusing inapplicable evidence
- **Recovery:** Applicability check on reuse.
- **Observe:** Count duplicate research of answered questions.
- **Brain implements:** TO BE RECONCILED

#### Q-R033 — Adaptive search strategy (MAJOR)

- **Accomplish:** When searches return nothing usable, reformulate (synonyms, source types such as forums, marketplaces, government data, price lists, proxy measures) and record dead ends; never repeat an identical failing approach.
- **Inputs:** failed research results
- **Outputs:** revised briefs; dead-end records
- **Correct when:** Consecutive attempts on one question differ in method; dead ends are recorded and consulted.
- **Depends on:** Q-R027; **required by:** —
- **Failure modes:** same query looped; giving up after one search; dead end read as negative answer
- **Recovery:** Escalate to reconstruction (Q-R034) or an in-plan test (Q-R026).
- **Observe:** Inspect attempt sequences per question.
- **Brain implements:** TO BE RECONCILED

#### Q-R034 — Reconstruction of unpublished figures (MAJOR)

- **Accomplish:** Where no source publishes a figure (e.g. a niche conversion rate), estimate it from mechanism and component evidence, labelled as an estimate with derivation chain and uncertainty.
- **Inputs:** component evidence
- **Outputs:** reconstructed estimates
- **Correct when:** Each reconstruction lists components, their sources, the formula, and a range; it is never presented as a published figure.
- **Depends on:** Q-R030; **required by:** —
- **Failure modes:** reconstruction presented as fact; implausible mechanism
- **Recovery:** Critique checks derivation; widen range.
- **Observe:** Audit reconstructed figures' derivation chains.
- **Brain implements:** TO BE RECONCILED

### S08. Market actors (buyers, suppliers, competitors, channels, fulfilment)

#### Q-R035 — Buyer existence, reachability and willingness to pay (CRITICAL)

- **Accomplish:** Establish that the buyer segment exists in sufficient number, can be reached through the chosen channel, pays the assumed price (evidence of comparable prices paid), and that its purchase cycle fits the window.
- **Inputs:** strategy spec; evidence
- **Outputs:** buyer analysis
- **Correct when:** Buyer count, reachability path, price evidence and cycle length are each evidenced or labelled assumption; named buyers or examples are real and verifiable; cycle length + settlement fits the window.
- **Depends on:** Q-R020, Q-R030; **required by:** Q-R040, Q-R047
- **Failure modes:** fabricated companies or contacts; enterprise buyer with 90-day procurement in a 30-day window; price evidence from a different segment
- **Recovery:** Re-target segment or downgrade strategy.
- **Observe:** Verify sampled named buyers exist; check cycle length vs window.
- **Brain implements:** TO BE RECONCILED

#### Q-R036 — Supplier and seller analysis (CRITICAL)

- **Accomplish:** For goods or subcontracted services: supplier exists, unit cost, MOQ, lead time, capacity, payment terms (prepay?), reliability, and whether the owner can open an account.
- **Inputs:** strategy spec; evidence
- **Outputs:** supplier analysis
- **Correct when:** Each supply input has an evidenced supplier with cost, MOQ, lead time and terms; MOQ x cost fits capital; lead time fits critical path.
- **Depends on:** Q-R020, Q-R030; **required by:** Q-R038, Q-R040, Q-R047
- **Failure modes:** supplier invented; MOQ exceeds capital; wholesale account requires a resale certificate the owner lacks
- **Recovery:** Alternate supplier search; strategy downgrade.
- **Observe:** Check supplier records for evidence and terms.
- **Brain implements:** TO BE RECONCILED

#### Q-R037 — Competitor and alternative analysis (MAJOR)

- **Accomplish:** Identify what buyers currently use instead, competitor prices and saturation, and why a buyer would choose this offer now.
- **Inputs:** strategy spec; evidence
- **Outputs:** competitive analysis
- **Correct when:** Price assumption is positioned against evidenced competitor prices; a differentiation or channel reason exists.
- **Depends on:** Q-R020, Q-R030; **required by:** —
- **Failure modes:** price above market with no reason; saturated marketplace ignored
- **Recovery:** Adjust price/positioning; re-run economics.
- **Observe:** Compare plan price to competitor evidence.
- **Brain implements:** TO BE RECONCILED

#### Q-R038 — Fulfilment analysis (CRITICAL)

- **Accomplish:** Determine how each unit is delivered, by whom, with what capacity per day, quality risk, refund/return exposure and owner hours.
- **Inputs:** strategy spec; owner profile; supplier analysis
- **Outputs:** fulfilment model
- **Correct when:** Fulfilment capacity >= required volume from Q-R041; fulfilment cost included in unit economics; owner hours included in Q-R048.
- **Depends on:** Q-R020, Q-R036; **required by:** Q-R040, Q-R041, Q-R048
- **Failure modes:** selling more than can be delivered; fulfilment by the owner exceeds involvement limit; AI-delivered service of unproven quality
- **Recovery:** Add capacity (contractor) with cost, or reduce volume.
- **Observe:** Compare fulfilment capacity to required volume.
- **Brain implements:** TO BE RECONCILED

#### Q-R039 — Acquisition channel access and performance (CRITICAL)

- **Accomplish:** For the chosen channel: access prerequisites (accounts, approvals, domain warm-up, ad review, marketplace seller verification), time to usable, cost per lead/contact, conversion evidence and channel rules.
- **Inputs:** strategy spec; evidence; owner profile
- **Outputs:** channel model
- **Correct when:** Channel prerequisites appear on the critical path with durations; cost and conversion are evidenced or assumptions with tests; channel rules feed Q-R050.
- **Depends on:** Q-R020, Q-R030; **required by:** Q-R040, Q-R041, Q-R047, Q-R050
- **Failure modes:** cold email at volume from a new domain on day 1; ad account approval delay ignored; marketplace new-seller limits ignored
- **Recovery:** Add warm-up/prereq steps or switch channel.
- **Observe:** Check channel prerequisites and their durations in the timeline.
- **Brain implements:** TO BE RECONCILED

### S09. Economic feasibility and capital

#### Q-R040 — Unit economics with all material costs (CRITICAL)

- **Accomplish:** Compute contribution per unit: price minus COGS, payment processing, platform/marketplace fees, shipping, taxes/VAT where applicable, refunds/chargebacks, acquisition cost, fulfilment cost.
- **Inputs:** strategy spec; actor analyses; evidence
- **Outputs:** unit economics
- **Correct when:** Every cost category is present or explicitly zero with reason; each figure links to evidence/assumption; computed in code.
- **Depends on:** Q-R020, Q-R035, Q-R036, Q-R038, Q-R039, Q-R045; **required by:** Q-R041, Q-R042, Q-R043, Q-R052
- **Failure modes:** omitted fees flip margin negative; sales tax treated as revenue; acquisition cost ignored
- **Recovery:** Add missing categories; recompute.
- **Observe:** Check presence of each cost category; recompute.
- **Brain implements:** TO BE RECONCILED

#### Q-R041 — Volume and funnel model to collected revenue (CRITICAL)

- **Accomplish:** Model the funnel from daily actions to collected cash with capacity limits at each stage, producing the distribution of collected revenue inside the window.
- **Inputs:** target decomposition; unit economics; channel model; fulfilment model; calendar; metric rule
- **Outputs:** collected-revenue forecast (range)
- **Correct when:** Forecast counts only revenue meeting the recognition rule by window end; capacity constraints bind; computed deterministically.
- **Depends on:** Q-R021, Q-R040, Q-R039, Q-R038, Q-R014, Q-R002; **required by:** Q-R042, Q-R043, Q-R044, Q-R068
- **Failure modes:** sales in the last week counted though payout lands after window; stage capacity ignored
- **Recovery:** Recompute with settlement cutoff.
- **Observe:** Recompute forecast; check last settlement date per sale cohort.
- **Brain implements:** TO BE RECONCILED

#### Q-R042 — Cash-flow timeline and peak capital requirement (CRITICAL)

- **Accomplish:** Produce a dated cash in/out schedule including prepayments, fees, ad spend, inventory, reserves and settlement lags; compute peak capital need and minimum balance.
- **Inputs:** unit economics; funnel model; supplier terms; payment constraints; calendar
- **Outputs:** cash-flow schedule; peak capital
- **Correct when:** Balance never goes below zero with available capital; peak need <= stated capital (with a stated buffer); money committed before revenue arrives is accounted.
- **Depends on:** Q-R040, Q-R041, Q-R046, Q-R014; **required by:** Q-R043, Q-R052, Q-R069
- **Failure modes:** capital assumed recycled before payout arrives; working capital ignored; reserve held by processor not modelled
- **Recovery:** Reduce scale, change terms, or reject strategy.
- **Observe:** Recompute daily balance series; find minimum.
- **Brain implements:** TO BE RECONCILED

#### Q-R043 — Deterministic arithmetic verification (CRITICAL)

- **Accomplish:** All plan numbers are computed or re-computed by deterministic code from the structured model; model-written arithmetic is never trusted; mismatches block release.
- **Inputs:** structured economics; plan text
- **Outputs:** verification report
- **Correct when:** Every number in the plan equals the code-computed value (within rounding); any mismatch blocks release.
- **Depends on:** Q-R040, Q-R041, Q-R042; **required by:** Q-R070
- **Failure modes:** LLM multiplication error; plan prose retypes a number differently
- **Recovery:** Regenerate plan figures from the structured model.
- **Observe:** Extract all numbers from the plan and diff against computed values.
- **Brain implements:** TO BE RECONCILED

#### Q-R044 — Uncertainty and probability of reaching target (MAJOR)

- **Accomplish:** Propagate ranges of decisive inputs to a distribution of collected revenue; report probability or confidence of reaching target, break-even volume, and most-sensitive inputs. Coverage of scenarios is not reported as probability.
- **Inputs:** funnel model; assumption ranges; evidence grades
- **Outputs:** uncertainty summary
- **Correct when:** Confidence is derived from stated ranges by a reproducible method; a point estimate is not presented as certainty; the most sensitive input matches sensitivity analysis.
- **Depends on:** Q-R041, Q-R023; **required by:** Q-R061, Q-R073
- **Failure modes:** point estimate passed as 'will achieve'; false precision; correlated assumptions treated as independent
- **Recovery:** Widen ranges; report lower confidence.
- **Observe:** Re-run uncertainty propagation; compare stated confidence.
- **Brain implements:** TO BE RECONCILED

#### Q-R045 — Provenance for every plan figure (CRITICAL)

- **Accomplish:** Every number in the plan links to an evidence claim, an owner input, an assumption record, or a computation over these.
- **Inputs:** plan figures; goal model
- **Outputs:** provenance graph
- **Correct when:** 100% of plan figures resolve to a provenance node; no orphan numbers.
- **Depends on:** Q-R008, Q-R011; **required by:** Q-R009, Q-R040, Q-R054, Q-R063
- **Failure modes:** model-invented numbers in prose; provenance lost across handoffs
- **Recovery:** Block release; resolve or label as assumption.
- **Observe:** Automated walk from plan numbers to provenance nodes; count orphans.
- **Brain implements:** TO BE RECONCILED

### S10. Acquisition, payment, timing, operational and legal constraints

#### Q-R046 — Payment acceptance and settlement feasibility (CRITICAL)

- **Accomplish:** Determine which payment methods the owner can actually use (by jurisdiction, entity, account status), account approval time, new-account holds and rolling reserves, payout schedule, invoice terms and chargeback windows, so that 'collected' cash lands inside the window.
- **Inputs:** owner profile; jurisdiction; strategy spec; evidence
- **Outputs:** payment model
- **Correct when:** For each strategy, the time from sale to available funds is evidenced and included in Q-R041/Q-R042; strategies relying on net-30+ terms or marketplace payout delays beyond the window are corrected or rejected.
- **Depends on:** Q-R003, Q-R007, Q-R020, Q-R030; **required by:** Q-R042, Q-R047
- **Failure modes:** assumes instant payout; new merchant account 7-14 day hold ignored; B2B invoices net-30 counted as collected; marketplace holds funds until delivery confirmation
- **Recovery:** Choose upfront payment / deposits / different rail; adjust forecast.
- **Observe:** For each strategy check sale->available-funds lag and its evidence.
- **Brain implements:** TO BE RECONCILED

#### Q-R047 — Critical-path timing feasibility (CRITICAL)

- **Accomplish:** Build the critical path of all prerequisites (entity/account setup, supplier lead time, channel warm-up, content/product creation, shipping, buyer cycle, settlement) and check it fits the window with margin.
- **Inputs:** actor analyses; payment model; calendar
- **Outputs:** critical path with slack
- **Correct when:** Earliest first-collected-cash date and the date by which enough volume settles are both before window end; slack is stated.
- **Depends on:** Q-R014, Q-R035, Q-R036, Q-R039, Q-R046; **required by:** Q-R061, Q-R066
- **Failure modes:** prerequisites in parallel that are actually sequential; lead times omitted
- **Recovery:** Reorder, choose faster alternatives, or reject.
- **Observe:** Recompute critical path from step durations.
- **Brain implements:** TO BE RECONCILED

#### Q-R048 — Owner-involvement budget (CRITICAL)

- **Accomplish:** Sum owner hours per week across all steps (including identity verification, signatures, calls, approvals, fulfilment) and keep within the stated limit; minimize owner-only tasks.
- **Inputs:** plan steps; owner profile; objective spec
- **Outputs:** owner-hours schedule
- **Correct when:** Owner hours in every week <= limit; every owner task is necessary (cannot be done by system or contractor) and named.
- **Depends on:** Q-R001, Q-R020, Q-R038; **required by:** Q-R061
- **Failure modes:** sales calls by owner every day under 'minimal involvement'; hidden owner tasks (KYC, approvals)
- **Recovery:** Delegate to system/contractor or reject strategy.
- **Observe:** Sum owner-assigned step hours by week.
- **Brain implements:** TO BE RECONCILED

#### Q-R049 — Capability, licence and credential requirements (CRITICAL)

- **Accomplish:** List every capability, licence, permit, certification, account and credential each strategy needs; check each against the owner profile; either plan acquisition (with cost and time on the critical path) or reject.
- **Inputs:** strategy spec; owner profile; jurisdiction; evidence
- **Outputs:** requirements check
- **Correct when:** No plan step requires something whose owner-profile status is not KNOWN-HELD unless an acquisition step precedes it and fits budget and window.
- **Depends on:** Q-R003, Q-R007, Q-R020; **required by:** Q-R061
- **Failure modes:** licensed activity (real estate, insurance, contracting, food) without licence; assumes owner has a business entity or bank account; needs a skill the owner lacks
- **Recovery:** Insert acquisition steps or reject.
- **Observe:** Cross-check required capabilities per step against owner profile.
- **Brain implements:** TO BE RECONCILED

#### Q-R050 — Legal, regulatory and terms-of-service compliance (CRITICAL)

- **Accomplish:** Check every action against law in the relevant jurisdictions (outreach: CAN-SPAM, GDPR/PECR, TCPA; consumer protection; licensing; tax registration/collection; IP; data protection) and platform terms (marketplaces, ad platforms, email providers, scraping).
- **Inputs:** plan steps; channel model; jurisdiction; evidence
- **Outputs:** compliance findings
- **Correct when:** No step is unlawful or breaches a platform's terms; borderline steps are rewritten to a compliant form; findings cite the rule.
- **Depends on:** Q-R007, Q-R039, Q-R020; **required by:** Q-R052, Q-R061
- **Failure modes:** purchased lists spammed; scraping prohibited by ToS; off-platform fee circumvention; fake reviews/testimonials; unregistered sales tax collection
- **Recovery:** Rewrite step or reject strategy.
- **Observe:** Run each step through a compliance checklist; independent legal-style review on samples.
- **Brain implements:** TO BE RECONCILED

#### Q-R051 — System's own executional capacity (MAJOR)

- **Accomplish:** Determine which steps the system can actually perform (integrations, accounts, tools) vs which require the owner or a contractor, so plan assignment is real.
- **Inputs:** integration inventory; plan steps
- **Outputs:** actor assignment validity
- **Correct when:** Every step assigned to 'the system' maps to a capability the system has; otherwise it is reassigned.
- **Depends on:** Q-R066; **required by:** —
- **Failure modes:** plan says 'Brain will send 500 emails' with no sending integration
- **Recovery:** Reassign to owner (then check Q-R048) or contractor.
- **Observe:** Map system-assigned steps to integration inventory.
- **Brain implements:** TO BE RECONCILED

### S11. Critique, contradiction and validation

#### Q-R052 — Independent adversarial critique (CRITICAL)

- **Accomplish:** Each finalist strategy and the draft plan are reviewed by a role or model that did not produce them, against the usable-plan definition and the critical-mistake taxonomy, producing structured findings with severity.
- **Inputs:** strategy specs; economics; draft plan; taxonomy
- **Outputs:** structured findings
- **Correct when:** Every critical-mistake category is checked explicitly; findings are structured (category, location, evidence); seeded-error plans are caught at a measured rate.
- **Depends on:** Q-R008, Q-R040, Q-R042, Q-R050; **required by:** Q-R054, Q-R057, Q-R058, Q-R059, Q-R062, Q-R077
- **Failure modes:** self-review rubber-stamps; critique stored only as prose; correlated models share blind spots
- **Recovery:** Route to a different model family or stronger model; repair via Q-R059.
- **Observe:** Inject known mistakes; measure catch rate; inspect finding records.
- **Brain implements:** TO BE RECONCILED

#### Q-R053 — Internal contradiction detection (CRITICAL)

- **Accomplish:** Check consistency across plan sections, between plan and goal model, and between narrative and economics (same price, volume, dates, buyer everywhere; strategy described equals strategy computed).
- **Inputs:** draft plan; goal model
- **Outputs:** contradiction records
- **Correct when:** Zero unresolved contradictions at release; check is mechanical where values are structured.
- **Depends on:** Q-R008, Q-R070; **required by:** Q-R071
- **Failure modes:** price $500 in one section, $300 in another; plan mixes two strategies
- **Recovery:** Regenerate sections from structured model.
- **Observe:** Automated cross-section value comparison.
- **Brain implements:** TO BE RECONCILED

#### Q-R054 — Unsupported-assumption detection (CRITICAL)

- **Accomplish:** Find claims in plan text and reasoning that rest on neither evidence nor a registered assumption, and register or remove them.
- **Inputs:** draft plan; provenance graph
- **Outputs:** unsupported-claim list
- **Correct when:** Every factual claim in the plan resolves to evidence or an assumption record.
- **Depends on:** Q-R045, Q-R052; **required by:** —
- **Failure modes:** persuasive unsupported market claims
- **Recovery:** Register as assumption with test step, or delete.
- **Observe:** Claim extraction over plan text and linkage check.
- **Brain implements:** TO BE RECONCILED

#### Q-R055 — Objective and constraint conformance check (CRITICAL)

- **Accomplish:** Check the plan against the objective spec: right metric, amount, window, capital, involvement limit, every owner constraint satisfied, and no restriction the owner never stated.
- **Inputs:** draft plan; objective spec; constraint register
- **Outputs:** conformance report
- **Correct when:** Each spec field satisfied; plan's stated constraints == owner-stated + disclosed legal/policy.
- **Depends on:** Q-R001, Q-R002, Q-R004, Q-R066; **required by:** Q-R071
- **Failure modes:** plan optimizes profit instead of collected revenue; adds 'no paid ads' restriction never stated
- **Recovery:** Repair or reselect.
- **Observe:** Diff plan constraints with spec.
- **Brain implements:** TO BE RECONCILED

#### Q-R056 — Model-output validation (CRITICAL)

- **Accomplish:** Every model answer is validated before it becomes state: non-empty, schema-valid, not truncated, not a refusal, references real ids, answers this goal's question, numbers parseable; invalid outputs are recorded as failures and retried or escalated, never stored as results.
- **Inputs:** raw model outputs
- **Outputs:** accepted outputs or failure records
- **Correct when:** No empty, truncated, schema-invalid, or off-goal output appears in the goal model; failure rate per model is recorded.
- **Depends on:** —; **required by:** Q-R029, Q-R064, Q-R079
- **Failure modes:** empty JSON accepted as 'no candidates'; truncated list treated as complete; refusal text parsed as a strategy; hallucinated evidence id
- **Recovery:** Retry with repair prompt, then another model, then mark the step failed and visible.
- **Observe:** Inject empty/truncated/invalid responses; verify none enters state.
- **Brain implements:** TO BE RECONCILED

#### Q-R057 — Critic calibration (MAJOR)

- **Accomplish:** Measure the critic's false-negative and false-positive rates on plans with seeded critical mistakes and on known-good plans; adjust or escalate where it misses categories.
- **Inputs:** seeded plans
- **Outputs:** critic calibration metrics per category
- **Correct when:** Per-category recall is measured and meets a set threshold on the frozen revision.
- **Depends on:** Q-R052; **required by:** —
- **Failure modes:** critic never tested so misses are invisible
- **Recovery:** Add category-specific checks; escalate model.
- **Observe:** Inspect calibration results.
- **Brain implements:** TO BE RECONCILED

### S12. Revision and repair

#### Q-R058 — Evidence-triggered revision (CRITICAL)

- **Accomplish:** When evidence or critique refutes or changes an assumption, recompute the affected strategy, economics and ranking; the selection may change; revision recorded with cause.
- **Inputs:** new evidence; critique findings; dependency links
- **Outputs:** revised goal model; revision log
- **Correct when:** After a refuting input, every affected decision is re-evaluated and the log shows before/after; the system will change its selected strategy when warranted.
- **Depends on:** Q-R009, Q-R052, Q-R031; **required by:** Q-R059
- **Failure modes:** anchoring: selection never changes; new evidence attached but not used
- **Recovery:** Force re-evaluation of dependents.
- **Observe:** Inject a refuting evidence item in replay; check selection/economics respond.
- **Brain implements:** TO BE RECONCILED

#### Q-R059 — Planned repair, not blind retry (MAJOR)

- **Accomplish:** A failed check produces a targeted repair that addresses its cause and differs from previous attempts; attempts are bounded; after the bound, abandon the strategy or report blocked.
- **Inputs:** findings; attempt history
- **Outputs:** repair attempts with strategy
- **Correct when:** Consecutive repairs differ in method; attempt count bounded; failures preserved in history.
- **Depends on:** Q-R052, Q-R058; **required by:** Q-R060
- **Failure modes:** same prompt retried; infinite repair loop; failure history overwritten
- **Recovery:** Escalate model; abandon strategy; choose runner-up.
- **Observe:** Inspect attempt sequences for difference and bound.
- **Brain implements:** TO BE RECONCILED

#### Q-R060 — Convergence and termination (CRITICAL)

- **Accomplish:** The goal reasoning loop terminates with a selected plan, an infeasible verdict, or a named blocker within time and cost budgets; stalls are detected.
- **Inputs:** loop state; budgets
- **Outputs:** terminal outcome
- **Correct when:** Every goal reaches a terminal outcome within its budget; stall detector fires on no-progress intervals.
- **Depends on:** Q-R024, Q-R059, Q-R083; **required by:** —
- **Failure modes:** oscillation between two strategies; waiting forever on one research task
- **Recovery:** Decide with current evidence and disclose unknowns.
- **Observe:** Measure time-to-terminal and stall events per goal.
- **Brain implements:** TO BE RECONCILED

### S13. Comparison and selection

#### Q-R061 — Comparison on a common basis (MAJOR)

- **Accomplish:** Compare strategies on the same criteria computed the same way from the same goal-model version: probability of reaching target in window, capital at risk, owner hours, evidence strength, downside, time to first cash.
- **Inputs:** strategy economics; uncertainty; constraint checks
- **Outputs:** comparison table
- **Correct when:** All strategies scored with identical criteria and evidence vintage; scores reproducible from inputs.
- **Depends on:** Q-R044, Q-R047, Q-R048, Q-R049, Q-R050, Q-R009; **required by:** Q-R062, Q-R065
- **Failure modes:** strategy A scored with old evidence, B with new; different optimism levels
- **Recovery:** Recompute all scores together.
- **Observe:** Recompute comparison; check versions.
- **Brain implements:** TO BE RECONCILED

#### Q-R062 — Single arbiter for competing proposals (CRITICAL)

- **Accomplish:** One decision authority resolves competing proposals from faculties, models and critics into one selected strategy, recording alternatives, reasons and dissent.
- **Inputs:** comparison table; critique findings; proposals
- **Outputs:** selection decision
- **Correct when:** Exactly one selected strategy per goal version; decision record lists alternatives and why rejected; no faculty overrides it outside the arbiter.
- **Depends on:** Q-R061, Q-R052; **required by:** Q-R063, Q-R066
- **Failure modes:** two faculties each 'select' a strategy; last writer wins; critic findings ignored
- **Recovery:** Re-run arbitration on current version.
- **Observe:** Count selection records per goal version; inspect rationale.
- **Brain implements:** TO BE RECONCILED

#### Q-R063 — Defensible selection rationale (MAJOR)

- **Accomplish:** The selected strategy's rationale cites evidence and computed figures, survives critique, and explains why runners-up lost.
- **Inputs:** selection decision; evidence
- **Outputs:** rationale
- **Correct when:** Rationale claims all resolve to provenance; no unresolved critical finding against the selection.
- **Depends on:** Q-R062, Q-R045; **required by:** Q-R070
- **Failure modes:** rationale is narrative only
- **Recovery:** Regenerate rationale from structured comparison.
- **Observe:** Check rationale provenance.
- **Brain implements:** TO BE RECONCILED

#### Q-R064 — Model routing, escalation and independence (MAJOR)

- **Accomplish:** Use cheap models by default and escalate to stronger models on low confidence, disagreement, decisive steps, or repeated validation failure; agreement among correlated models is not treated as independent evidence.
- **Inputs:** step type; confidence signals; validation failures
- **Outputs:** model assignments; escalation records
- **Correct when:** Decisive judgements (selection, critique of finalist, legal check) are made or confirmed by a model of sufficient measured quality; escalation events recorded.
- **Depends on:** Q-R056, Q-R083; **required by:** —
- **Failure modes:** cheap model makes the final decision unchecked; ensemble of identical models counted as consensus
- **Recovery:** Escalate; use different model family for critique.
- **Observe:** Inspect model used per decisive step and measured quality.
- **Brain implements:** TO BE RECONCILED

#### Q-R065 — Fallback strategy (MINOR)

- **Accomplish:** Retain a runner-up strategy compatible with remaining capital and time, triggered at a checkpoint if leading indicators fail.
- **Inputs:** comparison table; checkpoints
- **Outputs:** fallback definition
- **Correct when:** Fallback has its own feasibility from the trigger date with remaining capital.
- **Depends on:** Q-R061, Q-R068; **required by:** —
- **Failure modes:** fallback infeasible after primary spends capital
- **Recovery:** Recompute fallback from trigger state.
- **Observe:** Check fallback economics from trigger date.
- **Brain implements:** TO BE RECONCILED

### S14. Plan conversion

#### Q-R066 — Executable step plan (CRITICAL)

- **Accomplish:** Convert the selected strategy into ordered steps, each with actor (system/owner/contractor), inputs, outputs, duration, dependencies, cost, and done criteria.
- **Inputs:** selection; critical path; economics
- **Outputs:** step plan
- **Correct when:** Every step has all fields; dependencies acyclic; steps cover every leg of the strategy; sequencing matches critical path.
- **Depends on:** Q-R062, Q-R047; **required by:** Q-R051, Q-R055, Q-R067, Q-R069, Q-R070
- **Failure modes:** vague steps ('market the product'); missing steps for prerequisites
- **Recovery:** Regenerate steps from structured strategy and critical path.
- **Observe:** Schema and coverage check on steps.
- **Brain implements:** TO BE RECONCILED

#### Q-R067 — Named first action (CRITICAL)

- **Accomplish:** Name the first concrete action, its actor, and how to do it, executable immediately with no unmet prerequisites and no money commitment that lacks approval.
- **Inputs:** step plan
- **Outputs:** first action
- **Correct when:** First action has no unmet dependencies, is specific (what, where, who), and can start today.
- **Depends on:** Q-R066; **required by:** Q-R070
- **Failure modes:** first action is 'research more'; first action depends on an account not yet opened
- **Recovery:** Select earliest dependency-free step; split it if vague.
- **Observe:** Check first action's dependencies and specificity.
- **Brain implements:** TO BE RECONCILED

#### Q-R068 — Checkpoints and kill criteria (MAJOR)

- **Accomplish:** Define dated leading indicators (replies, conversions, first payment settled) with thresholds and the response if missed (pivot, fallback, stop) to protect capital.
- **Inputs:** funnel model; decisive unknowns
- **Outputs:** checkpoints
- **Correct when:** Each decisive unknown has a checkpoint testing it early; thresholds derive from the funnel model.
- **Depends on:** Q-R041, Q-R026; **required by:** Q-R065, Q-R070, Q-R074
- **Failure modes:** no early test; failure discovered at day 30
- **Recovery:** Add checkpoint per decisive unknown.
- **Observe:** Map decisive unknowns to checkpoints.
- **Brain implements:** TO BE RECONCILED

#### Q-R069 — Money-commitment schedule (CRITICAL)

- **Accomplish:** List each spend with amount, date, reversibility and approval requirement; total and peak within capital.
- **Inputs:** cash-flow schedule; step plan
- **Outputs:** commitment schedule
- **Correct when:** Sum and peak <= capital; each irreversible spend flagged for approval.
- **Depends on:** Q-R042, Q-R066; **required by:** Q-R070, Q-R072
- **Failure modes:** spend hidden in steps; exceeds capital
- **Recovery:** Recompute from cash-flow.
- **Observe:** Sum commitments; compare with capital.
- **Brain implements:** TO BE RECONCILED

#### Q-R070 — Plan rendering from the structured model (CRITICAL)

- **Accomplish:** Render the human-readable plan from the structured goal model (numbers, dates, names injected, not retyped by a model), covering every usable-plan element, including alternatives considered, risks, assumptions and confidence.
- **Inputs:** goal model; step plan
- **Outputs:** plan document
- **Correct when:** Every number and date in the document is injected from structured fields; all usable-plan sections present.
- **Depends on:** Q-R066, Q-R067, Q-R068, Q-R069, Q-R043, Q-R063; **required by:** Q-R053, Q-R071
- **Failure modes:** model rewrites figures; sections omitted; truncated document
- **Recovery:** Re-render; validate (Q-R071).
- **Observe:** Diff rendered values with structured model.
- **Brain implements:** TO BE RECONCILED

#### Q-R071 — Deterministic usable-plan completeness validator (CRITICAL)

- **Accomplish:** Before release, a deterministic validator checks presence and internal validity of every usable-plan element and blocks release on failure.
- **Inputs:** plan document; goal model
- **Outputs:** validation verdict
- **Correct when:** No released plan lacks a usable-plan element; failing plans are repaired or the goal reports blocked.
- **Depends on:** Q-R070, Q-R053, Q-R055; **required by:** Q-R072, Q-R073
- **Failure modes:** validator absent so incomplete plans ship
- **Recovery:** Repair loop.
- **Observe:** Run validator over released plans.
- **Brain implements:** TO BE RECONCILED

### S15. Readiness and commitment gates

#### Q-R072 — Plan readiness separate from money-commitment approval (CRITICAL)

- **Accomplish:** A plan can be READY for grading/owner review without any money committed; executing any spend requires an owner-set ceiling and explicit approval; approval is never released by a clock or inferred from silence; retries do not double-count commitments.
- **Inputs:** validated plan; owner approvals
- **Outputs:** readiness state; approval state
- **Correct when:** Readiness and approval are distinct states; no spend occurs without approval within ceiling; readiness does not wait on approval.
- **Depends on:** Q-R071, Q-R069; **required by:** Q-R078
- **Failure modes:** plan blocked waiting for spend approval so no plan exists; spend auto-approved after timeout; double spend on retry
- **Recovery:** Hold spend; keep plan ready.
- **Observe:** Inspect state machine transitions; attempt spend without approval in a test.
- **Brain implements:** TO BE RECONCILED

#### Q-R073 — Honest status and confidence disclosure (CRITICAL)

- **Accomplish:** The plan and the goal status state confidence, open decisive unknowns and interpretations; a goal with no plan meeting the bar reports infeasible/blocked with reason instead of presenting a weak plan as ready.
- **Inputs:** uncertainty; unknowns; validator result
- **Outputs:** status
- **Correct when:** Stated confidence equals computed confidence; open unknowns listed; no 'ready' status on a plan with unresolved critical findings.
- **Depends on:** Q-R044, Q-R026, Q-R071; **required by:** —
- **Failure modes:** overclaiming; silent omission of known weaknesses
- **Recovery:** Downgrade status.
- **Observe:** Compare status to findings and computed confidence.
- **Brain implements:** TO BE RECONCILED

### S16. Execution feedback and learning

#### Q-R074 — Execution result capture (MAJOR)

- **Accomplish:** Record actual outcomes (actions taken, leads, replies, sales, cash settled, costs, dates) against each plan step and checkpoint.
- **Inputs:** execution events; integrations; owner reports
- **Outputs:** actuals
- **Correct when:** Each checkpoint has an actual value or an explicit 'not measured'; actuals are attributed to the step that produced them.
- **Depends on:** Q-R068; **required by:** Q-R075
- **Failure modes:** results not recorded; results from integrations misattributed
- **Recovery:** Reconcile from source systems.
- **Observe:** Compare checkpoint table to actuals.
- **Brain implements:** TO BE RECONCILED

#### Q-R075 — Prediction-vs-outcome attribution (MAJOR)

- **Accomplish:** Compare predictions with actuals, identify which assumptions or evidence were wrong, and update their status.
- **Inputs:** predictions; actuals; assumption register
- **Outputs:** attribution records
- **Correct when:** Each significant miss is attributed to specific assumptions; those assumptions' status changes.
- **Depends on:** Q-R074, Q-R011; **required by:** Q-R076
- **Failure modes:** miss blamed vaguely; assumption unchanged after refutation
- **Recovery:** Re-run attribution.
- **Observe:** Inspect attribution records.
- **Brain implements:** TO BE RECONCILED

#### Q-R076 — Learning that changes later decisions (MAJOR)

- **Accomplish:** Store learned priors (conversion rates, lead times, payout delays, strategy-class success, research methods that worked, model quality per task) with scope, and make later discovery, economics, research and routing read them; measure that decisions changed.
- **Inputs:** attribution records; grader verdicts; research outcomes
- **Outputs:** scoped priors
- **Correct when:** A later goal's relevant computation reads the updated prior (visible in provenance) and its output differs accordingly; stale or over-broad priors are scoped.
- **Depends on:** Q-R075, Q-R010; **required by:** —
- **Failure modes:** lessons written but never read; overfitting from one case; prior from one geography applied everywhere
- **Recovery:** Scope and decay priors; require evidence counts.
- **Observe:** Trace later goals' reads of priors; A/B on replay.
- **Brain implements:** TO BE RECONCILED

#### Q-R077 — Learning from reasoning failures without test-set overfit (MAJOR)

- **Accomplish:** Classify each failed or rejected plan into the critical-mistake taxonomy, trace to requirement, and improve procedure; keep evaluation objectives out of the training/tuning loop.
- **Inputs:** grader verdicts; critique findings
- **Outputs:** improvement records
- **Correct when:** Each improvement targets a classified failure; acceptance objectives are never used for tuning.
- **Depends on:** Q-R087, Q-R052; **required by:** —
- **Failure modes:** tuning on evaluation set; fixing symptoms per case
- **Recovery:** Hold-out discipline; re-measure on fresh objectives.
- **Observe:** Audit tuning data against evaluation set.
- **Brain implements:** TO BE RECONCILED

#### Q-R078 — Safe execution of external effects (MAJOR)

- **Accomplish:** External effects (emails, payments, orders, posts) are performed exactly once per logical intent; an unknown outcome (timeout) is recorded as unknown and not auto-retried.
- **Inputs:** approved steps
- **Outputs:** effect records
- **Correct when:** No duplicated effects under retry/crash; unknown outcomes surfaced.
- **Depends on:** Q-R072, Q-R012; **required by:** —
- **Failure modes:** double charge; duplicate outreach violating rules
- **Recovery:** Reconcile with provider before retry.
- **Observe:** Fault-inject during effects; count duplicates.
- **Brain implements:** TO BE RECONCILED

### S17. Infrastructure reliability

#### Q-R079 — Model provider failure resilience (MAJOR)

- **Accomplish:** Handle timeouts, rate limits, outages and degraded models with bounded retry, backoff and fallback providers without losing progress or accepting degraded output.
- **Inputs:** model calls
- **Outputs:** results or recorded failures
- **Correct when:** Provider outage delays but does not corrupt or silently truncate a goal; fallback outputs pass Q-R056.
- **Depends on:** Q-R056, Q-R012; **required by:** —
- **Failure modes:** outage produces empty outputs that pass as results; whole goal fails on one timeout
- **Recovery:** Retry, fallback, resume.
- **Observe:** Fault injection on model calls.
- **Brain implements:** TO BE RECONCILED

#### Q-R080 — Research infrastructure failure handling (CRITICAL)

- **Accomplish:** When search or page fetch fails (API down, blocked, CAPTCHAs), mark the question unanswered/unresolved, try alternatives, and never record absence of results as a negative finding.
- **Inputs:** research tasks
- **Outputs:** failure states
- **Correct when:** Infrastructure failures appear as failure states, not as 'no evidence exists'; decisions depending on them use Q-R026 rules.
- **Depends on:** Q-R027, Q-R026; **required by:** —
- **Failure modes:** search outage read as 'no competitors'; blocked page inferred
- **Recovery:** Retry later; alternative sources; in-plan test.
- **Observe:** Simulate search outage; inspect conclusions.
- **Brain implements:** TO BE RECONCILED

#### Q-R081 — Work queue and worker reliability (MAJOR)

- **Accomplish:** Asynchronous workers claim work with exclusive leases, heartbeat, release or fail it; stuck items are recovered; no item is dropped; idle capacity is used while work waits.
- **Inputs:** work items
- **Outputs:** processed items
- **Correct when:** Every item terminal within bound; no double ownership; idle workers beside ready work is detected and corrected.
- **Depends on:** Q-R012; **required by:** Q-R027
- **Failure modes:** lost item after crash; two workers produce conflicting results; starvation
- **Recovery:** Lease expiry; reassignment; watchdog.
- **Observe:** Queue metrics: age, double-lease count, idle-with-backlog time.
- **Brain implements:** TO BE RECONCILED

#### Q-R082 — Database integrity and recovery (MAJOR)

- **Accomplish:** State writes are transactional; a database failure leaves no partial state; recovery restores consistency; the system detects and refuses to proceed on inconsistent state.
- **Inputs:** writes
- **Outputs:** consistent state
- **Correct when:** After an injected DB failure, goal model is either pre- or post-transaction, never between; derived state recomputes cleanly.
- **Depends on:** Q-R008, Q-R012; **required by:** —
- **Failure modes:** partial writes produce half-updated economics; connection loss treated as empty data
- **Recovery:** Rollback; recompute derived state.
- **Observe:** Fault injection on DB writes; consistency checker.
- **Brain implements:** TO BE RECONCILED

#### Q-R083 — Per-goal compute and research budget (MAJOR)

- **Accomplish:** Bound model tokens, strong-model calls, research calls and wall time per goal, allocating by decision value; exhaustion forces a decision with disclosed uncertainty rather than an abort or silent truncation.
- **Inputs:** budgets; task costs
- **Outputs:** budget ledger
- **Correct when:** Spend per goal within budget; budget exhaustion produces a terminal outcome with disclosed gaps.
- **Depends on:** —; **required by:** Q-R024, Q-R060, Q-R064
- **Failure modes:** runaway cost; budget cut mid-step truncates outputs silently
- **Recovery:** Reallocate; decide with current evidence.
- **Observe:** Budget ledger per goal.
- **Brain implements:** TO BE RECONCILED

#### Q-R084 — End-to-end trace for diagnosis (MAJOR)

- **Accomplish:** Record, per goal, every faculty call: inputs (goal-model version), model and prompt, raw output, validation result, accepted output, decisions, and links between them, so any plan can be replayed and each mistake traced to its origin step.
- **Inputs:** all calls
- **Outputs:** trace
- **Correct when:** For any plan figure or decision, the trace reaches the model call and evidence that produced it.
- **Depends on:** Q-R008; **required by:** Q-R085, Q-R089
- **Failure modes:** prose-only logs; missing prompts; trace not linked to versions
- **Recovery:** Instrument missing steps.
- **Observe:** Pick random plan facts; follow trace to origin.
- **Brain implements:** TO BE RECONCILED

#### Q-R085 — Frozen, identifiable revision and reproducibility (CRITICAL)

- **Accomplish:** The code, prompts, model versions, configuration and knowledge snapshot used for acceptance are frozen under one identifier, and the whole run is attributable to it.
- **Inputs:** deployment
- **Outputs:** revision id on every goal and plan
- **Correct when:** All 30 acceptance plans carry the same revision id; no config or prompt changed during the run.
- **Depends on:** Q-R084; **required by:** Q-R088
- **Failure modes:** hot-fix mid-evaluation; model provider silently changes model version
- **Recovery:** Restart evaluation on a new frozen revision.
- **Observe:** Check revision ids on all evaluated plans; diff config across run.
- **Brain implements:** TO BE RECONCILED

### S18. Acceptance evaluation

#### Q-R086 — Unfamiliar, feasible objective suite (CRITICAL)

- **Accomplish:** Maintain a suite of 30 diverse objectives (amounts, windows, capitals, involvement levels, owner profiles, jurisdictions, industries) never used in development, each with independently established feasibility, plus infeasible controls outside the 30.
- **Inputs:** objective authoring; feasibility evidence
- **Outputs:** evaluation suite
- **Correct when:** No suite objective (or near-duplicate) appears in development data; each has a feasibility argument by someone other than the system.
- **Depends on:** —; **required by:** Q-R087
- **Failure modes:** suite leaks into tuning; suite skewed to easy objectives; infeasible items counted
- **Recovery:** Replace leaked items.
- **Observe:** Leakage check vs development data; diversity stats.
- **Brain implements:** TO BE RECONCILED

#### Q-R087 — Independent grading against the usable-plan rubric (CRITICAL)

- **Accomplish:** Grade each plan by a grader independent of the system (different people or model family, no access to system prompts), using the usable-plan definition and critical-mistake taxonomy, with verification of factual claims (buyers exist, fees, settlement times) and inter-grader agreement measured.
- **Inputs:** plans; rubric; taxonomy
- **Outputs:** grades with per-element findings
- **Correct when:** Each grade lists element verdicts and any critical mistakes with evidence; agreement between graders measured and adequate.
- **Depends on:** Q-R086; **required by:** Q-R077, Q-R088, Q-R089
- **Failure modes:** grader shares the system's blind spots; grading on prose quality; grader cannot verify facts
- **Recovery:** Add graders; adjudicate disagreements.
- **Observe:** Inter-rater agreement; spot-audit grades.
- **Brain implements:** TO BE RECONCILED

#### Q-R088 — Acceptance computation (CRITICAL)

- **Accomplish:** Compute the acceptance result: at least 27 of 30 plans USABLE with zero critical mistakes, all from one frozen revision, one run per objective (no best-of-n selection unless the system itself does it within budget).
- **Inputs:** grades; revision ids
- **Outputs:** acceptance verdict
- **Correct when:** Verdict reproducible from grade records; no cherry-picked reruns; revision single.
- **Depends on:** Q-R087, Q-R085; **required by:** —
- **Failure modes:** rerunning failures until they pass; mixing revisions
- **Recovery:** Re-run whole suite on a new revision.
- **Observe:** Audit run log and grade records.
- **Brain implements:** TO BE RECONCILED

#### Q-R089 — Failure classification to requirements (MAJOR)

- **Accomplish:** Map every failed plan to critical-mistake categories and to the requirement(s) whose failure caused it, using the trace.
- **Inputs:** failed grades; trace
- **Outputs:** failure-to-requirement map
- **Correct when:** Every failure has at least one mapped requirement with trace evidence.
- **Depends on:** Q-R087, Q-R084; **required by:** —
- **Failure modes:** failures explained by narrative only
- **Recovery:** Improve trace.
- **Observe:** Inspect mapping records.
- **Brain implements:** TO BE RECONCILED

## 4. Handoffs

| id | producer → consumer | information that must cross | lost if it does not |
|---|---|---|---|
| Q-H01 | Q-R001 → Q-R008 | Structured objective spec with verbatim spans and UNSTATED markers | Faculties re-read the raw text differently; metric, window or capital drift. |
| Q-H02 | Q-R002 → Q-R041 | Single metric recognition rule (when cash counts) | Forecast counts uncollected or unsettled revenue. |
| Q-H03 | Q-R003 → Q-R049 | Owner profile with per-item status (held/unknown/absent) and source | Unknown capabilities treated as held; licence/account gaps. |
| Q-H04 | Q-R004 → Q-R017 | Constraint register with provenance and scope | System policy silently excludes strategies as if owner-stated; previous goal's constraints leak. |
| Q-H05 | Q-R015 → Q-R016 | Owner advantages (held only) | Generic or infeasible candidate set. |
| Q-H06 | Q-R017 → Q-R019 | Screened candidates plus rejected/deferred ones with reasons | Revision cannot revisit good candidates; deferred-on-unknown becomes permanent rejection. |
| Q-H07 | Q-R020 → Q-R023 | Full strategy specs with assumptions and UNKNOWN legs | Decisive unknowns not identified; incomplete strategies reach economics. |
| Q-H08 | Q-R023 → Q-R024 | Decisive unknowns with the decision each affects and its range | Research not bounded by decision value; trivia researched, decisive questions starved. |
| Q-H09 | Q-R024 → Q-R027 | Research brief: quantity, scope, acceptance criteria, decision link, stop rule | Vague results; tasks continue after decision settled. |
| Q-H10 | Q-R028 → Q-R029 | Captured source with snapshot and retrieval state | Claims attributed to unread pages; unreadable sources inferred. |
| Q-H11 | Q-R029 → Q-R030 | Extracted claims with passage, unit, date, geography, segment | Context lost; inapplicable figures used. |
| Q-H12 | Q-R030 → Q-R040 | Graded, applicable evidence with ids | Economics uses ungraded or inapplicable figures without provenance. |
| Q-H13 | Q-R031 → Q-R058 | Conflict records and reconciled values | New evidence silently overwrites; revision never triggered. |
| Q-H14 | Q-R035 → Q-R041 | Buyer counts, reachability, price evidence, purchase-cycle length | Funnel assumes demand that does not exist or buys too slowly. |
| Q-H15 | Q-R036 → Q-R042 | Supplier cost, MOQ, lead time, payment terms | Cash-flow ignores prepayments; capital exceeded. |
| Q-H16 | Q-R039 → Q-R047 | Channel prerequisites with durations | Critical path omits warm-up/approval; timeline infeasible. |
| Q-H17 | Q-R046 → Q-R042 | Sale-to-available-funds lag, holds, reserves per payment rail | Cash assumed available before it is. |
| Q-H18 | Q-R042 → Q-R069 | Dated cash-flow schedule and peak capital | Commitment schedule exceeds capital. |
| Q-H19 | Q-R044 → Q-R061 | Uncertainty distributions computed identically per strategy | Comparison biased by unequal optimism. |
| Q-H20 | Q-R052 → Q-R058 | Structured critique findings (category, location, evidence) | Findings in prose are never acted on. |
| Q-H21 | Q-R056 → Q-R008 | Validated outputs only; failure records for invalid ones | Empty/invalid model answers enter shared state as facts. |
| Q-H22 | Q-R061 → Q-R062 | Comparison table on one goal-model version | Arbiter decides on mixed-vintage scores. |
| Q-H23 | Q-R062 → Q-R066 | Single selected strategy with rationale and runner-ups | Plan built from a mix of strategies; contradictions. |
| Q-H24 | Q-R047 → Q-R066 | Critical path with dependencies and durations | Steps out of order; first action has unmet prerequisites. |
| Q-H25 | Q-R026 → Q-R068 | Unresolved decisive unknowns needing in-plan tests | No early checkpoint; failure discovered at window end. |
| Q-H26 | Q-R071 → Q-R072 | Validation verdict (complete/blocked) | Incomplete plan marked ready, or ready plan blocked behind spend approval. |
| Q-H27 | Q-R072 → Q-R078 | Owner approval with ceiling per commitment | Spend executed without approval or twice. |
| Q-H28 | Q-R074 → Q-R075 | Actuals per checkpoint and step | Learning has nothing to attribute. |
| Q-H29 | Q-R076 → Q-R016 | Scoped learned priors (strategy-class success, rates, lead times) | Learning written but never changes discovery/economics. |
| Q-H30 | Q-R076 → Q-R064 | Measured model quality per task type | Routing never improves; weak model keeps deciding. |
| Q-H31 | Q-R080 → Q-R026 | Infrastructure failure state (not 'no evidence') | Outage read as a negative or favourable finding. |
| Q-H32 | Q-R009 → Q-R061 | Stale flags on dependents after a change | Selection made on superseded values. |

## 5. Requirements most likely missing in a typical implementation

- **Q-R004** constraint provenance — system policies masquerading as owner restrictions (Q-CM09).
- **Q-R002 / Q-R046** collected-cash recognition and settlement lag — revenue counted before it can be collected (Q-CM03).
- **Q-R008 / Q-R009** one shared per-goal model with staleness propagation — faculties exchanging prose, plans built on superseded figures (Q-CM13, Q-CM16).
- **Q-R045 / Q-R043 / Q-R070** figure provenance, deterministic arithmetic and rendering from structure — model-retyped numbers (Q-CM01, Q-CM06).
- **Q-R056 / Q-R080** model-output and research-failure validation — empty answers or outages read as facts (Q-CM18, Q-CM19).
- **Q-R026** unknowns never resolved favourably, plus in-plan tests (Q-CM18).
- **Q-R024** research bounded by decision value with stop rules (Q-CM20 via non-termination).
- **Q-R062** a single arbiter (Q-CM13).
- **Q-R072** plan readiness separate from money approval (Q-CM15, Q-CM20).
- **Q-R076** learning that is actually read by later decisions.
- **Q-R057 / Q-R087** calibrated critic and an independent grader that verifies facts.
- **Q-R085 / Q-R086** a frozen revision and a leak-free unfamiliar suite — otherwise the 27/30 result means nothing.
