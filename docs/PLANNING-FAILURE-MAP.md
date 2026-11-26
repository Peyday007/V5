# Planning failure map: the authoritative record

Rendered from `docs/planning-failure-map/map.py` by `render_md.py`; edit the data, never this file. `node scripts/planningFailureMapCheck.mjs` recomputes every count.

**Outcome the map is derived from:** A credible, researched, financially sound, executable plan that satisfies the owner's original objective inside every stated limit, graded USABLE by an independent grader.

## Summary

- Capabilities required: **42**
- Diagnostic questions (5 per capability, +1 model-isolation question for each of the 8 model-dependent ones): **218**
- PASS 27 · FAIL 85 · NEEDS RECHECK 32 · UNKNOWN 74
- Root causes established: **15**

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

Dimensions: **P** Can Brain perform it correctly?; **R** Does the result reach every component that needs it?; **I** Does the result change later decisions correctly?; **F** Does Brain recognise and recover when it fails?; **X** Does it still work combined with the other capabilities?; **M** Is a failure the model's own, or Brain's instructions/software? (model isolated on the identical input)

## B–C. Every diagnostic question and its status

### C01 Read the objective (amount, currency, window, capital, hours, recurrence, place)

| id | dimension | test | expected (pass condition) | status | evidence | component | root cause |
|---|---|---|---|---|---|---|---|
| C01-P | Can Brain perform it correctly? | Read 30 varied owner requests incl. "can't put any hours in", weekly vs total hours, "keeps going after". | Amount, window, capital and hours match a human reading; unknowns marked unread, never guessed. | **FAIL** | Fresh batch fm1126a (30 goals, production 4dcef5c-era reader): 4 refused (monthly figure with a start month x2, "spending more than $1,000", "about two weeks"), 1 read as OTHER ("go from nothing to $3,500 a month"), "3 hours a week at most" read as 3 hours total, "zero time" / "not going to do any of the work" read as no limit. Repaired W1i; recheck on the next batch. | industry/construction/intent.ts readObjective | RC15 |
| C01-R | Does the result reach every component that needs it? | Does the reading reach proposer, critic, planner, committee? | Same figures in every prompt and plan reading. | **PASS** | 30Q probe objective lines; plan readings use target. | goals/target.ts | — |
| C01-I | Does the result change later decisions correctly? | Change hours from 15 to 0 mid-course. | Next ask drops owner-performed routes. | **UNKNOWN** | — | planningEval update path | — |
| C01-F | Does Brain recognise and recover when it fails? | Ambiguous request ("some money soon"). | Goal flags the unread field as a question to the owner, plans nothing on a guess. | **UNKNOWN** | — | readObjective unread[] | — |
| C01-X | Does it still work combined with the other capabilities? | Objective reading + operating rule + labour offer on the same goal. | No contradiction between limits and owner offer in the prompt. | **NEEDS RECHECK** | p10 "zero hours" fixed d5beaf6; not re-run on fresh goals. | routeProposal limitLines | RC3 |

### C02 Read the owner's means without inventing them (skills, assets, licences, location, authority, refusals)

| id | dimension | test | expected (pass condition) | status | evidence | component | root cause |
|---|---|---|---|---|---|---|---|
| C02-P | Can Brain perform it correctly? | Owner profile in the reply for 30 requests. | Every skill/asset/refusal appears in the owner's words; "not stated" otherwise. | **FAIL** | 4/4 fallback replies invented refusals; p02 run-1 "no physical work". | route prompt STEP 1 | RC3 |
| C02-R | Does the result reach every component that needs it? | Is the profile stored and read by the next ask/critic/discovery? | One profile per goal, read by all. | **FAIL** | Integration diag: profile kept only in event detail, re-derived each ask. | routeProposal record | RC7 |
| C02-I | Does the result change later decisions correctly? | Owner states a licence; do routes sell the licensed work? | At least one route sells it. | **PASS** | p02: every output led with Part 107 aerial work. | ROUTE_RULES.OWNER_FIT | — |
| C02-F | Does Brain recognise and recover when it fails? | Profile contradicts owner words; is it corrected? | Code compares profile to words and drops inventions. | **FAIL** | No check exists (code). | ownerProfileOf | RC3 |
| C02-X | Does it still work combined with the other capabilities? | Owner with no stated skill + $0 + place. | Means = time, place; direct paid work considered. | **FAIL** | p06: no output proposed the owner's own paid work. | directionPrompt | RC5 |
| C02-M | Is a failure the model's own, or Brain's instructions/software? (model isolated on the identical input) | Same p06 prompt to the control model. | Control reads the owner correctly. | **PASS** | Model exam: given complete facts, Claude Opus reads constraints with 3 violations in 30; gpt-oss 8, fallback 22. The 4/4 invented refusals were the fallback's. | model | RC14 |

### C03 Resolve Brain's standing operating rule against the goal's own offer, once, as data

| id | dimension | test | expected (pass condition) | status | evidence | component | root cause |
|---|---|---|---|---|---|---|---|
| C03-P | Can Brain perform it correctly? | Owner offering labour/equipment: does every prompt state the lift? | Route prompt, discovery and gates agree. | **FAIL** | Route prompt fixed (d5beaf6); discovery still appends REMOTE_AI_FOCUS (discovery.ts:1304). | domain/operatingModel.ts | RC3 |
| C03-R | Does the result reach every component that needs it? | Do the three regex gates read the same resolution? | One resolution object read by all. | **FAIL** | Integration diag: regex re-implemented in goalScenario, worthResearching, answers. | operatingModel | RC3 |
| C03-I | Does the result change later decisions correctly? | Does the lift change discovery questions? | Discovery asks about in-person work when offered. | **FAIL** | Code: REMOTE_AI_FOCUS unconditional. | discovery.ts | RC3 |
| C03-F | Does Brain recognise and recover when it fails? | Regex misses an offer ("I can fly 20 h a week"). | A model-read offer or an explicit question; not silent refusal. | **NEEDS RECHECK** | p02 "fly about 20 hours" read as labour after ad40c37; unverified on fresh goals. | ownerLabourOffer | — |
| C03-X | Does it still work combined with the other capabilities? | Owner offer + zero capital + 7 days. | Owner-performed routes allowed and preferred when fastest. | **FAIL** | p06 final: no owner-performed route proposed. | route prompt | RC5 |

### C04 Keep one consistent understanding of the goal across faculties and time

| id | dimension | test | expected (pass condition) | status | evidence | component | root cause |
|---|---|---|---|---|---|---|---|
| C04-P | Can Brain perform it correctly? | Read one goal's plan, report and operator view at once. | Same chosen strategy and binding factor everywhere. | **FAIL** | wst_db2e: four "best" answers, three binding diagnoses. | readGoalPlan | RC11 |
| C04-R | Does the result reach every component that needs it? | Do lessons, refutations and committee questions reach the route ask? | Shown in routeContext. | **FAIL** | Integration diag (code). | routeContext | RC7 |
| C04-I | Does the result change later decisions correctly? | A refuted direction: is it proposed again? | Never in another wording. | **NEEDS RECHECK** | Last ask's CRITIQUE drops fed back (routeProposal ~1836); multi-ask effect unmeasured. | routeContext refuted | — |
| C04-F | Does Brain recognise and recover when it fails? | Goal changed by owner: are stale openings retired? | Openings inconsistent with new limits archived. | **UNKNOWN** | — | — | — |
| C04-X | Does it still work combined with the other capabilities? | Six generators feed one goal. | One arbitrated set; no contradictory openings. | **FAIL** | fm1126a f01: the plan reading is built from constructed arrangements while the route proposer's owner-read directions are not yet openings; two generators, no arbiter. | plan set | RC11,RC13 |

### C05 Calendar, season and window arithmetic

