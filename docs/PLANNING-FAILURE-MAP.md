# Planning failure map: the authoritative record

Rendered from `docs/planning-failure-map/map.py` by `render_md.py`; edit the data, never this file. `node scripts/planningFailureMapCheck.mjs` recomputes every count.

**Outcome the map is derived from:** A credible, researched, financially sound, executable plan that satisfies the owner's original objective inside every stated limit, graded USABLE by an independent grader.

## Summary

- Capabilities required: **75**
- Diagnostic questions (5 per capability, +1 model-isolation question for each of the 8 model-dependent ones): **383**
- PASS 24 · FAIL 85 · RECHECK 75 · UNKNOWN 199
- Diagnostic validity (Phase 3): CONTROLLED_FAILURE 25 · HISTORICAL_FAILURE_DETECTED 27 · KNOWN_GOOD_ONLY 12 · UNPROVEN 319
- Root causes established: **20**

## A. What creating a successful plan requires (capability map)

| id | stage | capability | why a plan needs it |
|---|---|---|---|
| C01 | Goal | Read the objective (amount, currency, window, capital, hours, recurrence, place) | Every limit a plan is judged against comes from this reading. |
| C02 | Goal | Read the owner's means without inventing them (skills, assets, licences, location, authority, refusals) | Owner fit is the first feasibility rule; invented refusals or skills send every route wrong. |
| C03 | Goal | Resolve Brain's standing operating rule against the goal's own offer, once, as data | Brain's rule and the owner's offer must not contradict each other in any prompt or gate. |
| C04 | Goal | Keep one consistent understanding of the goal across faculties and time | Plans built by faculties that disagree about the goal cannot be coherent. |
| C05 | Environment | Calendar, season and window arithmetic | Whether money settles inside the window decides feasibility. |
| C06 | Environment | Know the local economic environment (buyers in the place, market conditions, season) | Routes must target buyers who exist and are buying now, there. |
| C07 | Opportunity | Discover opportunities without being given a strategy | The plan can only be as good as the best opportunity considered. |
| C08 | Opportunity | Generate genuinely different approaches | Comparison needs real alternatives, not variations. |
| C09 | Opportunity | Pre-screen against hard limits (capital, hours, window, lawful) | Infeasible routes waste research and mislead. |
| C10 | Inquiry | Identify what must be known before choosing (decisive unknowns) | Research effort must go where an answer changes the decision. |
| C11 | Inquiry | Ask useful, non-anchored research questions | Questions decide what can ever be learned. |
| C12 | Inquiry | Prioritise follow-ups and stop when research cannot change the decision | Unbounded research wastes scarce capacity; premature stop leaves gaps. |
| C13 | Research | Search provider availability and capacity | No search, no facts. |
| C14 | Research | Research work executes (fragments complete) | Planned research must actually run. |
| C15 | Research | Open and read the pages | Search snippets are not evidence. |
| C16 | Research | Extract claims with exact citations | A planner can only cite what was extracted with its source. |
| C17 | Research | Verify that the evidence supports the claim | Unverified claims mislead the planner. |
| C18 | Research | Type the evidence (what it establishes: lane, scope exact/comparable, place, date) | A fact about another segment or another figure must not ground this one. |
| C19 | Research | Combine facts and detect contradictions | Contradicted routes must be rejected; conflicting facts resolved. |
| C20 | Research | Knowledge library matching (buyer identity, counts) | Wrong buyer counts close the buyer question falsely. |
| C21 | Delivery | Deliver verified findings into the proposer's reasoning input | A fact not shown cannot change the plan. |
| C22 | Delivery | Deliver findings and conclusions to other faculties (constructor, committee, dives, report, operator) | Every faculty that decides must see the evidence. |
| C23 | Planning | A model turn returns a valid answer (no empty/timeout/unparseable fall-through) | Every reasoning step depends on a model actually answering. |
| C24 | Planning | Propose routes that use the evidence correctly | The plan is built from these routes. |
| C25 | Planning | Quantitative and causal economics (price x volume, CAC vs capital, margin, hours, reach) | A plan is financially sound only if the arithmetic holds. |
| C26 | Planning | Payment terms and time to collected cash | Money must be collected, not pending, inside the window. |
| C27 | Planning | Buyer discovery and acquisition channel reasoning | Without a channel that produces buyers in time, no plan works. |
| C28 | Planning | Fulfilment and subcontractor reasoning | Someone named must deliver at a known cost. |
| C29 | Planning | Legal and platform-terms reasoning | Unlawful or ToS-breaking plans are not usable. |
| C30 | Planning | Parser and mechanical validation (correct rejections; repair, not loss) | Mechanical checks must remove bad routes without losing good ones. |
| C31 | Planning | Criticise correctly (drop only on verified grounds) | The critic has the last word on what the owner receives. |
| C32 | Planning | Revise after critique (replacement routes) | Criticism must improve the plan, not end it. |
| C33 | Planning | Compare and select one strategy | The owner needs one plan, chosen on evidence. |
| C34 | Planning | Identify risks and invalid assumptions | Unexamined assumptions sink plans. |
| C35 | Planning | Know when a plan is ready (and when more research is needed) | Neither premature nor never. |
| C36 | Planning | Convert the chosen strategy into a complete executable plan | A route is not a plan: steps, who, when, cost, first actions, acceptance. |
| C37 | Learning | Learn from previous findings and failures | The same mistake must not repeat. |
| C38 | Learning | Adapt when circumstances change (owner change, new evidence, refutation) | Plans must follow reality. |
| C39 | Learning | Recover from model, research and software failures | Failures are frequent; recovery must be automatic. |
| C40 | Orchestration | Own the next step of every goal (no unowned step) | Work nobody owns does not happen. |
| C41 | Orchestration | Choose models by their measured results on this work | The model that answers must be the one that reasons best here. |
| C42 | Output | Present a usable plan to the owner | The owner must be able to act on it. |
| C43 | Reviewer-1 coverage | Constructed arrangement generation and candidate selection (the non-LLM generator) | goalArrangements feeds composeGoalModel; the arrangement set is the main supply of openings the planner and reconstruction can adopt. HELD slots keep last readings' leaders, so a bad early leader can lock out alternatives. |
| C44 | Reviewer-1 coverage | Arrangement de-duplication by signature | Diversity of the plan set is decided here, not by the critic (C08 tests only the LLM). Diagnosis doc: 426 candidates -> 49 distinct, signatures like 'risk=are client marketplace one pay...'. |
| C45 | Reviewer-1 coverage | Arrangement pre-screen in the quantitative model (deadline, capital, hours, loss per deal) | C09 tests parseRoutes only; this is the hard-limit filter for the openings the plan is actually built from. A wrong cut silently removes the winning structure. |
| C46 | Reviewer-1 coverage | Opening economic model (price, volume, close, days-to-cash, owner hours, supply cost) | C25/C26 test the LLM's arithmetic in parseRoutes; the plan's reach, p10 and steps come from this model instead. |
| C47 | Reviewer-1 coverage | Portfolio simulation and the conservative settled figure | Acceptance (the 90% defensible reach, §95) is read from this distribution; an error here flips ACCEPTED/CANDIDATE_ONLY regardless of route quality. |
| C48 | Reviewer-1 coverage | Validation ladder / link checks per opening | Decides which openings are 'considered' vs held for research, and what the next test is; C35 tests readiness only at the judgeAcceptance level. |
| C49 | Reviewer-1 coverage | Acceptance judgement and its calibration | The single readiness verdict the owner sees. Map C35-P only notes it is 'unattainable by research'; it does not test the decision logic or calibration. |
| C50 | Reviewer-1 coverage | Plan reconstruction when short of requirement (§99) | This is Brain's main 'revise the plan' mechanism and produces the adopted candidate in most short goals; the map's C32 tests only the LLM replacement ask. |
| C51 | Reviewer-1 coverage | Evolutionary direction search (exploreDirections) | §101/§102 search over plan variants; its leader becomes the reconstruction's best. Not referenced by any question. |
| C52 | Reviewer-1 coverage | Variable sweep (sweepVariables) | Supplies the 'which lever moves reach' reading and price variables used by candidateStrategyReading; the binding factor shown to the owner comes from here. |
| C53 | Reviewer-1 coverage | Strategist invention of new designs (inventDirections) | A second LLM generator feeding the reconstruction, separate from the route proposer; C23 covers model failures only for route asks. |
| C54 | Reviewer-1 coverage | Cross-goal reasoning-method learning (UCB library, stance prior) | This is the only learning loop actually read back on the planning path; C37 tests only route 'rethink' lessons (which have no reader). |
| C55 | Reviewer-1 coverage | Evaluator pool robustness | All exploration/sweep quality depends on enough evaluations completing; C39 does not cover the evaluator. |
| C56 | Reviewer-1 coverage | Adopting one plan (reconstruction vs plan as held) | The actual 'compare and select one strategy' step for the owner's plan. Map C33 points at applyCritique, which only ranks LLM routes. |
| C57 | Reviewer-1 coverage | Infeasibility by arithmetic and held-market ceilings | A false NOT_VIABLE ends planning for the goal; a missed one keeps spending research on an impossible goal. Unmapped. |
| C58 | Reviewer-1 coverage | Investment committee rule roles and answer settlement (§117) | The committee can refuse an ACCEPTED plan; the map only checks whether its questions are answered (C22-R), not whether its verdicts are right. |
| C59 | Reviewer-1 coverage | Committee model specialists | The only independent model critic of the whole plan (as opposed to single routes); production reads NOT_RUN. |
| C60 | Reviewer-1 coverage | Plan integrity gate | Last filter before RECOMMENDABLE; a false pass shows the owner an invalid plan, a false refusal hides a valid one. |
| C61 | Reviewer-1 coverage | Step-writing guards (window, figures, missing transaction stages, owner of each step) | C36 asks whether steps exist; these guards decide whether they are executable and correctly owned. |
| C62 | Reviewer-1 coverage | Plan set distinctness and resilience | The owner-facing alternatives and fallback; C08-R tests distinctness only through the critic. |
| C63 | Reviewer-1 coverage | Plan refresh trigger (inputs fingerprint) | C38 tests route re-asks (routeAskDue); the plan itself only adapts if this fires. |
| C64 | Reviewer-1 coverage | Reconsideration of decisions when underlying facts change | The mechanism for C04-F/C38-I ('stale openings retired', 'new evidence changes plan'), but no question names it. |
| C65 | Reviewer-1 coverage | Prediction calibration and miss classification | §108 'a decision is judged by what it predicted'; with no reader, Brain cannot learn its planning bias. Map C37-P mentions calibration lessons only as recorded. |
| C66 | Reviewer-1 coverage | Research worth / materiality filter | This is the real implementation of C12's 'stop when research cannot change the decision'; untested. |
| C67 | Reviewer-1 coverage | Validation dive selection and ordering | Dives establish buyer/price/demand the plan is judged on; the map tests dives only as a destination (C07-R, C10-R). |
| C68 | Reviewer-1 coverage | Plan -> research priority handoff | C35-I asks only whether not-ready names research; this tests the planner's priorities actually steer research capacity. |
| C69 | Reviewer-1 coverage | Goal discovery lenses and focus | Discovery supplies openings independent of the proposer; C07 tests only directionPrompt. Diagnosis doc: online-only focus appended whatever the owner offered. |
| C70 | Reviewer-1 coverage | Harvest of research into openings and evidence join | The only path by which research becomes model inputs on openings; C21/C22 test delivery to prompts, not to the opening card the planner reads. |
| C71 | Reviewer-1 coverage | Direction critique (scout stage critic) | A second critic before any route is priced; C31 tests only the route critic. |
| C72 | Reviewer-1 coverage | Continuation decision (keep searching / successors) | Decides whether Brain keeps working a goal at all (C40 'idle goal' is the symptom). |
| C73 | Reviewer-1 coverage | Pathway constructions and commercial reality check (§116) | §116: coverage over unsupported legs is not reliability; this is the check, unmapped. |
| C74 | Reviewer-1 coverage | Goal sprints and the industry kernel (Russell) | Listed in the intelligence diagnosis as invoked faculties on the goal path; no question touches them. |
| C75 | Reviewer-1 coverage | Operator detection of stuck plans | The recovery owner for a plan that stops improving; C22-F/C39-F state 'operator does not act' without a test on this code. |

Dimensions: **P** Can Brain perform it correctly?; **R** Does the result reach every component that needs it?; **I** Does the result change later decisions correctly?; **F** Does Brain recognise and recover when it fails?; **X** Does it still work combined with the other capabilities?; **M** Is a failure the model's own, or Brain's instructions/software? (model isolated on the identical input)

## B–C. Every diagnostic question and its status

### C01 Read the objective (amount, currency, window, capital, hours, recurrence, place)

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C01-P | Can Brain perform it correctly? | Read 30 varied owner requests incl. "can't put any hours in", weekly vs total hours, "keeps going after". | Amount, window, capital and hours match a human reading; unknowns marked unread, never guessed. | **RECHECK** | fm1126b on a8c46995: 30 of 30 fresh goals read and created (fm1126a on the earlier reader: 26, with 3+ misread). Amount, window, capital and hours match a human reading on all 30 (local read of the batch). / REVIEW 2: validity review: f07 and f24 were misread on fm1126b; repaired W2c and checked against blind expected readings of all 30 (tests/objectiveFreshBatchBlind.test.ts, 30/30) — production re-demonstration pending. | CONTROLLED_FAILURE: re-introduced "historical: "3 hours a week at most" read as 3 hours in total" → tests/objectiveFreshPhrasings.test.ts failed naming RC15; unmutated code accepted | industry/construction/intent.ts readObjective | RC15 |
| C01-R | Does the result reach every component that needs it? | Does the reading reach proposer, critic, planner, committee? | Same figures in every prompt and plan reading. | **PASS** | 30Q probe objective lines; plan readings use target. | CONTROLLED_FAILURE: re-introduced "historical: a monthly figure with a start month refused" → tests/objectiveFreshPhrasings.test.ts failed naming RC15; unmutated code accepted | goals/target.ts | — |
| C01-I | Does the result change later decisions correctly? | Change hours from 15 to 0 mid-course. | Next ask drops owner-performed routes. | **RECHECK** | Same path as C38-R; not exercised on production. | CONTROLLED_FAILURE: re-introduced "historical: "over winter break, about two weeks" read as a window ending 10 December" → tests/objectiveFreshPhrasings.test.ts failed naming RC15; unmutated code accepted | planningEval update path | — |
| C01-F | Does Brain recognise and recover when it fails? | Ambiguous request ("some money soon"). | Goal flags the unread field as a question to the owner, plans nothing on a guess. | **RECHECK** | fm1126a create log: unread phrases are named and the goal is refused rather than guessed ("nothing was created. Unread: …"). / REVIEW 2: validity review: the earlier evidence came from the old reader. | CONTROLLED_FAILURE: re-introduced "historical (own regression): "I have more than $600 to spend" read as a $600 ceiling" → tests/objectiveFreshPhrasings.test.ts failed naming RC15; unmutated code accepted | readObjective unread[] | — |
| C01-X | Does it still work combined with the other capabilities? | Objective reading + operating rule + labour offer on the same goal. | No contradiction between limits and owner offer in the prompt. | **RECHECK** | p10 "zero hours" fixed d5beaf6; not re-run on fresh goals. | CONTROLLED_FAILURE: re-introduced "historical: "I already work 40 hours a week … maybe 15 more" read as 40 h a week" → tests/objectiveFreshBatchBlind.test.ts failed naming RC15; unmutated code accepted | routeProposal limitLines | RC3 |

### C02 Read the owner's means without inventing them (skills, assets, licences, location, authority, refusals)

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C02-P | Can Brain perform it correctly? | Owner profile in the reply for 30 requests. | Every skill/asset/refusal appears in the owner's words; "not stated" otherwise. | **FAIL** | 4/4 fallback replies invented refusals; p02 run-1 "no physical work". | UNPROVEN | route prompt STEP 1 | RC3 |
| C02-R | Does the result reach every component that needs it? | Is the profile stored and read by the next ask/critic/discovery? | One profile per goal, read by all. | **FAIL** | Integration diag: profile kept only in event detail, re-derived each ask. | UNPROVEN | routeProposal record | RC7 |
| C02-I | Does the result change later decisions correctly? | Owner states a licence; do routes sell the licensed work? | At least one route sells it. | **RECHECK** | p02: every output led with Part 107 aerial work. / REVIEW 2: test-validity review: rests on one example, a field existing, or a contract — not a demonstration. | UNPROVEN | ROUTE_RULES.OWNER_FIT | — |
| C02-F | Does Brain recognise and recover when it fails? | Profile contradicts owner words; is it corrected? | Code compares profile to words and drops inventions. | **FAIL** | No check exists (code). | UNPROVEN | ownerProfileOf | RC3 |
| C02-X | Does it still work combined with the other capabilities? | Owner with no stated skill + $0 + place. | Means = time, place; direct paid work considered. | **FAIL** | p06: no output proposed the owner's own paid work. | UNPROVEN | directionPrompt | RC5 |
| C02-M | Is a failure the model's own, or Brain's instructions/software? (model isolated on the identical input) | Same p06 prompt to the control model. | Control reads the owner correctly. | **RECHECK** | Model exam: given complete facts, Claude Opus reads constraints with 3 violations in 30; gpt-oss 8, fallback 22. The 4/4 invented refusals were the fallback's. / REVIEW 2: test-validity review: rests on one example, a field existing, or a contract — not a demonstration. | UNPROVEN | model | RC14 |

### C03 Resolve Brain's standing operating rule against the goal's own offer, once, as data

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C03-P | Can Brain perform it correctly? | Owner offering labour/equipment: does every prompt state the lift? | Route prompt, discovery and gates agree. | **RECHECK** | Route prompt fixed (d5beaf6); discovery still appends REMOTE_AI_FOCUS (discovery.ts:1304). / REVIEW 2: test-validity review: the evidence describes code since changed; the repaired behaviour must be re-demonstrated on production. | CONTROLLED_FAILURE: re-introduced "historical: 14 of 30 owners stating hours sent the no-physical-work rule" → tests/planningFailureMapWave2.test.ts failed naming RC3; unmutated code accepted | domain/operatingModel.ts | RC3 |
| C03-R | Does the result reach every component that needs it? | Do the three regex gates read the same resolution? | One resolution object read by all. | **FAIL** | Integration diag: regex re-implemented in goalScenario, worthResearching, answers. | UNPROVEN | operatingModel | RC3 |
| C03-I | Does the result change later decisions correctly? | Does the lift change discovery questions? | Discovery asks about in-person work when offered. | **RECHECK** | Code: REMOTE_AI_FOCUS unconditional. / REVIEW 2: test-validity review: the evidence describes code since changed; the repaired behaviour must be re-demonstrated on production. | CONTROLLED_FAILURE: re-introduced "historical: discovery online-only for an owner who offered work" → tests/planningFailureMapWave1.test.ts failed naming RC3; unmutated code accepted | discovery.ts | RC3 |
| C03-F | Does Brain recognise and recover when it fails? | Regex misses an offer ("I can fly 20 h a week"). | A model-read offer or an explicit question; not silent refusal. | **RECHECK** | p02 "fly about 20 hours" read as labour after ad40c37; unverified on fresh goals. | UNPROVEN | ownerLabourOffer | — |
| C03-X | Does it still work combined with the other capabilities? | Owner offer + zero capital + 7 days. | Owner-performed routes allowed and preferred when fastest. | **FAIL** | p06 final: no owner-performed route proposed. | UNPROVEN | route prompt | RC5 |

### C04 Keep one consistent understanding of the goal across faculties and time

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C04-P | Can Brain perform it correctly? | Read one goal's plan, report and operator view at once. | Same chosen strategy and binding factor everywhere. | **FAIL** | wst_db2e: four "best" answers, three binding diagnoses. | UNPROVEN | readGoalPlan | RC11 |
| C04-R | Does the result reach every component that needs it? | Do lessons, refutations and committee questions reach the route ask? | Shown in routeContext. | **FAIL** | Integration diag (code). | UNPROVEN | routeContext | RC7 |
| C04-I | Does the result change later decisions correctly? | A refuted direction: is it proposed again? | Never in another wording. | **RECHECK** | Last ask's CRITIQUE drops fed back (routeProposal ~1836); multi-ask effect unmeasured. | UNPROVEN | routeContext refuted | — |
| C04-F | Does Brain recognise and recover when it fails? | Goal changed by owner: are stale openings retired? | Openings inconsistent with new limits archived. | **UNKNOWN** | — | UNPROVEN | — | — |
| C04-X | Does it still work combined with the other capabilities? | Six generators feed one goal. | One arbitrated set; no contradictory openings. | **FAIL** | fm1126a f01: the plan reading is built from constructed arrangements while the route proposer's owner-read directions are not yet openings; two generators, no arbiter. | HISTORICAL_FAILURE_DETECTED: the measurement procedure cited in the evidence recorded the failure on production or in a recorded probe | plan set | RC11,RC13 |

### C05 Calendar, season and window arithmetic

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C05-P | Can Brain perform it correctly? | Critic/proposer judge "net 30 in a 60-day window", "Dec 3-7 in a window ending Feb 24". | Correct inside/outside. | **FAIL** | 30Q: both misread by the critic. | HISTORICAL_FAILURE_DETECTED: the measurement procedure cited in the evidence recorded the failure on production or in a recorded probe | critic | RC2 |
| C05-R | Does the result reach every component that needs it? | Is the window end date in every prompt? | Explicit end date. | **PASS** | a1eba64 (windowEnd) present in final prompts. | UNPROVEN | limitLines | — |
| C05-I | Does the result change later decisions correctly? | Does a correct date change keep/drop? | Drops on window only when computed outside. | **RECHECK** | No computed check (code). / REVIEW 2: test-validity review: the evidence describes code since changed; the repaired behaviour must be re-demonstrated on production. | UNPROVEN | applyCritique | RC2 |
| C05-F | Does Brain recognise and recover when it fails? | A wrong date claim: detected? | Code overrules. | **RECHECK** | None (code). / REVIEW 2: test-validity review: the evidence describes code since changed; the repaired behaviour must be re-demonstrated on production. | UNPROVEN | applyCritique | RC2 |
| C05-X | Does it still work combined with the other capabilities? | Season + payment terms + delivery lead time combined. | Computed first-cash day inside window. | **FAIL** | p02/p10 critic errors. | UNPROVEN | critic | RC2 |
| C05-M | Is a failure the model's own, or Brain's instructions/software? (model isolated on the identical input) | Same critique prompt to the control model. | Control does the arithmetic right. | **FAIL** | Model exam: gpt-oss 8 and the fallback 22 constraint violations in 30, Claude 3; date and window arithmetic errors concentrate in the open models. | HISTORICAL_FAILURE_DETECTED: the measurement procedure cited in the evidence recorded the failure on production or in a recorded probe | model | RC14 |