| id | dimension | test | expected (pass condition) | status | evidence | component | root cause |
|---|---|---|---|---|---|---|---|
| C05-P | Can Brain perform it correctly? | Critic/proposer judge "net 30 in a 60-day window", "Dec 3-7 in a window ending Feb 24". | Correct inside/outside. | **FAIL** | 30Q: both misread by the critic. | critic | RC2 |
| C05-R | Does the result reach every component that needs it? | Is the window end date in every prompt? | Explicit end date. | **PASS** | a1eba64 (windowEnd) present in final prompts. | limitLines | — |
| C05-I | Does the result change later decisions correctly? | Does a correct date change keep/drop? | Drops on window only when computed outside. | **FAIL** | No computed check (code). | applyCritique | RC2 |
| C05-F | Does Brain recognise and recover when it fails? | A wrong date claim: detected? | Code overrules. | **FAIL** | None (code). | applyCritique | RC2 |
| C05-X | Does it still work combined with the other capabilities? | Season + payment terms + delivery lead time combined. | Computed first-cash day inside window. | **FAIL** | p02/p10 critic errors. | critic | RC2 |
| C05-M | Is a failure the model's own, or Brain's instructions/software? (model isolated on the identical input) | Same critique prompt to the control model. | Control does the arithmetic right. | **FAIL** | Model exam: gpt-oss 8 and the fallback 22 constraint violations in 30, Claude 3; date and window arithmetic errors concentrate in the open models. | model | RC14 |

### C06 Know the local economic environment (buyers in the place, market conditions, season)

| id | dimension | test | expected (pass condition) | status | evidence | component | root cause |
|---|---|---|---|---|---|---|---|
| C06-P | Can Brain perform it correctly? | Plan cites local, dated market facts. | Demand facts are local and current. | **NEEDS RECHECK** | With supplied research yes (p02 listings, ARMLS); production research 0 facts. | research→findings | RC6 |
| C06-R | Does the result reach every component that needs it? | Do local facts reach the proposer? | Yes, within the findings budget. | **FAIL** | 40 cap. | findingsOf | RC4 |
| C06-I | Does the result change later decisions correctly? | Off-season facts drop seasonal routes? | Yes. | **NEEDS RECHECK** | p02 December listings drop found by follow-ups, not reflected in plans. | proposer | — |
| C06-F | Does Brain recognise and recover when it fails? | No local facts: does Brain ask for them? | Research asks local demand first. | **NEEDS RECHECK** | Questions did ask (p02 Q1, Q27); production does not execute. | questions | RC6 |
| C06-X | Does it still work combined with the other capabilities? | Local facts + owner means + window. | Fastest local buyers considered first. | **FAIL** | p06/p10 local options absent. | proposer | RC5 |

### C07 Discover opportunities without being given a strategy