### C06 Know the local economic environment (buyers in the place, market conditions, season)

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C06-P | Can Brain perform it correctly? | Plan cites local, dated market facts. | Demand facts are local and current. | **RECHECK** | With supplied research yes (p02 listings, ARMLS); production research 0 facts. | UNPROVEN | research→findings | RC6 |
| C06-R | Does the result reach every component that needs it? | Do local facts reach the proposer? | Yes, within the findings budget. | **FAIL** | 40 cap. | UNPROVEN | findingsOf | RC4 |
| C06-I | Does the result change later decisions correctly? | Off-season facts drop seasonal routes? | Yes. | **RECHECK** | p02 December listings drop found by follow-ups, not reflected in plans. | UNPROVEN | proposer | — |
| C06-F | Does Brain recognise and recover when it fails? | No local facts: does Brain ask for them? | Research asks local demand first. | **RECHECK** | Questions did ask (p02 Q1, Q27); production does not execute. | UNPROVEN | questions | RC6 |
| C06-X | Does it still work combined with the other capabilities? | Local facts + owner means + window. | Fastest local buyers considered first. | **FAIL** | p06/p10 local options absent. | UNPROVEN | proposer | RC5 |

### C07 Discover opportunities without being given a strategy

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C07-P | Can Brain perform it correctly? | Directions for 30 fresh goals. | Strongest evidence-supported path among those named in >=27/30. | **RECHECK** | fm1126b f01 (production, revision a8c46995 with wave 1): the scout named 4 directions fitting the owner (gig grocery delivery, local business delivery partner, holiday decoration transport, weekend junk haul) where fm1126a's plan had led with fractional aircraft ownership. One goal; the batch read will decide. | UNPROVEN | directionPrompt/proposer | RC5,RC3 |
| C07-R | Does the result reach every component that needs it? | Do discovered directions reach research and the planner? | Each direction's decisive unknown is researched. | **FAIL** | Dives starved (RC6). | UNPROVEN | validation dives | RC6 |
| C07-I | Does the result change later decisions correctly? | Research refutes a direction: replaced? | Replacement direction differs structurally. | **RECHECK** | Scout→refuted loop exists; starved. | UNPROVEN | scout loop | — |
| C07-F | Does Brain recognise and recover when it fails? | All directions refuted. | New directions from a different mechanism. | **UNKNOWN** | — | UNPROVEN | — | — |
| C07-X | Does it still work combined with the other capabilities? | Discovery + owner means + constraints. | No online-only bias for owners with physical means. | **FAIL** | discovery REMOTE_AI_FOCUS. | UNPROVEN | discovery | RC3 |
| C07-M | Is a failure the model's own, or Brain's instructions/software? (model isolated on the identical input) | Control model on the same direction prompt. | Control names the strongest path. | **FAIL** | Model exam commercial planning: Claude 10/11, gpt-oss 4/11, Qwen 1/11, fallback 0/11. 30Q control (Claude Sonnet, Brain's prompt) also missed p06's strongest path, so the prompt shares the failure (RC5). | HISTORICAL_FAILURE_DETECTED: the measurement procedure cited in the evidence recorded the failure on production or in a recorded probe | prompt | RC14,RC5 |

### C08 Generate genuinely different approaches

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C08-P | Can Brain perform it correctly? | Routes in one ask: distinct mechanisms/buyers. | >=2 structurally different where evidence allows. | **RECHECK** | p02 final cap: 6 routes, 4 mechanisms; others 1 route. | UNPROVEN | proposer | — |
| C08-R | Does the result reach every component that needs it? | Distinct routes survive to the plan set. | Yes. | **FAIL** | Critic dropped most. | UNPROVEN | critic | RC2 |
| C08-I | Does the result change later decisions correctly? | Alternatives compared on computed economics. | Yes. | **RECHECK** | No computed economics. / REVIEW 2: test-validity review: the evidence describes code since changed; the repaired behaviour must be re-demonstrated on production. | UNPROVEN | parseRoutes | RC8 |
| C08-F | Does Brain recognise and recover when it fails? | Only one route proposed: asked for more? | Replacement ask with different mechanism. | **RECHECK** | Replacement ask exists; effect not visible in probes. | UNPROVEN | critiqueAndRevise | — |
| C08-X | Does it still work combined with the other capabilities? | Diversity + constraints + evidence. | Diverse and feasible. | **FAIL** | Outputs mostly single routes. | UNPROVEN | proposer | RC5 |

### C09 Pre-screen against hard limits (capital, hours, window, lawful)

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C09-P | Can Brain perform it correctly? | Routes breaching capital/hours/window rejected by code. | Correctly rejected, no false rejects. | **RECHECK** | Hours/margin rejections correct (30Q); capital/window not computed. | UNPROVEN | parseRoutes | RC8 |
| C09-R | Does the result reach every component that needs it? | Rejection reasons reach the next ask. | Yes. | **PASS** | replacementPrompt names failures; refuted list. | UNPROVEN | routeProposal | — |
| C09-I | Does the result change later decisions correctly? | Next ask avoids the breach. | Yes. | **RECHECK** | Rejections and critique drops are fed to the next ask (code); multi-ask effect unmeasured. | UNPROVEN | — | — |
| C09-F | Does Brain recognise and recover when it fails? | False reject (rule misfires). | Rule reports and route kept for review. | **RECHECK** | OWNER_FIT missing-field drop. / REVIEW 2: test-validity review: the evidence describes code since changed; the repaired behaviour must be re-demonstrated on production. | UNPROVEN | parseRoutes | RC9 |
| C09-X | Does it still work combined with the other capabilities? | Pre-screen + critic. | No double-jeopardy contradictions. | **FAIL** | Critic contradicts code-passed routes on false grounds. | UNPROVEN | critic | RC2 |

### C10 Identify what must be known before choosing (decisive unknowns)

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C10-P | Can Brain perform it correctly? | Each direction names its decisive unknown. | Specific, checkable, decision-bearing. | **RECHECK** | Directions carry decisiveUnknown (production SCOUT asks). / REVIEW 2: test-validity review: rests on one example, a field existing, or a contract — not a demonstration. | UNPROVEN | directionPrompt | — |
| C10-R | Does the result reach every component that needs it? | Unknown becomes the first research question. | Yes. | **FAIL** | fm1126b f01: 4 owner-fit directions filed with decisive unknowns; their 4 validation dives sat CAPTURED, unjudged, so the unknowns never became research. | HISTORICAL_FAILURE_DETECTED: the measurement procedure cited in the evidence recorded the failure on production or in a recorded probe | validation.ts | RC19 |
| C10-I | Does the result change later decisions correctly? | Answer to unknown keeps/kills the direction. | Yes. | **RECHECK** | Loop starved. | UNPROVEN | scout loop | RC6 |
| C10-F | Does Brain recognise and recover when it fails? | Unknown unanswerable: recognised? | Marked and replaced. | **UNKNOWN** | — | UNPROVEN | — | — |
| C10-X | Does it still work combined with the other capabilities? | Unknowns across directions de-duplicated. | Yes. | **UNKNOWN** | — | UNPROVEN | — | — |

### C11 Ask useful, non-anchored research questions

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C11-P | Can Brain perform it correctly? | 30 questions per goal from the owner's words. | Distinct, specific, cover means/buyers/price/channel/fulfilment/cash/legal; not anchored. | **FAIL** | 30Q: p06/p10 anchored on brokerage/dropshipping; p02 good. | HISTORICAL_FAILURE_DETECTED: the measurement procedure cited in the evidence recorded the failure on production or in a recorded probe | directionPrompt framing | RC3,RC5 |
| C11-R | Does the result reach every component that needs it? | Questions become research work. | Each question queued with a decision. | **FAIL** | Production executes ~6%. | HISTORICAL_FAILURE_DETECTED: the measurement procedure cited in the evidence recorded the failure on production or in a recorded probe | research queue | RC6 |
| C11-I | Does the result change later decisions correctly? | Answers change routes. | Yes. | **PASS** | 30Q: facts killed Upwork/Fiverr/dropship routes. | KNOWN_GOOD_ONLY: correct behaviour observed; no known-bad case run yet | proposer | — |
| C11-F | Does Brain recognise and recover when it fails? | Model fails to answer (timeout/unparsed). | Retried, salvaged. | **RECHECK** | Questions command salvages; production route path unchanged. | UNPROVEN | ask | RC1 |
| C11-X | Does it still work combined with the other capabilities? | Questions + owner means. | Ask how owner can be paid directly. | **FAIL** | p06. | CONTROLLED_FAILURE: re-introduced "reproduction: the owner's direct paid work never considered first" → tests/planningFailureMapWave1.test.ts failed naming RC5; unmutated code accepted | directionPrompt | RC5 |
| C11-M | Is a failure the model's own, or Brain's instructions/software? (model isolated on the identical input) | Control model on the question prompt. | Less anchored. | **RECHECK** | Not run on the question prompt; the model exam's evidence-interpretation errors (gpt-oss 61, Claude 1) predict the gap. | UNPROVEN | model | RC14 |

### C12 Prioritise follow-ups and stop when research cannot change the decision

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C12-P | Can Brain perform it correctly? | Follow-ups after findings. | Decision-bearing, not already answered. | **FAIL** | 30Q: 35/90 follow-ups already answered or no decision value; narrow. | HISTORICAL_FAILURE_DETECTED: the measurement procedure cited in the evidence recorded the failure on production or in a recorded probe | questions follow-up | RC5 |
| C12-R | Does the result reach every component that needs it? | Follow-up answers reach the planner. | Yes, ahead of older ones. | **FAIL** | Newest-first cap displaced key older facts (p10). | CONTROLLED_FAILURE: re-introduced "historical: newest-first slice crowding out other lanes" → tests/planningFailureMapWave1.test.ts failed naming RC4; unmutated code accepted | findingsOf | RC4 |
| C12-I | Does the result change later decisions correctly? | Follow-ups change the plan. | Yes when material. | **FAIL** | Final grades no better than round 1. | UNPROVEN | proposer | — |
| C12-F | Does Brain recognise and recover when it fails? | No answer found: stops? | Records and stops. | **PASS** | Workers recorded UNANSWERED honestly. | UNPROVEN | workers | — |
| C12-X | Does it still work combined with the other capabilities? | Follow-ups + selection. | Questions target the chosen strategy's weakest leg. | **RECHECK** | Partly (p02 insurance, seasonality). | UNPROVEN | — | — |

### C13 Search provider availability and capacity

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C13-P | Can Brain perform it correctly? | Searches answered per day. | Enough for planned questions. | **FAIL** | 785/1142 refused; Firecrawl 7/day; no keyed search. | UNPROVEN | sources/* | RC6 |
| C13-R | Does the result reach every component that needs it? | Results reach workers. | Yes. | **RECHECK** | p06 trace: searches answered (6) reached the free-lane worker and pages were read (3). / REVIEW 2: test-validity review: rests on one example, a field existing, or a contract — not a demonstration. | UNPROVEN | — | — |
| C13-I | Does the result change later decisions correctly? | Capacity allocated by decision value. | Yes. | **FAIL** | stall 2026-11-26: every queued research fragment sits at priority 9 (eval) or 8/6 by purpose, never by the decision its answer changes; 1,167 waiting. | HISTORICAL_FAILURE_DETECTED: the measurement procedure cited in the evidence recorded the failure on production or in a recorded probe | — | RC6 |
| C13-F | Does Brain recognise and recover when it fails? | Provider refuses: falls back. | Yes. | **RECHECK** | DDG lite/html fallback; still 69% refused. | UNPROVEN | sources | — |
| C13-X | Does it still work combined with the other capabilities? | Capacity under 18+ goals. | Shared fairly. | **RECHECK** | 585d3fb shares capacity; unmeasured. | UNPROVEN | — | — |

### C14 Research work executes (fragments complete)

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C14-P | Can Brain perform it correctly? | Fragments completed in 6 h. | >=80%. | **FAIL** | fm1126b: 0 research fragments, 0 work items, 0 claims for 30 fresh goals 1.5 h after creation (stall, items, judging probes). | HISTORICAL_FAILURE_DETECTED: the measurement procedure cited in the evidence recorded the failure on production or in a recorded probe | research coordinator | RC19 |
| C14-R | Does the result reach every component that needs it? | Completed fragments file claims. | Yes. | **FAIL** | fm1126b on dcc34fe: ideas judged, missions 0 — the launch window ranked paused and ended goals' price questions and rounds as goal work (launching probe 09:45Z). | HISTORICAL_FAILURE_DETECTED: the measurement procedure cited in the evidence recorded the failure on production or in a recorded probe | gate | RC20 |
| C14-I | Does the result change later decisions correctly? | Queue ordered by decision value. | Yes. | **FAIL** | The goal-idea queue is not ordered by live goal or decision value: cancelled and paused goals' ideas head it (judging probe 08:00Z). | CONTROLLED_FAILURE: re-introduced "historical: a cancelled run and paused goals held the head of the judge queue; 30 live goals waited" → tests/goalIdeasEachProjectsTurn.test.ts failed naming RC19; unmutated code accepted | — | RC19 |
| C14-F | Does Brain recognise and recover when it fails? | Fragment faults: retried elsewhere. | Yes. | **RECHECK** | #1018 class fixes; unmeasured here. | UNPROVEN | — | — |
| C14-X | Does it still work combined with the other capabilities? | Execution under contention with other goals. | Goal research not starved. | **FAIL** | 2,063 waiting beside 278 free slots. | UNPROVEN | — | RC6 |

### C15 Open and read the pages

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C15-P | Can Brain perform it correctly? | Pages read per page found. | High. | **FAIL** | Production 21%; session workers 70-80%. | HISTORICAL_FAILURE_DETECTED: the measurement procedure cited in the evidence recorded the failure on production or in a recorded probe | sources reader | RC6 |
| C15-R | Does the result reach every component that needs it? | Read text reaches extraction. | Yes. | **PASS** | p06 trace: pages read → 3 claims extracted. | KNOWN_GOOD_ONLY: correct behaviour observed; no known-bad case run yet | — | — |
| C15-I | Does the result change later decisions correctly? | Unreadable source marked unresolved, not rejected. | Yes. | **RECHECK** | Retrieval state contract. / REVIEW 2: test-validity review: rests on one example, a field existing, or a contract — not a demonstration. | UNPROVEN | gate | — |
| C15-F | Does Brain recognise and recover when it fails? | Blocked site: alternative source. | Yes. | **RECHECK** | Workers did; production unknown. | UNPROVEN | — | — |
| C15-X | Does it still work combined with the other capabilities? | Reading + capacity. | Within credits. | **FAIL** | Firecrawl 15/day. | UNPROVEN | — | RC6 |

### C16 Extract claims with exact citations

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C16-P | Can Brain perform it correctly? | Claims carry URL, quote, date, lane. | Yes. | **PASS** | 30Q: 100% of facts had URL+quote. | KNOWN_GOOD_ONLY: correct behaviour observed; no known-bad case run yet | workers/gate | — |
| C16-R | Does the result reach every component that needs it? | Claims reach findings. | Yes. | **PASS** | p06 trace: accepted claims appear in findings_now and were shown to a route ask (findingsShown 1). | KNOWN_GOOD_ONLY: correct behaviour observed; no known-bad case run yet | — | — |
| C16-I | Does the result change later decisions correctly? | Lane decides which figure a fact can ground. | Yes. | **PASS** | GROUND_LANES (9fb993c). | UNPROVEN | groundsOf | — |
| C16-F | Does Brain recognise and recover when it fails? | Claim without source rejected. | Yes. | **RECHECK** | Gate contract. / REVIEW 2: test-validity review: rests on one example, a field existing, or a contract — not a demonstration. | UNPROVEN | gate | — |
| C16-X | Does it still work combined with the other capabilities? | Extraction + verification. | Yes. | **PASS** | stall rejections: extraction then verification ("source does not directly support" 12 rejected). | KNOWN_GOOD_ONLY: correct behaviour observed; no known-bad case run yet | — | — |

### C17 Verify that the evidence supports the claim

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C17-P | Can Brain perform it correctly? | Quote present in the re-read page. | >=85%. | **FAIL** | 30Q: 329/428 verified (77%); remainder held back, none delivered. / REVIEW 2: test-validity review: the evidence cited contradicts PASS. | HISTORICAL_FAILURE_DETECTED: the measurement procedure cited in the evidence recorded the failure on production or in a recorded probe | tools/verify.py (eval) / gate | — |
| C17-R | Does the result reach every component that needs it? | Only verified claims delivered. | Yes. | **RECHECK** | True in eval; production gate checks source, not quote presence. | UNPROVEN | gate | — |
| C17-I | Does the result change later decisions correctly? | Unverified claim cannot ground a figure. | Yes. | **PASS** | groundsOf cites only shown findings of a fitting lane (tests); production gate rejects unsupported claims before they become findings. | KNOWN_GOOD_ONLY: correct behaviour observed; no known-bad case run yet | — | — |
| C17-F | Does Brain recognise and recover when it fails? | Paraphrased quote detected. | Yes. | **PASS** | Verifier caught 32 NOT_FOUND. | UNPROVEN | verify | — |
| C17-X | Does it still work combined with the other capabilities? | Verification + capacity. | Cheap. | **RECHECK** | Re-read cache. / REVIEW 2: test-validity review: rests on one example, a field existing, or a contract — not a demonstration. | UNPROVEN | — | — |

### C18 Type the evidence (what it establishes: lane, scope exact/comparable, place, date)

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C18-P | Can Brain perform it correctly? | Lanes assigned correctly. | Yes. | **RECHECK** | Workers assigned lanes; not audited. | UNPROVEN | workers | — |
| C18-R | Does the result reach every component that needs it? | Lane reaches groundsOf. | Yes. | **PASS** | 9fb993c. | UNPROVEN | groundsOf | — |
| C18-I | Does the result change later decisions correctly? | Mis-scoped fact rejected as grounds. | Yes. | **FAIL** | GROUND_LANES test. / REVIEW 2: test-validity review: the evidence cited contradicts PASS. | UNPROVEN | groundsOf | — |
| C18-F | Does Brain recognise and recover when it fails? | Consumer fact cited for B2B channel: caught? | Yes. | **FAIL** | p10 grader: consumer fact cited for B2B channel. | HISTORICAL_FAILURE_DETECTED: the measurement procedure cited in the evidence recorded the failure on production or in a recorded probe | groundsOf | — |
| C18-X | Does it still work combined with the other capabilities? | Typing + critic. | Critic checks scope. | **UNKNOWN** | — | UNPROVEN | — | — |

### C19 Combine facts and detect contradictions

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C19-P | Can Brain perform it correctly? | Route contradicted by a shown fact is dropped. | Yes. | **RECHECK** | Upwork/Fiverr payout facts killed brokerage (correct); p10 CPA facts ignored by proposer. | UNPROVEN | critic/proposer | — |
| C19-R | Does the result reach every component that needs it? | Knowledge contradictions reach planning. | Yes. | **FAIL** | Display only (integration diag). | UNPROVEN | knowledge | RC7 |
| C19-I | Does the result change later decisions correctly? | Refuted claims never shown. | Yes. | **RECHECK** | projectEvidenceClaims ignores contradiction_state (code). / REVIEW 2: test-validity review: the evidence describes code since changed; the repaired behaviour must be re-demonstrated on production. | CONTROLLED_FAILURE: re-introduced "reproduction: a refuted claim shown as a finding (the SQL predicate is proven separately in code; no DB test yet)" → tests/planningFailureMapWave1.test.ts failed naming RC4; unmutated code accepted | repos/research.ts | RC4 |
| C19-F | Does Brain recognise and recover when it fails? | Contradiction resolved by better source. | Yes. | **UNKNOWN** | — | UNPROVEN | — | — |
| C19-X | Does it still work combined with the other capabilities? | Contradiction + selection. | Yes. | **UNKNOWN** | — | UNPROVEN | — | — |

### C20 Knowledge library matching (buyer identity, counts)

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C20-P | Can Brain perform it correctly? | Fragment buyers linked to NAICS counts? | Never as established. | **FAIL** | Integration diag. | UNPROVEN | knowledge/apply.ts | RC10 |
| C20-R | Does the result reach every component that needs it? | Counts reach arrangements. | Only real segments. | **FAIL** | Integration diagnosis: 80 buyers linked to Census counts reach arrangement buyer counts. / REVIEW 2: test-validity review: the evidence cited contradicts PASS. | HISTORICAL_FAILURE_DETECTED: the measurement procedure cited in the evidence recorded the failure on production or in a recorded probe | — | — |
| C20-I | Does the result change later decisions correctly? | A false count redirects research. | No. | **FAIL** | Integration diagnosis: a wrong link reads "buyers established … the next research round asks for conversion". | HISTORICAL_FAILURE_DETECTED: the measurement procedure cited in the evidence recorded the failure on production or in a recorded probe | — | RC10 |
| C20-F | Does Brain recognise and recover when it fails? | Mismatch detected. | Yes. | **FAIL** | None. | UNPROVEN | — | RC10 |
| C20-X | Does it still work combined with the other capabilities? | Library + route proposer. | Library facts available to routes. | **FAIL** | Integration diagnosis: the knowledge library feeds arrangements only; route asks never read it. | HISTORICAL_FAILURE_DETECTED: the measurement procedure cited in the evidence recorded the failure on production or in a recorded probe | — | RC10 |

### C21 Deliver verified findings into the proposer's reasoning input

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C21-P | Can Brain perform it correctly? | Findings shown vs verified. | All distinct verified, or a relevance-chosen set covering every ground field. | **RECHECK** | 40/111, 40/111, 40/135. / REVIEW 2: test-validity review: the evidence describes code since changed; the repaired behaviour must be re-demonstrated on production. | CONTROLLED_FAILURE: re-introduced "historical: the 40-finding cap" → tests/planningFailureMapWave1.test.ts failed naming RC4; unmutated code accepted | findingsOf | RC4 |
| C21-R | Does the result reach every component that needs it? | Findings reach the critic too. | Yes. | **PASS** | critiquePrompt includes findings. | UNPROVEN | critiquePrompt | — |
| C21-I | Does the result change later decisions correctly? | Shown findings used correctly. | Yes. | **FAIL** | 8/12 D. | UNPROVEN | proposer | RC8 |
| C21-F | Does Brain recognise and recover when it fails? | Prompt too long / truncated. | Budgeted, not silently cut. | **RECHECK** | Prompts 35 KB ok. | UNPROVEN | — | — |
| C21-X | Does it still work combined with the other capabilities? | Delivery + dedupe + refuted filter. | No verified finding lost. | **RECHECK** | 160-char dedupe dropped 6/9. / REVIEW 2: test-validity review: the evidence describes code since changed; the repaired behaviour must be re-demonstrated on production. | CONTROLLED_FAILURE: re-introduced "historical: near-duplicates judged on the first 160 characters" → tests/planningFailureMapWave1.test.ts failed naming RC4; unmutated code accepted | findingsOf | RC4 |

### C22 Deliver findings and conclusions to other faculties (constructor, committee, dives, report, operator)

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C22-P | Can Brain perform it correctly? | Constructor reads research. | Yes. | **FAIL** | 11-17 F2 (code). | UNPROVEN | goalScenario | RC7 |
| C22-R | Does the result reach every component that needs it? | Committee questions answered. | Yes. | **FAIL** | answeredBy [] (production). | HISTORICAL_FAILURE_DETECTED: the measurement procedure cited in the evidence recorded the failure on production or in a recorded probe | committee | RC7 |
| C22-I | Does the result change later decisions correctly? | Plan verdict reaches route ask. | Yes. | **FAIL** | heldTitles only. | UNPROVEN | plan.ts:5877 | RC7 |
| C22-F | Does Brain recognise and recover when it fails? | Missed handoff detected. | Yes. | **FAIL** | Report sees repetition; operator does not act. | UNPROVEN | — | RC7 |
| C22-X | Does it still work combined with the other capabilities? | All faculties on one record. | Yes. | **FAIL** | Integration diagnosis §4.1: no shared per-goal working state. | HISTORICAL_FAILURE_DETECTED: the measurement procedure cited in the evidence recorded the failure on production or in a recorded probe | — | RC7 |

### C23 A model turn returns a valid answer (no empty/timeout/unparseable fall-through)

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C23-P | Can Brain perform it correctly? | Primary model answers route asks. | >=95% valid. | **FAIL** | gpt-oss 6/12 empty. | CONTROLLED_FAILURE: re-introduced "historical: non-streamed turns cut by the 100 s proxy idle (524)" → tests/chatStreaming.test.ts failed naming RC1; unmutated code accepted | ask/operatorChats | RC1 |
| C23-R | Does the result reach every component that needs it? | Valid answer used; failed answer retried. | Yes. | **FAIL** | Falls to weaker model. | CONTROLLED_FAILURE: re-introduced "historical: 2,500–4,000 token budgets exhausted by hidden reasoning" → tests/planningFailureMapWave2.test.ts failed naming RC16; unmutated code accepted | ask | RC16 |
| C23-I | Does the result change later decisions correctly? | Fallback quality equals primary. | Yes. | **FAIL** | Fallback invented refusals. | CONTROLLED_FAILURE: re-introduced "reproduction: a cut stream returned as a complete answer" → tests/chatStreaming.test.ts failed naming RC1; unmutated code accepted | — | RC1 |
| C23-F | Does Brain recognise and recover when it fails? | Empty content treated as error and retried with larger budget. | Yes. | **RECHECK** | Code: error null on empty. / REVIEW 2: test-validity review: the evidence describes code since changed; the repaired behaviour must be re-demonstrated on production. | CONTROLLED_FAILURE: re-introduced "historical: an empty reply counted as an answer path with no retry" → tests/planningFailureMapWave1.test.ts failed naming RC1; unmutated code accepted | ask | RC1 |
| C23-X | Does it still work combined with the other capabilities? | Model answers under concurrent load. | Yes. | **RECHECK** | Capacity 2026-11-26: GPU 8/16 slots with "errors acceptable"; route-ask behaviour under that load unmeasured. | UNPROVEN | — | — |
| C23-M | Is a failure the model's own, or Brain's instructions/software? (model isolated on the identical input) | Same prompt, larger max_tokens. | Answers. | **FAIL** | Model exam: re-asked with streaming, gpt-oss served 30/30; the empty replies are the proxy idle cut, not the model (repaired W1j). / REVIEW 2: root-cause challenge + validity review: empty replies arrive in 47–85 s (< the 100 s cut) — they are the token budget, not the proxy; the proxy explains the 524s only. | HISTORICAL_FAILURE_DETECTED: the measurement procedure cited in the evidence recorded the failure on production or in a recorded probe | model | RC1 |

### C24 Propose routes that use the evidence correctly

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C24-P | Can Brain perform it correctly? | Routes cite findings that state the figure. | Yes. | **FAIL** | Mis-citations (p10 F2 for price; consumer fact for B2B). | UNPROVEN | proposer | RC8 |
| C24-R | Does the result reach every component that needs it? | Proposed routes reach critic and plan. | Yes. | **PASS** | 30Q probes: every parsed route was critiqued (critique records per route). | KNOWN_GOOD_ONLY: correct behaviour observed; no known-bad case run yet | — | — |
| C24-I | Does the result change later decisions correctly? | Evidence changes route choice. | Yes. | **RECHECK** | Partly (p02 prices; p06 escrow). | UNPROVEN | — | — |
| C24-F | Does Brain recognise and recover when it fails? | Route contradicted by a fact: dropped by code or critic. | Yes. | **RECHECK** | 30Q p06 R1all: Upwork route contradicted by payout-hold facts dropped by the critic, correctly (grader). / REVIEW 2: test-validity review: rests on one example, a field existing, or a contract — not a demonstration. | UNPROVEN | — | — |
| C24-X | Does it still work combined with the other capabilities? | Evidence + limits + owner means. | All three respected. | **FAIL** | p06 invented subcontractor. | UNPROVEN | proposer | RC8 |
| C24-M | Is a failure the model's own, or Brain's instructions/software? (model isolated on the identical input) | Control model on identical prompt. | Better use. | **FAIL** | Model exam evidence interpretation: gpt-oss 1.00/2, Claude 1.93/2; 30Q control 0/3 usable but best evidence hygiene. | HISTORICAL_FAILURE_DETECTED: the measurement procedure cited in the evidence recorded the failure on production or in a recorded probe | model | RC14 |

### C25 Quantitative and causal economics (price x volume, CAC vs capital, margin, hours, reach)

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C25-P | Can Brain perform it correctly? | Route reach computed vs target. | Correct. | **FAIL** | 445 sales from $3k at $39 CPA. | CONTROLLED_FAILURE: re-introduced "historical: the 445-beanies-from-$3,000 route accepted" → tests/planningFailureMapWave1.test.ts failed naming RC8; unmutated code accepted | parseRoutes | RC17,RC8 |
| C25-R | Does the result reach every component that needs it? | Computed figures shown to critic and owner. | Yes. | **RECHECK** | Only hours computed. / REVIEW 2: test-validity review: the evidence describes code since changed; the repaired behaviour must be re-demonstrated on production. | CONTROLLED_FAILURE: re-introduced "historical: the critic never shown computed economics" → tests/planningFailureMapWave1.test.ts failed naming RC8; unmutated code accepted | — | RC8 |
| C25-I | Does the result change later decisions correctly? | Under-reaching route flagged/fixed. | Yes. | **RECHECK** | W1c: economics line + ACQUISITION refusal (tests); production pending. | UNPROVEN | — | — |
| C25-F | Does Brain recognise and recover when it fails? | Arithmetic error detected. | Yes. | **RECHECK** | None. / REVIEW 2: test-validity review: the evidence describes code since changed; the repaired behaviour must be re-demonstrated on production. | UNPROVEN | — | RC8 |
| C25-X | Does it still work combined with the other capabilities? | Economics + timing + capital. | Consistent. | **UNKNOWN** | — | CONTROLLED_FAILURE: re-introduced "reproduction: buyer acquisition beyond the capital accepted" → tests/planningFailureMapWave1.test.ts failed naming RC8; unmutated code accepted | — | — |
| C25-M | Is a failure the model's own, or Brain's instructions/software? (model isolated on the identical input) | Control on arithmetic. | Correct. | **FAIL** | Model exam reasoning correctness: gpt-oss 1.13/2, fallback 0.23, Claude 1.97; mechanical key numbers gpt-oss 7/9. | HISTORICAL_FAILURE_DETECTED: the measurement procedure cited in the evidence recorded the failure on production or in a recorded probe | model | RC14 |

### C26 Payment terms and time to collected cash

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C26-P | Can Brain perform it correctly? | Collected-cash day computed from payout facts. | Correct. | **FAIL** | p06 routes ignored 10/14-day holds; critic misread net-30. | UNPROVEN | proposer/critic | RC2 |
| C26-R | Does the result reach every component that needs it? | Payout facts shown. | Yes. | **RECHECK** | 30Q all-findings arm: payout facts shown; under the old 40 cap they were cut. Cap raised (W1e); production recheck pending. | UNPROVEN | — | — |
| C26-I | Does the result change later decisions correctly? | Settlement fact rules routes in/out. | Yes. | **RECHECK** | Correct kills on p06. | UNPROVEN | — | — |
| C26-F | Does Brain recognise and recover when it fails? | Misread timing corrected. | Yes. | **RECHECK** | W1b: a disputed timing is a repair the code re-checks (tests); production pending. | CONTROLLED_FAILURE: re-introduced "historical: a disputed timing dropped instead of re-checked" → tests/planningFailureMapWave1.test.ts failed naming RC2; unmutated code accepted | — | RC2 |
| C26-X | Does it still work combined with the other capabilities? | Timing + window + platform. | Yes. | **UNKNOWN** | — | UNPROVEN | — | RC2 |

### C27 Buyer discovery and acquisition channel reasoning

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C27-P | Can Brain perform it correctly? | Channel can produce needed buyers in window on budget. | Yes. | **FAIL** | Passive channels (ARMLS listing), cold email at 0.45% for 6 buyers in 7 days. | UNPROVEN | proposer | RC8 |
| C27-R | Does the result reach every component that needs it? | Channel cost facts shown. | Yes. | **FAIL** | Cut by cap (p02 FB CPL, p10 cold-email cost). | UNPROVEN | findingsOf | RC4 |
| C27-I | Does the result change later decisions correctly? | Channel cost changes volume. | Yes. | **UNKNOWN** | — | UNPROVEN | — | RC8 |
| C27-F | Does Brain recognise and recover when it fails? | Channel inadequate: replaced. | Yes. | **UNKNOWN** | — | UNPROVEN | — | — |
| C27-X | Does it still work combined with the other capabilities? | Channel + capital + hours. | Yes. | **UNKNOWN** | — | UNPROVEN | — | RC8 |

### C28 Fulfilment and subcontractor reasoning

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C28-P | Can Brain perform it correctly? | Named fulfiller with evidenced cost. | Yes. | **FAIL** | Invented $10/h VA; unnamed subcontractor. | UNPROVEN | proposer | RC8 |
| C28-R | Does the result reach every component that needs it? | Fulfiller facts shown. | Yes. | **RECHECK** | As C26-R, for fulfiller facts. | UNPROVEN | — | — |
| C28-I | Does the result change later decisions correctly? | Fulfiller cost sets margin. | Yes. | **RECHECK** | MARGIN rule worked (p06). / REVIEW 2: test-validity review: rests on one example, a field existing, or a contract — not a demonstration. | UNPROVEN | parseRoutes | — |
| C28-F | Does Brain recognise and recover when it fails? | No fulfiller: route repaired or dropped. | Yes. | **UNKNOWN** | — | UNPROVEN | — | — |
| C28-X | Does it still work combined with the other capabilities? | Fulfilment + zero owner hours. | Selling/managing also delegated. | **FAIL** | p10 nobody takes sales calls. | UNPROVEN | proposer | RC8 |

### C29 Legal and platform-terms reasoning

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C29-P | Can Brain perform it correctly? | Surveying licence, platform rules, business licence. | Correct. | **PASS** | p02 survey law flagged; Marketplace services ban found. | UNPROVEN | critic | — |
| C29-R | Does the result reach every component that needs it? | Legal facts reach critic. | Yes. | **PASS** | 30Q: the critic cited A.R.S. 32-101 survey law from the findings. | KNOWN_GOOD_ONLY: correct behaviour observed; no known-bad case run yet | — | — |
| C29-I | Does the result change later decisions correctly? | Legal fact drops route. | Yes. | **RECHECK** | Construction surveying dropped. / REVIEW 2: test-validity review: rests on one example, a field existing, or a contract — not a demonstration. | UNPROVEN | — | — |
| C29-F | Does Brain recognise and recover when it fails? | Over-strict legal veto (license cost as capital breach). | Distinguish payable-from-proceeds. | **FAIL** | p06 $73 licence used to drop. | UNPROVEN | critic | RC2 |
| C29-X | Does it still work combined with the other capabilities? | Legal + capital + timing. | Yes. | **UNKNOWN** | — | UNPROVEN | — | RC2 |

### C30 Parser and mechanical validation (correct rejections; repair, not loss)

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C30-P | Can Brain perform it correctly? | Rejections correct. | Yes. | **RECHECK** | Hours/margin correct; OWNER_FIT missing-field incorrect. | UNPROVEN | parseRoutes | RC9 |
| C30-R | Does the result reach every component that needs it? | Rejections recorded. | Yes. | **PASS** | Route events record rejectedByRule; probe parsed.rejected lists rule and reason. | KNOWN_GOOD_ONLY: correct behaviour observed; no known-bad case run yet | — | — |
| C30-I | Does the result change later decisions correctly? | Rejected route repaired once. | Yes. | **FAIL** | No repair. | UNPROVEN | — | RC9 |
| C30-F | Does Brain recognise and recover when it fails? | Whole output lost to a field rule. | Never. | **RECHECK** | p10 R1 all. / REVIEW 2: test-validity review: the evidence describes code since changed; the repaired behaviour must be re-demonstrated on production. | CONTROLLED_FAILURE: re-introduced "historical: a missing owner-fit sentence loses the route" → tests/planningFailureMapWave1.test.ts failed naming RC9; unmutated code accepted | — | RC9 |
| C30-X | Does it still work combined with the other capabilities? | Parser + critic + replacement. | Yes. | **UNKNOWN** | — | UNPROVEN | — | — |

### C31 Criticise correctly (drop only on verified grounds)

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C31-P | Can Brain perform it correctly? | Critic drops only routes that truly fail. | Yes. | **FAIL** | >=4 false drops; 14/18 dropped. | UNPROVEN | critic | RC17,RC2 |
| C31-R | Does the result reach every component that needs it? | Critic sees findings and computed figures. | Yes. | **RECHECK** | No computed figures. / REVIEW 2: test-validity review: the evidence describes code since changed; the repaired behaviour must be re-demonstrated on production. | UNPROVEN | — | RC8 |
| C31-I | Does the result change later decisions correctly? | A drop leads to a better route. | Yes. | **FAIL** | Outputs end with nothing. | UNPROVEN | — | RC2 |
| C31-F | Does Brain recognise and recover when it fails? | False drop detected and overruled. | Yes. | **RECHECK** | None. / REVIEW 2: test-validity review: the evidence describes code since changed; the repaired behaviour must be re-demonstrated on production. | CONTROLLED_FAILURE: re-introduced "historical: a WINDOW-only drop removes the route (net 30 read as outside 60 days)" → tests/planningFailureMapWave1.test.ts failed naming RC2; unmutated code accepted | — | RC2 |
| C31-X | Does it still work combined with the other capabilities? | Critic + parser + replacement. | At least one usable route survives when one exists. | **FAIL** | 9/12 outputs no plan. | CONTROLLED_FAILURE: re-introduced "reproduction: a route kept against the critic outranks routes the critic kept" → tests/planningFailureMapWave1.test.ts failed naming RC2; unmutated code accepted | — | RC2 |
| C31-M | Is a failure the model's own, or Brain's instructions/software? (model isolated on the identical input) | Control model as critic on the same routes. | Fewer false drops. | **RECHECK** | Not run as critic; exam constraint and evidence errors predict false drops from open models. | UNPROVEN | model | RC14 |

### C32 Revise after critique (replacement routes)

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C32-P | Can Brain perform it correctly? | Replacement ask runs when nothing survives. | Yes. | **RECHECK** | Code: critiqueAndRevise asks replacements when fewer than ROUTES_MIN_SURVIVING survive; not exercised by the eval probe, production effect unmeasured. | UNPROVEN | critiqueAndRevise | — |
| C32-R | Does the result reach every component that needs it? | Replacements critiqued. | Yes. | **RECHECK** | Code: replacements are parsed and ranked after kept routes, not critiqued again. | UNPROVEN | — | — |
| C32-I | Does the result change later decisions correctly? | Replacement better. | Yes. | **UNKNOWN** | — | UNPROVEN | — | — |
| C32-F | Does Brain recognise and recover when it fails? | Replacement fails: recorded. | Yes. | **PASS** | Code + event detail: replacement failures are named in critique.reason. | UNPROVEN | — | — |
| C32-X | Does it still work combined with the other capabilities? | Revision + economics. | Yes. | **UNKNOWN** | — | UNPROVEN | — | — |

### C33 Compare and select one strategy

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C33-P | Can Brain perform it correctly? | Ranking follows computed economics and evidence. | Yes. | **FAIL** | Critic scores; no economics. | UNPROVEN | applyCritique | RC8 |
| C33-R | Does the result reach every component that needs it? | Chosen strategy read by planner/committee/report. | Yes. | **FAIL** | Integration diagnosis: four different "best" strategies in one production reading. | HISTORICAL_FAILURE_DETECTED: the measurement procedure cited in the evidence recorded the failure on production or in a recorded probe | — | RC11,RC13 |
| C33-I | Does the result change later decisions correctly? | Selection changes plan reading. | Yes. | **FAIL** | Same: the chosen route does not decide the plan reading (fm1126a f01 plan built from constructed arrangements). | HISTORICAL_FAILURE_DETECTED: the measurement procedure cited in the evidence recorded the failure on production or in a recorded probe | — | RC11,RC13 |
| C33-F | Does Brain recognise and recover when it fails? | Tie or none: says so. | Yes. | **PASS** | fm1126a f01 read: "NOT ACCEPTED: no candidate plan yet" — says so. | KNOWN_GOOD_ONLY: correct behaviour observed; no known-bad case run yet | — | — |
| C33-X | Does it still work combined with the other capabilities? | Selection across generators. | One arbiter. | **FAIL** | RC11/RC13: generators are not arbitrated. | UNPROVEN | — | RC11,RC13 |

### C34 Identify risks and invalid assumptions

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C34-P | Can Brain perform it correctly? | Assumptions named per route. | Yes. | **RECHECK** | routes carry assumptions. / REVIEW 2: test-validity review: rests on one example, a field existing, or a contract — not a demonstration. | UNPROVEN | proposer | — |
| C34-R | Does the result reach every component that needs it? | Assumptions become research. | Yes. | **RECHECK** | searches field exists; execution starved. | UNPROVEN | — | RC6 |
| C34-I | Does the result change later decisions correctly? | Disproved assumption drops/repairs route. | Yes. | **UNKNOWN** | — | UNPROVEN | — | — |
| C34-F | Does Brain recognise and recover when it fails? | Hidden assumption surfaced by critic. | Yes. | **UNKNOWN** | — | UNPROVEN | — | — |
| C34-X | Does it still work combined with the other capabilities? | Risk + economics. | Sensitivity shown. | **UNKNOWN** | — | UNPROVEN | — | RC8 |

### C35 Know when a plan is ready (and when more research is needed)

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C35-P | Can Brain perform it correctly? | Readiness of a research-backed plan. | Reachable. | **FAIL** | Acceptance unattainable by research (11-17 F1). | UNPROVEN | judgeAcceptance | RC12 |
| C35-R | Does the result reach every component that needs it? | Readiness shown to owner. | Yes. | **RECHECK** | fm1126a f01 read: report lines and acceptance sentence shown. / REVIEW 2: test-validity review: rests on one example, a field existing, or a contract — not a demonstration. | UNPROVEN | — | — |
| C35-I | Does the result change later decisions correctly? | Not-ready names the next research. | Yes. | **RECHECK** | Plan "missing" lists exist. | UNPROVEN | plan.ts | — |
| C35-F | Does Brain recognise and recover when it fails? | Stalled readiness detected. | Yes. | **FAIL** | Report sees 12-hour repetition; nothing acts. | UNPROVEN | — | RC7 |
| C35-X | Does it still work combined with the other capabilities? | Readiness + committee. | Agree. | **UNKNOWN** | — | UNPROVEN | — | — |

### C36 Convert the chosen strategy into a complete executable plan

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C36-P | Can Brain perform it correctly? | Route → steps with owners, dates, costs, first action. | Executable tomorrow. | **FAIL** | Model exam: complete executable plan Claude 4/4, gpt-oss 0/4, Qwen 0/4. Production fm1126a f01: the owner's plan is research steps on generic constructed arrangements. | HISTORICAL_FAILURE_DETECTED: the measurement procedure cited in the evidence recorded the failure on production or in a recorded probe | goals/plan.ts steps; route→plan | RC14,RC13 |
| C36-R | Does the result reach every component that needs it? | Steps reach the owner view. | Yes. | **RECHECK** | fm1126a f01 read: steps reach the owner view (their content fails C36-P). / REVIEW 2: test-validity review: rests on one example, a field existing, or a contract — not a demonstration. | UNPROVEN | — | — |
| C36-I | Does the result change later decisions correctly? | Step results update the plan. | Yes. | **UNKNOWN** | — | UNPROVEN | — | — |
| C36-F | Does Brain recognise and recover when it fails? | Step blocked: replanned. | Yes. | **UNKNOWN** | — | UNPROVEN | — | — |
| C36-X | Does it still work combined with the other capabilities? | Plan + limits + economics. | Consistent. | **UNKNOWN** | — | UNPROVEN | — | — |

### C37 Learn from previous findings and failures

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C37-P | Can Brain perform it correctly? | Rethink/calibration lessons recorded. | Yes. | **RECHECK** | operator_learnings rows. / REVIEW 2: test-validity review: rests on one example, a field existing, or a contract — not a demonstration. | UNPROVEN | routeProposal:1911 | — |
| C37-R | Does the result reach every component that needs it? | Lessons read by the next ask. | Yes. | **RECHECK** | No reader. / REVIEW 2: test-validity review: the evidence describes code since changed; the repaired behaviour must be re-demonstrated on production. | UNPROVEN | routeContext | RC7 |
| C37-I | Does the result change later decisions correctly? | A lesson changes the next ask. | Yes. | **RECHECK** | W1h: rethinks of earlier asks are now read (code); production effect pending. | UNPROVEN | — | RC7 |
| C37-F | Does Brain recognise and recover when it fails? | Wrong lesson corrected. | Yes. | **UNKNOWN** | — | UNPROVEN | — | — |
| C37-X | Does it still work combined with the other capabilities? | Lessons across goals. | Transfer. | **UNKNOWN** | — | UNPROVEN | — | — |

### C38 Adapt when circumstances change (owner change, new evidence, refutation)

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C38-P | Can Brain perform it correctly? | New findings trigger a re-ask. | Yes. | **PASS** | NEW_FINDINGS_FOR_REASK. | UNPROVEN | routeAskDue | — |
| C38-R | Does the result reach every component that needs it? | Owner change reaches prompts. | Yes. | **RECHECK** | planningEval update writes the owner's change into target resources read by routeContext (code); not exercised. | UNPROVEN | — | — |
| C38-I | Does the result change later decisions correctly? | Re-ask changes plan. | Yes. | **UNKNOWN** | — | UNPROVEN | — | — |
| C38-F | Does Brain recognise and recover when it fails? | Failed ask retried soon. | Yes. | **PASS** | ROUTE_RETRY_AFTER_FAILURE_MS 30 min. | UNPROVEN | — | — |
| C38-X | Does it still work combined with the other capabilities? | Adaptation + learning. | Yes. | **UNKNOWN** | — | UNPROVEN | — | — |

### C39 Recover from model, research and software failures

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C39-P | Can Brain perform it correctly? | Model failure → retry; research fault → requeue; parse fail → salvage. | Yes. | **FAIL** | Empty → weaker fallback; parse loss. | UNPROVEN | — | RC1 |
| C39-R | Does the result reach every component that needs it? | Failure recorded where the next faculty reads it. | Yes. | **PASS** | Route events record why an ask failed (NO_ANSWER reasons in trace route_asks). | KNOWN_GOOD_ONLY: correct behaviour observed; no known-bad case run yet | — | — |
| C39-I | Does the result change later decisions correctly? | Recovery restores the plan. | Yes. | **UNKNOWN** | — | UNPROVEN | — | RC1 |
| C39-F | Does Brain recognise and recover when it fails? | Repeated failure escalates. | Yes. | **RECHECK** | Report flags repetition. | UNPROVEN | — | — |
| C39-X | Does it still work combined with the other capabilities? | Concurrent failures. | Yes. | **UNKNOWN** | — | UNPROVEN | — | — |

### C40 Own the next step of every goal (no unowned step)

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C40-P | Can Brain perform it correctly? | Every live goal names an owner for its next step. | Yes. | **FAIL** | 4/6 "[NOBODY]". | UNPROVEN | goal tick | RC7 |
| C40-R | Does the result reach every component that needs it? | Owner acts. | Yes. | **FAIL** | Integration diagnosis: 4 of 6 live goals "[NOBODY] Brain judges each idea on its next pass". | HISTORICAL_FAILURE_DETECTED: the measurement procedure cited in the evidence recorded the failure on production or in a recorded probe | — | RC7 |
| C40-I | Does the result change later decisions correctly? | Action changes the plan. | Yes. | **UNKNOWN** | — | UNPROVEN | — | — |
| C40-F | Does Brain recognise and recover when it fails? | Idle goal detected. | Yes. | **RECHECK** | Watchdog exists. | UNPROVEN | — | — |
| C40-X | Does it still work combined with the other capabilities? | Orchestration + capacity. | Yes. | **UNKNOWN** | — | UNPROVEN | — | — |

### C41 Choose models by their measured results on this work

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C41-P | Can Brain perform it correctly? | Model fitness measured on route outcomes. | Yes. | **FAIL** | Report judges by tool-call success (operationsReport.ts:327). | UNPROVEN | operationsReport | RC1 |
| C41-R | Does the result reach every component that needs it? | Fitness changes routing. | Yes. | **FAIL** | Code: operationsReport.ts:327 judges model adequacy by tool-call success; no route-outcome measure changes routing. | UNPROVEN | — | RC1,RC14 |
| C41-I | Does the result change later decisions correctly? | Better model used when measured better. | Yes. | **FAIL** | Strong model inert (no key). | UNPROVEN | strongRouteModels | RC1 |
| C41-F | Does Brain recognise and recover when it fails? | A failing model is benched. | Yes. | **FAIL** | Code: the fallback (1/30 on the model exam) is never benched; challengerModels order is fixed. | CONTROLLED_FAILURE: re-introduced "historical: the 1/30 fallback proposed and critiqued its own routes" → tests/planningFailureMapWave2.test.ts failed naming RC17; unmutated code accepted | — | RC17,RC14 |
| C41-X | Does it still work combined with the other capabilities? | Model choice across faculties. | Yes. | **UNKNOWN** | — | UNPROVEN | — | — |

### C42 Present a usable plan to the owner

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C42-P | Can Brain perform it correctly? | Owner view shows chosen plan, economics, steps, risks. | Yes. | **FAIL** | fm1126b f01: the plan the owner is handed is still the constructed estimates ("No found opening is far enough along to model"), because the owner-fit directions have no research yet (RC19) and constructed arrangements read nothing of the owner (RC13). | HISTORICAL_FAILURE_DETECTED: the measurement procedure cited in the evidence recorded the failure on production or in a recorded probe | — | RC19,RC13 |
| C42-R | Does the result reach every component that needs it? | Plan reaches owner surface. | Yes. | **PASS** | fm1126a f01: the reading reaches the owner surface (read output). | KNOWN_GOOD_ONLY: correct behaviour observed; no known-bad case run yet | — | — |
| C42-I | Does the result change later decisions correctly? | Owner decisions reach the work. | Yes. | **UNKNOWN** | — | UNPROVEN | — | — |
| C42-F | Does Brain recognise and recover when it fails? | No plan: says why and what next. | Yes. | **RECHECK** | NOT_VIABLE/NEEDS_EVIDENCE readings. | UNPROVEN | — | — |
| C42-X | Does it still work combined with the other capabilities? | Output consistent with plan reading. | Yes. | **FAIL** | Four best answers. | UNPROVEN | — | RC11 |

### C43 Constructed arrangement generation and candidate selection (the non-LLM generator)

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C43-P | Can Brain perform it correctly? | For 10 goals, of the arrangements constructArrangements/graphPass enumerate, how many reach selectCandidates' window, and does the HELD/EVIDENCED/RANKED slotting admit a candidate whose only weakness is no prior evidence (cold-start)? | Correct as stated; failure observable as: Same leaders across consecutive readings with no new evidence; alternatives never enter the window; plan set shows <3 distinct legs while construction reports hundreds of candidates. | **UNKNOWN** | — | UNPROVEN | server/services/cash/construct.ts:constructArrangements (755), graphPass (1400), selectCandidates (1882), rotationWindow (1825) | — |
| C43-R | Does the result reach every component that needs it? | Does what Constructed arrangement generation and candidate selection (the non-LLM generator) decides reach the components downstream of server/services/cash/construct.ts? | Its result is read where the plan is decided. | **UNKNOWN** | — | UNPROVEN | server/services/cash/construct.ts:constructArrangements (755), graphPass (1400), selectCandidates (1882), rotationWindow (1825) | — |
| C43-I | Does the result change later decisions correctly? | Does a change in Constructed arrangement generation and candidate selection (the non-LLM generator)'s result change the plan reading? | The owner's plan changes when it does. | **UNKNOWN** | — | UNPROVEN | server/services/cash/construct.ts:constructArrangements (755), graphPass (1400), selectCandidates (1882), rotationWindow (1825) | — |
| C43-F | Does Brain recognise and recover when it fails? | When Constructed arrangement generation and candidate selection (the non-LLM generator) fails (throws, returns nothing, or returns a wrong answer), is it detected and recovered? | The failure is recorded and the plan does not silently rest on it. | **UNKNOWN** | — | UNPROVEN | server/services/cash/construct.ts:constructArrangements (755), graphPass (1400), selectCandidates (1882), rotationWindow (1825) | — |
| C43-X | Does it still work combined with the other capabilities? | Does Constructed arrangement generation and candidate selection (the non-LLM generator) still work combined with the route proposer, research and acceptance on a fresh goal? | The combined plan is consistent with it. | **UNKNOWN** | — | UNPROVEN | server/services/cash/construct.ts:constructArrangements (755), graphPass (1400), selectCandidates (1882), rotationWindow (1825) | — |

### C44 Arrangement de-duplication by signature

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C44-P | Can Brain perform it correctly? | Do arrangementSignature/canonicalSignature collapse genuinely different arrangements (or keep near-identical ones) because signatures are built from tokenized claim text? | Correct as stated; failure observable as: Hand-label 50 pairs collapsed/kept; measure false-merge and false-split rates; plan set dimensions (planSet.differingDimensions) show duplicates. | **UNKNOWN** | — | UNPROVEN | server/services/cash/construct.ts:arrangementSignature (613), canonicalSignature (1531); server/services/cash/goalScenario.ts:samePopulationOfferKey (1714), modelledTwinKey (1746) | — |
| C44-R | Does the result reach every component that needs it? | Does what Arrangement de-duplication by signature decides reach the components downstream of server/services/cash/construct.ts? | Its result is read where the plan is decided. | **UNKNOWN** | — | UNPROVEN | server/services/cash/construct.ts:arrangementSignature (613), canonicalSignature (1531); server/services/cash/goalScenario.ts:samePopulationOfferKey (1714), modelledTwinKey (1746) | — |
| C44-I | Does the result change later decisions correctly? | Does a change in Arrangement de-duplication by signature's result change the plan reading? | The owner's plan changes when it does. | **UNKNOWN** | — | UNPROVEN | server/services/cash/construct.ts:arrangementSignature (613), canonicalSignature (1531); server/services/cash/goalScenario.ts:samePopulationOfferKey (1714), modelledTwinKey (1746) | — |
| C44-F | Does Brain recognise and recover when it fails? | When Arrangement de-duplication by signature fails (throws, returns nothing, or returns a wrong answer), is it detected and recovered? | The failure is recorded and the plan does not silently rest on it. | **UNKNOWN** | — | UNPROVEN | server/services/cash/construct.ts:arrangementSignature (613), canonicalSignature (1531); server/services/cash/goalScenario.ts:samePopulationOfferKey (1714), modelledTwinKey (1746) | — |
| C44-X | Does it still work combined with the other capabilities? | Does Arrangement de-duplication by signature still work combined with the route proposer, research and acceptance on a fresh goal? | The combined plan is consistent with it. | **UNKNOWN** | — | UNPROVEN | server/services/cash/construct.ts:arrangementSignature (613), canonicalSignature (1531); server/services/cash/goalScenario.ts:samePopulationOfferKey (1714), modelledTwinKey (1746) | — |

### C45 Arrangement pre-screen in the quantitative model (deadline, capital, hours, loss per deal)

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C45-P | Can Brain perform it correctly? | Does screenArrangement/losesMoneyPerDeal/selectEstimatedArrangements cut arrangements for the right reason (settles after deadline, capital beyond limit, hours beyond owner's, every deal losing money), and are false cuts recoverable? | Correct as stated; failure observable as: Cut-reason histogram per goal; replay cut arrangements with corrected facts and see if any would have been adopted. | **UNKNOWN** | — | UNPROVEN | server/services/cash/goalScenario.ts:screenArrangement (1548), losesMoneyPerDeal (1514), selectEstimatedArrangements (1818), cutReasonClass (1691) | — |
| C45-R | Does the result reach every component that needs it? | Does what Arrangement pre-screen in the quantitative model (deadline, capital, hours, loss per deal) decides reach the components downstream of server/services/cash/goalScenario.ts? | Its result is read where the plan is decided. | **UNKNOWN** | — | UNPROVEN | server/services/cash/goalScenario.ts:screenArrangement (1548), losesMoneyPerDeal (1514), selectEstimatedArrangements (1818), cutReasonClass (1691) | — |
| C45-I | Does the result change later decisions correctly? | Does a change in Arrangement pre-screen in the quantitative model (deadline, capital, hours, loss per deal)'s result change the plan reading? | The owner's plan changes when it does. | **UNKNOWN** | — | UNPROVEN | server/services/cash/goalScenario.ts:screenArrangement (1548), losesMoneyPerDeal (1514), selectEstimatedArrangements (1818), cutReasonClass (1691) | — |
| C45-F | Does Brain recognise and recover when it fails? | When Arrangement pre-screen in the quantitative model (deadline, capital, hours, loss per deal) fails (throws, returns nothing, or returns a wrong answer), is it detected and recovered? | The failure is recorded and the plan does not silently rest on it. | **UNKNOWN** | — | UNPROVEN | server/services/cash/goalScenario.ts:screenArrangement (1548), losesMoneyPerDeal (1514), selectEstimatedArrangements (1818), cutReasonClass (1691) | — |
| C45-X | Does it still work combined with the other capabilities? | Does Arrangement pre-screen in the quantitative model (deadline, capital, hours, loss per deal) still work combined with the route proposer, research and acceptance on a fresh goal? | The combined plan is consistent with it. | **UNKNOWN** | — | UNPROVEN | server/services/cash/goalScenario.ts:screenArrangement (1548), losesMoneyPerDeal (1514), selectEstimatedArrangements (1818), cutReasonClass (1691) | — |

### C46 Opening economic model (price, volume, close, days-to-cash, owner hours, supply cost)

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C46-P | Can Brain perform it correctly? | For 20 openings, do modelOpportunity's inferred price/close/volume/daysToCash and ownerHoursOf/reconstructedSupplyCostPerDeal match a hand computation from the cited evidence, and does priceContradiction fire when evidence conflicts? | Correct as stated; failure observable as: Diff of modelled vs hand-computed inputs; openings whose daysToCash falls outside the window yet are counted toward reach. | **UNKNOWN** | — | UNPROVEN | server/services/cash/goalScenario.ts:modelOpportunity (2419), ownerHoursOf (876), structuralDaysToCash (1110), reconstructedSupplyCostPerDeal (1032), priceContradiction (2383) | — |
| C46-R | Does the result reach every component that needs it? | Does what Opening economic model (price, volume, close, days-to-cash, owner hours, supply cost) decides reach the components downstream of server/services/cash/goalScenario.ts? | Its result is read where the plan is decided. | **UNKNOWN** | — | UNPROVEN | server/services/cash/goalScenario.ts:modelOpportunity (2419), ownerHoursOf (876), structuralDaysToCash (1110), reconstructedSupplyCostPerDeal (1032), priceContradiction (2383) | — |
| C46-I | Does the result change later decisions correctly? | Does a change in Opening economic model (price, volume, close, days-to-cash, owner hours, supply cost)'s result change the plan reading? | The owner's plan changes when it does. | **UNKNOWN** | — | UNPROVEN | server/services/cash/goalScenario.ts:modelOpportunity (2419), ownerHoursOf (876), structuralDaysToCash (1110), reconstructedSupplyCostPerDeal (1032), priceContradiction (2383) | — |
| C46-F | Does Brain recognise and recover when it fails? | When Opening economic model (price, volume, close, days-to-cash, owner hours, supply cost) fails (throws, returns nothing, or returns a wrong answer), is it detected and recovered? | The failure is recorded and the plan does not silently rest on it. | **UNKNOWN** | — | UNPROVEN | server/services/cash/goalScenario.ts:modelOpportunity (2419), ownerHoursOf (876), structuralDaysToCash (1110), reconstructedSupplyCostPerDeal (1032), priceContradiction (2383) | — |
| C46-X | Does it still work combined with the other capabilities? | Does Opening economic model (price, volume, close, days-to-cash, owner hours, supply cost) still work combined with the route proposer, research and acceptance on a fresh goal? | The combined plan is consistent with it. | **UNKNOWN** | — | UNPROVEN | server/services/cash/goalScenario.ts:modelOpportunity (2419), ownerHoursOf (876), structuralDaysToCash (1110), reconstructedSupplyCostPerDeal (1032), priceContradiction (2383) | — |

### C47 Portfolio simulation and the conservative settled figure

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C47-P | Can Brain perform it correctly? | Does evaluateGoalPortfolio (demandWorlds, sampler, settlementOf, stakeCycles) plus conservative() and the without* lot filters produce a p10/p50 a human would derive, with capital tied up as peak (peakConcurrentLots) not sum and net targets net of cost? | Correct as stated; failure observable as: Hand-built 3-opening portfolios with known answers; compare p10/p50, capital held and owner hours; check net vs gross targets. | **UNKNOWN** | — | UNPROVEN | server/services/goals/portfolio.ts:evaluateGoalPortfolio (1315), demandWorlds (873); server/services/goals/plan.ts:conservative (1446), withoutSpareOwnerWork (1309), withoutLossMakingLots (1358), withoutSpareCapitalLots (1385), withoutUnestablishedLots (1418), peakConcurrentLots (1240) | — |
| C47-R | Does the result reach every component that needs it? | Does what Portfolio simulation and the conservative settled figure decides reach the components downstream of server/services/goals/portfolio.ts? | Its result is read where the plan is decided. | **UNKNOWN** | — | UNPROVEN | server/services/goals/portfolio.ts:evaluateGoalPortfolio (1315), demandWorlds (873); server/services/goals/plan.ts:conservative (1446), withoutSpareOwnerWork (1309), withoutLossMakingLots (1358), withoutSpareCapitalLots (1385), withoutUnestablishedLots (1418), peakConcurrentLots (1240) | — |
| C47-I | Does the result change later decisions correctly? | Does a change in Portfolio simulation and the conservative settled figure's result change the plan reading? | The owner's plan changes when it does. | **UNKNOWN** | — | UNPROVEN | server/services/goals/portfolio.ts:evaluateGoalPortfolio (1315), demandWorlds (873); server/services/goals/plan.ts:conservative (1446), withoutSpareOwnerWork (1309), withoutLossMakingLots (1358), withoutSpareCapitalLots (1385), withoutUnestablishedLots (1418), peakConcurrentLots (1240) | — |
| C47-F | Does Brain recognise and recover when it fails? | When Portfolio simulation and the conservative settled figure fails (throws, returns nothing, or returns a wrong answer), is it detected and recovered? | The failure is recorded and the plan does not silently rest on it. | **UNKNOWN** | — | UNPROVEN | server/services/goals/portfolio.ts:evaluateGoalPortfolio (1315), demandWorlds (873); server/services/goals/plan.ts:conservative (1446), withoutSpareOwnerWork (1309), withoutLossMakingLots (1358), withoutSpareCapitalLots (1385), withoutUnestablishedLots (1418), peakConcurrentLots (1240) | — |
| C47-X | Does it still work combined with the other capabilities? | Does Portfolio simulation and the conservative settled figure still work combined with the route proposer, research and acceptance on a fresh goal? | The combined plan is consistent with it. | **UNKNOWN** | — | UNPROVEN | server/services/goals/portfolio.ts:evaluateGoalPortfolio (1315), demandWorlds (873); server/services/goals/plan.ts:conservative (1446), withoutSpareOwnerWork (1309), withoutLossMakingLots (1358), withoutSpareCapitalLots (1385), withoutUnestablishedLots (1418), peakConcurrentLots (1240) | — |

### C48 Validation ladder / link checks per opening

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C48-P | Can Brain perform it correctly? | Does linkChecks/validationStage assign each opening the right missing link (demand, conversion, economics, settles, fulfilment, volume) and does nextTestFor name the cheapest test that would close it? | Correct as stated; failure observable as: Ladder counts (ladderOf) per goal vs hand labels; openings stuck at the same stage across readings. | **UNKNOWN** | — | UNPROVEN | server/services/goals/plan.ts:linkChecks (961), validationStage (872), currentDemandCheck (920), economicsState (1051), settlesState (1072), fulfilmentCheck (1093), volumeCheck (1116), nextTestFor (1185) | — |
| C48-R | Does the result reach every component that needs it? | Does what Validation ladder / link checks per opening decides reach the components downstream of server/services/goals/plan.ts? | Its result is read where the plan is decided. | **UNKNOWN** | — | UNPROVEN | server/services/goals/plan.ts:linkChecks (961), validationStage (872), currentDemandCheck (920), economicsState (1051), settlesState (1072), fulfilmentCheck (1093), volumeCheck (1116), nextTestFor (1185) | — |
| C48-I | Does the result change later decisions correctly? | Does a change in Validation ladder / link checks per opening's result change the plan reading? | The owner's plan changes when it does. | **UNKNOWN** | — | UNPROVEN | server/services/goals/plan.ts:linkChecks (961), validationStage (872), currentDemandCheck (920), economicsState (1051), settlesState (1072), fulfilmentCheck (1093), volumeCheck (1116), nextTestFor (1185) | — |
| C48-F | Does Brain recognise and recover when it fails? | When Validation ladder / link checks per opening fails (throws, returns nothing, or returns a wrong answer), is it detected and recovered? | The failure is recorded and the plan does not silently rest on it. | **UNKNOWN** | — | UNPROVEN | server/services/goals/plan.ts:linkChecks (961), validationStage (872), currentDemandCheck (920), economicsState (1051), settlesState (1072), fulfilmentCheck (1093), volumeCheck (1116), nextTestFor (1185) | — |
| C48-X | Does it still work combined with the other capabilities? | Does Validation ladder / link checks per opening still work combined with the route proposer, research and acceptance on a fresh goal? | The combined plan is consistent with it. | **UNKNOWN** | — | UNPROVEN | server/services/goals/plan.ts:linkChecks (961), validationStage (872), currentDemandCheck (920), economicsState (1051), settlesState (1072), fulfilmentCheck (1093), volumeCheck (1116), nextTestFor (1185) | — |

### C49 Acceptance judgement and its calibration

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C49-P | Can Brain perform it correctly? | Does judgeAcceptance's 90% condition use measuredPlanChance/planCalibration correctly, and is a candidate's coverage ever reported as a probability (§60)? | Correct as stated; failure observable as: Construct readings at 89%/91% p10 reach, with and without measured calibration rows; check status and sentence. | **UNKNOWN** | — | UNPROVEN | server/services/goals/plan.ts:judgeAcceptance (1648), measuredPlanChance (1557), planCalibration (2097), candidateSentence (1930), verdictOf (1921) | — |
| C49-R | Does the result reach every component that needs it? | Does what Acceptance judgement and its calibration decides reach the components downstream of server/services/goals/plan.ts? | Its result is read where the plan is decided. | **UNKNOWN** | — | UNPROVEN | server/services/goals/plan.ts:judgeAcceptance (1648), measuredPlanChance (1557), planCalibration (2097), candidateSentence (1930), verdictOf (1921) | — |
| C49-I | Does the result change later decisions correctly? | Does a change in Acceptance judgement and its calibration's result change the plan reading? | The owner's plan changes when it does. | **UNKNOWN** | — | UNPROVEN | server/services/goals/plan.ts:judgeAcceptance (1648), measuredPlanChance (1557), planCalibration (2097), candidateSentence (1930), verdictOf (1921) | — |
| C49-F | Does Brain recognise and recover when it fails? | When Acceptance judgement and its calibration fails (throws, returns nothing, or returns a wrong answer), is it detected and recovered? | The failure is recorded and the plan does not silently rest on it. | **UNKNOWN** | — | UNPROVEN | server/services/goals/plan.ts:judgeAcceptance (1648), measuredPlanChance (1557), planCalibration (2097), candidateSentence (1930), verdictOf (1921) | — |
| C49-X | Does it still work combined with the other capabilities? | Does Acceptance judgement and its calibration still work combined with the route proposer, research and acceptance on a fresh goal? | The combined plan is consistent with it. | **UNKNOWN** | — | UNPROVEN | server/services/goals/plan.ts:judgeAcceptance (1648), measuredPlanChance (1557), planCalibration (2097), candidateSentence (1930), verdictOf (1921) | — |

### C50 Plan reconstruction when short of requirement (§99)

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C50-P | Can Brain perform it correctly? | When acceptance is not ACCEPTED, does reconstructPlan (partitionOpenings, gatesOf, buildOperators, wilsonLower) find structural changes (price, volume, prepayment, fulfilment) that a human strategist would, and are its fulfilmentQuestions/volumeQuestionsFor turned into research? | Correct as stated; failure observable as: Reconstruction moves per goal, share that are measured vs assumed (Reconstruction.established), and whether their questions appear in the research queue. | **UNKNOWN** | — | UNPROVEN | server/services/goals/reconstruction.ts:reconstructPlan (333), partitionOpenings (309), gatesOf (798), prepaymentEligible (1174), fulfilmentQuestions (1197), volumeQuestionsFor (1268); server/services/goals/plan.ts:reconstructionFor (3274) | — |
| C50-R | Does the result reach every component that needs it? | Does what Plan reconstruction when short of requirement (§99) decides reach the components downstream of server/services/goals/reconstruction.ts? | Its result is read where the plan is decided. | **UNKNOWN** | — | UNPROVEN | server/services/goals/reconstruction.ts:reconstructPlan (333), partitionOpenings (309), gatesOf (798), prepaymentEligible (1174), fulfilmentQuestions (1197), volumeQuestionsFor (1268); server/services/goals/plan.ts:reconstructionFor (3274) | — |
| C50-I | Does the result change later decisions correctly? | Does a change in Plan reconstruction when short of requirement (§99)'s result change the plan reading? | The owner's plan changes when it does. | **UNKNOWN** | — | UNPROVEN | server/services/goals/reconstruction.ts:reconstructPlan (333), partitionOpenings (309), gatesOf (798), prepaymentEligible (1174), fulfilmentQuestions (1197), volumeQuestionsFor (1268); server/services/goals/plan.ts:reconstructionFor (3274) | — |
| C50-F | Does Brain recognise and recover when it fails? | When Plan reconstruction when short of requirement (§99) fails (throws, returns nothing, or returns a wrong answer), is it detected and recovered? | The failure is recorded and the plan does not silently rest on it. | **UNKNOWN** | — | UNPROVEN | server/services/goals/reconstruction.ts:reconstructPlan (333), partitionOpenings (309), gatesOf (798), prepaymentEligible (1174), fulfilmentQuestions (1197), volumeQuestionsFor (1268); server/services/goals/plan.ts:reconstructionFor (3274) | — |
| C50-X | Does it still work combined with the other capabilities? | Does Plan reconstruction when short of requirement (§99) still work combined with the route proposer, research and acceptance on a fresh goal? | The combined plan is consistent with it. | **UNKNOWN** | — | UNPROVEN | server/services/goals/reconstruction.ts:reconstructPlan (333), partitionOpenings (309), gatesOf (798), prepaymentEligible (1174), fulfilmentQuestions (1197), volumeQuestionsFor (1268); server/services/goals/plan.ts:reconstructionFor (3274) | — |

### C51 Evolutionary direction search (exploreDirections)

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C51-P | Can Brain perform it correctly? | Does exploreDirections (seedDirections, stanceQuotas, mutate, recombine, challengeProgram, scoreOf, diverseLeaders) converge on better and diverse structures than the baseline in its time budget, or return the seed when evaluations time out? | Correct as stated; failure observable as: Lift of leader over baseline per goal, number of generations run before DEFAULT_MAX_MS, leader diversity (distance) and challenged vs bare score gap. | **UNKNOWN** | — | UNPROVEN | server/services/goals/reasoning/directions.ts:exploreDirections (899), stanceQuotas (752), mutate (834), recombine (817), challengeProgram (622), scoreOf (891), diverseLeaders (1136) | — |
| C51-R | Does the result reach every component that needs it? | Does what Evolutionary direction search (exploreDirections) decides reach the components downstream of server/services/goals/reasoning/directions.ts? | Its result is read where the plan is decided. | **UNKNOWN** | — | UNPROVEN | server/services/goals/reasoning/directions.ts:exploreDirections (899), stanceQuotas (752), mutate (834), recombine (817), challengeProgram (622), scoreOf (891), diverseLeaders (1136) | — |
| C51-I | Does the result change later decisions correctly? | Does a change in Evolutionary direction search (exploreDirections)'s result change the plan reading? | The owner's plan changes when it does. | **UNKNOWN** | — | UNPROVEN | server/services/goals/reasoning/directions.ts:exploreDirections (899), stanceQuotas (752), mutate (834), recombine (817), challengeProgram (622), scoreOf (891), diverseLeaders (1136) | — |
| C51-F | Does Brain recognise and recover when it fails? | When Evolutionary direction search (exploreDirections) fails (throws, returns nothing, or returns a wrong answer), is it detected and recovered? | The failure is recorded and the plan does not silently rest on it. | **UNKNOWN** | — | UNPROVEN | server/services/goals/reasoning/directions.ts:exploreDirections (899), stanceQuotas (752), mutate (834), recombine (817), challengeProgram (622), scoreOf (891), diverseLeaders (1136) | — |
| C51-X | Does it still work combined with the other capabilities? | Does Evolutionary direction search (exploreDirections) still work combined with the route proposer, research and acceptance on a fresh goal? | The combined plan is consistent with it. | **UNKNOWN** | — | UNPROVEN | server/services/goals/reasoning/directions.ts:exploreDirections (899), stanceQuotas (752), mutate (834), recombine (817), challengeProgram (622), scoreOf (891), diverseLeaders (1136) | — |

### C52 Variable sweep (sweepVariables)

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C52-P | Can Brain perform it correctly? | Does discoverVariables/discoverConditions find the binding variables (price, volume, close, capital) and does narrowLevels + topInteractions identify the effect that matters, within MIN_EFFECT/REQUIREMENT_BOUND? | Correct as stated; failure observable as: Synthetic portfolio with a known binding variable; check the sweep names it; 'three binding diagnoses in one reading' (diagnosis doc) is a symptom. | **UNKNOWN** | — | UNPROVEN | server/services/goals/reasoning/variables.ts:sweepVariables (692), discoverVariables (589), discoverConditions (643), narrowLevels (189) | — |
| C52-R | Does the result reach every component that needs it? | Does what Variable sweep (sweepVariables) decides reach the components downstream of server/services/goals/reasoning/variables.ts? | Its result is read where the plan is decided. | **UNKNOWN** | — | UNPROVEN | server/services/goals/reasoning/variables.ts:sweepVariables (692), discoverVariables (589), discoverConditions (643), narrowLevels (189) | — |
| C52-I | Does the result change later decisions correctly? | Does a change in Variable sweep (sweepVariables)'s result change the plan reading? | The owner's plan changes when it does. | **UNKNOWN** | — | UNPROVEN | server/services/goals/reasoning/variables.ts:sweepVariables (692), discoverVariables (589), discoverConditions (643), narrowLevels (189) | — |
| C52-F | Does Brain recognise and recover when it fails? | When Variable sweep (sweepVariables) fails (throws, returns nothing, or returns a wrong answer), is it detected and recovered? | The failure is recorded and the plan does not silently rest on it. | **UNKNOWN** | — | UNPROVEN | server/services/goals/reasoning/variables.ts:sweepVariables (692), discoverVariables (589), discoverConditions (643), narrowLevels (189) | — |
| C52-X | Does it still work combined with the other capabilities? | Does Variable sweep (sweepVariables) still work combined with the route proposer, research and acceptance on a fresh goal? | The combined plan is consistent with it. | **UNKNOWN** | — | UNPROVEN | server/services/goals/reasoning/variables.ts:sweepVariables (692), discoverVariables (589), discoverConditions (643), narrowLevels (189) | — |

### C53 Strategist invention of new designs (inventDirections)

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C53-P | Can Brain perform it correctly? | When inventDue, do inventDirections' model calls produce parseable, in-scope designs (parseInvented/composeInventedDesigns), and how many are refused vs adopted? | Correct as stated; failure observable as: Per-run {calls, proposed, refused, error, rejections}; share of adopted reconstructions containing an invented design. | **UNKNOWN** | — | UNPROVEN | server/services/goals/reasoning/invent.ts:inventDirections (102), inventEnabled (98); server/services/goals/reasoning/directions.ts:parseInvented, composeInventedDesigns; server/services/goals/plan.ts:inventDue (3259); server/services/cash/goalScenario.ts:inventedFromArrangement (1185) | — |
| C53-R | Does the result reach every component that needs it? | Does what Strategist invention of new designs (inventDirections) decides reach the components downstream of server/services/goals/reasoning/invent.ts? | Its result is read where the plan is decided. | **UNKNOWN** | — | UNPROVEN | server/services/goals/reasoning/invent.ts:inventDirections (102), inventEnabled (98); server/services/goals/reasoning/directions.ts:parseInvented, composeInventedDesigns; server/services/goals/plan.ts:inventDue (3259); server/services/cash/goalScenario.ts:inventedFromArrangement (1185) | — |
| C53-I | Does the result change later decisions correctly? | Does a change in Strategist invention of new designs (inventDirections)'s result change the plan reading? | The owner's plan changes when it does. | **UNKNOWN** | — | UNPROVEN | server/services/goals/reasoning/invent.ts:inventDirections (102), inventEnabled (98); server/services/goals/reasoning/directions.ts:parseInvented, composeInventedDesigns; server/services/goals/plan.ts:inventDue (3259); server/services/cash/goalScenario.ts:inventedFromArrangement (1185) | — |
| C53-F | Does Brain recognise and recover when it fails? | When Strategist invention of new designs (inventDirections) fails (throws, returns nothing, or returns a wrong answer), is it detected and recovered? | The failure is recorded and the plan does not silently rest on it. | **UNKNOWN** | — | UNPROVEN | server/services/goals/reasoning/invent.ts:inventDirections (102), inventEnabled (98); server/services/goals/reasoning/directions.ts:parseInvented, composeInventedDesigns; server/services/goals/plan.ts:inventDue (3259); server/services/cash/goalScenario.ts:inventedFromArrangement (1185) | — |
| C53-X | Does it still work combined with the other capabilities? | Does Strategist invention of new designs (inventDirections) still work combined with the route proposer, research and acceptance on a fresh goal? | The combined plan is consistent with it. | **UNKNOWN** | — | UNPROVEN | server/services/goals/reasoning/invent.ts:inventDirections (102), inventEnabled (98); server/services/goals/reasoning/directions.ts:parseInvented, composeInventedDesigns; server/services/goals/plan.ts:inventDue (3259); server/services/cash/goalScenario.ts:inventedFromArrangement (1185) | — |

### C54 Cross-goal reasoning-method learning (UCB library, stance prior)

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C54-P | Can Brain perform it correctly? | Does recordExploration write the lift of each method/stance, and do loadLibrary (ucb) and loadStancePrior actually shift the next goal's seeds toward methods that worked? | Correct as stated; failure observable as: methodYield rows over time; seed allocation by stance before/after a run of wins; a stance with zero lift still receiving its full quota. | **UNKNOWN** | — | UNPROVEN | server/services/goals/reasoning/learning.ts:recordExploration (146), ucb (50), loadLibrary (67), loadStancePrior (94), methodYield (182); directions.ts:stancePosterior (740) | — |
| C54-R | Does the result reach every component that needs it? | Does what Cross-goal reasoning-method learning (UCB library, stance prior) decides reach the components downstream of server/services/goals/reasoning/learning.ts? | Its result is read where the plan is decided. | **UNKNOWN** | — | UNPROVEN | server/services/goals/reasoning/learning.ts:recordExploration (146), ucb (50), loadLibrary (67), loadStancePrior (94), methodYield (182); directions.ts:stancePosterior (740) | — |
| C54-I | Does the result change later decisions correctly? | Does a change in Cross-goal reasoning-method learning (UCB library, stance prior)'s result change the plan reading? | The owner's plan changes when it does. | **UNKNOWN** | — | UNPROVEN | server/services/goals/reasoning/learning.ts:recordExploration (146), ucb (50), loadLibrary (67), loadStancePrior (94), methodYield (182); directions.ts:stancePosterior (740) | — |
| C54-F | Does Brain recognise and recover when it fails? | When Cross-goal reasoning-method learning (UCB library, stance prior) fails (throws, returns nothing, or returns a wrong answer), is it detected and recovered? | The failure is recorded and the plan does not silently rest on it. | **UNKNOWN** | — | UNPROVEN | server/services/goals/reasoning/learning.ts:recordExploration (146), ucb (50), loadLibrary (67), loadStancePrior (94), methodYield (182); directions.ts:stancePosterior (740) | — |
| C54-X | Does it still work combined with the other capabilities? | Does Cross-goal reasoning-method learning (UCB library, stance prior) still work combined with the route proposer, research and acceptance on a fresh goal? | The combined plan is consistent with it. | **UNKNOWN** | — | UNPROVEN | server/services/goals/reasoning/learning.ts:recordExploration (146), ucb (50), loadLibrary (67), loadStancePrior (94), methodYield (182); directions.ts:stancePosterior (740) | — |

### C55 Evaluator pool robustness

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C55-P | Can Brain perform it correctly? | When the worker-thread evaluator times out or a thread dies (EVALUATION_TIMEOUT_MS, REPLACEMENTS_PER_WINDOW), is the reconstruction marked degraded rather than silently returning a shallow search? | Correct as stated; failure observable as: degraded[] entries on readings; evaluations completed vs requested (defaultEvaluations) per reading. | **UNKNOWN** | — | UNPROVEN | server/services/goals/reasoning/evaluatorPool.ts:openEvaluator (133), sharedEvaluator, inlineEvaluator (112); server/services/goals/plan.ts:recordDegraded (3349) | — |
| C55-R | Does the result reach every component that needs it? | Does what Evaluator pool robustness decides reach the components downstream of server/services/goals/reasoning/evaluatorPool.ts? | Its result is read where the plan is decided. | **UNKNOWN** | — | UNPROVEN | server/services/goals/reasoning/evaluatorPool.ts:openEvaluator (133), sharedEvaluator, inlineEvaluator (112); server/services/goals/plan.ts:recordDegraded (3349) | — |
| C55-I | Does the result change later decisions correctly? | Does a change in Evaluator pool robustness's result change the plan reading? | The owner's plan changes when it does. | **UNKNOWN** | — | UNPROVEN | server/services/goals/reasoning/evaluatorPool.ts:openEvaluator (133), sharedEvaluator, inlineEvaluator (112); server/services/goals/plan.ts:recordDegraded (3349) | — |
| C55-F | Does Brain recognise and recover when it fails? | When Evaluator pool robustness fails (throws, returns nothing, or returns a wrong answer), is it detected and recovered? | The failure is recorded and the plan does not silently rest on it. | **UNKNOWN** | — | UNPROVEN | server/services/goals/reasoning/evaluatorPool.ts:openEvaluator (133), sharedEvaluator, inlineEvaluator (112); server/services/goals/plan.ts:recordDegraded (3349) | — |
| C55-X | Does it still work combined with the other capabilities? | Does Evaluator pool robustness still work combined with the route proposer, research and acceptance on a fresh goal? | The combined plan is consistent with it. | **UNKNOWN** | — | UNPROVEN | server/services/goals/reasoning/evaluatorPool.ts:openEvaluator (133), sharedEvaluator, inlineEvaluator (112); server/services/goals/plan.ts:recordDegraded (3349) | — |

### C56 Adopting one plan (reconstruction vs plan as held)

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C56-P | Can Brain perform it correctly? | Does adoptReconstruction adopt the reconstruction exactly when it is inside limits, not implausible and materially better on established (not assumed) moves, and is a hypothetical reconstruction never presented as the plan? | Correct as stated; failure observable as: Readings where the steps' leg differs from the candidate's leg, or 'four best strategies in one reading' (diagnosis doc). | **UNKNOWN** | — | UNPROVEN | server/services/goals/plan.ts:adoptReconstruction (3630), implausibility (3448), heldDistribution (1973), candidateStrategyReading (2001) | — |
| C56-R | Does the result reach every component that needs it? | Does what Adopting one plan (reconstruction vs plan as held) decides reach the components downstream of server/services/goals/plan.ts? | Its result is read where the plan is decided. | **UNKNOWN** | — | UNPROVEN | server/services/goals/plan.ts:adoptReconstruction (3630), implausibility (3448), heldDistribution (1973), candidateStrategyReading (2001) | — |
| C56-I | Does the result change later decisions correctly? | Does a change in Adopting one plan (reconstruction vs plan as held)'s result change the plan reading? | The owner's plan changes when it does. | **UNKNOWN** | — | UNPROVEN | server/services/goals/plan.ts:adoptReconstruction (3630), implausibility (3448), heldDistribution (1973), candidateStrategyReading (2001) | — |
| C56-F | Does Brain recognise and recover when it fails? | When Adopting one plan (reconstruction vs plan as held) fails (throws, returns nothing, or returns a wrong answer), is it detected and recovered? | The failure is recorded and the plan does not silently rest on it. | **UNKNOWN** | — | UNPROVEN | server/services/goals/plan.ts:adoptReconstruction (3630), implausibility (3448), heldDistribution (1973), candidateStrategyReading (2001) | — |
| C56-X | Does it still work combined with the other capabilities? | Does Adopting one plan (reconstruction vs plan as held) still work combined with the route proposer, research and acceptance on a fresh goal? | The combined plan is consistent with it. | **UNKNOWN** | — | UNPROVEN | server/services/goals/plan.ts:adoptReconstruction (3630), implausibility (3448), heldDistribution (1973), candidateStrategyReading (2001) | — |

### C57 Infeasibility by arithmetic and held-market ceilings

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C57-P | Can Brain perform it correctly? | Does judgeFeasibility/judgeHeldMarkets conclude NOT_VIABLE only when arithmetic (every estimate at its favourable end) cannot reach the requirement, never on a short pool, and does relaxAlso name the relaxation that would make it feasible? | Correct as stated; failure observable as: Goals with NOT_VIABLE whose later openings reached the target; goals the owner would call impossible still NEEDS_EVIDENCE after many rounds. | **UNKNOWN** | — | UNPROVEN | server/services/goals/plan.ts:judgeFeasibility (3743), judgeHeldMarkets (3889), heldCeiling (3845), agreedInReach (3809), everyCaseInfeasible (1518), relaxAlso (3960), notSupported (3967) | — |
| C57-R | Does the result reach every component that needs it? | Does what Infeasibility by arithmetic and held-market ceilings decides reach the components downstream of server/services/goals/plan.ts? | Its result is read where the plan is decided. | **UNKNOWN** | — | UNPROVEN | server/services/goals/plan.ts:judgeFeasibility (3743), judgeHeldMarkets (3889), heldCeiling (3845), agreedInReach (3809), everyCaseInfeasible (1518), relaxAlso (3960), notSupported (3967) | — |
| C57-I | Does the result change later decisions correctly? | Does a change in Infeasibility by arithmetic and held-market ceilings's result change the plan reading? | The owner's plan changes when it does. | **UNKNOWN** | — | UNPROVEN | server/services/goals/plan.ts:judgeFeasibility (3743), judgeHeldMarkets (3889), heldCeiling (3845), agreedInReach (3809), everyCaseInfeasible (1518), relaxAlso (3960), notSupported (3967) | — |
| C57-F | Does Brain recognise and recover when it fails? | When Infeasibility by arithmetic and held-market ceilings fails (throws, returns nothing, or returns a wrong answer), is it detected and recovered? | The failure is recorded and the plan does not silently rest on it. | **UNKNOWN** | — | UNPROVEN | server/services/goals/plan.ts:judgeFeasibility (3743), judgeHeldMarkets (3889), heldCeiling (3845), agreedInReach (3809), everyCaseInfeasible (1518), relaxAlso (3960), notSupported (3967) | — |
| C57-X | Does it still work combined with the other capabilities? | Does Infeasibility by arithmetic and held-market ceilings still work combined with the route proposer, research and acceptance on a fresh goal? | The combined plan is consistent with it. | **UNKNOWN** | — | UNPROVEN | server/services/goals/plan.ts:judgeFeasibility (3743), judgeHeldMarkets (3889), heldCeiling (3845), agreedInReach (3809), everyCaseInfeasible (1518), relaxAlso (3960), notSupported (3967) | — |

### C58 Investment committee rule roles and answer settlement (§117)

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C58-P | Can Brain perform it correctly? | Do the six COMMITTEE_ROLES (reviewRole/reviewPlan) block plans on correct grounds, does evidencedReach recompute reach from legs, and does settleByAnswers settle a question when research answers it? | Correct as stated; failure observable as: Blocks per role vs hand review on 10 readings; false blocks; questions settled vs answers on record. | **UNKNOWN** | — | UNPROVEN | server/services/goals/committee.ts:reviewPlan (669), reviewRole (653), evidencedReach (556), settleByAnswers (373), committeeTier (779); server/services/goals/plan.ts:refuseForCommittee (5451) | — |
| C58-R | Does the result reach every component that needs it? | Does what Investment committee rule roles and answer settlement (§117) decides reach the components downstream of server/services/goals/committee.ts? | Its result is read where the plan is decided. | **UNKNOWN** | — | UNPROVEN | server/services/goals/committee.ts:reviewPlan (669), reviewRole (653), evidencedReach (556), settleByAnswers (373), committeeTier (779); server/services/goals/plan.ts:refuseForCommittee (5451) | — |
| C58-I | Does the result change later decisions correctly? | Does a change in Investment committee rule roles and answer settlement (§117)'s result change the plan reading? | The owner's plan changes when it does. | **UNKNOWN** | — | UNPROVEN | server/services/goals/committee.ts:reviewPlan (669), reviewRole (653), evidencedReach (556), settleByAnswers (373), committeeTier (779); server/services/goals/plan.ts:refuseForCommittee (5451) | — |
| C58-F | Does Brain recognise and recover when it fails? | When Investment committee rule roles and answer settlement (§117) fails (throws, returns nothing, or returns a wrong answer), is it detected and recovered? | The failure is recorded and the plan does not silently rest on it. | **UNKNOWN** | — | UNPROVEN | server/services/goals/committee.ts:reviewPlan (669), reviewRole (653), evidencedReach (556), settleByAnswers (373), committeeTier (779); server/services/goals/plan.ts:refuseForCommittee (5451) | — |
| C58-X | Does it still work combined with the other capabilities? | Does Investment committee rule roles and answer settlement (§117) still work combined with the route proposer, research and acceptance on a fresh goal? | The combined plan is consistent with it. | **UNKNOWN** | — | UNPROVEN | server/services/goals/committee.ts:reviewPlan (669), reviewRole (653), evidencedReach (556), settleByAnswers (373), committeeTier (779); server/services/goals/plan.ts:refuseForCommittee (5451) | — |

### C59 Committee model specialists

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C59-P | Can Brain perform it correctly? | When specialists are configured, do reviewWithSpecialists/parseSpecialist return usable independent findings, and does armSpecialistReview bind them into the next reading (state != NOT_RUN)? | Correct as stated; failure observable as: specialists.state on readings; parse failures; agreement rate with rule roles (agreement is not evidence, §117). | **UNKNOWN** | — | UNPROVEN | server/services/goals/committeeSpecialists.ts:reviewWithSpecialists (172), parseSpecialist (134), specialistReviewDue (277), armSpecialistReview, specialistsConfigured | — |
| C59-R | Does the result reach every component that needs it? | Does what Committee model specialists decides reach the components downstream of server/services/goals/committeeSpecialists.ts? | Its result is read where the plan is decided. | **UNKNOWN** | — | UNPROVEN | server/services/goals/committeeSpecialists.ts:reviewWithSpecialists (172), parseSpecialist (134), specialistReviewDue (277), armSpecialistReview, specialistsConfigured | — |
| C59-I | Does the result change later decisions correctly? | Does a change in Committee model specialists's result change the plan reading? | The owner's plan changes when it does. | **UNKNOWN** | — | UNPROVEN | server/services/goals/committeeSpecialists.ts:reviewWithSpecialists (172), parseSpecialist (134), specialistReviewDue (277), armSpecialistReview, specialistsConfigured | — |
| C59-F | Does Brain recognise and recover when it fails? | When Committee model specialists fails (throws, returns nothing, or returns a wrong answer), is it detected and recovered? | The failure is recorded and the plan does not silently rest on it. | **UNKNOWN** | — | UNPROVEN | server/services/goals/committeeSpecialists.ts:reviewWithSpecialists (172), parseSpecialist (134), specialistReviewDue (277), armSpecialistReview, specialistsConfigured | — |
| C59-X | Does it still work combined with the other capabilities? | Does Committee model specialists still work combined with the route proposer, research and acceptance on a fresh goal? | The combined plan is consistent with it. | **UNKNOWN** | — | UNPROVEN | server/services/goals/committeeSpecialists.ts:reviewWithSpecialists (172), parseSpecialist (134), specialistReviewDue (277), armSpecialistReview, specialistsConfigured | — |

### C60 Plan integrity gate

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C60-P | Can Brain perform it correctly? | Does gateIntegrity/integrityInput refuse every ACCEPTED reading that breaks a rule (lead price, membership, window), and only those? | Correct as stated; failure observable as: Seeded readings with one violation each; integrity.violations vs expected. | **UNKNOWN** | — | UNPROVEN | server/services/goals/plan.ts:gateIntegrity (5473), refuseForIntegrity (5431); server/services/goals/planIntegrityInput.ts:integrityInput, leadPrice | — |
| C60-R | Does the result reach every component that needs it? | Does what Plan integrity gate decides reach the components downstream of server/services/goals/plan.ts? | Its result is read where the plan is decided. | **UNKNOWN** | — | UNPROVEN | server/services/goals/plan.ts:gateIntegrity (5473), refuseForIntegrity (5431); server/services/goals/planIntegrityInput.ts:integrityInput, leadPrice | — |
| C60-I | Does the result change later decisions correctly? | Does a change in Plan integrity gate's result change the plan reading? | The owner's plan changes when it does. | **UNKNOWN** | — | UNPROVEN | server/services/goals/plan.ts:gateIntegrity (5473), refuseForIntegrity (5431); server/services/goals/planIntegrityInput.ts:integrityInput, leadPrice | — |
| C60-F | Does Brain recognise and recover when it fails? | When Plan integrity gate fails (throws, returns nothing, or returns a wrong answer), is it detected and recovered? | The failure is recorded and the plan does not silently rest on it. | **UNKNOWN** | — | UNPROVEN | server/services/goals/plan.ts:gateIntegrity (5473), refuseForIntegrity (5431); server/services/goals/planIntegrityInput.ts:integrityInput, leadPrice | — |
| C60-X | Does it still work combined with the other capabilities? | Does Plan integrity gate still work combined with the route proposer, research and acceptance on a fresh goal? | The combined plan is consistent with it. | **UNKNOWN** | — | UNPROVEN | server/services/goals/plan.ts:gateIntegrity (5473), refuseForIntegrity (5431); server/services/goals/planIntegrityInput.ts:integrityInput, leadPrice | — |

### C61 Step-writing guards (window, figures, missing transaction stages, owner of each step)

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C61-P | Can Brain perform it correctly? | Do collectsOutsideWindow, withholdImplausibleFigures, missingTransactionStages and ownerOf (BRAIN vs PERSON) catch steps that collect after the window, print implausible figures, skip a transaction stage, or hand Brain's work to the owner? | Correct as stated; failure observable as: stepsMissing non-empty on RECOMMENDABLE readings; steps assigned PERSON that Brain operations could do; kill criteria absent. | **UNKNOWN** | — | UNPROVEN | server/services/goals/plan.ts:planSteps (4207), collectsOutsideWindow (4654), withholdImplausibleFigures (4615), missingTransactionStages (4584), ownerOf (4052), killFor (4088); server/services/goals/arrangementSteps.ts | — |
| C61-R | Does the result reach every component that needs it? | Does what Step-writing guards (window, figures, missing transaction stages, owner of each step) decides reach the components downstream of server/services/goals/plan.ts? | Its result is read where the plan is decided. | **UNKNOWN** | — | UNPROVEN | server/services/goals/plan.ts:planSteps (4207), collectsOutsideWindow (4654), withholdImplausibleFigures (4615), missingTransactionStages (4584), ownerOf (4052), killFor (4088); server/services/goals/arrangementSteps.ts | — |
| C61-I | Does the result change later decisions correctly? | Does a change in Step-writing guards (window, figures, missing transaction stages, owner of each step)'s result change the plan reading? | The owner's plan changes when it does. | **UNKNOWN** | — | UNPROVEN | server/services/goals/plan.ts:planSteps (4207), collectsOutsideWindow (4654), withholdImplausibleFigures (4615), missingTransactionStages (4584), ownerOf (4052), killFor (4088); server/services/goals/arrangementSteps.ts | — |
| C61-F | Does Brain recognise and recover when it fails? | When Step-writing guards (window, figures, missing transaction stages, owner of each step) fails (throws, returns nothing, or returns a wrong answer), is it detected and recovered? | The failure is recorded and the plan does not silently rest on it. | **UNKNOWN** | — | UNPROVEN | server/services/goals/plan.ts:planSteps (4207), collectsOutsideWindow (4654), withholdImplausibleFigures (4615), missingTransactionStages (4584), ownerOf (4052), killFor (4088); server/services/goals/arrangementSteps.ts | — |
| C61-X | Does it still work combined with the other capabilities? | Does Step-writing guards (window, figures, missing transaction stages, owner of each step) still work combined with the route proposer, research and acceptance on a fresh goal? | The combined plan is consistent with it. | **UNKNOWN** | — | UNPROVEN | server/services/goals/plan.ts:planSteps (4207), collectsOutsideWindow (4654), withholdImplausibleFigures (4615), missingTransactionStages (4584), ownerOf (4052), killFor (4088); server/services/goals/arrangementSteps.ts | — |

### C62 Plan set distinctness and resilience

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C62-P | Can Brain perform it correctly? | Does buildPlanSet produce plans that differ on DISTINCTNESS_DIMENSIONS, and does rebuildAfter/resilienceOf correctly say which plan survives a change (e.g. a leg refuted)? | Correct as stated; failure observable as: Plan sets with 2+ plans differing on 0 dimensions; rebuildAfter verdicts vs recomputed plans after a refutation. | **UNKNOWN** | — | UNPROVEN | server/services/goals/planSet.ts:buildPlanSet (649), differingDimensions (549), resilienceOf (747), rebuildAfter (798), modelledShareReaching (562) | — |
| C62-R | Does the result reach every component that needs it? | Does what Plan set distinctness and resilience decides reach the components downstream of server/services/goals/planSet.ts? | Its result is read where the plan is decided. | **UNKNOWN** | — | UNPROVEN | server/services/goals/planSet.ts:buildPlanSet (649), differingDimensions (549), resilienceOf (747), rebuildAfter (798), modelledShareReaching (562) | — |
| C62-I | Does the result change later decisions correctly? | Does a change in Plan set distinctness and resilience's result change the plan reading? | The owner's plan changes when it does. | **UNKNOWN** | — | UNPROVEN | server/services/goals/planSet.ts:buildPlanSet (649), differingDimensions (549), resilienceOf (747), rebuildAfter (798), modelledShareReaching (562) | — |
| C62-F | Does Brain recognise and recover when it fails? | When Plan set distinctness and resilience fails (throws, returns nothing, or returns a wrong answer), is it detected and recovered? | The failure is recorded and the plan does not silently rest on it. | **UNKNOWN** | — | UNPROVEN | server/services/goals/planSet.ts:buildPlanSet (649), differingDimensions (549), resilienceOf (747), rebuildAfter (798), modelledShareReaching (562) | — |
| C62-X | Does it still work combined with the other capabilities? | Does Plan set distinctness and resilience still work combined with the route proposer, research and acceptance on a fresh goal? | The combined plan is consistent with it. | **UNKNOWN** | — | UNPROVEN | server/services/goals/planSet.ts:buildPlanSet (649), differingDimensions (549), resilienceOf (747), rebuildAfter (798), modelledShareReaching (562) | — |

### C63 Plan refresh trigger (inputs fingerprint)

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C63-P | Can Brain perform it correctly? | Does planInputsFingerprint change when any input a reading depends on changes (new claim, owner term change, dive answer), so planDue re-reads, and stay stable otherwise? | Correct as stated; failure observable as: Readings whose inputs changed but whose fingerprint did not (stale plan); excessive re-reads with identical inputs. | **UNKNOWN** | — | UNPROVEN | server/services/goals/plan.ts:planInputsFingerprint (5722), planDue (5789), inputsTakenOver (5769), requestGoalPlanPass (5805) | — |
| C63-R | Does the result reach every component that needs it? | Does what Plan refresh trigger (inputs fingerprint) decides reach the components downstream of server/services/goals/plan.ts? | Its result is read where the plan is decided. | **UNKNOWN** | — | UNPROVEN | server/services/goals/plan.ts:planInputsFingerprint (5722), planDue (5789), inputsTakenOver (5769), requestGoalPlanPass (5805) | — |
| C63-I | Does the result change later decisions correctly? | Does a change in Plan refresh trigger (inputs fingerprint)'s result change the plan reading? | The owner's plan changes when it does. | **UNKNOWN** | — | UNPROVEN | server/services/goals/plan.ts:planInputsFingerprint (5722), planDue (5789), inputsTakenOver (5769), requestGoalPlanPass (5805) | — |
| C63-F | Does Brain recognise and recover when it fails? | When Plan refresh trigger (inputs fingerprint) fails (throws, returns nothing, or returns a wrong answer), is it detected and recovered? | The failure is recorded and the plan does not silently rest on it. | **UNKNOWN** | — | UNPROVEN | server/services/goals/plan.ts:planInputsFingerprint (5722), planDue (5789), inputsTakenOver (5769), requestGoalPlanPass (5805) | — |
| C63-X | Does it still work combined with the other capabilities? | Does Plan refresh trigger (inputs fingerprint) still work combined with the route proposer, research and acceptance on a fresh goal? | The combined plan is consistent with it. | **UNKNOWN** | — | UNPROVEN | server/services/goals/plan.ts:planInputsFingerprint (5722), planDue (5789), inputsTakenOver (5769), requestGoalPlanPass (5805) | — |

### C64 Reconsideration of decisions when underlying facts change

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C64-P | Can Brain perform it correctly? | When a fact a decision record rests on changes, do changedFacts/dependentsOf find the dependent goals/openings and does reconcileFactChanges re-open them? | Correct as stated; failure observable as: Change a price fact under a held opening; check a RECONSIDER event and a new reading within one pass. | **UNKNOWN** | — | UNPROVEN | server/services/goals/reconsider.ts:changedFacts (119), dependentsOf (154), reconcileFactChanges (343); wired from goals/tick.ts (reconcileFactChangesIfDue) | — |
| C64-R | Does the result reach every component that needs it? | Does what Reconsideration of decisions when underlying facts change decides reach the components downstream of server/services/goals/reconsider.ts? | Its result is read where the plan is decided. | **UNKNOWN** | — | UNPROVEN | server/services/goals/reconsider.ts:changedFacts (119), dependentsOf (154), reconcileFactChanges (343); wired from goals/tick.ts (reconcileFactChangesIfDue) | — |
| C64-I | Does the result change later decisions correctly? | Does a change in Reconsideration of decisions when underlying facts change's result change the plan reading? | The owner's plan changes when it does. | **UNKNOWN** | — | UNPROVEN | server/services/goals/reconsider.ts:changedFacts (119), dependentsOf (154), reconcileFactChanges (343); wired from goals/tick.ts (reconcileFactChangesIfDue) | — |
| C64-F | Does Brain recognise and recover when it fails? | When Reconsideration of decisions when underlying facts change fails (throws, returns nothing, or returns a wrong answer), is it detected and recovered? | The failure is recorded and the plan does not silently rest on it. | **UNKNOWN** | — | UNPROVEN | server/services/goals/reconsider.ts:changedFacts (119), dependentsOf (154), reconcileFactChanges (343); wired from goals/tick.ts (reconcileFactChangesIfDue) | — |
| C64-X | Does it still work combined with the other capabilities? | Does Reconsideration of decisions when underlying facts change still work combined with the route proposer, research and acceptance on a fresh goal? | The combined plan is consistent with it. | **UNKNOWN** | — | UNPROVEN | server/services/goals/reconsider.ts:changedFacts (119), dependentsOf (154), reconcileFactChanges (343); wired from goals/tick.ts (reconcileFactChangesIfDue) | — |

### C65 Prediction calibration and miss classification

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C65-P | Can Brain perform it correctly? | Does reconcileCalibration compare goal predictions with outcomes, classify misses (classifyMiss) and produce methodCorrections that the planner reads? | Correct as stated; failure observable as: Calibration pass reports per goal; whether any correction changes a later reading's inputs. | **UNKNOWN** | — | UNPROVEN | server/services/goals/calibration.ts:reconcileCalibration (404), classifyMiss (129), methodCorrections (174); goals/plan.ts:recordGoalOutcome (5651) | — |
| C65-R | Does the result reach every component that needs it? | Does what Prediction calibration and miss classification decides reach the components downstream of server/services/goals/calibration.ts? | Its result is read where the plan is decided. | **UNKNOWN** | — | UNPROVEN | server/services/goals/calibration.ts:reconcileCalibration (404), classifyMiss (129), methodCorrections (174); goals/plan.ts:recordGoalOutcome (5651) | — |
| C65-I | Does the result change later decisions correctly? | Does a change in Prediction calibration and miss classification's result change the plan reading? | The owner's plan changes when it does. | **UNKNOWN** | — | UNPROVEN | server/services/goals/calibration.ts:reconcileCalibration (404), classifyMiss (129), methodCorrections (174); goals/plan.ts:recordGoalOutcome (5651) | — |
| C65-F | Does Brain recognise and recover when it fails? | When Prediction calibration and miss classification fails (throws, returns nothing, or returns a wrong answer), is it detected and recovered? | The failure is recorded and the plan does not silently rest on it. | **UNKNOWN** | — | UNPROVEN | server/services/goals/calibration.ts:reconcileCalibration (404), classifyMiss (129), methodCorrections (174); goals/plan.ts:recordGoalOutcome (5651) | — |
| C65-X | Does it still work combined with the other capabilities? | Does Prediction calibration and miss classification still work combined with the route proposer, research and acceptance on a fresh goal? | The combined plan is consistent with it. | **UNKNOWN** | — | UNPROVEN | server/services/goals/calibration.ts:reconcileCalibration (404), classifyMiss (129), methodCorrections (174); goals/plan.ts:recordGoalOutcome (5651) | — |

### C66 Research worth / materiality filter

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C66-P | Can Brain perform it correctly? | Do notWorthResearching and tooSmallForGoals/recordMateriality skip research that cannot change a decision (too small a share, closes before a dive can finish) without excluding the opening that would decide the goal? | Correct as stated; failure observable as: Openings marked not-worth/too-small that later proved decisive; dives skipped by closing runway. | **UNKNOWN** | — | UNPROVEN | server/services/cash/worthResearching.ts:notWorthResearching (247), goalLimitsFor (210), closesWithin (105); server/services/goals/materiality.ts:recordMateriality (27), tooSmallForGoals (63) | — |
| C66-R | Does the result reach every component that needs it? | Does what Research worth / materiality filter decides reach the components downstream of server/services/cash/worthResearching.ts? | Its result is read where the plan is decided. | **UNKNOWN** | — | UNPROVEN | server/services/cash/worthResearching.ts:notWorthResearching (247), goalLimitsFor (210), closesWithin (105); server/services/goals/materiality.ts:recordMateriality (27), tooSmallForGoals (63) | — |
| C66-I | Does the result change later decisions correctly? | Does a change in Research worth / materiality filter's result change the plan reading? | The owner's plan changes when it does. | **UNKNOWN** | — | UNPROVEN | server/services/cash/worthResearching.ts:notWorthResearching (247), goalLimitsFor (210), closesWithin (105); server/services/goals/materiality.ts:recordMateriality (27), tooSmallForGoals (63) | — |
| C66-F | Does Brain recognise and recover when it fails? | When Research worth / materiality filter fails (throws, returns nothing, or returns a wrong answer), is it detected and recovered? | The failure is recorded and the plan does not silently rest on it. | **UNKNOWN** | — | UNPROVEN | server/services/cash/worthResearching.ts:notWorthResearching (247), goalLimitsFor (210), closesWithin (105); server/services/goals/materiality.ts:recordMateriality (27), tooSmallForGoals (63) | — |
| C66-X | Does it still work combined with the other capabilities? | Does Research worth / materiality filter still work combined with the route proposer, research and acceptance on a fresh goal? | The combined plan is consistent with it. | **UNKNOWN** | — | UNPROVEN | server/services/cash/worthResearching.ts:notWorthResearching (247), goalLimitsFor (210), closesWithin (105); server/services/goals/materiality.ts:recordMateriality (27), tooSmallForGoals (63) | — |

### C67 Validation dive selection and ordering

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C67-P | Can Brain perform it correctly? | Do compareDiveValue/diveOrder/fieldsWorthResearching and startValidations start dives on the openings and fields with the highest decision value for live goals, and do capacity deferrals (recordCapacityDeferrals) push out the right ones? | Correct as stated; failure observable as: Dive starts ranked vs the planner's researchPriority/planResearchPriority; pending dives blocking the next test for days. | **UNKNOWN** | — | UNPROVEN | server/services/cash/validation.ts:startValidations (1238), compareDiveValue (997), diveOrder (1046), fieldsWorthResearching (880), capacityDeferralCandidates (1134), whyNotDiving (398) | — |
| C67-R | Does the result reach every component that needs it? | Does what Validation dive selection and ordering decides reach the components downstream of server/services/cash/validation.ts? | Its result is read where the plan is decided. | **UNKNOWN** | — | UNPROVEN | server/services/cash/validation.ts:startValidations (1238), compareDiveValue (997), diveOrder (1046), fieldsWorthResearching (880), capacityDeferralCandidates (1134), whyNotDiving (398) | — |
| C67-I | Does the result change later decisions correctly? | Does a change in Validation dive selection and ordering's result change the plan reading? | The owner's plan changes when it does. | **UNKNOWN** | — | UNPROVEN | server/services/cash/validation.ts:startValidations (1238), compareDiveValue (997), diveOrder (1046), fieldsWorthResearching (880), capacityDeferralCandidates (1134), whyNotDiving (398) | — |
| C67-F | Does Brain recognise and recover when it fails? | When Validation dive selection and ordering fails (throws, returns nothing, or returns a wrong answer), is it detected and recovered? | The failure is recorded and the plan does not silently rest on it. | **UNKNOWN** | — | UNPROVEN | server/services/cash/validation.ts:startValidations (1238), compareDiveValue (997), diveOrder (1046), fieldsWorthResearching (880), capacityDeferralCandidates (1134), whyNotDiving (398) | — |
| C67-X | Does it still work combined with the other capabilities? | Does Validation dive selection and ordering still work combined with the route proposer, research and acceptance on a fresh goal? | The combined plan is consistent with it. | **UNKNOWN** | — | UNPROVEN | server/services/cash/validation.ts:startValidations (1238), compareDiveValue (997), diveOrder (1046), fieldsWorthResearching (880), capacityDeferralCandidates (1134), whyNotDiving (398) | — |

### C68 Plan -> research priority handoff

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C68-P | Can Brain perform it correctly? | Do researchPriority/planResearchPriority/heldForResearch/diagnoseGoalResearch name the research that would most move reach, and does that ordering reach the research queue (decideResearchAllocation)? | Correct as stated; failure observable as: Rank correlation between planner priority and queue order/started fragments; DECISION_VALUE_WEIGHT effect. | **UNKNOWN** | — | UNPROVEN | server/services/goals/plan.ts:researchPriority (5232), planResearchPriority (4786), heldForResearch (4982), planSearchBrief (4860); server/services/goals/researchYield.ts:diagnoseGoalResearch (87); server/services/goals/researchAllocation.ts:decideResearchAllocation (332) | — |
| C68-R | Does the result reach every component that needs it? | Does what Plan -> research priority handoff decides reach the components downstream of server/services/goals/plan.ts? | Its result is read where the plan is decided. | **UNKNOWN** | — | UNPROVEN | server/services/goals/plan.ts:researchPriority (5232), planResearchPriority (4786), heldForResearch (4982), planSearchBrief (4860); server/services/goals/researchYield.ts:diagnoseGoalResearch (87); server/services/goals/researchAllocation.ts:decideResearchAllocation (332) | — |
| C68-I | Does the result change later decisions correctly? | Does a change in Plan -> research priority handoff's result change the plan reading? | The owner's plan changes when it does. | **UNKNOWN** | — | UNPROVEN | server/services/goals/plan.ts:researchPriority (5232), planResearchPriority (4786), heldForResearch (4982), planSearchBrief (4860); server/services/goals/researchYield.ts:diagnoseGoalResearch (87); server/services/goals/researchAllocation.ts:decideResearchAllocation (332) | — |
| C68-F | Does Brain recognise and recover when it fails? | When Plan -> research priority handoff fails (throws, returns nothing, or returns a wrong answer), is it detected and recovered? | The failure is recorded and the plan does not silently rest on it. | **UNKNOWN** | — | UNPROVEN | server/services/goals/plan.ts:researchPriority (5232), planResearchPriority (4786), heldForResearch (4982), planSearchBrief (4860); server/services/goals/researchYield.ts:diagnoseGoalResearch (87); server/services/goals/researchAllocation.ts:decideResearchAllocation (332) | — |
| C68-X | Does it still work combined with the other capabilities? | Does Plan -> research priority handoff still work combined with the route proposer, research and acceptance on a fresh goal? | The combined plan is consistent with it. | **UNKNOWN** | — | UNPROVEN | server/services/goals/plan.ts:researchPriority (5232), planResearchPriority (4786), heldForResearch (4982), planSearchBrief (4860); server/services/goals/researchYield.ts:diagnoseGoalResearch (87); server/services/goals/researchAllocation.ts:decideResearchAllocation (332) | — |

### C69 Goal discovery lenses and focus

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C69-P | Can Brain perform it correctly? | Do industryLensSelection/fixedLenses/originLenses/roleLenses/openWorldLenses and discoveryFocusFor (online-only focus, discovery.ts:987) give rounds lenses that fit the owner's offer and place, and does constructedShare balance constructed vs open rounds? | Correct as stated; failure observable as: Lens/focus text on rounds for owners offering local physical labour; share of rounds with off-profile focus. | **UNKNOWN** | — | UNPROVEN | server/services/cash/discovery.ts:openGoalDiscovery (1113), discoveryFocusFor (998), industryLensSelection (764), openWorldLenses (913), roleLenses (865), constructedShare (966), nextGoalRoundFor (1062) | — |
| C69-R | Does the result reach every component that needs it? | Does what Goal discovery lenses and focus decides reach the components downstream of server/services/cash/discovery.ts? | Its result is read where the plan is decided. | **UNKNOWN** | — | UNPROVEN | server/services/cash/discovery.ts:openGoalDiscovery (1113), discoveryFocusFor (998), industryLensSelection (764), openWorldLenses (913), roleLenses (865), constructedShare (966), nextGoalRoundFor (1062) | — |
| C69-I | Does the result change later decisions correctly? | Does a change in Goal discovery lenses and focus's result change the plan reading? | The owner's plan changes when it does. | **UNKNOWN** | — | UNPROVEN | server/services/cash/discovery.ts:openGoalDiscovery (1113), discoveryFocusFor (998), industryLensSelection (764), openWorldLenses (913), roleLenses (865), constructedShare (966), nextGoalRoundFor (1062) | — |
| C69-F | Does Brain recognise and recover when it fails? | When Goal discovery lenses and focus fails (throws, returns nothing, or returns a wrong answer), is it detected and recovered? | The failure is recorded and the plan does not silently rest on it. | **UNKNOWN** | — | UNPROVEN | server/services/cash/discovery.ts:openGoalDiscovery (1113), discoveryFocusFor (998), industryLensSelection (764), openWorldLenses (913), roleLenses (865), constructedShare (966), nextGoalRoundFor (1062) | — |
| C69-X | Does it still work combined with the other capabilities? | Does Goal discovery lenses and focus still work combined with the route proposer, research and acceptance on a fresh goal? | The combined plan is consistent with it. | **UNKNOWN** | — | UNPROVEN | server/services/cash/discovery.ts:openGoalDiscovery (1113), discoveryFocusFor (998), industryLensSelection (764), openWorldLenses (913), roleLenses (865), constructedShare (966), nextGoalRoundFor (1062) | — |

### C70 Harvest of research into openings and evidence join

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C70-P | Can Brain perform it correctly? | Does harvest turn gated fragment claims into openings and evidence fields (routeEvidence -> writeEvidenceAnswer) without duplicating or mis-filing comparable demand as exact demand? | Correct as stated; failure observable as: Claims accepted vs fields filed; comparableDemand vs demand field counts; duplicate openings per harvest. | **UNKNOWN** | — | UNPROVEN | server/services/cash/discovery.ts:harvest (2149); server/services/cash/routeEvidence.ts; server/services/cash/answers.ts:writeEvidenceAnswer; server/services/goals/routeProposal.ts:groundRoute (1713) | — |
| C70-R | Does the result reach every component that needs it? | Does what Harvest of research into openings and evidence join decides reach the components downstream of server/services/cash/discovery.ts? | Its result is read where the plan is decided. | **UNKNOWN** | — | UNPROVEN | server/services/cash/discovery.ts:harvest (2149); server/services/cash/routeEvidence.ts; server/services/cash/answers.ts:writeEvidenceAnswer; server/services/goals/routeProposal.ts:groundRoute (1713) | — |
| C70-I | Does the result change later decisions correctly? | Does a change in Harvest of research into openings and evidence join's result change the plan reading? | The owner's plan changes when it does. | **UNKNOWN** | — | UNPROVEN | server/services/cash/discovery.ts:harvest (2149); server/services/cash/routeEvidence.ts; server/services/cash/answers.ts:writeEvidenceAnswer; server/services/goals/routeProposal.ts:groundRoute (1713) | — |
| C70-F | Does Brain recognise and recover when it fails? | When Harvest of research into openings and evidence join fails (throws, returns nothing, or returns a wrong answer), is it detected and recovered? | The failure is recorded and the plan does not silently rest on it. | **UNKNOWN** | — | UNPROVEN | server/services/cash/discovery.ts:harvest (2149); server/services/cash/routeEvidence.ts; server/services/cash/answers.ts:writeEvidenceAnswer; server/services/goals/routeProposal.ts:groundRoute (1713) | — |
| C70-X | Does it still work combined with the other capabilities? | Does Harvest of research into openings and evidence join still work combined with the route proposer, research and acceptance on a fresh goal? | The combined plan is consistent with it. | **UNKNOWN** | — | UNPROVEN | server/services/cash/discovery.ts:harvest (2149); server/services/cash/routeEvidence.ts; server/services/cash/answers.ts:writeEvidenceAnswer; server/services/goals/routeProposal.ts:groundRoute (1713) | — |

### C71 Direction critique (scout stage critic)

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C71-P | Can Brain perform it correctly? | Does applyDirectionCritique keep/drop scouted directions on correct grounds, and does parseDirections preserve decisive unknowns into fileDirection's research? | Correct as stated; failure observable as: Dropped directions later supported by research; directions filed without a research question. | **UNKNOWN** | — | UNPROVEN | server/services/goals/routeProposal.ts:directionCritiquePrompt (611), applyDirectionCritique (633), parseDirections (510), fileDirection | — |
| C71-R | Does the result reach every component that needs it? | Does what Direction critique (scout stage critic) decides reach the components downstream of server/services/goals/routeProposal.ts? | Its result is read where the plan is decided. | **UNKNOWN** | — | UNPROVEN | server/services/goals/routeProposal.ts:directionCritiquePrompt (611), applyDirectionCritique (633), parseDirections (510), fileDirection | — |
| C71-I | Does the result change later decisions correctly? | Does a change in Direction critique (scout stage critic)'s result change the plan reading? | The owner's plan changes when it does. | **UNKNOWN** | — | UNPROVEN | server/services/goals/routeProposal.ts:directionCritiquePrompt (611), applyDirectionCritique (633), parseDirections (510), fileDirection | — |
| C71-F | Does Brain recognise and recover when it fails? | When Direction critique (scout stage critic) fails (throws, returns nothing, or returns a wrong answer), is it detected and recovered? | The failure is recorded and the plan does not silently rest on it. | **UNKNOWN** | — | UNPROVEN | server/services/goals/routeProposal.ts:directionCritiquePrompt (611), applyDirectionCritique (633), parseDirections (510), fileDirection | — |
| C71-X | Does it still work combined with the other capabilities? | Does Direction critique (scout stage critic) still work combined with the route proposer, research and acceptance on a fresh goal? | The combined plan is consistent with it. | **UNKNOWN** | — | UNPROVEN | server/services/goals/routeProposal.ts:directionCritiquePrompt (611), applyDirectionCritique (633), parseDirections (510), fileDirection | — |

### C72 Continuation decision (keep searching / successors)

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C72-P | Can Brain perform it correctly? | Does continuationOf/continueSearch keep the search going exactly when the goal is unmet with days left, stop on achievement or recorded outcome, and carry surplus to successors? | Correct as stated; failure observable as: Goals with needsMoreOpenings=false while NEEDS_EVIDENCE and daysLeft>0; widenGoalSearch counts per tick. | **UNKNOWN** | — | UNPROVEN | server/services/goals/plan.ts:continuationOf (3997), continueSearch (3985), widenGoalSearch (5854), askPathwayConstructions (5945) | — |
| C72-R | Does the result reach every component that needs it? | Does what Continuation decision (keep searching / successors) decides reach the components downstream of server/services/goals/plan.ts? | Its result is read where the plan is decided. | **UNKNOWN** | — | UNPROVEN | server/services/goals/plan.ts:continuationOf (3997), continueSearch (3985), widenGoalSearch (5854), askPathwayConstructions (5945) | — |
| C72-I | Does the result change later decisions correctly? | Does a change in Continuation decision (keep searching / successors)'s result change the plan reading? | The owner's plan changes when it does. | **UNKNOWN** | — | UNPROVEN | server/services/goals/plan.ts:continuationOf (3997), continueSearch (3985), widenGoalSearch (5854), askPathwayConstructions (5945) | — |
| C72-F | Does Brain recognise and recover when it fails? | When Continuation decision (keep searching / successors) fails (throws, returns nothing, or returns a wrong answer), is it detected and recovered? | The failure is recorded and the plan does not silently rest on it. | **UNKNOWN** | — | UNPROVEN | server/services/goals/plan.ts:continuationOf (3997), continueSearch (3985), widenGoalSearch (5854), askPathwayConstructions (5945) | — |
| C72-X | Does it still work combined with the other capabilities? | Does Continuation decision (keep searching / successors) still work combined with the route proposer, research and acceptance on a fresh goal? | The combined plan is consistent with it. | **UNKNOWN** | — | UNPROVEN | server/services/goals/plan.ts:continuationOf (3997), continueSearch (3985), widenGoalSearch (5854), askPathwayConstructions (5945) | — |

### C73 Pathway constructions and commercial reality check (§116)

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C73-P | Can Brain perform it correctly? | Does commercialRealityOf reject legs where the payer/buyer population/repeat is unreal, and do pathway constructions (askPathwayConstructions) fill the gap it names? | Correct as stated; failure observable as: Legs passing with a single-company buyer population; failing items vs pathway rounds opened. | **UNKNOWN** | — | UNPROVEN | server/services/goals/pathways.ts (commercialRealityOf use at 311, 795); server/services/goals/commercialReality.ts:commercialRealityOf (52) | — |
| C73-R | Does the result reach every component that needs it? | Does what Pathway constructions and commercial reality check (§116) decides reach the components downstream of server/services/goals/pathways.ts (commercialRealityOf use at 311, 795); server/services/goals/commercialReality.ts? | Its result is read where the plan is decided. | **UNKNOWN** | — | UNPROVEN | server/services/goals/pathways.ts (commercialRealityOf use at 311, 795); server/services/goals/commercialReality.ts:commercialRealityOf (52) | — |
| C73-I | Does the result change later decisions correctly? | Does a change in Pathway constructions and commercial reality check (§116)'s result change the plan reading? | The owner's plan changes when it does. | **UNKNOWN** | — | UNPROVEN | server/services/goals/pathways.ts (commercialRealityOf use at 311, 795); server/services/goals/commercialReality.ts:commercialRealityOf (52) | — |
| C73-F | Does Brain recognise and recover when it fails? | When Pathway constructions and commercial reality check (§116) fails (throws, returns nothing, or returns a wrong answer), is it detected and recovered? | The failure is recorded and the plan does not silently rest on it. | **UNKNOWN** | — | UNPROVEN | server/services/goals/pathways.ts (commercialRealityOf use at 311, 795); server/services/goals/commercialReality.ts:commercialRealityOf (52) | — |
| C73-X | Does it still work combined with the other capabilities? | Does Pathway constructions and commercial reality check (§116) still work combined with the route proposer, research and acceptance on a fresh goal? | The combined plan is consistent with it. | **UNKNOWN** | — | UNPROVEN | server/services/goals/pathways.ts (commercialRealityOf use at 311, 795); server/services/goals/commercialReality.ts:commercialRealityOf (52) | — |

### C74 Goal sprints and the industry kernel (Russell)

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C74-P | Can Brain perform it correctly? | Do sprintCandidate/activateGoalSprints and runIndustryKernel open rounds for the goals that need them, and do absorbed nodes/constraints/capital reach construction? | Correct as stated; failure observable as: Sprint events per live goal; kernel.opened/absorbed counts vs openings appearing in goalArrangements. | **UNKNOWN** | — | UNPROVEN | server/services/russell/goalSprint.ts:sprintCandidate (64), activateGoalSprints (95); server/services/russell/loop.ts:runIndustryKernel call (~2226) | — |
| C74-R | Does the result reach every component that needs it? | Does what Goal sprints and the industry kernel (Russell) decides reach the components downstream of server/services/russell/goalSprint.ts? | Its result is read where the plan is decided. | **UNKNOWN** | — | UNPROVEN | server/services/russell/goalSprint.ts:sprintCandidate (64), activateGoalSprints (95); server/services/russell/loop.ts:runIndustryKernel call (~2226) | — |
| C74-I | Does the result change later decisions correctly? | Does a change in Goal sprints and the industry kernel (Russell)'s result change the plan reading? | The owner's plan changes when it does. | **UNKNOWN** | — | UNPROVEN | server/services/russell/goalSprint.ts:sprintCandidate (64), activateGoalSprints (95); server/services/russell/loop.ts:runIndustryKernel call (~2226) | — |
| C74-F | Does Brain recognise and recover when it fails? | When Goal sprints and the industry kernel (Russell) fails (throws, returns nothing, or returns a wrong answer), is it detected and recovered? | The failure is recorded and the plan does not silently rest on it. | **UNKNOWN** | — | UNPROVEN | server/services/russell/goalSprint.ts:sprintCandidate (64), activateGoalSprints (95); server/services/russell/loop.ts:runIndustryKernel call (~2226) | — |
| C74-X | Does it still work combined with the other capabilities? | Does Goal sprints and the industry kernel (Russell) still work combined with the route proposer, research and acceptance on a fresh goal? | The combined plan is consistent with it. | **UNKNOWN** | — | UNPROVEN | server/services/russell/goalSprint.ts:sprintCandidate (64), activateGoalSprints (95); server/services/russell/loop.ts:runIndustryKernel call (~2226) | — |

### C75 Operator detection of stuck plans

| id | dimension | test | expected (pass condition) | status | evidence | proof the test detects its failure | component | root cause |
|---|---|---|---|---|---|---|---|---|
| C75-P | Can Brain perform it correctly? | Does stuckPlanDeficiencies detect readings unchanged for STUCK_PLAN_STALE_DAYS and does directorPass/reattempt act on them (commissionResearch) rather than only on engineering? | Correct as stated; failure observable as: Deficiency rows for stalled goals vs commissions/reattempts produced in the next pass. | **UNKNOWN** | — | UNPROVEN | server/services/operator/director.ts:stuckPlanDeficiencies (1513), directorPass (1044), reattempt (859), commissionResearch | — |
| C75-R | Does the result reach every component that needs it? | Does what Operator detection of stuck plans decides reach the components downstream of server/services/operator/director.ts? | Its result is read where the plan is decided. | **UNKNOWN** | — | UNPROVEN | server/services/operator/director.ts:stuckPlanDeficiencies (1513), directorPass (1044), reattempt (859), commissionResearch | — |
| C75-I | Does the result change later decisions correctly? | Does a change in Operator detection of stuck plans's result change the plan reading? | The owner's plan changes when it does. | **UNKNOWN** | — | UNPROVEN | server/services/operator/director.ts:stuckPlanDeficiencies (1513), directorPass (1044), reattempt (859), commissionResearch | — |
| C75-F | Does Brain recognise and recover when it fails? | When Operator detection of stuck plans fails (throws, returns nothing, or returns a wrong answer), is it detected and recovered? | The failure is recorded and the plan does not silently rest on it. | **UNKNOWN** | — | UNPROVEN | server/services/operator/director.ts:stuckPlanDeficiencies (1513), directorPass (1044), reattempt (859), commissionResearch | — |
| C75-X | Does it still work combined with the other capabilities? | Does Operator detection of stuck plans still work combined with the route proposer, research and acceptance on a fresh goal? | The combined plan is consistent with it. | **UNKNOWN** | — | UNPROVEN | server/services/operator/director.ts:stuckPlanDeficiencies (1513), directorPass (1044), reattempt (859), commissionResearch | — |

## D. Root causes and the failures they explain

### RC1 Model turn is not checked before it counts (model+software)

- **What is wrong:** A model turn is not checked before it counts. Two distinct mechanisms: (a) HTTP 524 after ~125 s — the GPU pod proxy closes a non-streamed connection idle for 100 s (exam pass 2: streaming served every one); (b) content "" with no error in 47–85 s — the output budget (2,500–4,000 tokens) is spent on hidden reasoning (RC16). An empty reply was never treated as a failed turn.
- **Owner of the correction:** server/services/goals/routeProposal.ts (ask/operatorChats), server/services/cheap/modelBench.ts
- **How a correction is proved:** Replay: on the same prompts, empty replies retried with a larger budget answer; production route asks record zero empty-reply fall-throughs.
- **Evidence:** 30Q test: gpt-oss empty on 6/12 route asks; 524 at ~125 s on 2/3 question asks; integration diagnosis: 4/8 primary failures.
- **Questions it explains (10):** C11-F, C23-P, C23-I, C23-F, C23-M, C39-P, C39-I, C41-P, C41-R, C41-I

### RC2 Critic veto is unchecked (SYMPTOM of RC17 (and RC14))

- **What is wrong:** The critic may drop any route on an assertion nothing verifies (date arithmetic, payment windows, fees the route never uses). Its word is final; when it drops all routes the owner gets no plan, even though the code can check most of what it asserts.
- **Owner of the correction:** routeProposal.ts critiquePrompt/applyCritique/critiqueAndRevise
- **How a correction is proved:** Re-run the logged critiques: a drop resting on a false window/fee/capital claim is overruled by the deterministic check; outputs with zero surviving routes fall from 9/12.
- **Evidence:** 30Q: critic dropped 14 of 18 parsed routes; >=4 on misreadings (net-30 outside 60 days; Dec 3-7 after a Feb window; a $5 fee not used; service agreement as payment risk). Integration diagnosis: 6/8 asks ended empty, p10 false WINDOW x3. | REVIEW 3: most cited misreadings were written by the fallback (laguna, 1/30) critiquing its own routes after one primary failure; the code-level veto weakness is real but secondary.
- **Questions it explains (15):** C05-P, C05-I, C05-F, C05-X, C08-R, C09-X, C26-P, C26-F, C26-X, C29-F, C29-X, C31-P, C31-I, C31-F, C31-X

### RC3 A standing operating rule is presented as the owner's own constraint (instruction)

- **What is wrong:** Brain's operating-model sentence and REMOTE_AI_FOCUS are injected into goal prompts beside the owner's limits; models copy them into the owner's refusals and discovery searches online-only work for owners who offered labour or own equipment. The goal-specific lift exists only in the route prompt and only when a regex matches. REVIEW 3 + fresh batch: the lift reached none of the prompts actually sent — every final 30Q prompt, the strong control's included, carried "run entirely online" for owners offering work; the phrase reader missed 14 of 30 fresh owners who stated hours.
- **Owner of the correction:** server/domain/operatingModel.ts; cash/discovery.ts (REMOTE_AI_FOCUS)
- **How a correction is proved:** Owner profiles in replies carry no refusal the owner did not state; discovery questions for an owner with stated labour/equipment are not online-only.
- **Evidence:** Integration diagnosis: 4/4 fallback replies invented refusals; 30Q p02 run 1 owner profile "no physical work" for a drone pilot. Partly repaired d5beaf6 (route prompt); discovery unchanged (code).
- **Questions it explains (9):** C01-X, C02-P, C02-F, C03-P, C03-R, C03-I, C07-P, C07-X, C11-P

### RC4 Verified findings are lost on the way to the planner (software)

- **What is wrong:** The proposer is shown at most 40 findings, newest first, with near-duplicates judged on the first 160 characters; refuted claims are not filtered; nothing selects findings by the decision they bear on.
- **Owner of the correction:** routeProposal.ts findingsOf/FINDINGS_SHOWN; repos/research.ts projectEvidenceClaims
- **How a correction is proved:** With all verified findings available, the planner's input holds every distinct verified finding (or a relevance-chosen set that covers every ground field), and a refuted claim is never shown.
- **Evidence:** 30Q: 40 of 111/111/135 delivered under the cap; uncapped near-dup filter dropped 6 and 9; graders attribute 3/12 failures to C. Code: refuted not filtered.
- **Questions it explains (6):** C06-R, C12-R, C19-I, C21-P, C21-X, C27-R

### RC5 Inquiry and direction-finding anchor on one menu (SYMPTOM of RC3)

- **What is wrong:** Question generation and scouting fix on a business shape before research (brokered digital tasks, dropshipping) and never ask whether the owner can be paid directly for what they can do now; follow-ups narrow onto the same shape.
- **Owner of the correction:** routeProposal.ts directionPrompt (and the questions framing that reuses it); discovery lenses
- **How a correction is proved:** Fresh goals: the question set and directions include the owner's direct means and at least three structurally different mechanisms; p06-type goals surface direct paid work.
- **Evidence:** 30Q: p06 60 questions all brokerage/digital; p10 60 questions dropshipping/ad-services; graders: strongest p06 path (owner as Tasker) found by no output. | REVIEW 3: the anchoring questions were written under a LIMITS block carrying the standing online-only rule.
- **Questions it explains (9):** C02-X, C03-X, C06-X, C07-P, C07-M, C08-X, C11-P, C11-X, C12-P

### RC6 Research supply is starved (information+infrastructure)

- **What is wrong:** Fragments are not executed, 69% of searches are refused, no keyed search provider is configured, Firecrawl is held to 15 credits/day, and the read-capable routine workers are not members of evaluation projects.
- **Owner of the correction:** research coordinator/queue; server/services/sources/*; owner items (keyed search key)
- **How a correction is proved:** A fresh goal's research completes its planned fragments and its plan reads >=20 relevant verified facts within the goal window.
- **Evidence:** RESEARCH-STARVATION-DIAGNOSIS: 1/16 fragments completed; 30Q traces: 0/1/0 completions after ~6 h; searches 785/1142 refused. Operator capacity 06:20-07:00Z (RC6 owner session_01QF5Tk5NBNTchKMwPJPQFEc): about 20 research fragments SUCCEEDED per hour Brain-wide; the GPU lane is held below its slot target (inFlight 3 of 8) by "database connections contended"; each restart holds the free lane at START_TARGET=2 for 10 min and resumes at half the saved target (16 restarts/24h, about 160 min/day); fragmentSearchRoom is 2 Brain-wide once Firecrawl hits its ceiling (34 CEILING vs 7 ANSWERED/24h; DDG 817 refused vs 416 answered). The free-lane database-saturation brake fired 253 times/24h while checkouts waited 0 ms p95, a false brake, corrected by #1342 (queue session). Projection: 30 goals x about 6 fragments = about 9 h for a first round.
- **Questions it explains (11):** C06-P, C06-F, C07-R, C10-I, C11-R, C13-P, C13-I, C14-X, C15-P, C15-X, C34-R

### RC7 No shared per-goal working state (coordination)

- **What is wrong:** Each faculty writes its conclusions to its own store; the next faculty re-derives or never reads them (rethink and calibration lessons, owner profile, committee questions, plan verdict and binding factor are not inputs to the route ask).
- **Owner of the correction:** goal plan reading + routeContext
- **How a correction is proved:** A route ask's context shows the previous ask's rethink, the plan verdict and binding factor, and open committee questions; a lesson recorded once changes the next ask.
- **Evidence:** Integration diagnosis §2 "present but unused" (code and production).
- **Questions it explains (13):** C02-R, C04-R, C19-R, C22-P, C22-R, C22-I, C22-F, C22-X, C35-F, C37-R, C37-I, C40-P, C40-R

### RC8 Route economics are left to the model (SYMPTOM of RC17/RC14 (code check is the safeguard))

- **What is wrong:** Nothing computes, before a route counts, whether its price x realistic volume reaches the target, whether paid acquisition at the cited cost per sale fits the capital, or whether the buyer count supports the sales needed; models get the arithmetic wrong in both directions (proposer optimistic, critic pessimistic).
- **Owner of the correction:** routeProposal.ts parseRoutes (routeHours already does hours)
- **How a correction is proved:** Logged routes: the 445-sales-from-$3k beanie route is flagged by code; a sound route is not. The critic sees the computed figures.
- **Evidence:** 30Q graders: p10 beanie routes (445 sales from $3,000 at $39 CPA), p02 critic multiplying CPL by an inflated buyer count, p06 invented $10/h subcontractor. | REVIEW 3: every concrete instance came from the fallback model.
- **Questions it explains (16):** C08-I, C09-P, C21-I, C24-P, C24-X, C25-P, C25-R, C25-F, C27-P, C27-I, C27-X, C28-P, C28-X, C31-R, C33-P, C34-X

### RC9 Mechanical rules drop instead of repairing (software)

- **What is wrong:** A route missing a descriptive field (ownerFit) is rejected outright, and the whole output can be lost; no repair is asked.
- **Owner of the correction:** routeProposal.ts parseRoutes
- **How a correction is proved:** A route missing only ownerFit is kept with the owner fit derived or asked once; no output is lost to it.
- **Evidence:** 30Q p10 round-1 uncapped: both routes rejected OWNER_FIT, owner handed nothing (category E).
- **Questions it explains (4):** C09-F, C30-P, C30-I, C30-F

### RC10 Knowledge links name no real segment (software)

- **What is wrong:** Sentence-fragment buyers are linked to Census/NAICS counts and the buyer question is closed as established.
- **Owner of the correction:** server/services/knowledge/apply.ts
- **How a correction is proved:** A fragment-shaped buyer gets an ESTIMATE that does not close the buyer question.
- **Evidence:** Integration diagnosis §2 (production knowledge view).
- **Questions it explains (4):** C20-P, C20-I, C20-F, C20-X

### RC11 No single selector (SYMPTOM of RC7 (no shared goal record))

- **What is wrong:** Six generators and four selectors produce competing "best" answers in one reading; nothing arbitrates.
- **Owner of the correction:** readGoalPlan
- **How a correction is proved:** One reading names one chosen strategy that acceptance, committee, report and operator all read.
- **Evidence:** Integration diagnosis §3 q6: four best answers, three binding diagnoses on wst_db2e.
- **Questions it explains (6):** C04-P, C04-X, C33-R, C33-I, C33-X, C42-X

### RC12 Readiness cannot be reached by research (CONTRADICTED as a cause of unusable plans (graders judged content, not acceptance state); kept as a readiness-signal defect)

- **What is wrong:** Plan acceptance needs every input evidenced at sample>=20 and p5 reach>=90%; research alone cannot move it, so "ready" is never signalled by a research-backed plan.
- **Owner of the correction:** goals/plan.ts judgeAcceptance
- **How a correction is proved:** A plan whose legs are each grounded by verified findings reaches an owner-usable readiness state distinct from the money-commitment gate.
- **Evidence:** BRAIN-FAILURE-DIAGNOSIS-2026-11-17 F1 (code).
- **Questions it explains (1):** C35-P

### RC13 The owner's plan is built from generic constructed arrangements that never read the owner (coordination+reasoning)

- **What is wrong:** Until route openings exist, readGoalPlan models the arrangement constructor's generic designs (fractional aircraft ownership, HVAC referral brokering) for every goal; the constructor and its research steps never read the owner's words, means or place, so the plan the owner is handed fits any request.
- **Owner of the correction:** cash/construct.ts / goals/plan.ts goalArrangements
- **How a correction is proved:** A fresh goal's plan reading names only strategies whose buyer, offer or means come from the owner's words or from the route proposer's owner-read routes.
- **Evidence:** Production read fm1126a f01 (Tulsa, pickup truck, weekends, $200): plan = 12 constructed estimates incl. "Fractional ownership of aircraft" and HVAC firms; steps = research their buyer counts. Integration diagnosis: owner words do not reach the constructor.
- **Questions it explains (6):** C04-X, C33-R, C33-I, C33-X, C36-P, C42-P

### RC14 The production reasoning models are below the bar the outcome needs (model)

- **What is wrong:** In isolation, on complete-information commercial questions, gpt-oss-120b answers 14/30 correctly, 4/11 commercial planning, 0/4 complete executable plans, with 61 evidence-interpretation errors; the fallback (laguna-xs-2.1) 1/30; Claude Opus 28/30, 10/11, 4/4. No prompt or software repair raises a model past its own ceiling.
- **Owner of the correction:** model selection: routeProposal strongRouteModels (BRAIN_ROUTE_MODEL + key), operator models
- **How a correction is proved:** Route asks served by a model that passes the commercial-planning exam (>=9/11) on the same prompts.
- **Evidence:** docs/model-exam-2026-11-26/REPORT.md (blind, 4 models, 30 questions, mechanical cross-check).
- **Questions it explains (10):** C02-M, C05-M, C07-M, C11-M, C24-M, C25-M, C31-M, C36-P, C41-R, C41-F

### RC15 The objective reader misses common phrasings (software)

- **What is wrong:** The regex reader has no reading for several ordinary ways people state a window, a spending cap, an hours rate or no time at all, so a goal is refused or carries a wrong limit into every later step.
- **Owner of the correction:** industry/construction/intent.ts readObjective
- **How a correction is proved:** Every goal of a fresh batch is read with the amount, window, capital and hours a person would read.
- **Evidence:** fm1126a create log: 4 of 30 refused, 3+ misread (see C01-P).
- **Questions it explains (1):** C01-P

### RC16 Output budgets too small for a reasoning model (software+model)

- **What is wrong:** Route, critique and direction asks gave gpt-oss-120b 2,500–4,000 max_tokens; hidden reasoning consumed them and the reply arrived empty or cut mid-JSON.
- **Owner of the correction:** routeProposal.ts (ROUTE_TOKENS)
- **How a correction is proved:** Production route asks show no empty or truncated primary replies; exam at 16,000 had 0/47 empty.
- **Evidence:** Root-cause challenge: empty replies in 47–85 s with error:null (planner/final_*.txt, probe1_*.txt); question replies cut mid-JSON (questions/*.raw.txt).
- **Questions it explains (1):** C23-R

### RC17 Model fall-through has no competence floor; the proposer critiques itself (coordination+model)

- **What is wrong:** After one primary failure the fallback combo (laguna-xs-2.1: 1/30, 0/11 planning, 19 critical errors) both proposed and critiqued; the critic order puts the proposing model first, so the check is not independent.
- **Owner of the correction:** routeProposal.ts operatorChats / critiqueAndRevise
- **How a correction is proved:** No route ask is answered or critiqued by a model below the planning bar; production route events show the fallback never serves.
- **Evidence:** Root-cause challenge: 6 of 12 probes and 2 of 3 question sets served by the fallback; routeProposal.ts "The model that proposed critiques first".
- **Questions it explains (3):** C25-P, C31-P, C41-F

### RC18 The evaluation was underpowered and its grading standard drifted (measurement)

- **What is wrong:** Three goals, one sample per arm, one grader per goal whose bar moved between days; the rubric had no cause categories separating model, research capacity, timing and code.
- **Owner of the correction:** evaluation (planningEval, grading rubric)
- **How a correction is proved:** 30 fresh goals on one frozen revision, graded blind with a fixed rubric that records a cause category per failure.
- **Evidence:** 30Q report: "Today's grader was stricter"; validity review on GRADING.md / GRADING-E2E.md.
- **Questions it explains (0):** —

### RC19 A goal's research never starts: its ideas are not judged within the goal's window (coordination+software)

- **What is wrong:** The tick's judge pass judged at most 5 goal ideas a tick under database pressure, ticks run many minutes when dozens of goal plans are read in sequence (30–40 s each), and the goal-idea queue held ideas of cancelled and paused goals (matched by how they were made, never by whether their goal still runs) ahead of live goals'. 30 fresh goals produced 605 ideas; none was judged in 1.5 h, so no mission, fragment or claim existed and every plan stayed on generic constructed estimates.
- **Owner of the correction:** russell/loop.ts judge-unjudged pass; goals/goalWork.ts goalIdeaSql
- **How a correction is proved:** On a fresh batch, each live goal's first ideas are judged within one tick and its first research fragments are queued within the hour.
- **Evidence:** planningEval judging (08:00Z): run ideas 605 CAPTURED unjudged, head of the goal queue created 05:56–06:08Z by the retired fm1126a and paused goals, updated_at = created_at; judge-one: one judgment 1.75 s; judge-pass: the pass body judged 18 in 20 s — so the pass works and is starved by budget and queue, not broken.
- **Questions it explains (4):** C10-R, C14-P, C14-I, C42-P

### RC20 A live goal's judged ideas never launch: the launch window ranks paused and ended goals' price questions and rounds as goal work (coordination+software)

- **What is wrong:** goalPriceSql and goalRoundSql (goals/goalWork.ts) named ideas as goal work by how they were made, never by whether their goal still runs, so in nextLaunchable's order (fits, goal tier, per-project turn, tier) paused and ended goals' price questions (tier 0) and rounds (tier 1) stood ahead of a live goal's dives and ideas (tiers 2-3). A tick fills 5-30 launches inside a 30 s budget and ticks run ~17 min, so the head was refilled from other projects every tick. The packet runner's plan-read boost used the same ungated predicate.
- **Owner of the correction:** goals/goalWork.ts goalPriceSql, goalRoundSql (read by russell/loop.ts nextLaunchable and research/packetRunner.ts servesGoalPlanRead)
- **How a correction is proved:** On a fresh batch, each live goal's judged ideas launch missions within a tick or two of being judged, and its first fragments run within the hour.
- **Evidence:** planningEval launching (09:45-09:55Z, dcc34fe): run 143 judged ideas, all with missionSpec, 30 grants at 6 free slots each, run ideas first at launch-window position 33, 0 run missions in 3 h; Brain-wide 31-86 missions an hour across 22-41 projects; 152 projects with 2483 launchable ideas. Isolated: tests/goalIdeasEachProjectsTurn 'launches a live goal's judged idea before a paused goal's judged price questions' fails on the unfixed predicate (paused price question first) and passes with the gate.
- **Questions it explains (1):** C14-R

## E. Repairs, owners and dependencies

| id | root cause | repair | owner | depends on | state | evidence |
|---|---|---|---|---|---|---|
| W1a | RC1 | askModel: an empty reply with no error is retried once with twice the token budget, then is an error; route asks, critiques and the eval probe use it. | routeProposal.ts | — | MERGED_PENDING_PRODUCTION | tests/planningFailureMapWave1.test.ts RC1 | PRs #1339/#1341 deployed; production verification pending the next batch |
| W1b | RC2 | Critic is shown exact computed economics and dates; told to REPAIR a disputed figure (re-checked by code) and DROP only for what no figure can fix; a drop resting only on WINDOW/CAPITAL is kept (ranked last) or re-checked as a repair. | routeProposal.ts critiquePrompt/applyCritique | W1c | MERGED_PENDING_PRODUCTION | tests RC2 | PRs #1339/#1341 deployed; production verification pending the next batch |
| W1c | RC8 | routeEconomics/economicsLine: margin after direct and buyer cost, sales needed, acquisition spend, owner hours, first-cash date; a route whose buyers cost at least what a sale earns is refused (ACQUISITION); proposer asked for acquisitionCostPerSale and selling time in owner hours. | routeProposal.ts parseRoutes | — | MERGED_PENDING_PRODUCTION | tests RC8 | PRs #1339/#1341 deployed; production verification pending the next batch |
| W1d | RC9 | A route missing ownerFit is kept with the gap stated for the critic. | routeProposal.ts parseRoutes | — | MERGED_PENDING_PRODUCTION | tests RC9; routeProposal.test.ts updated | PRs #1339/#1341 deployed; production verification pending the next batch |
| W1e | RC4 | Findings: 120 shown (was 40); near-duplicates judged on the whole statement; past the budget, lanes taken in turn; refuted claims filtered where read (projectEvidenceClaims) and where shown. | routeProposal.ts findingsOf; repos/research.ts | — | MERGED_PENDING_PRODUCTION | tests RC4 | PRs #1339/#1341 deployed; production verification pending the next batch |
| W1f | RC5 | Scouting and route asks: when the owner offers their own work, consider being paid directly first; named directions/routes must differ in who pays, for what, through which channel. | routeProposal.ts directionPrompt/routePrompt | — | MERGED_PENDING_PRODUCTION | tests RC5 | PRs #1339/#1341 deployed; production verification pending the next batch |
| W1g | RC3 | Discovery questions carry the online-only focus only when the goal offers no owner work; with an offer, the owner's direct paid work is searched first. | cash/discovery.ts discoveryFocusFor | — | MERGED_PENDING_PRODUCTION | tests RC3 | PRs #1339/#1341 deployed; production verification pending the next batch |
| W1h | RC7 | Each route ask reads the rethinks of earlier asks for the goal (lessons) instead of only recording them. | routeProposal.ts proposeGoalRoutes/evidenceSections | — | MERGED_PENDING_PRODUCTION | code; production pending | PRs #1339/#1341 deployed; production verification pending the next batch |
| W2a | RC6 | Research execution: fragments for goal research complete; search refusals; keyed search (owner key). | research coordinator; sources | owner: keyed search key | OPEN | — |
| W2b | RC10 | Knowledge links require a real segment; a fragment buyer gets an ESTIMATE that does not close the question. | knowledge/apply.ts | — | OPEN | — |
| W2c | RC11 | One selector: the plan reading's chosen strategy is the single answer read by acceptance, committee, report and operator. | readGoalPlan | W1 | OPEN | — |
| W2d | RC12 | An owner-usable readiness state for a research-grounded plan, separate from the money-commitment gate. | goals/plan.ts | W2c | OPEN | — |
| W2e | — | Convert the chosen route into an executable step plan (who, when, cost, first action, acceptance) on the owner surface (C36). | goals/arrangementSteps.ts / stepTitle | W2c | OPEN | — |
| W1i | RC15 | Objective reader: monthly figure with a start month (deadline end of that month), "more than" spending limits, bare spans ("about two weeks"), "N hours a week at most" read as a rate, "zero time"/"not going to do any of the work" as zero hours, "don't want to put any money in"/"nothing, no savings" as no capital. | intent.ts | — | MERGED_PENDING_PRODUCTION | tests/objectiveFreshPhrasings.test.ts; all 30 fm1126a goals read locally | PRs #1339/#1341 deployed; production verification pending the next batch |
| W1j | RC1 | chatFor streams every turn without tools, so reasoning past the 100 s proxy idle cut still answers. | cheap/modelBench.ts | — | MERGED_PENDING_PRODUCTION | tests/chatStreaming.test.ts; model exam pass 2 | PRs #1339/#1341 deployed; production verification pending the next batch |
| W3a | RC13 | The owner's plan must not be built from constructed arrangements that read nothing of the owner: route the owner's words and means into construction, or hold generic arrangements out of the owner plan until owner-fit is shown. | cash/construct.ts; goals/plan.ts (integration owner session_01QF5Tk7etm6MGmaFuHMd6eZ) | — | MERGED_PENDING_PRODUCTION | PR #1345 (8a2c568): a constructed design reaches a goal plan only if its precedent is one of that goal's own route openings; tests/ownerRoutesLeadConstruction.test.ts. Motivating production read: dev6 0/12 usable on a8c4699 (6 QUANT critical on generic arrangements, 6 no-candidate). |
| W3b | RC14 | A route and critique model that passes the commercial-planning exam: BRAIN_ROUTE_MODEL with an Anthropic key (owner), or the owner lifting the §84 reservation so Claude routines may plan goals. | owner decision; routeProposal strongRouteModels | owner | BLOCKED_MISSING_AUTHORITY | model exam |
| W2a | RC17 | Route asks, critiques and direction asks never use a model measured unfit (ROUTE_UNFIT_MODEL_LABELS: the fallback combo); with no fit model left the ask records NO_ANSWER and retries on the failure interval. | routeProposal.ts operatorChats; planningEval probe parity | — | MERGED_PENDING_PRODUCTION | tests/planningFailureMapWave2.test.ts; sensitivity C41-F | PR #1346 |
| W2b | RC16 | Output budgets 14,000 / 12,000 / 10,000 (route / direction / critique); attempt bound 300 s, ask budget 720 s. | routeProposal.ts ROUTE_TOKENS | W1j streaming | MERGED_PENDING_PRODUCTION | sensitivity C23-R | PR #1346 |
| W2c | RC3 | An owner who gives the goal hours has offered their work (ownerLabourWithHours), in route asks and discovery; "I can work all day / full time" read as an offer. | domain/operatingModel.ts; routeProposal routeContext; discovery | — | MERGED_PENDING_PRODUCTION | sensitivity C03-P; blind fixture 30/30 | PR #1346 |
| W2d | RC15 | Reader: negated "spend more than" only (own regression removed); a floor ("more than $600") never a ceiling; a named break is the window; a job's hours are not time given, the extra hours are. | intent.ts | — | MERGED_PENDING_PRODUCTION | tests/objectiveFreshBatchBlind.test.ts (blind readings, 30/30); sensitivity C01-* | PR #1346 |
| W2e | RC1 | A stream that ends without a finish reason or [DONE] is an error, not an answer. | modelBench.ts readStream | — | MERGED_PENDING_PRODUCTION | sensitivity C23-I | PR #1346 |
| W2f | RC2 | A route kept against the critic ranks after every route the critic kept (the earlier fixture hid that it did not). | routeProposal.ts applyCritique | — | MERGED_PENDING_PRODUCTION | sensitivity C31-X | PR #1346 |
| W2g | RC8 | Capital plus the first buyer's cost must fit the limit; the critic is told when the target needs reinvested proceeds; the critique prompt is tested to carry the computed line. | routeProposal.ts parseRoutes/economicsLine | — | MERGED_PENDING_PRODUCTION | sensitivity C25-X, C25-R | PR #1346 |
| W2h | RC18 | Fresh 30-goal evaluation on one frozen revision; blind graders with a fixed rubric recording a cause category per failure. | planningEval; GRADING-E2E | — | IN_PROGRESS | fm1126b created 06:24Z on a8c46995 |
| W2i | RC19 | Goal ideas are goal work only while their goal is live (goalIdeaSql: LIVE_GOAL_PROJECT_IDS_SQL); the judge pass judges up to 40 goal ideas a tick until a 45 s budget, halved under pressure instead of falling to 5. | goals/goalWork.ts; russell/loop.ts | — | DEPLOYED_PARTIAL | Deploy 45788180566 (dcc34fe) success. Judging on production: fm1126b 143 ideas judged WORTH_DOING with compiled missions by 09:40Z (was 0 at 08:00Z); 944 still unjudged behind other live eval goals. Judging works; launch does not (RC20). |
| W2j | RC20 | Every goal tier is a live goal's work: goalPriceSql and goalRoundSql are gated on liveGoalProjectSql (LIVE_GOAL_PROJECT_IDS_SQL), as goalIdeaSql and goalDiveSql already were; goalRoundsAwaitingLaunch keeps its reading. | goals/goalWork.ts | W2i | BRANCH_PENDING_DEPLOY | tests/goalIdeasEachProjectsTurn.test.ts known-bad fails without the gate, passes with it; test:impacted 117 passed; launch-window and price-priority suites 264 passed |

## F. Production evidence of repairs

- None verified on production yet.

## G. Remaining untested or unresolved requirements

C01-P, C01-I, C01-F, C01-X, C02-I, C02-M, C03-P, C03-I, C03-F, C04-I, C04-F, C05-I, C05-F, C06-P, C06-I, C06-F, C07-P, C07-I, C07-F, C08-P, C08-I, C08-F, C09-P, C09-I, C09-F, C10-P, C10-I, C10-F, C10-X, C11-F, C11-M, C12-X, C13-R, C13-F, C13-X, C14-F, C15-I, C15-F, C16-F, C17-R, C17-X, C18-P, C18-X, C19-P, C19-I, C19-F, C19-X, C21-P, C21-F, C21-X, C23-F, C23-X, C24-I, C24-F, C25-R, C25-I, C25-F, C25-X, C26-R, C26-I, C26-F, C26-X, C27-I, C27-F, C27-X, C28-R, C28-I, C28-F, C29-I, C29-X, C30-P, C30-F, C30-X, C31-R, C31-F, C31-M, C32-P, C32-R, C32-I, C32-X, C34-P, C34-R, C34-I, C34-F, C34-X, C35-R, C35-I, C35-X, C36-R, C36-I, C36-F, C36-X, C37-P, C37-R, C37-I, C37-F, C37-X, C38-R, C38-I, C38-X, C39-I, C39-F, C39-X, C40-I, C40-F, C40-X, C41-X, C42-I, C42-F, C43-P, C43-R, C43-I, C43-F, C43-X, C44-P, C44-R, C44-I, C44-F, C44-X, C45-P, C45-R, C45-I, C45-F, C45-X, C46-P, C46-R, C46-I, C46-F, C46-X, C47-P, C47-R, C47-I, C47-F, C47-X, C48-P, C48-R, C48-I, C48-F, C48-X, C49-P, C49-R, C49-I, C49-F, C49-X, C50-P, C50-R, C50-I, C50-F, C50-X, C51-P, C51-R, C51-I, C51-F, C51-X, C52-P, C52-R, C52-I, C52-F, C52-X, C53-P, C53-R, C53-I, C53-F, C53-X, C54-P, C54-R, C54-I, C54-F, C54-X, C55-P, C55-R, C55-I, C55-F, C55-X, C56-P, C56-R, C56-I, C56-F, C56-X, C57-P, C57-R, C57-I, C57-F, C57-X, C58-P, C58-R, C58-I, C58-F, C58-X, C59-P, C59-R, C59-I, C59-F, C59-X, C60-P, C60-R, C60-I, C60-F, C60-X, C61-P, C61-R, C61-I, C61-F, C61-X, C62-P, C62-R, C62-I, C62-F, C62-X, C63-P, C63-R, C63-I, C63-F, C63-X, C64-P, C64-R, C64-I, C64-F, C64-X, C65-P, C65-R, C65-I, C65-F, C65-X, C66-P, C66-R, C66-I, C66-F, C66-X, C67-P, C67-R, C67-I, C67-F, C67-X, C68-P, C68-R, C68-I, C68-F, C68-X, C69-P, C69-R, C69-I, C69-F, C69-X, C70-P, C70-R, C70-I, C70-F, C70-X, C71-P, C71-R, C71-I, C71-F, C71-X, C72-P, C72-R, C72-I, C72-F, C72-X, C73-P, C73-R, C73-I, C73-F, C73-X, C74-P, C74-R, C74-I, C74-F, C74-X, C75-P, C75-R, C75-I, C75-F, C75-X

## H. Measured progress toward 27/30 usable plans

| date | measure | usable | source |
|---|---|---|---|
| 2026-11-25 | dec1125c 10 goals, production | 0/10 | PLANNING-ROUTE-GENERATION-2026-11-25 |
| 2026-11-26 | 30Q test p02/p06/p10, 12 Brain outputs, blind | 0/3 goals (0/12 outputs); 3/12 credible-incomplete | INTELLIGENCE-TEST-30Q-2026-11-26 |
| 2026-11-26 06:24Z | fm1126b: 30 fresh goals created on frozen revision a8c46995; plans to be read and graded blind after research runs | pending | create log in scratchpad; read and grade to follow |
| 2026-11-26 08:10Z | fm1126b mid-run: research never started on any of 30 goals (RC19); the batch measures RC19, not planning. Acceptance restarts on a new frozen revision after wave 2 deploys. | n/a | judging, judge-one and judge-pass probes |
| 2026-11-26 09:30Z | fm1126b read on dcc34fe: 30/30 NO_CANDIDATE. Every goal holds 1-4 owner-fit openings (89 total, e.g. Tulsa truck: junk haul, delivery partner, holiday setup), all unpriced; 0 missions, 0 fragments, 0 claims for the run. | 0/30 | read_fm1126b_0926, stall, judging and launching probes; the blocker is launch, not planning (RC20) |