| id | dimension | test | expected (pass condition) | status | evidence | component | root cause |
|---|---|---|---|---|---|---|---|
| C07-P | Can Brain perform it correctly? | Directions for 30 fresh goals. | Strongest evidence-supported path among those named in >=27/30. | **FAIL** | 30Q: strongest path named in 1/3 goals (p02); none p06. | directionPrompt/proposer | RC5 |
| C07-R | Does the result reach every component that needs it? | Do discovered directions reach research and the planner? | Each direction's decisive unknown is researched. | **FAIL** | Dives starved (RC6). | validation dives | RC6 |
| C07-I | Does the result change later decisions correctly? | Research refutes a direction: replaced? | Replacement direction differs structurally. | **NEEDS RECHECK** | Scout→refuted loop exists; starved. | scout loop | — |
| C07-F | Does Brain recognise and recover when it fails? | All directions refuted. | New directions from a different mechanism. | **UNKNOWN** | — | — | — |
| C07-X | Does it still work combined with the other capabilities? | Discovery + owner means + constraints. | No online-only bias for owners with physical means. | **FAIL** | discovery REMOTE_AI_FOCUS. | discovery | RC3 |
| C07-M | Is a failure the model's own, or Brain's instructions/software? (model isolated on the identical input) | Control model on the same direction prompt. | Control names the strongest path. | **FAIL** | Model exam commercial planning: Claude 10/11, gpt-oss 4/11, Qwen 1/11, fallback 0/11. 30Q control (Claude Sonnet, Brain's prompt) also missed p06's strongest path, so the prompt shares the failure (RC5). | prompt | RC14,RC5 |

### C08 Generate genuinely different approaches

| id | dimension | test | expected (pass condition) | status | evidence | component | root cause |
|---|---|---|---|---|---|---|---|
| C08-P | Can Brain perform it correctly? | Routes in one ask: distinct mechanisms/buyers. | >=2 structurally different where evidence allows. | **NEEDS RECHECK** | p02 final cap: 6 routes, 4 mechanisms; others 1 route. | proposer | — |
| C08-R | Does the result reach every component that needs it? | Distinct routes survive to the plan set. | Yes. | **FAIL** | Critic dropped most. | critic | RC2 |
| C08-I | Does the result change later decisions correctly? | Alternatives compared on computed economics. | Yes. | **FAIL** | No computed economics. | parseRoutes | RC8 |
| C08-F | Does Brain recognise and recover when it fails? | Only one route proposed: asked for more? | Replacement ask with different mechanism. | **NEEDS RECHECK** | Replacement ask exists; effect not visible in probes. | critiqueAndRevise | — |
| C08-X | Does it still work combined with the other capabilities? | Diversity + constraints + evidence. | Diverse and feasible. | **FAIL** | Outputs mostly single routes. | proposer | RC5 |

### C09 Pre-screen against hard limits (capital, hours, window, lawful)

| id | dimension | test | expected (pass condition) | status | evidence | component | root cause |
|---|---|---|---|---|---|---|---|
| C09-P | Can Brain perform it correctly? | Routes breaching capital/hours/window rejected by code. | Correctly rejected, no false rejects. | **NEEDS RECHECK** | Hours/margin rejections correct (30Q); capital/window not computed. | parseRoutes | RC8 |
| C09-R | Does the result reach every component that needs it? | Rejection reasons reach the next ask. | Yes. | **PASS** | replacementPrompt names failures; refuted list. | routeProposal | — |
| C09-I | Does the result change later decisions correctly? | Next ask avoids the breach. | Yes. | **UNKNOWN** | — | — | — |
| C09-F | Does Brain recognise and recover when it fails? | False reject (rule misfires). | Rule reports and route kept for review. | **FAIL** | OWNER_FIT missing-field drop. | parseRoutes | RC9 |
| C09-X | Does it still work combined with the other capabilities? | Pre-screen + critic. | No double-jeopardy contradictions. | **FAIL** | Critic contradicts code-passed routes on false grounds. | critic | RC2 |

### C10 Identify what must be known before choosing (decisive unknowns)

| id | dimension | test | expected (pass condition) | status | evidence | component | root cause |
|---|---|---|---|---|---|---|---|
| C10-P | Can Brain perform it correctly? | Each direction names its decisive unknown. | Specific, checkable, decision-bearing. | **PASS** | Directions carry decisiveUnknown (production SCOUT asks). | directionPrompt | — |
| C10-R | Does the result reach every component that needs it? | Unknown becomes the first research question. | Yes. | **NEEDS RECHECK** | routeValidationQuestion exists; execution starved. | validation.ts | RC6 |
| C10-I | Does the result change later decisions correctly? | Answer to unknown keeps/kills the direction. | Yes. | **NEEDS RECHECK** | Loop starved. | scout loop | RC6 |
| C10-F | Does Brain recognise and recover when it fails? | Unknown unanswerable: recognised? | Marked and replaced. | **UNKNOWN** | — | — | — |
| C10-X | Does it still work combined with the other capabilities? | Unknowns across directions de-duplicated. | Yes. | **UNKNOWN** | — | — | — |

### C11 Ask useful, non-anchored research questions

| id | dimension | test | expected (pass condition) | status | evidence | component | root cause |
|---|---|---|---|---|---|---|---|
| C11-P | Can Brain perform it correctly? | 30 questions per goal from the owner's words. | Distinct, specific, cover means/buyers/price/channel/fulfilment/cash/legal; not anchored. | **FAIL** | 30Q: p06/p10 anchored on brokerage/dropshipping; p02 good. | directionPrompt framing | RC5 |
| C11-R | Does the result reach every component that needs it? | Questions become research work. | Each question queued with a decision. | **FAIL** | Production executes ~6%. | research queue | RC6 |
| C11-I | Does the result change later decisions correctly? | Answers change routes. | Yes. | **PASS** | 30Q: facts killed Upwork/Fiverr/dropship routes. | proposer | — |
| C11-F | Does Brain recognise and recover when it fails? | Model fails to answer (timeout/unparsed). | Retried, salvaged. | **NEEDS RECHECK** | Questions command salvages; production route path unchanged. | ask | RC1 |
| C11-X | Does it still work combined with the other capabilities? | Questions + owner means. | Ask how owner can be paid directly. | **FAIL** | p06. | directionPrompt | RC5 |
| C11-M | Is a failure the model's own, or Brain's instructions/software? (model isolated on the identical input) | Control model on the question prompt. | Less anchored. | **NEEDS RECHECK** | Not run on the question prompt; the model exam's evidence-interpretation errors (gpt-oss 61, Claude 1) predict the gap. | model | RC14 |

### C12 Prioritise follow-ups and stop when research cannot change the decision

| id | dimension | test | expected (pass condition) | status | evidence | component | root cause |
|---|---|---|---|---|---|---|---|
| C12-P | Can Brain perform it correctly? | Follow-ups after findings. | Decision-bearing, not already answered. | **FAIL** | 30Q: 35/90 follow-ups already answered or no decision value; narrow. | questions follow-up | RC5 |
| C12-R | Does the result reach every component that needs it? | Follow-up answers reach the planner. | Yes, ahead of older ones. | **FAIL** | Newest-first cap displaced key older facts (p10). | findingsOf | RC4 |
| C12-I | Does the result change later decisions correctly? | Follow-ups change the plan. | Yes when material. | **FAIL** | Final grades no better than round 1. | proposer | — |
| C12-F | Does Brain recognise and recover when it fails? | No answer found: stops? | Records and stops. | **PASS** | Workers recorded UNANSWERED honestly. | workers | — |
| C12-X | Does it still work combined with the other capabilities? | Follow-ups + selection. | Questions target the chosen strategy's weakest leg. | **NEEDS RECHECK** | Partly (p02 insurance, seasonality). | — | — |

### C13 Search provider availability and capacity

| id | dimension | test | expected (pass condition) | status | evidence | component | root cause |
|---|---|---|---|---|---|---|---|
| C13-P | Can Brain perform it correctly? | Searches answered per day. | Enough for planned questions. | **FAIL** | 785/1142 refused; Firecrawl 7/day; no keyed search. | sources/* | RC6 |
| C13-R | Does the result reach every component that needs it? | Results reach workers. | Yes. | **UNKNOWN** | — | — | — |
| C13-I | Does the result change later decisions correctly? | Capacity allocated by decision value. | Yes. | **UNKNOWN** | — | — | — |
| C13-F | Does Brain recognise and recover when it fails? | Provider refuses: falls back. | Yes. | **NEEDS RECHECK** | DDG lite/html fallback; still 69% refused. | sources | — |
| C13-X | Does it still work combined with the other capabilities? | Capacity under 18+ goals. | Shared fairly. | **NEEDS RECHECK** | 585d3fb shares capacity; unmeasured. | — | — |

### C14 Research work executes (fragments complete)

| id | dimension | test | expected (pass condition) | status | evidence | component | root cause |
|---|---|---|---|---|---|---|---|
| C14-P | Can Brain perform it correctly? | Fragments completed in 6 h. | >=80%. | **FAIL** | 1/18 (30Q traces). | research coordinator | RC6 |
| C14-R | Does the result reach every component that needs it? | Completed fragments file claims. | Yes. | **PASS** | p06 3 claims filed. | gate | — |
| C14-I | Does the result change later decisions correctly? | Queue ordered by decision value. | Yes. | **UNKNOWN** | — | — | — |
| C14-F | Does Brain recognise and recover when it fails? | Fragment faults: retried elsewhere. | Yes. | **NEEDS RECHECK** | #1018 class fixes; unmeasured here. | — | — |
| C14-X | Does it still work combined with the other capabilities? | Execution under contention with other goals. | Goal research not starved. | **FAIL** | 2,063 waiting beside 278 free slots. | — | RC6 |

### C15 Open and read the pages

| id | dimension | test | expected (pass condition) | status | evidence | component | root cause |
|---|---|---|---|---|---|---|---|
| C15-P | Can Brain perform it correctly? | Pages read per page found. | High. | **FAIL** | Production 21%; session workers 70-80%. | sources reader | RC6 |
| C15-R | Does the result reach every component that needs it? | Read text reaches extraction. | Yes. | **UNKNOWN** | — | — | — |
| C15-I | Does the result change later decisions correctly? | Unreadable source marked unresolved, not rejected. | Yes. | **PASS** | Retrieval state contract. | gate | — |
| C15-F | Does Brain recognise and recover when it fails? | Blocked site: alternative source. | Yes. | **NEEDS RECHECK** | Workers did; production unknown. | — | — |
| C15-X | Does it still work combined with the other capabilities? | Reading + capacity. | Within credits. | **FAIL** | Firecrawl 15/day. | — | RC6 |

### C16 Extract claims with exact citations

| id | dimension | test | expected (pass condition) | status | evidence | component | root cause |
|---|---|---|---|---|---|---|---|
| C16-P | Can Brain perform it correctly? | Claims carry URL, quote, date, lane. | Yes. | **PASS** | 30Q: 100% of facts had URL+quote. | workers/gate | — |
| C16-R | Does the result reach every component that needs it? | Claims reach findings. | Yes. | **UNKNOWN** | — | — | — |
| C16-I | Does the result change later decisions correctly? | Lane decides which figure a fact can ground. | Yes. | **PASS** | GROUND_LANES (9fb993c). | groundsOf | — |
| C16-F | Does Brain recognise and recover when it fails? | Claim without source rejected. | Yes. | **PASS** | Gate contract. | gate | — |
| C16-X | Does it still work combined with the other capabilities? | Extraction + verification. | Yes. | **UNKNOWN** | — | — | — |

### C17 Verify that the evidence supports the claim

| id | dimension | test | expected (pass condition) | status | evidence | component | root cause |
|---|---|---|---|---|---|---|---|
| C17-P | Can Brain perform it correctly? | Quote present in the re-read page. | >=85%. | **PASS** | 30Q: 329/428 verified (77%); remainder held back, none delivered. | tools/verify.py (eval) / gate | — |
| C17-R | Does the result reach every component that needs it? | Only verified claims delivered. | Yes. | **NEEDS RECHECK** | True in eval; production gate checks source, not quote presence. | gate | — |
| C17-I | Does the result change later decisions correctly? | Unverified claim cannot ground a figure. | Yes. | **UNKNOWN** | — | — | — |
| C17-F | Does Brain recognise and recover when it fails? | Paraphrased quote detected. | Yes. | **PASS** | Verifier caught 32 NOT_FOUND. | verify | — |
| C17-X | Does it still work combined with the other capabilities? | Verification + capacity. | Cheap. | **PASS** | Re-read cache. | — | — |

### C18 Type the evidence (what it establishes: lane, scope exact/comparable, place, date)

| id | dimension | test | expected (pass condition) | status | evidence | component | root cause |
|---|---|---|---|---|---|---|---|
| C18-P | Can Brain perform it correctly? | Lanes assigned correctly. | Yes. | **NEEDS RECHECK** | Workers assigned lanes; not audited. | workers | — |
| C18-R | Does the result reach every component that needs it? | Lane reaches groundsOf. | Yes. | **PASS** | 9fb993c. | groundsOf | — |
| C18-I | Does the result change later decisions correctly? | Mis-scoped fact rejected as grounds. | Yes. | **PASS** | GROUND_LANES test. | groundsOf | — |
| C18-F | Does Brain recognise and recover when it fails? | Consumer fact cited for B2B channel: caught? | Yes. | **FAIL** | p10 grader: consumer fact cited for B2B channel. | groundsOf | — |
| C18-X | Does it still work combined with the other capabilities? | Typing + critic. | Critic checks scope. | **UNKNOWN** | — | — | — |

### C19 Combine facts and detect contradictions

| id | dimension | test | expected (pass condition) | status | evidence | component | root cause |
|---|---|---|---|---|---|---|---|
| C19-P | Can Brain perform it correctly? | Route contradicted by a shown fact is dropped. | Yes. | **NEEDS RECHECK** | Upwork/Fiverr payout facts killed brokerage (correct); p10 CPA facts ignored by proposer. | critic/proposer | — |
| C19-R | Does the result reach every component that needs it? | Knowledge contradictions reach planning. | Yes. | **FAIL** | Display only (integration diag). | knowledge | RC7 |
| C19-I | Does the result change later decisions correctly? | Refuted claims never shown. | Yes. | **FAIL** | projectEvidenceClaims ignores contradiction_state (code). | repos/research.ts | RC4 |
| C19-F | Does Brain recognise and recover when it fails? | Contradiction resolved by better source. | Yes. | **UNKNOWN** | — | — | — |
| C19-X | Does it still work combined with the other capabilities? | Contradiction + selection. | Yes. | **UNKNOWN** | — | — | — |

### C20 Knowledge library matching (buyer identity, counts)

| id | dimension | test | expected (pass condition) | status | evidence | component | root cause |
|---|---|---|---|---|---|---|---|
| C20-P | Can Brain perform it correctly? | Fragment buyers linked to NAICS counts? | Never as established. | **FAIL** | Integration diag. | knowledge/apply.ts | RC10 |
| C20-R | Does the result reach every component that needs it? | Counts reach arrangements. | Only real segments. | **UNKNOWN** | — | — | — |
| C20-I | Does the result change later decisions correctly? | A false count redirects research. | No. | **UNKNOWN** | — | — | — |
| C20-F | Does Brain recognise and recover when it fails? | Mismatch detected. | Yes. | **FAIL** | None. | — | RC10 |
| C20-X | Does it still work combined with the other capabilities? | Library + route proposer. | Library facts available to routes. | **UNKNOWN** | — | — | — |

### C21 Deliver verified findings into the proposer's reasoning input

| id | dimension | test | expected (pass condition) | status | evidence | component | root cause |
|---|---|---|---|---|---|---|---|
| C21-P | Can Brain perform it correctly? | Findings shown vs verified. | All distinct verified, or a relevance-chosen set covering every ground field. | **FAIL** | 40/111, 40/111, 40/135. | findingsOf | RC4 |
| C21-R | Does the result reach every component that needs it? | Findings reach the critic too. | Yes. | **PASS** | critiquePrompt includes findings. | critiquePrompt | — |
| C21-I | Does the result change later decisions correctly? | Shown findings used correctly. | Yes. | **FAIL** | 8/12 D. | proposer | RC8 |
| C21-F | Does Brain recognise and recover when it fails? | Prompt too long / truncated. | Budgeted, not silently cut. | **NEEDS RECHECK** | Prompts 35 KB ok. | — | — |
| C21-X | Does it still work combined with the other capabilities? | Delivery + dedupe + refuted filter. | No verified finding lost. | **FAIL** | 160-char dedupe dropped 6/9. | findingsOf | RC4 |

### C22 Deliver findings and conclusions to other faculties (constructor, committee, dives, report, operator)

| id | dimension | test | expected (pass condition) | status | evidence | component | root cause |
|---|---|---|---|---|---|---|---|
| C22-P | Can Brain perform it correctly? | Constructor reads research. | Yes. | **FAIL** | 11-17 F2 (code). | goalScenario | RC7 |
| C22-R | Does the result reach every component that needs it? | Committee questions answered. | Yes. | **FAIL** | answeredBy [] (production). | committee | RC7 |
| C22-I | Does the result change later decisions correctly? | Plan verdict reaches route ask. | Yes. | **FAIL** | heldTitles only. | plan.ts:5877 | RC7 |
| C22-F | Does Brain recognise and recover when it fails? | Missed handoff detected. | Yes. | **FAIL** | Report sees repetition; operator does not act. | — | RC7 |
| C22-X | Does it still work combined with the other capabilities? | All faculties on one record. | Yes. | **UNKNOWN** | — | — | RC7 |

### C23 A model turn returns a valid answer (no empty/timeout/unparseable fall-through)

| id | dimension | test | expected (pass condition) | status | evidence | component | root cause |
|---|---|---|---|---|---|---|---|
| C23-P | Can Brain perform it correctly? | Primary model answers route asks. | >=95% valid. | **FAIL** | gpt-oss 6/12 empty. | ask/operatorChats | RC1 |
| C23-R | Does the result reach every component that needs it? | Valid answer used; failed answer retried. | Yes. | **FAIL** | Falls to weaker model. | ask | RC1 |
| C23-I | Does the result change later decisions correctly? | Fallback quality equals primary. | Yes. | **FAIL** | Fallback invented refusals. | — | RC1 |
| C23-F | Does Brain recognise and recover when it fails? | Empty content treated as error and retried with larger budget. | Yes. | **FAIL** | Code: error null on empty. | ask | RC1 |
| C23-X | Does it still work combined with the other capabilities? | Model answers under concurrent load. | Yes. | **UNKNOWN** | — | — | — |
| C23-M | Is a failure the model's own, or Brain's instructions/software? (model isolated on the identical input) | Same prompt, larger max_tokens. | Answers. | **PASS** | Model exam: re-asked with streaming, gpt-oss served 30/30; the empty replies are the proxy idle cut, not the model (repaired W1j). | model | RC1 |

### C24 Propose routes that use the evidence correctly

| id | dimension | test | expected (pass condition) | status | evidence | component | root cause |
|---|---|---|---|---|---|---|---|
| C24-P | Can Brain perform it correctly? | Routes cite findings that state the figure. | Yes. | **FAIL** | Mis-citations (p10 F2 for price; consumer fact for B2B). | proposer | RC8 |
| C24-R | Does the result reach every component that needs it? | Proposed routes reach critic and plan. | Yes. | **UNKNOWN** | — | — | — |
| C24-I | Does the result change later decisions correctly? | Evidence changes route choice. | Yes. | **NEEDS RECHECK** | Partly (p02 prices; p06 escrow). | — | — |
| C24-F | Does Brain recognise and recover when it fails? | Route contradicted by a fact: dropped by code or critic. | Yes. | **UNKNOWN** | — | — | — |
| C24-X | Does it still work combined with the other capabilities? | Evidence + limits + owner means. | All three respected. | **FAIL** | p06 invented subcontractor. | proposer | RC8 |
| C24-M | Is a failure the model's own, or Brain's instructions/software? (model isolated on the identical input) | Control model on identical prompt. | Better use. | **FAIL** | Model exam evidence interpretation: gpt-oss 1.00/2, Claude 1.93/2; 30Q control 0/3 usable but best evidence hygiene. | model | RC14 |

### C25 Quantitative and causal economics (price x volume, CAC vs capital, margin, hours, reach)

| id | dimension | test | expected (pass condition) | status | evidence | component | root cause |
|---|---|---|---|---|---|---|---|
| C25-P | Can Brain perform it correctly? | Route reach computed vs target. | Correct. | **FAIL** | 445 sales from $3k at $39 CPA. | parseRoutes | RC8 |
| C25-R | Does the result reach every component that needs it? | Computed figures shown to critic and owner. | Yes. | **FAIL** | Only hours computed. | — | RC8 |
| C25-I | Does the result change later decisions correctly? | Under-reaching route flagged/fixed. | Yes. | **UNKNOWN** | — | — | — |
| C25-F | Does Brain recognise and recover when it fails? | Arithmetic error detected. | Yes. | **FAIL** | None. | — | RC8 |
| C25-X | Does it still work combined with the other capabilities? | Economics + timing + capital. | Consistent. | **UNKNOWN** | — | — | — |
| C25-M | Is a failure the model's own, or Brain's instructions/software? (model isolated on the identical input) | Control on arithmetic. | Correct. | **FAIL** | Model exam reasoning correctness: gpt-oss 1.13/2, fallback 0.23, Claude 1.97; mechanical key numbers gpt-oss 7/9. | model | RC14 |

### C26 Payment terms and time to collected cash

| id | dimension | test | expected (pass condition) | status | evidence | component | root cause |
|---|---|---|---|---|---|---|---|
| C26-P | Can Brain perform it correctly? | Collected-cash day computed from payout facts. | Correct. | **FAIL** | p06 routes ignored 10/14-day holds; critic misread net-30. | proposer/critic | RC2 |
| C26-R | Does the result reach every component that needs it? | Payout facts shown. | Yes. | **UNKNOWN** | — | — | — |
| C26-I | Does the result change later decisions correctly? | Settlement fact rules routes in/out. | Yes. | **NEEDS RECHECK** | Correct kills on p06. | — | — |
| C26-F | Does Brain recognise and recover when it fails? | Misread timing corrected. | Yes. | **UNKNOWN** | — | — | RC2 |
| C26-X | Does it still work combined with the other capabilities? | Timing + window + platform. | Yes. | **UNKNOWN** | — | — | RC2 |

### C27 Buyer discovery and acquisition channel reasoning

| id | dimension | test | expected (pass condition) | status | evidence | component | root cause |
|---|---|---|---|---|---|---|---|
| C27-P | Can Brain perform it correctly? | Channel can produce needed buyers in window on budget. | Yes. | **FAIL** | Passive channels (ARMLS listing), cold email at 0.45% for 6 buyers in 7 days. | proposer | RC8 |
| C27-R | Does the result reach every component that needs it? | Channel cost facts shown. | Yes. | **FAIL** | Cut by cap (p02 FB CPL, p10 cold-email cost). | findingsOf | RC4 |
| C27-I | Does the result change later decisions correctly? | Channel cost changes volume. | Yes. | **UNKNOWN** | — | — | RC8 |
| C27-F | Does Brain recognise and recover when it fails? | Channel inadequate: replaced. | Yes. | **UNKNOWN** | — | — | — |
| C27-X | Does it still work combined with the other capabilities? | Channel + capital + hours. | Yes. | **UNKNOWN** | — | — | RC8 |

### C28 Fulfilment and subcontractor reasoning

| id | dimension | test | expected (pass condition) | status | evidence | component | root cause |
|---|---|---|---|---|---|---|---|
| C28-P | Can Brain perform it correctly? | Named fulfiller with evidenced cost. | Yes. | **FAIL** | Invented $10/h VA; unnamed subcontractor. | proposer | RC8 |
| C28-R | Does the result reach every component that needs it? | Fulfiller facts shown. | Yes. | **UNKNOWN** | — | — | — |
| C28-I | Does the result change later decisions correctly? | Fulfiller cost sets margin. | Yes. | **PASS** | MARGIN rule worked (p06). | parseRoutes | — |
| C28-F | Does Brain recognise and recover when it fails? | No fulfiller: route repaired or dropped. | Yes. | **UNKNOWN** | — | — | — |
| C28-X | Does it still work combined with the other capabilities? | Fulfilment + zero owner hours. | Selling/managing also delegated. | **FAIL** | p10 nobody takes sales calls. | proposer | RC8 |

### C29 Legal and platform-terms reasoning

| id | dimension | test | expected (pass condition) | status | evidence | component | root cause |
|---|---|---|---|---|---|---|---|
| C29-P | Can Brain perform it correctly? | Surveying licence, platform rules, business licence. | Correct. | **PASS** | p02 survey law flagged; Marketplace services ban found. | critic | — |
| C29-R | Does the result reach every component that needs it? | Legal facts reach critic. | Yes. | **UNKNOWN** | — | — | — |
| C29-I | Does the result change later decisions correctly? | Legal fact drops route. | Yes. | **PASS** | Construction surveying dropped. | — | — |
| C29-F | Does Brain recognise and recover when it fails? | Over-strict legal veto (license cost as capital breach). | Distinguish payable-from-proceeds. | **FAIL** | p06 $73 licence used to drop. | critic | RC2 |
| C29-X | Does it still work combined with the other capabilities? | Legal + capital + timing. | Yes. | **UNKNOWN** | — | — | RC2 |

### C30 Parser and mechanical validation (correct rejections; repair, not loss)

| id | dimension | test | expected (pass condition) | status | evidence | component | root cause |
|---|---|---|---|---|---|---|---|
| C30-P | Can Brain perform it correctly? | Rejections correct. | Yes. | **NEEDS RECHECK** | Hours/margin correct; OWNER_FIT missing-field incorrect. | parseRoutes | RC9 |
| C30-R | Does the result reach every component that needs it? | Rejections recorded. | Yes. | **UNKNOWN** | — | — | — |
| C30-I | Does the result change later decisions correctly? | Rejected route repaired once. | Yes. | **FAIL** | No repair. | — | RC9 |
| C30-F | Does Brain recognise and recover when it fails? | Whole output lost to a field rule. | Never. | **FAIL** | p10 R1 all. | — | RC9 |
| C30-X | Does it still work combined with the other capabilities? | Parser + critic + replacement. | Yes. | **UNKNOWN** | — | — | — |

### C31 Criticise correctly (drop only on verified grounds)

| id | dimension | test | expected (pass condition) | status | evidence | component | root cause |
|---|---|---|---|---|---|---|---|
| C31-P | Can Brain perform it correctly? | Critic drops only routes that truly fail. | Yes. | **FAIL** | >=4 false drops; 14/18 dropped. | critic | RC2 |
| C31-R | Does the result reach every component that needs it? | Critic sees findings and computed figures. | Yes. | **FAIL** | No computed figures. | — | RC8 |
| C31-I | Does the result change later decisions correctly? | A drop leads to a better route. | Yes. | **FAIL** | Outputs end with nothing. | — | RC2 |
| C31-F | Does Brain recognise and recover when it fails? | False drop detected and overruled. | Yes. | **FAIL** | None. | — | RC2 |
| C31-X | Does it still work combined with the other capabilities? | Critic + parser + replacement. | At least one usable route survives when one exists. | **FAIL** | 9/12 outputs no plan. | — | RC2 |
| C31-M | Is a failure the model's own, or Brain's instructions/software? (model isolated on the identical input) | Control model as critic on the same routes. | Fewer false drops. | **NEEDS RECHECK** | Not run as critic; exam constraint and evidence errors predict false drops from open models. | model | RC14 |

### C32 Revise after critique (replacement routes)

| id | dimension | test | expected (pass condition) | status | evidence | component | root cause |
|---|---|---|---|---|---|---|---|
| C32-P | Can Brain perform it correctly? | Replacement ask runs when nothing survives. | Yes. | **UNKNOWN** | Not visible in probe. | critiqueAndRevise | — |
| C32-R | Does the result reach every component that needs it? | Replacements critiqued. | Yes. | **UNKNOWN** | — | — | — |
| C32-I | Does the result change later decisions correctly? | Replacement better. | Yes. | **UNKNOWN** | — | — | — |
| C32-F | Does Brain recognise and recover when it fails? | Replacement fails: recorded. | Yes. | **UNKNOWN** | — | — | — |
| C32-X | Does it still work combined with the other capabilities? | Revision + economics. | Yes. | **UNKNOWN** | — | — | — |

### C33 Compare and select one strategy

| id | dimension | test | expected (pass condition) | status | evidence | component | root cause |
|---|---|---|---|---|---|---|---|
| C33-P | Can Brain perform it correctly? | Ranking follows computed economics and evidence. | Yes. | **FAIL** | Critic scores; no economics. | applyCritique | RC8 |
| C33-R | Does the result reach every component that needs it? | Chosen strategy read by planner/committee/report. | Yes. | **UNKNOWN** | — | — | RC11 |
| C33-I | Does the result change later decisions correctly? | Selection changes plan reading. | Yes. | **UNKNOWN** | — | — | RC11 |
| C33-F | Does Brain recognise and recover when it fails? | Tie or none: says so. | Yes. | **UNKNOWN** | — | — | — |
| C33-X | Does it still work combined with the other capabilities? | Selection across generators. | One arbiter. | **UNKNOWN** | — | — | RC11 |

### C34 Identify risks and invalid assumptions

| id | dimension | test | expected (pass condition) | status | evidence | component | root cause |
|---|---|---|---|---|---|---|---|
| C34-P | Can Brain perform it correctly? | Assumptions named per route. | Yes. | **PASS** | routes carry assumptions. | proposer | — |
| C34-R | Does the result reach every component that needs it? | Assumptions become research. | Yes. | **NEEDS RECHECK** | searches field exists; execution starved. | — | RC6 |
| C34-I | Does the result change later decisions correctly? | Disproved assumption drops/repairs route. | Yes. | **UNKNOWN** | — | — | — |
| C34-F | Does Brain recognise and recover when it fails? | Hidden assumption surfaced by critic. | Yes. | **UNKNOWN** | — | — | — |
| C34-X | Does it still work combined with the other capabilities? | Risk + economics. | Sensitivity shown. | **UNKNOWN** | — | — | RC8 |

### C35 Know when a plan is ready (and when more research is needed)

| id | dimension | test | expected (pass condition) | status | evidence | component | root cause |
|---|---|---|---|---|---|---|---|
| C35-P | Can Brain perform it correctly? | Readiness of a research-backed plan. | Reachable. | **FAIL** | Acceptance unattainable by research (11-17 F1). | judgeAcceptance | RC12 |
| C35-R | Does the result reach every component that needs it? | Readiness shown to owner. | Yes. | **UNKNOWN** | — | — | — |
| C35-I | Does the result change later decisions correctly? | Not-ready names the next research. | Yes. | **NEEDS RECHECK** | Plan "missing" lists exist. | plan.ts | — |
| C35-F | Does Brain recognise and recover when it fails? | Stalled readiness detected. | Yes. | **FAIL** | Report sees 12-hour repetition; nothing acts. | — | RC7 |
| C35-X | Does it still work combined with the other capabilities? | Readiness + committee. | Agree. | **UNKNOWN** | — | — | — |

### C36 Convert the chosen strategy into a complete executable plan

| id | dimension | test | expected (pass condition) | status | evidence | component | root cause |
|---|---|---|---|---|---|---|---|
| C36-P | Can Brain perform it correctly? | Route → steps with owners, dates, costs, first action. | Executable tomorrow. | **FAIL** | Model exam: complete executable plan Claude 4/4, gpt-oss 0/4, Qwen 0/4. Production fm1126a f01: the owner's plan is research steps on generic constructed arrangements. | goals/plan.ts steps; route→plan | RC14,RC13 |
| C36-R | Does the result reach every component that needs it? | Steps reach the owner view. | Yes. | **UNKNOWN** | — | — | — |
| C36-I | Does the result change later decisions correctly? | Step results update the plan. | Yes. | **UNKNOWN** | — | — | — |
| C36-F | Does Brain recognise and recover when it fails? | Step blocked: replanned. | Yes. | **UNKNOWN** | — | — | — |
| C36-X | Does it still work combined with the other capabilities? | Plan + limits + economics. | Consistent. | **UNKNOWN** | — | — | — |

### C37 Learn from previous findings and failures

| id | dimension | test | expected (pass condition) | status | evidence | component | root cause |
|---|---|---|---|---|---|---|---|
| C37-P | Can Brain perform it correctly? | Rethink/calibration lessons recorded. | Yes. | **PASS** | operator_learnings rows. | routeProposal:1911 | — |
| C37-R | Does the result reach every component that needs it? | Lessons read by the next ask. | Yes. | **FAIL** | No reader. | routeContext | RC7 |
| C37-I | Does the result change later decisions correctly? | A lesson changes the next ask. | Yes. | **UNKNOWN** | — | — | RC7 |
| C37-F | Does Brain recognise and recover when it fails? | Wrong lesson corrected. | Yes. | **UNKNOWN** | — | — | — |
| C37-X | Does it still work combined with the other capabilities? | Lessons across goals. | Transfer. | **UNKNOWN** | — | — | — |

### C38 Adapt when circumstances change (owner change, new evidence, refutation)

| id | dimension | test | expected (pass condition) | status | evidence | component | root cause |
|---|---|---|---|---|---|---|---|
| C38-P | Can Brain perform it correctly? | New findings trigger a re-ask. | Yes. | **PASS** | NEW_FINDINGS_FOR_REASK. | routeAskDue | — |
| C38-R | Does the result reach every component that needs it? | Owner change reaches prompts. | Yes. | **UNKNOWN** | — | — | — |
| C38-I | Does the result change later decisions correctly? | Re-ask changes plan. | Yes. | **UNKNOWN** | — | — | — |
| C38-F | Does Brain recognise and recover when it fails? | Failed ask retried soon. | Yes. | **PASS** | ROUTE_RETRY_AFTER_FAILURE_MS 30 min. | — | — |
| C38-X | Does it still work combined with the other capabilities? | Adaptation + learning. | Yes. | **UNKNOWN** | — | — | — |

### C39 Recover from model, research and software failures

| id | dimension | test | expected (pass condition) | status | evidence | component | root cause |
|---|---|---|---|---|---|---|---|
| C39-P | Can Brain perform it correctly? | Model failure → retry; research fault → requeue; parse fail → salvage. | Yes. | **FAIL** | Empty → weaker fallback; parse loss. | — | RC1 |
| C39-R | Does the result reach every component that needs it? | Failure recorded where the next faculty reads it. | Yes. | **UNKNOWN** | — | — | — |
| C39-I | Does the result change later decisions correctly? | Recovery restores the plan. | Yes. | **UNKNOWN** | — | — | RC1 |
| C39-F | Does Brain recognise and recover when it fails? | Repeated failure escalates. | Yes. | **NEEDS RECHECK** | Report flags repetition. | — | — |
| C39-X | Does it still work combined with the other capabilities? | Concurrent failures. | Yes. | **UNKNOWN** | — | — | — |

### C40 Own the next step of every goal (no unowned step)

| id | dimension | test | expected (pass condition) | status | evidence | component | root cause |
|---|---|---|---|---|---|---|---|
| C40-P | Can Brain perform it correctly? | Every live goal names an owner for its next step. | Yes. | **FAIL** | 4/6 "[NOBODY]". | goal tick | RC7 |
| C40-R | Does the result reach every component that needs it? | Owner acts. | Yes. | **UNKNOWN** | — | — | RC7 |
| C40-I | Does the result change later decisions correctly? | Action changes the plan. | Yes. | **UNKNOWN** | — | — | — |
| C40-F | Does Brain recognise and recover when it fails? | Idle goal detected. | Yes. | **NEEDS RECHECK** | Watchdog exists. | — | — |
| C40-X | Does it still work combined with the other capabilities? | Orchestration + capacity. | Yes. | **UNKNOWN** | — | — | — |

### C41 Choose models by their measured results on this work

| id | dimension | test | expected (pass condition) | status | evidence | component | root cause |
|---|---|---|---|---|---|---|---|
| C41-P | Can Brain perform it correctly? | Model fitness measured on route outcomes. | Yes. | **FAIL** | Report judges by tool-call success (operationsReport.ts:327). | operationsReport | RC1 |
| C41-R | Does the result reach every component that needs it? | Fitness changes routing. | Yes. | **UNKNOWN** | — | — | RC1 |
| C41-I | Does the result change later decisions correctly? | Better model used when measured better. | Yes. | **FAIL** | Strong model inert (no key). | strongRouteModels | RC1 |
| C41-F | Does Brain recognise and recover when it fails? | A failing model is benched. | Yes. | **UNKNOWN** | — | — | — |
| C41-X | Does it still work combined with the other capabilities? | Model choice across faculties. | Yes. | **UNKNOWN** | — | — | — |

### C42 Present a usable plan to the owner

| id | dimension | test | expected (pass condition) | status | evidence | component | root cause |
|---|---|---|---|---|---|---|---|
| C42-P | Can Brain perform it correctly? | Owner view shows chosen plan, economics, steps, risks. | Yes. | **UNKNOWN** | — | — | — |
| C42-R | Does the result reach every component that needs it? | Plan reaches owner surface. | Yes. | **UNKNOWN** | — | — | — |
| C42-I | Does the result change later decisions correctly? | Owner decisions reach the work. | Yes. | **UNKNOWN** | — | — | — |
| C42-F | Does Brain recognise and recover when it fails? | No plan: says why and what next. | Yes. | **NEEDS RECHECK** | NOT_VIABLE/NEEDS_EVIDENCE readings. | — | — |
| C42-X | Does it still work combined with the other capabilities? | Output consistent with plan reading. | Yes. | **FAIL** | Four best answers. | — | RC11 |

## D. Root causes and the failures they explain

### RC1 Model turn is not checked before it counts (model+software)

- **What is wrong:** An empty reply (content "" with no error) or a 524 timeout from the primary model (gpt-oss-120b) is not treated as a failed turn to be retried on the same capable model; the turn falls to a weaker fallback. Reasoning models spend the max-token budget on hidden reasoning and return nothing. Measured cause: the GPU pod proxy closes a connection idle for 100 s; a non-streamed reasoning reply that thinks longer arrives empty or as HTTP 524 (model exam 2026-11-26: every such item served once streamed).
- **Owner of the correction:** server/services/goals/routeProposal.ts (ask/operatorChats), server/services/cheap/modelBench.ts
- **How a correction is proved:** Replay: on the same prompts, empty replies retried with a larger budget answer; production route asks record zero empty-reply fall-throughs.
- **Evidence:** 30Q test: gpt-oss empty on 6/12 route asks; 524 at ~125 s on 2/3 question asks; integration diagnosis: 4/8 primary failures.
- **Questions it explains (11):** C11-F, C23-P, C23-R, C23-I, C23-F, C23-M, C39-P, C39-I, C41-P, C41-R, C41-I

### RC2 Critic veto is unchecked (instruction+coordination)

- **What is wrong:** The critic may drop any route on an assertion nothing verifies (date arithmetic, payment windows, fees the route never uses). Its word is final; when it drops all routes the owner gets no plan, even though the code can check most of what it asserts.
- **Owner of the correction:** routeProposal.ts critiquePrompt/applyCritique/critiqueAndRevise
- **How a correction is proved:** Re-run the logged critiques: a drop resting on a false window/fee/capital claim is overruled by the deterministic check; outputs with zero surviving routes fall from 9/12.
- **Evidence:** 30Q: critic dropped 14 of 18 parsed routes; >=4 on misreadings (net-30 outside 60 days; Dec 3-7 after a Feb window; a $5 fee not used; service agreement as payment risk). Integration diagnosis: 6/8 asks ended empty, p10 false WINDOW x3.
- **Questions it explains (15):** C05-P, C05-I, C05-F, C05-X, C08-R, C09-X, C26-P, C26-F, C26-X, C29-F, C29-X, C31-P, C31-I, C31-F, C31-X

### RC3 A standing operating rule is presented as the owner's own constraint (instruction)

- **What is wrong:** Brain's operating-model sentence and REMOTE_AI_FOCUS are injected into goal prompts beside the owner's limits; models copy them into the owner's refusals and discovery searches online-only work for owners who offered labour or own equipment. The goal-specific lift exists only in the route prompt and only when a regex matches.
- **Owner of the correction:** server/domain/operatingModel.ts; cash/discovery.ts (REMOTE_AI_FOCUS)
- **How a correction is proved:** Owner profiles in replies carry no refusal the owner did not state; discovery questions for an owner with stated labour/equipment are not online-only.
- **Evidence:** Integration diagnosis: 4/4 fallback replies invented refusals; 30Q p02 run 1 owner profile "no physical work" for a drone pilot. Partly repaired d5beaf6 (route prompt); discovery unchanged (code).
- **Questions it explains (7):** C01-X, C02-P, C02-F, C03-P, C03-R, C03-I, C07-X

### RC4 Verified findings are lost on the way to the planner (software)

- **What is wrong:** The proposer is shown at most 40 findings, newest first, with near-duplicates judged on the first 160 characters; refuted claims are not filtered; nothing selects findings by the decision they bear on.
- **Owner of the correction:** routeProposal.ts findingsOf/FINDINGS_SHOWN; repos/research.ts projectEvidenceClaims
- **How a correction is proved:** With all verified findings available, the planner's input holds every distinct verified finding (or a relevance-chosen set that covers every ground field), and a refuted claim is never shown.
- **Evidence:** 30Q: 40 of 111/111/135 delivered under the cap; uncapped near-dup filter dropped 6 and 9; graders attribute 3/12 failures to C. Code: refuted not filtered.
- **Questions it explains (6):** C06-R, C12-R, C19-I, C21-P, C21-X, C27-R

### RC5 Inquiry and direction-finding anchor on one menu (instruction+reasoning)

- **What is wrong:** Question generation and scouting fix on a business shape before research (brokered digital tasks, dropshipping) and never ask whether the owner can be paid directly for what they can do now; follow-ups narrow onto the same shape.
- **Owner of the correction:** routeProposal.ts directionPrompt (and the questions framing that reuses it); discovery lenses
- **How a correction is proved:** Fresh goals: the question set and directions include the owner's direct means and at least three structurally different mechanisms; p06-type goals surface direct paid work.
- **Evidence:** 30Q: p06 60 questions all brokerage/digital; p10 60 questions dropshipping/ad-services; graders: strongest p06 path (owner as Tasker) found by no output.
- **Questions it explains (9):** C02-X, C03-X, C06-X, C07-P, C07-M, C08-X, C11-P, C11-X, C12-P

### RC6 Research supply is starved (information+infrastructure)

- **What is wrong:** Fragments are not executed, 69% of searches are refused, no keyed search provider is configured, Firecrawl is held to 15 credits/day, and the read-capable routine workers are not members of evaluation projects.
- **Owner of the correction:** research coordinator/queue; server/services/sources/*; owner items (keyed search key)
- **How a correction is proved:** A fresh goal's research completes its planned fragments and its plan reads >=20 relevant verified facts within the goal window.
- **Evidence:** RESEARCH-STARVATION-DIAGNOSIS: 1/16 fragments completed; 30Q traces: 0/1/0 completions after ~6 h; searches 785/1142 refused.
- **Questions it explains (12):** C06-P, C06-F, C07-R, C10-R, C10-I, C11-R, C13-P, C14-P, C14-X, C15-P, C15-X, C34-R

### RC7 No shared per-goal working state (coordination)

- **What is wrong:** Each faculty writes its conclusions to its own store; the next faculty re-derives or never reads them (rethink and calibration lessons, owner profile, committee questions, plan verdict and binding factor are not inputs to the route ask).
- **Owner of the correction:** goal plan reading + routeContext
- **How a correction is proved:** A route ask's context shows the previous ask's rethink, the plan verdict and binding factor, and open committee questions; a lesson recorded once changes the next ask.
- **Evidence:** Integration diagnosis §2 "present but unused" (code and production).
- **Questions it explains (13):** C02-R, C04-R, C19-R, C22-P, C22-R, C22-I, C22-F, C22-X, C35-F, C37-R, C37-I, C40-P, C40-R

### RC8 Route economics are left to the model (reasoning+software)

- **What is wrong:** Nothing computes, before a route counts, whether its price x realistic volume reaches the target, whether paid acquisition at the cited cost per sale fits the capital, or whether the buyer count supports the sales needed; models get the arithmetic wrong in both directions (proposer optimistic, critic pessimistic).
- **Owner of the correction:** routeProposal.ts parseRoutes (routeHours already does hours)
- **How a correction is proved:** Logged routes: the 445-sales-from-$3k beanie route is flagged by code; a sound route is not. The critic sees the computed figures.
- **Evidence:** 30Q graders: p10 beanie routes (445 sales from $3,000 at $39 CPA), p02 critic multiplying CPL by an inflated buyer count, p06 invented $10/h subcontractor.
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
- **Questions it explains (2):** C20-P, C20-F

### RC11 No single selector (coordination)

- **What is wrong:** Six generators and four selectors produce competing "best" answers in one reading; nothing arbitrates.
- **Owner of the correction:** readGoalPlan
- **How a correction is proved:** One reading names one chosen strategy that acceptance, committee, report and operator all read.
- **Evidence:** Integration diagnosis §3 q6: four best answers, three binding diagnoses on wst_db2e.
- **Questions it explains (6):** C04-P, C04-X, C33-R, C33-I, C33-X, C42-X

### RC12 Readiness cannot be reached by research (reasoning)

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
- **Questions it explains (2):** C04-X, C36-P

### RC14 The production reasoning models are below the bar the outcome needs (model)

- **What is wrong:** In isolation, on complete-information commercial questions, gpt-oss-120b answers 14/30 correctly, 4/11 commercial planning, 0/4 complete executable plans, with 61 evidence-interpretation errors; the fallback (laguna-xs-2.1) 1/30; Claude Opus 28/30, 10/11, 4/4. No prompt or software repair raises a model past its own ceiling.
- **Owner of the correction:** model selection: routeProposal strongRouteModels (BRAIN_ROUTE_MODEL + key), operator models
- **How a correction is proved:** Route asks served by a model that passes the commercial-planning exam (>=9/11) on the same prompts.
- **Evidence:** docs/model-exam-2026-11-26/REPORT.md (blind, 4 models, 30 questions, mechanical cross-check).
- **Questions it explains (8):** C02-M, C05-M, C07-M, C11-M, C24-M, C25-M, C31-M, C36-P

### RC15 The objective reader misses common phrasings (software)

- **What is wrong:** The regex reader has no reading for several ordinary ways people state a window, a spending cap, an hours rate or no time at all, so a goal is refused or carries a wrong limit into every later step.
- **Owner of the correction:** industry/construction/intent.ts readObjective
- **How a correction is proved:** Every goal of a fresh batch is read with the amount, window, capital and hours a person would read.
- **Evidence:** fm1126a create log: 4 of 30 refused, 3+ misread (see C01-P).
- **Questions it explains (1):** C01-P

## E. Repairs, owners and dependencies

| id | root cause | repair | owner | depends on | state | evidence |
|---|---|---|---|---|---|---|
| W1a | RC1 | askModel: an empty reply with no error is retried once with twice the token budget, then is an error; route asks, critiques and the eval probe use it. | routeProposal.ts | — | MERGED_PENDING_PRODUCTION | tests/planningFailureMapWave1.test.ts RC1 |
| W1b | RC2 | Critic is shown exact computed economics and dates; told to REPAIR a disputed figure (re-checked by code) and DROP only for what no figure can fix; a drop resting only on WINDOW/CAPITAL is kept (ranked last) or re-checked as a repair. | routeProposal.ts critiquePrompt/applyCritique | W1c | MERGED_PENDING_PRODUCTION | tests RC2 |
| W1c | RC8 | routeEconomics/economicsLine: margin after direct and buyer cost, sales needed, acquisition spend, owner hours, first-cash date; a route whose buyers cost at least what a sale earns is refused (ACQUISITION); proposer asked for acquisitionCostPerSale and selling time in owner hours. | routeProposal.ts parseRoutes | — | MERGED_PENDING_PRODUCTION | tests RC8 |
| W1d | RC9 | A route missing ownerFit is kept with the gap stated for the critic. | routeProposal.ts parseRoutes | — | MERGED_PENDING_PRODUCTION | tests RC9; routeProposal.test.ts updated |
| W1e | RC4 | Findings: 120 shown (was 40); near-duplicates judged on the whole statement; past the budget, lanes taken in turn; refuted claims filtered where read (projectEvidenceClaims) and where shown. | routeProposal.ts findingsOf; repos/research.ts | — | MERGED_PENDING_PRODUCTION | tests RC4 |
| W1f | RC5 | Scouting and route asks: when the owner offers their own work, consider being paid directly first; named directions/routes must differ in who pays, for what, through which channel. | routeProposal.ts directionPrompt/routePrompt | — | MERGED_PENDING_PRODUCTION | tests RC5 |
| W1g | RC3 | Discovery questions carry the online-only focus only when the goal offers no owner work; with an offer, the owner's direct paid work is searched first. | cash/discovery.ts discoveryFocusFor | — | MERGED_PENDING_PRODUCTION | tests RC3 |
| W1h | RC7 | Each route ask reads the rethinks of earlier asks for the goal (lessons) instead of only recording them. | routeProposal.ts proposeGoalRoutes/evidenceSections | — | MERGED_PENDING_PRODUCTION | code; production pending |
| W2a | RC6 | Research execution: fragments for goal research complete; search refusals; keyed search (owner key). | research coordinator; sources | owner: keyed search key | OPEN | — |
| W2b | RC10 | Knowledge links require a real segment; a fragment buyer gets an ESTIMATE that does not close the question. | knowledge/apply.ts | — | OPEN | — |
| W2c | RC11 | One selector: the plan reading's chosen strategy is the single answer read by acceptance, committee, report and operator. | readGoalPlan | W1 | OPEN | — |
| W2d | RC12 | An owner-usable readiness state for a research-grounded plan, separate from the money-commitment gate. | goals/plan.ts | W2c | OPEN | — |
| W2e | — | Convert the chosen route into an executable step plan (who, when, cost, first action, acceptance) on the owner surface (C36). | goals/arrangementSteps.ts / stepTitle | W2c | OPEN | — |
| W1i | RC15 | Objective reader: monthly figure with a start month (deadline end of that month), "more than" spending limits, bare spans ("about two weeks"), "N hours a week at most" read as a rate, "zero time"/"not going to do any of the work" as zero hours, "don't want to put any money in"/"nothing, no savings" as no capital. | intent.ts | — | MERGED_PENDING_PRODUCTION | tests/objectiveFreshPhrasings.test.ts; all 30 fm1126a goals read locally |
| W1j | RC1 | chatFor streams every turn without tools, so reasoning past the 100 s proxy idle cut still answers. | cheap/modelBench.ts | — | MERGED_PENDING_PRODUCTION | tests/chatStreaming.test.ts; model exam pass 2 |
| W3a | RC13 | The owner's plan must not be built from constructed arrangements that read nothing of the owner: route the owner's words and means into construction, or hold generic arrangements out of the owner plan until owner-fit is shown. | cash/construct.ts; goals/plan.ts | — | OPEN | — |
| W3b | RC14 | A route and critique model that passes the commercial-planning exam: BRAIN_ROUTE_MODEL with an Anthropic key (owner), or the owner lifting the §84 reservation so Claude routines may plan goals. | owner decision; routeProposal strongRouteModels | owner | BLOCKED_MISSING_AUTHORITY | model exam |

## F. Production evidence of repairs

- None verified on production yet.

## G. Remaining untested or unresolved requirements

C01-I, C01-F, C01-X, C03-F, C04-I, C04-F, C06-P, C06-I, C06-F, C07-I, C07-F, C08-P, C08-F, C09-P, C09-I, C10-R, C10-I, C10-F, C10-X, C11-F, C11-M, C12-X, C13-R, C13-I, C13-F, C13-X, C14-I, C14-F, C15-R, C15-F, C16-R, C16-X, C17-R, C17-I, C18-P, C18-X, C19-P, C19-F, C19-X, C20-R, C20-I, C20-X, C21-F, C22-X, C23-X, C24-R, C24-I, C24-F, C25-I, C25-X, C26-R, C26-I, C26-F, C26-X, C27-I, C27-F, C27-X, C28-R, C28-F, C29-R, C29-X, C30-P, C30-R, C30-X, C31-M, C32-P, C32-R, C32-I, C32-F, C32-X, C33-R, C33-I, C33-F, C33-X, C34-R, C34-I, C34-F, C34-X, C35-R, C35-I, C35-X, C36-R, C36-I, C36-F, C36-X, C37-I, C37-F, C37-X, C38-R, C38-I, C38-X, C39-R, C39-I, C39-F, C39-X, C40-R, C40-I, C40-F, C40-X, C41-R, C41-F, C41-X, C42-P, C42-R, C42-I, C42-F

## H. Measured progress toward 27/30 usable plans

| date | measure | usable | source |
|---|---|---|---|
| 2026-11-25 | dec1125c 10 goals, production | 0/10 | PLANNING-ROUTE-GENERATION-2026-11-25 |
| 2026-11-26 | 30Q test p02/p06/p10, 12 Brain outputs, blind | 0/3 goals (0/12 outputs); 3/12 credible-incomplete | INTELLIGENCE-TEST-30Q-2026-11-26 |
