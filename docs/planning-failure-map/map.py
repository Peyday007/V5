"""The planning failure map: capabilities derived backward from the outcome, the
diagnostic questions each one needs, their status and root causes. Data, rendered by
render.py into ../PLANNING-FAILURE-MAP.md. Statuses change only with evidence named here."""

OUTCOME = ("A credible, researched, financially sound, executable plan that satisfies the owner's "
           "original objective inside every stated limit, graded USABLE by an independent grader.")

# Dimension templates: every capability is examined on all five; the capability supplies the specifics.
DIMS = {
  'P': 'Can Brain perform it correctly?',
  'R': 'Does the result reach every component that needs it?',
  'I': 'Does the result change later decisions correctly?',
  'F': 'Does Brain recognise and recover when it fails?',
  'X': 'Does it still work combined with the other capabilities?',
  'M': 'Is a failure the model\'s own, or Brain\'s instructions/software? (model isolated on the identical input)',
}

# Root causes: established only with production or code evidence.
ROOT_CAUSES = {
 'RC1': dict(name='Model turn is not checked before it counts', kind='model+software',
   wrong='An empty reply (content "" with no error) or a 524 timeout from the primary model (gpt-oss-120b) is not treated as a failed turn to be retried on the same capable model; the turn falls to a weaker fallback. Reasoning models spend the max-token budget on hidden reasoning and return nothing.',
   owner='server/services/goals/routeProposal.ts (ask/operatorChats), server/services/cheap/modelBench.ts',
   proof='Replay: on the same prompts, empty replies retried with a larger budget answer; production route asks record zero empty-reply fall-throughs.',
   evidence='30Q test: gpt-oss empty on 6/12 route asks; 524 at ~125 s on 2/3 question asks; integration diagnosis: 4/8 primary failures.'),
 'RC2': dict(name='Critic veto is unchecked', kind='instruction+coordination',
   wrong='The critic may drop any route on an assertion nothing verifies (date arithmetic, payment windows, fees the route never uses). Its word is final; when it drops all routes the owner gets no plan, even though the code can check most of what it asserts.',
   owner='routeProposal.ts critiquePrompt/applyCritique/critiqueAndRevise',
   proof='Re-run the logged critiques: a drop resting on a false window/fee/capital claim is overruled by the deterministic check; outputs with zero surviving routes fall from 9/12.',
   evidence='30Q: critic dropped 14 of 18 parsed routes; >=4 on misreadings (net-30 outside 60 days; Dec 3-7 after a Feb window; a $5 fee not used; service agreement as payment risk). Integration diagnosis: 6/8 asks ended empty, p10 false WINDOW x3.'),
 'RC3': dict(name='A standing operating rule is presented as the owner\'s own constraint', kind='instruction',
   wrong='Brain\'s operating-model sentence and REMOTE_AI_FOCUS are injected into goal prompts beside the owner\'s limits; models copy them into the owner\'s refusals and discovery searches online-only work for owners who offered labour or own equipment. The goal-specific lift exists only in the route prompt and only when a regex matches.',
   owner='server/domain/operatingModel.ts; cash/discovery.ts (REMOTE_AI_FOCUS)',
   proof='Owner profiles in replies carry no refusal the owner did not state; discovery questions for an owner with stated labour/equipment are not online-only.',
   evidence='Integration diagnosis: 4/4 fallback replies invented refusals; 30Q p02 run 1 owner profile "no physical work" for a drone pilot. Partly repaired d5beaf6 (route prompt); discovery unchanged (code).'),
 'RC4': dict(name='Verified findings are lost on the way to the planner', kind='software',
   wrong='The proposer is shown at most 40 findings, newest first, with near-duplicates judged on the first 160 characters; refuted claims are not filtered; nothing selects findings by the decision they bear on.',
   owner='routeProposal.ts findingsOf/FINDINGS_SHOWN; repos/research.ts projectEvidenceClaims',
   proof='With all verified findings available, the planner\'s input holds every distinct verified finding (or a relevance-chosen set that covers every ground field), and a refuted claim is never shown.',
   evidence='30Q: 40 of 111/111/135 delivered under the cap; uncapped near-dup filter dropped 6 and 9; graders attribute 3/12 failures to C. Code: refuted not filtered.'),
 'RC5': dict(name='Inquiry and direction-finding anchor on one menu', kind='instruction+reasoning',
   wrong='Question generation and scouting fix on a business shape before research (brokered digital tasks, dropshipping) and never ask whether the owner can be paid directly for what they can do now; follow-ups narrow onto the same shape.',
   owner='routeProposal.ts directionPrompt (and the questions framing that reuses it); discovery lenses',
   proof='Fresh goals: the question set and directions include the owner\'s direct means and at least three structurally different mechanisms; p06-type goals surface direct paid work.',
   evidence='30Q: p06 60 questions all brokerage/digital; p10 60 questions dropshipping/ad-services; graders: strongest p06 path (owner as Tasker) found by no output.'),
 'RC6': dict(name='Research supply is starved', kind='information+infrastructure',
   wrong='Fragments are not executed, 69% of searches are refused, no keyed search provider is configured, Firecrawl is held to 15 credits/day, and the read-capable routine workers are not members of evaluation projects.',
   owner='research coordinator/queue; server/services/sources/*; owner items (keyed search key)',
   proof='A fresh goal\'s research completes its planned fragments and its plan reads >=20 relevant verified facts within the goal window.',
   evidence='RESEARCH-STARVATION-DIAGNOSIS: 1/16 fragments completed; 30Q traces: 0/1/0 completions after ~6 h; searches 785/1142 refused. Operator capacity 06:20-07:00Z (RC6 owner session_01QF5Tk5NBNTchKMwPJPQFEc): about 20 research fragments SUCCEEDED per hour Brain-wide; the GPU lane is held below its slot target (inFlight 3 of 8) by "database connections contended"; each restart holds the free lane at START_TARGET=2 for 10 min and resumes at half the saved target (16 restarts/24h, about 160 min/day); fragmentSearchRoom is 2 Brain-wide once Firecrawl hits its ceiling (34 CEILING vs 7 ANSWERED/24h; DDG 817 refused vs 416 answered). The free-lane database-saturation brake fired 253 times/24h while checkouts waited 0 ms p95, a false brake, corrected by #1342 (queue session). Projection: 30 goals x about 6 fragments = about 9 h for a first round.'),
 'RC7': dict(name='No shared per-goal working state', kind='coordination',
   wrong='Each faculty writes its conclusions to its own store; the next faculty re-derives or never reads them (rethink and calibration lessons, owner profile, committee questions, plan verdict and binding factor are not inputs to the route ask).',
   owner='goal plan reading + routeContext',
   proof='A route ask\'s context shows the previous ask\'s rethink, the plan verdict and binding factor, and open committee questions; a lesson recorded once changes the next ask.',
   evidence='Integration diagnosis §2 "present but unused" (code and production).'),
 'RC8': dict(name='Route economics are left to the model', kind='reasoning+software',
   wrong='Nothing computes, before a route counts, whether its price x realistic volume reaches the target, whether paid acquisition at the cited cost per sale fits the capital, or whether the buyer count supports the sales needed; models get the arithmetic wrong in both directions (proposer optimistic, critic pessimistic).',
   owner='routeProposal.ts parseRoutes (routeHours already does hours)',
   proof='Logged routes: the 445-sales-from-$3k beanie route is flagged by code; a sound route is not. The critic sees the computed figures.',
   evidence='30Q graders: p10 beanie routes (445 sales from $3,000 at $39 CPA), p02 critic multiplying CPL by an inflated buyer count, p06 invented $10/h subcontractor.'),
 'RC9': dict(name='Mechanical rules drop instead of repairing', kind='software',
   wrong='A route missing a descriptive field (ownerFit) is rejected outright, and the whole output can be lost; no repair is asked.',
   owner='routeProposal.ts parseRoutes',
   proof='A route missing only ownerFit is kept with the owner fit derived or asked once; no output is lost to it.',
   evidence='30Q p10 round-1 uncapped: both routes rejected OWNER_FIT, owner handed nothing (category E).'),
 'RC10': dict(name='Knowledge links name no real segment', kind='software',
   wrong='Sentence-fragment buyers are linked to Census/NAICS counts and the buyer question is closed as established.',
   owner='server/services/knowledge/apply.ts',
   proof='A fragment-shaped buyer gets an ESTIMATE that does not close the buyer question.',
   evidence='Integration diagnosis §2 (production knowledge view).'),
 'RC11': dict(name='No single selector', kind='coordination',
   wrong='Six generators and four selectors produce competing "best" answers in one reading; nothing arbitrates.',
   owner='readGoalPlan',
   proof='One reading names one chosen strategy that acceptance, committee, report and operator all read.',
   evidence='Integration diagnosis §3 q6: four best answers, three binding diagnoses on wst_db2e.'),
 'RC12': dict(name='Readiness cannot be reached by research', kind='reasoning',
   wrong='Plan acceptance needs every input evidenced at sample>=20 and p5 reach>=90%; research alone cannot move it, so "ready" is never signalled by a research-backed plan.',
   owner='goals/plan.ts judgeAcceptance',
   proof='A plan whose legs are each grounded by verified findings reaches an owner-usable readiness state distinct from the money-commitment gate.',
   evidence='BRAIN-FAILURE-DIAGNOSIS-2026-11-17 F1 (code).'),
}

# Capabilities derived backward from the outcome. Each: id, stage, name, why, dims{P,R,I,F,X,(M)}: (test, expected, status, evidence, component, rc)
S='PASS'; F='FAIL'; U='UNKNOWN'; N='NEEDS RECHECK'
def d(test, expect, status=U, ev='', comp='', rc=''):
    return dict(test=test, expected=expect, status=status, evidence=ev, component=comp, rc=rc)

CAPS = [
 # ---- G: the goal
 ('C01','Goal','Read the objective (amount, currency, window, capital, hours, recurrence, place)',
  'Every limit a plan is judged against comes from this reading.',
  dict(P=d('Read 30 varied owner requests incl. "can\'t put any hours in", weekly vs total hours, "keeps going after".','Amount, window, capital and hours match a human reading; unknowns marked unread, never guessed.',S,'30Q: p02/p06/p10 readings correct (capital 1500/0/5000; hours 171/15/0 after d5beaf6).','industry/construction/intent.ts readObjective'),
       R=d('Does the reading reach proposer, critic, planner, committee?','Same figures in every prompt and plan reading.',S,'30Q probe objective lines; plan readings use target.','goals/target.ts'),
       I=d('Change hours from 15 to 0 mid-course.','Next ask drops owner-performed routes.',U,'','planningEval update path'),
       F=d('Ambiguous request ("some money soon").','Goal flags the unread field as a question to the owner, plans nothing on a guess.',U,'','readObjective unread[]'),
       X=d('Objective reading + operating rule + labour offer on the same goal.','No contradiction between limits and owner offer in the prompt.',N,'p10 "zero hours" fixed d5beaf6; not re-run on fresh goals.','routeProposal limitLines','RC3'))),
 ('C02','Goal','Read the owner\'s means without inventing them (skills, assets, licences, location, authority, refusals)',
  'Owner fit is the first feasibility rule; invented refusals or skills send every route wrong.',
  dict(P=d('Owner profile in the reply for 30 requests.','Every skill/asset/refusal appears in the owner\'s words; "not stated" otherwise.',F,'4/4 fallback replies invented refusals; p02 run-1 "no physical work".','route prompt STEP 1','RC3'),
       R=d('Is the profile stored and read by the next ask/critic/discovery?','One profile per goal, read by all.',F,'Integration diag: profile kept only in event detail, re-derived each ask.','routeProposal record','RC7'),
       I=d('Owner states a licence; do routes sell the licensed work?','At least one route sells it.',S,'p02: every output led with Part 107 aerial work.','ROUTE_RULES.OWNER_FIT'),
       F=d('Profile contradicts owner words; is it corrected?','Code compares profile to words and drops inventions.',F,'No check exists (code).','ownerProfileOf','RC3'),
       X=d('Owner with no stated skill + $0 + place.','Means = time, place; direct paid work considered.',F,'p06: no output proposed the owner\'s own paid work.','directionPrompt','RC5'),
       M=d('Same p06 prompt to the control model.','Control reads the owner correctly.',S,'Control p06 owner profile had no invented refusals.','model'))),
 ('C03','Goal','Resolve Brain\'s standing operating rule against the goal\'s own offer, once, as data',
  'Brain\'s rule and the owner\'s offer must not contradict each other in any prompt or gate.',
  dict(P=d('Owner offering labour/equipment: does every prompt state the lift?','Route prompt, discovery and gates agree.',F,'Route prompt fixed (d5beaf6); discovery still appends REMOTE_AI_FOCUS (discovery.ts:1304).','domain/operatingModel.ts','RC3'),
       R=d('Do the three regex gates read the same resolution?','One resolution object read by all.',F,'Integration diag: regex re-implemented in goalScenario, worthResearching, answers.','operatingModel','RC3'),
       I=d('Does the lift change discovery questions?','Discovery asks about in-person work when offered.',F,'Code: REMOTE_AI_FOCUS unconditional.','discovery.ts','RC3'),
       F=d('Regex misses an offer ("I can fly 20 h a week").','A model-read offer or an explicit question; not silent refusal.',N,'p02 "fly about 20 hours" read as labour after ad40c37; unverified on fresh goals.','ownerLabourOffer'),
       X=d('Owner offer + zero capital + 7 days.','Owner-performed routes allowed and preferred when fastest.',F,'p06 final: no owner-performed route proposed.','route prompt','RC5'))),
 ('C04','Goal','Keep one consistent understanding of the goal across faculties and time',
  'Plans built by faculties that disagree about the goal cannot be coherent.',
  dict(P=d('Read one goal\'s plan, report and operator view at once.','Same chosen strategy and binding factor everywhere.',F,'wst_db2e: four "best" answers, three binding diagnoses.','readGoalPlan','RC11'),
       R=d('Do lessons, refutations and committee questions reach the route ask?','Shown in routeContext.',F,'Integration diag (code).','routeContext','RC7'),
       I=d('A refuted direction: is it proposed again?','Never in another wording.',N,'Last ask\'s CRITIQUE drops fed back (routeProposal ~1836); multi-ask effect unmeasured.','routeContext refuted'),
       F=d('Goal changed by owner: are stale openings retired?','Openings inconsistent with new limits archived.',U),
       X=d('Six generators feed one goal.','One arbitrated set; no contradictory openings.',F,'426 candidates → 49 distinct; no arbiter.','plan set','RC11'))),
 # ---- E: environment
 ('C05','Environment','Calendar, season and window arithmetic',
  'Whether money settles inside the window decides feasibility.',
  dict(P=d('Critic/proposer judge "net 30 in a 60-day window", "Dec 3-7 in a window ending Feb 24".','Correct inside/outside.',F,'30Q: both misread by the critic.','critic','RC2'),
       R=d('Is the window end date in every prompt?','Explicit end date.',S,'a1eba64 (windowEnd) present in final prompts.','limitLines'),
       I=d('Does a correct date change keep/drop?','Drops on window only when computed outside.',F,'No computed check (code).','applyCritique','RC2'),
       F=d('A wrong date claim: detected?','Code overrules.',F,'None (code).','applyCritique','RC2'),
       X=d('Season + payment terms + delivery lead time combined.','Computed first-cash day inside window.',F,'p02/p10 critic errors.','critic','RC2'),
       M=d('Same critique prompt to the control model.','Control does the arithmetic right.',N,'Not run on the critique prompt.','model'))),
 ('C06','Environment','Know the local economic environment (buyers in the place, market conditions, season)',
  'Routes must target buyers who exist and are buying now, there.',
  dict(P=d('Plan cites local, dated market facts.','Demand facts are local and current.',N,'With supplied research yes (p02 listings, ARMLS); production research 0 facts.','research→findings','RC6'),
       R=d('Do local facts reach the proposer?','Yes, within the findings budget.',F,'40 cap.','findingsOf','RC4'),
       I=d('Off-season facts drop seasonal routes?','Yes.',N,'p02 December listings drop found by follow-ups, not reflected in plans.','proposer'),
       F=d('No local facts: does Brain ask for them?','Research asks local demand first.',N,'Questions did ask (p02 Q1, Q27); production does not execute.','questions','RC6'),
       X=d('Local facts + owner means + window.','Fastest local buyers considered first.',F,'p06/p10 local options absent.','proposer','RC5'))),
 # ---- O: opportunities
 ('C07','Opportunity','Discover opportunities without being given a strategy',
  'The plan can only be as good as the best opportunity considered.',
  dict(P=d('Directions for 30 fresh goals.','Strongest evidence-supported path among those named in >=27/30.',F,'30Q: strongest path named in 1/3 goals (p02); none p06.','directionPrompt/proposer','RC5'),
       R=d('Do discovered directions reach research and the planner?','Each direction\'s decisive unknown is researched.',F,'Dives starved (RC6).','validation dives','RC6'),
       I=d('Research refutes a direction: replaced?','Replacement direction differs structurally.',N,'Scout→refuted loop exists; starved.','scout loop'),
       F=d('All directions refuted.','New directions from a different mechanism.',U),
       X=d('Discovery + owner means + constraints.','No online-only bias for owners with physical means.',F,'discovery REMOTE_AI_FOCUS.','discovery','RC3'),
       M=d('Control model on the same direction prompt.','Control names the strongest path.',F,'Control p06 also missed the Tasker path; p02 chose wholesale over retail.','prompt','RC5'))),
 ('C08','Opportunity','Generate genuinely different approaches',
  'Comparison needs real alternatives, not variations.',
  dict(P=d('Routes in one ask: distinct mechanisms/buyers.','>=2 structurally different where evidence allows.',N,'p02 final cap: 6 routes, 4 mechanisms; others 1 route.','proposer'),
       R=d('Distinct routes survive to the plan set.','Yes.',F,'Critic dropped most.','critic','RC2'),
       I=d('Alternatives compared on computed economics.','Yes.',F,'No computed economics.','parseRoutes','RC8'),
       F=d('Only one route proposed: asked for more?','Replacement ask with different mechanism.',N,'Replacement ask exists; effect not visible in probes.','critiqueAndRevise'),
       X=d('Diversity + constraints + evidence.','Diverse and feasible.',F,'Outputs mostly single routes.','proposer','RC5'))),
 ('C09','Opportunity','Pre-screen against hard limits (capital, hours, window, lawful)',
  'Infeasible routes waste research and mislead.',
  dict(P=d('Routes breaching capital/hours/window rejected by code.','Correctly rejected, no false rejects.',N,'Hours/margin rejections correct (30Q); capital/window not computed.','parseRoutes','RC8'),
       R=d('Rejection reasons reach the next ask.','Yes.',S,'replacementPrompt names failures; refuted list.','routeProposal'),
       I=d('Next ask avoids the breach.','Yes.',U),
       F=d('False reject (rule misfires).','Rule reports and route kept for review.',F,'OWNER_FIT missing-field drop.','parseRoutes','RC9'),
       X=d('Pre-screen + critic.','No double-jeopardy contradictions.',F,'Critic contradicts code-passed routes on false grounds.','critic','RC2'))),
 # ---- Q: inquiry
 ('C10','Inquiry','Identify what must be known before choosing (decisive unknowns)',
  'Research effort must go where an answer changes the decision.',
  dict(P=d('Each direction names its decisive unknown.','Specific, checkable, decision-bearing.',S,'Directions carry decisiveUnknown (production SCOUT asks).','directionPrompt'),
       R=d('Unknown becomes the first research question.','Yes.',N,'routeValidationQuestion exists; execution starved.','validation.ts','RC6'),
       I=d('Answer to unknown keeps/kills the direction.','Yes.',N,'Loop starved.','scout loop','RC6'),
       F=d('Unknown unanswerable: recognised?','Marked and replaced.',U),
       X=d('Unknowns across directions de-duplicated.','Yes.',U))),
 ('C11','Inquiry','Ask useful, non-anchored research questions',
  'Questions decide what can ever be learned.',
  dict(P=d('30 questions per goal from the owner\'s words.','Distinct, specific, cover means/buyers/price/channel/fulfilment/cash/legal; not anchored.',F,'30Q: p06/p10 anchored on brokerage/dropshipping; p02 good.','directionPrompt framing','RC5'),
       R=d('Questions become research work.','Each question queued with a decision.',F,'Production executes ~6%.','research queue','RC6'),
       I=d('Answers change routes.','Yes.',S,'30Q: facts killed Upwork/Fiverr/dropship routes.','proposer'),
       F=d('Model fails to answer (timeout/unparsed).','Retried, salvaged.',N,'Questions command salvages; production route path unchanged.','ask','RC1'),
       X=d('Questions + owner means.','Ask how owner can be paid directly.',F,'p06.','directionPrompt','RC5'),
       M=d('Control model on the question prompt.','Less anchored.',U,'Not run.','model'))),
 ('C12','Inquiry','Prioritise follow-ups and stop when research cannot change the decision',
  'Unbounded research wastes scarce capacity; premature stop leaves gaps.',
  dict(P=d('Follow-ups after findings.','Decision-bearing, not already answered.',F,'30Q: 35/90 follow-ups already answered or no decision value; narrow.','questions follow-up','RC5'),
       R=d('Follow-up answers reach the planner.','Yes, ahead of older ones.',F,'Newest-first cap displaced key older facts (p10).','findingsOf','RC4'),
       I=d('Follow-ups change the plan.','Yes when material.',F,'Final grades no better than round 1.','proposer'),
       F=d('No answer found: stops?','Records and stops.',S,'Workers recorded UNANSWERED honestly.','workers'),
       X=d('Follow-ups + selection.','Questions target the chosen strategy\'s weakest leg.',N,'Partly (p02 insurance, seasonality).','')) ),
 # ---- R: research
 ('C13','Research','Search provider availability and capacity',
  'No search, no facts.',
  dict(P=d('Searches answered per day.','Enough for planned questions.',F,'785/1142 refused; Firecrawl 7/day; no keyed search.','sources/*','RC6'),
       R=d('Results reach workers.','Yes.',S),
       I=d('Capacity allocated by decision value.','Yes.',U),
       F=d('Provider refuses: falls back.','Yes.',N,'DDG lite/html fallback; still 69% refused.','sources'),
       X=d('Capacity under 18+ goals.','Shared fairly.',N,'585d3fb shares capacity; unmeasured.',''))),
 ('C14','Research','Research work executes (fragments complete)',
  'Planned research must actually run.',
  dict(P=d('Fragments completed in 6 h.','>=80%.',F,'1/18 (30Q traces).','research coordinator','RC6'),
       R=d('Completed fragments file claims.','Yes.',S,'p06 3 claims filed.','gate'),
       I=d('Queue ordered by decision value.','Yes.',U),
       F=d('Fragment faults: retried elsewhere.','Yes.',N,'#1018 class fixes; unmeasured here.',''),
       X=d('Execution under contention with other goals.','Goal research not starved.',F,'2,063 waiting beside 278 free slots.','','RC6'))),
 ('C15','Research','Open and read the pages',
  'Search snippets are not evidence.',
  dict(P=d('Pages read per page found.','High.',F,'Production 21%; session workers 70-80%.','sources reader','RC6'),
       R=d('Read text reaches extraction.','Yes.',S),
       I=d('Unreadable source marked unresolved, not rejected.','Yes.',S,'Retrieval state contract.','gate'),
       F=d('Blocked site: alternative source.','Yes.',N,'Workers did; production unknown.',''),
       X=d('Reading + capacity.','Within credits.',F,'Firecrawl 15/day.','','RC6'))),
 ('C16','Research','Extract claims with exact citations',
  'A planner can only cite what was extracted with its source.',
  dict(P=d('Claims carry URL, quote, date, lane.','Yes.',S,'30Q: 100% of facts had URL+quote.','workers/gate'),
       R=d('Claims reach findings.','Yes.',S),
       I=d('Lane decides which figure a fact can ground.','Yes.',S,'GROUND_LANES (9fb993c).','groundsOf'),
       F=d('Claim without source rejected.','Yes.',S,'Gate contract.','gate'),
       X=d('Extraction + verification.','Yes.',S))),
 ('C17','Research','Verify that the evidence supports the claim',
  'Unverified claims mislead the planner.',
  dict(P=d('Quote present in the re-read page.','>=85%.',S,'30Q: 329/428 verified (77%); remainder held back, none delivered.','tools/verify.py (eval) / gate'),
       R=d('Only verified claims delivered.','Yes.',N,'True in eval; production gate checks source, not quote presence.','gate'),
       I=d('Unverified claim cannot ground a figure.','Yes.',N,'',''),
       F=d('Paraphrased quote detected.','Yes.',S,'Verifier caught 32 NOT_FOUND.','verify'),
       X=d('Verification + capacity.','Cheap.',S,'Re-read cache.',''))),
 ('C18','Research','Type the evidence (what it establishes: lane, scope exact/comparable, place, date)',
  'A fact about another segment or another figure must not ground this one.',
  dict(P=d('Lanes assigned correctly.','Yes.',N,'Workers assigned lanes; not audited.','workers'),
       R=d('Lane reaches groundsOf.','Yes.',S,'9fb993c.','groundsOf'),
       I=d('Mis-scoped fact rejected as grounds.','Yes.',S,'GROUND_LANES test.','groundsOf'),
       F=d('Consumer fact cited for B2B channel: caught?','Yes.',F,'p10 grader: consumer fact cited for B2B channel.','groundsOf'),
       X=d('Typing + critic.','Critic checks scope.',U))),
 ('C19','Research','Combine facts and detect contradictions',
  'Contradicted routes must be rejected; conflicting facts resolved.',
  dict(P=d('Route contradicted by a shown fact is dropped.','Yes.',N,'Upwork/Fiverr payout facts killed brokerage (correct); p10 CPA facts ignored by proposer.','critic/proposer'),
       R=d('Knowledge contradictions reach planning.','Yes.',F,'Display only (integration diag).','knowledge','RC7'),
       I=d('Refuted claims never shown.','Yes.',F,'projectEvidenceClaims ignores contradiction_state (code).','repos/research.ts','RC4'),
       F=d('Contradiction resolved by better source.','Yes.',U),
       X=d('Contradiction + selection.','Yes.',U))),
 ('C20','Research','Knowledge library matching (buyer identity, counts)',
  'Wrong buyer counts close the buyer question falsely.',
  dict(P=d('Fragment buyers linked to NAICS counts?','Never as established.',F,'Integration diag.','knowledge/apply.ts','RC10'),
       R=d('Counts reach arrangements.','Only real segments.',F,'',''),
       I=d('A false count redirects research.','No.',F,'',''),
       F=d('Mismatch detected.','Yes.',F,'None.','','RC10'),
       X=d('Library + route proposer.','Library facts available to routes.',U))),
 # ---- D: delivery
 ('C21','Delivery','Deliver verified findings into the proposer\'s reasoning input',
  'A fact not shown cannot change the plan.',
  dict(P=d('Findings shown vs verified.','All distinct verified, or a relevance-chosen set covering every ground field.',F,'40/111, 40/111, 40/135.','findingsOf','RC4'),
       R=d('Findings reach the critic too.','Yes.',S,'critiquePrompt includes findings.','critiquePrompt'),
       I=d('Shown findings used correctly.','Yes.',F,'8/12 D.','proposer','RC8'),
       F=d('Prompt too long / truncated.','Budgeted, not silently cut.',N,'Prompts 35 KB ok.',''),
       X=d('Delivery + dedupe + refuted filter.','No verified finding lost.',F,'160-char dedupe dropped 6/9.','findingsOf','RC4'))),
 ('C22','Delivery','Deliver findings and conclusions to other faculties (constructor, committee, dives, report, operator)',
  'Every faculty that decides must see the evidence.',
  dict(P=d('Constructor reads research.','Yes.',F,'11-17 F2 (code).','goalScenario','RC7'),
       R=d('Committee questions answered.','Yes.',F,'answeredBy [] (production).','committee','RC7'),
       I=d('Plan verdict reaches route ask.','Yes.',F,'heldTitles only.','plan.ts:5877','RC7'),
       F=d('Missed handoff detected.','Yes.',F,'Report sees repetition; operator does not act.','','RC7'),
       X=d('All faculties on one record.','Yes.',F,'','','RC7'))),
 # ---- P: reasoning & planning
 ('C23','Planning','A model turn returns a valid answer (no empty/timeout/unparseable fall-through)',
  'Every reasoning step depends on a model actually answering.',
  dict(P=d('Primary model answers route asks.','>=95% valid.',F,'gpt-oss 6/12 empty.','ask/operatorChats','RC1'),
       R=d('Valid answer used; failed answer retried.','Yes.',F,'Falls to weaker model.','ask','RC1'),
       I=d('Fallback quality equals primary.','Yes.',F,'Fallback invented refusals.','','RC1'),
       F=d('Empty content treated as error and retried with larger budget.','Yes.',F,'Code: error null on empty.','ask','RC1'),
       X=d('Model answers under concurrent load.','Yes.',U),
       M=d('Same prompt, larger max_tokens.','Answers.',U,'To test.','model'))),
 ('C24','Planning','Propose routes that use the evidence correctly',
  'The plan is built from these routes.',
  dict(P=d('Routes cite findings that state the figure.','Yes.',F,'Mis-citations (p10 F2 for price; consumer fact for B2B).','proposer','RC8'),
       R=d('Proposed routes reach critic and plan.','Yes.',S),
       I=d('Evidence changes route choice.','Yes.',N,'Partly (p02 prices; p06 escrow).',''),
       F=d('Route contradicted by a fact: dropped by code or critic.','Yes.',N,'',''),
       X=d('Evidence + limits + owner means.','All three respected.',F,'p06 invented subcontractor.','proposer','RC8'),
       M=d('Control model on identical prompt.','Better use.',F,'Control 0/3 usable; better hygiene.','model'))),
 ('C25','Planning','Quantitative and causal economics (price x volume, CAC vs capital, margin, hours, reach)',
  'A plan is financially sound only if the arithmetic holds.',
  dict(P=d('Route reach computed vs target.','Correct.',F,'445 sales from $3k at $39 CPA.','parseRoutes','RC8'),
       R=d('Computed figures shown to critic and owner.','Yes.',F,'Only hours computed.','','RC8'),
       I=d('Under-reaching route flagged/fixed.','Yes.',F,'',''),
       F=d('Arithmetic error detected.','Yes.',F,'None.','','RC8'),
       X=d('Economics + timing + capital.','Consistent.',F,'',''),
       M=d('Control on arithmetic.','Correct.',N,'Control understated channel budget (p10).','model'))),
 ('C26','Planning','Payment terms and time to collected cash',
  'Money must be collected, not pending, inside the window.',
  dict(P=d('Collected-cash day computed from payout facts.','Correct.',F,'p06 routes ignored 10/14-day holds; critic misread net-30.','proposer/critic','RC2'),
       R=d('Payout facts shown.','Yes.',S),
       I=d('Settlement fact rules routes in/out.','Yes.',N,'Correct kills on p06.',''),
       F=d('Misread timing corrected.','Yes.',F,'','','RC2'),
       X=d('Timing + window + platform.','Yes.',F,'','','RC2'))),
 ('C27','Planning','Buyer discovery and acquisition channel reasoning',
  'Without a channel that produces buyers in time, no plan works.',
  dict(P=d('Channel can produce needed buyers in window on budget.','Yes.',F,'Passive channels (ARMLS listing), cold email at 0.45% for 6 buyers in 7 days.','proposer','RC8'),
       R=d('Channel cost facts shown.','Yes.',F,'Cut by cap (p02 FB CPL, p10 cold-email cost).','findingsOf','RC4'),
       I=d('Channel cost changes volume.','Yes.',F,'','','RC8'),
       F=d('Channel inadequate: replaced.','Yes.',U),
       X=d('Channel + capital + hours.','Yes.',F,'','','RC8'))),
 ('C28','Planning','Fulfilment and subcontractor reasoning',
  'Someone named must deliver at a known cost.',
  dict(P=d('Named fulfiller with evidenced cost.','Yes.',F,'Invented $10/h VA; unnamed subcontractor.','proposer','RC8'),
       R=d('Fulfiller facts shown.','Yes.',N),
       I=d('Fulfiller cost sets margin.','Yes.',S,'MARGIN rule worked (p06).','parseRoutes'),
       F=d('No fulfiller: route repaired or dropped.','Yes.',N),
       X=d('Fulfilment + zero owner hours.','Selling/managing also delegated.',F,'p10 nobody takes sales calls.','proposer','RC8'))),
 ('C29','Planning','Legal and platform-terms reasoning',
  'Unlawful or ToS-breaking plans are not usable.',
  dict(P=d('Surveying licence, platform rules, business licence.','Correct.',S,'p02 survey law flagged; Marketplace services ban found.','critic'),
       R=d('Legal facts reach critic.','Yes.',S),
       I=d('Legal fact drops route.','Yes.',S,'Construction surveying dropped.',''),
       F=d('Over-strict legal veto (license cost as capital breach).','Distinguish payable-from-proceeds.',F,'p06 $73 licence used to drop.','critic','RC2'),
       X=d('Legal + capital + timing.','Yes.',F,'','','RC2'))),
 ('C30','Planning','Parser and mechanical validation (correct rejections; repair, not loss)',
  'Mechanical checks must remove bad routes without losing good ones.',
  dict(P=d('Rejections correct.','Yes.',N,'Hours/margin correct; OWNER_FIT missing-field incorrect.','parseRoutes','RC9'),
       R=d('Rejections recorded.','Yes.',S),
       I=d('Rejected route repaired once.','Yes.',F,'No repair.','','RC9'),
       F=d('Whole output lost to a field rule.','Never.',F,'p10 R1 all.','','RC9'),
       X=d('Parser + critic + replacement.','Yes.',U))),
 ('C31','Planning','Criticise correctly (drop only on verified grounds)',
  'The critic has the last word on what the owner receives.',
  dict(P=d('Critic drops only routes that truly fail.','Yes.',F,'>=4 false drops; 14/18 dropped.','critic','RC2'),
       R=d('Critic sees findings and computed figures.','Yes.',F,'No computed figures.','','RC8'),
       I=d('A drop leads to a better route.','Yes.',F,'Outputs end with nothing.','','RC2'),
       F=d('False drop detected and overruled.','Yes.',F,'None.','','RC2'),
       X=d('Critic + parser + replacement.','At least one usable route survives when one exists.',F,'9/12 outputs no plan.','','RC2'),
       M=d('Control model as critic on the same routes.','Fewer false drops.',U,'To test.','model'))),
 ('C32','Planning','Revise after critique (replacement routes)',
  'Criticism must improve the plan, not end it.',
  dict(P=d('Replacement ask runs when nothing survives.','Yes.',U,'Not visible in probe.','critiqueAndRevise'),
       R=d('Replacements critiqued.','Yes.',U),
       I=d('Replacement better.','Yes.',U),
       F=d('Replacement fails: recorded.','Yes.',U),
       X=d('Revision + economics.','Yes.',U))),
 ('C33','Planning','Compare and select one strategy',
  'The owner needs one plan, chosen on evidence.',
  dict(P=d('Ranking follows computed economics and evidence.','Yes.',F,'Critic scores; no economics.','applyCritique','RC8'),
       R=d('Chosen strategy read by planner/committee/report.','Yes.',F,'','','RC11'),
       I=d('Selection changes plan reading.','Yes.',F,'','','RC11'),
       F=d('Tie or none: says so.','Yes.',U),
       X=d('Selection across generators.','One arbiter.',F,'','','RC11'))),
 ('C34','Planning','Identify risks and invalid assumptions',
  'Unexamined assumptions sink plans.',
  dict(P=d('Assumptions named per route.','Yes.',S,'routes carry assumptions.','proposer'),
       R=d('Assumptions become research.','Yes.',N,'searches field exists; execution starved.','','RC6'),
       I=d('Disproved assumption drops/repairs route.','Yes.',U),
       F=d('Hidden assumption surfaced by critic.','Yes.',N),
       X=d('Risk + economics.','Sensitivity shown.',F,'','','RC8'))),
 ('C35','Planning','Know when a plan is ready (and when more research is needed)',
  'Neither premature nor never.',
  dict(P=d('Readiness of a research-backed plan.','Reachable.',F,'Acceptance unattainable by research (11-17 F1).','judgeAcceptance','RC12'),
       R=d('Readiness shown to owner.','Yes.',N),
       I=d('Not-ready names the next research.','Yes.',N,'Plan "missing" lists exist.','plan.ts'),
       F=d('Stalled readiness detected.','Yes.',F,'Report sees 12-hour repetition; nothing acts.','','RC7'),
       X=d('Readiness + committee.','Agree.',U))),
 ('C36','Planning','Convert the chosen strategy into a complete executable plan',
  'A route is not a plan: steps, who, when, cost, first actions, acceptance.',
  dict(P=d('Route → steps with owners, dates, costs, first action.','Executable tomorrow.',F,'Graders: no output executable; route output has no step plan.','arrangementSteps/stepExecutor (route path)',''),
       R=d('Steps reach the owner view.','Yes.',U),
       I=d('Step results update the plan.','Yes.',U),
       F=d('Step blocked: replanned.','Yes.',U),
       X=d('Plan + limits + economics.','Consistent.',U))),
 # ---- L: learning, recovery, adaptation, orchestration
 ('C37','Learning','Learn from previous findings and failures',
  'The same mistake must not repeat.',
  dict(P=d('Rethink/calibration lessons recorded.','Yes.',S,'operator_learnings rows.','routeProposal:1911'),
       R=d('Lessons read by the next ask.','Yes.',F,'No reader.','routeContext','RC7'),
       I=d('A lesson changes the next ask.','Yes.',F,'','','RC7'),
       F=d('Wrong lesson corrected.','Yes.',U),
       X=d('Lessons across goals.','Transfer.',U))),
 ('C38','Learning','Adapt when circumstances change (owner change, new evidence, refutation)',
  'Plans must follow reality.',
  dict(P=d('New findings trigger a re-ask.','Yes.',S,'NEW_FINDINGS_FOR_REASK.','routeAskDue'),
       R=d('Owner change reaches prompts.','Yes.',N),
       I=d('Re-ask changes plan.','Yes.',U),
       F=d('Failed ask retried soon.','Yes.',S,'ROUTE_RETRY_AFTER_FAILURE_MS 30 min.',''),
       X=d('Adaptation + learning.','Yes.',U))),
 ('C39','Learning','Recover from model, research and software failures',
  'Failures are frequent; recovery must be automatic.',
  dict(P=d('Model failure → retry; research fault → requeue; parse fail → salvage.','Yes.',F,'Empty → weaker fallback; parse loss.','','RC1'),
       R=d('Failure recorded where the next faculty reads it.','Yes.',N),
       I=d('Recovery restores the plan.','Yes.',F,'','','RC1'),
       F=d('Repeated failure escalates.','Yes.',N,'Report flags repetition.',''),
       X=d('Concurrent failures.','Yes.',U))),
 ('C40','Orchestration','Own the next step of every goal (no unowned step)',
  'Work nobody owns does not happen.',
  dict(P=d('Every live goal names an owner for its next step.','Yes.',F,'4/6 "[NOBODY]".','goal tick','RC7'),
       R=d('Owner acts.','Yes.',F,'','','RC7'),
       I=d('Action changes the plan.','Yes.',U),
       F=d('Idle goal detected.','Yes.',N,'Watchdog exists.',''),
       X=d('Orchestration + capacity.','Yes.',U))),
 ('C41','Orchestration','Choose models by their measured results on this work',
  'The model that answers must be the one that reasons best here.',
  dict(P=d('Model fitness measured on route outcomes.','Yes.',F,'Report judges by tool-call success (operationsReport.ts:327).','operationsReport','RC1'),
       R=d('Fitness changes routing.','Yes.',F,'','','RC1'),
       I=d('Better model used when measured better.','Yes.',F,'Strong model inert (no key).','strongRouteModels','RC1'),
       F=d('A failing model is benched.','Yes.',N),
       X=d('Model choice across faculties.','Yes.',U))),
 ('C42','Output','Present a usable plan to the owner',
  'The owner must be able to act on it.',
  dict(P=d('Owner view shows chosen plan, economics, steps, risks.','Yes.',U),
       R=d('Plan reaches owner surface.','Yes.',U),
       I=d('Owner decisions reach the work.','Yes.',U),
       F=d('No plan: says why and what next.','Yes.',N,'NOT_VIABLE/NEEDS_EVIDENCE readings.',''),
       X=d('Output consistent with plan reading.','Yes.',F,'Four best answers.','','RC11'))),
]

# Repairs: wave, root causes, owner, depends on, state, production evidence.
REPAIRS = [
 dict(id='W1a', rc='RC1', what='askModel: an empty reply with no error is retried once with twice the token budget, then is an error; route asks, critiques and the eval probe use it.', owner='routeProposal.ts', depends='', state='MERGED_PENDING_PRODUCTION', evidence='tests/planningFailureMapWave1.test.ts RC1'),
 dict(id='W1b', rc='RC2', what='Critic is shown exact computed economics and dates; told to REPAIR a disputed figure (re-checked by code) and DROP only for what no figure can fix; a drop resting only on WINDOW/CAPITAL is kept (ranked last) or re-checked as a repair.', owner='routeProposal.ts critiquePrompt/applyCritique', depends='W1c', state='MERGED_PENDING_PRODUCTION', evidence='tests RC2'),
 dict(id='W1c', rc='RC8', what='routeEconomics/economicsLine: margin after direct and buyer cost, sales needed, acquisition spend, owner hours, first-cash date; a route whose buyers cost at least what a sale earns is refused (ACQUISITION); proposer asked for acquisitionCostPerSale and selling time in owner hours.', owner='routeProposal.ts parseRoutes', depends='', state='MERGED_PENDING_PRODUCTION', evidence='tests RC8'),
 dict(id='W1d', rc='RC9', what='A route missing ownerFit is kept with the gap stated for the critic.', owner='routeProposal.ts parseRoutes', depends='', state='MERGED_PENDING_PRODUCTION', evidence='tests RC9; routeProposal.test.ts updated'),
 dict(id='W1e', rc='RC4', what='Findings: 120 shown (was 40); near-duplicates judged on the whole statement; past the budget, lanes taken in turn; refuted claims filtered where read (projectEvidenceClaims) and where shown.', owner='routeProposal.ts findingsOf; repos/research.ts', depends='', state='MERGED_PENDING_PRODUCTION', evidence='tests RC4'),
 dict(id='W1f', rc='RC5', what='Scouting and route asks: when the owner offers their own work, consider being paid directly first; named directions/routes must differ in who pays, for what, through which channel.', owner='routeProposal.ts directionPrompt/routePrompt', depends='', state='MERGED_PENDING_PRODUCTION', evidence='tests RC5'),
 dict(id='W1g', rc='RC3', what='Discovery questions carry the online-only focus only when the goal offers no owner work; with an offer, the owner\'s direct paid work is searched first.', owner='cash/discovery.ts discoveryFocusFor', depends='', state='MERGED_PENDING_PRODUCTION', evidence='tests RC3'),
 dict(id='W1h', rc='RC7', what='Each route ask reads the rethinks of earlier asks for the goal (lessons) instead of only recording them.', owner='routeProposal.ts proposeGoalRoutes/evidenceSections', depends='', state='MERGED_PENDING_PRODUCTION', evidence='code; production pending'),
 dict(id='W2a', rc='RC6', what='Research execution: fragments for goal research complete; search refusals; keyed search (owner key).', owner='research coordinator; sources', depends='owner: keyed search key', state='OPEN', evidence=''),
 dict(id='W2b', rc='RC10', what='Knowledge links require a real segment; a fragment buyer gets an ESTIMATE that does not close the question.', owner='knowledge/apply.ts', depends='', state='OPEN', evidence=''),
 dict(id='W2c', rc='RC11', what='One selector: the plan reading\'s chosen strategy is the single answer read by acceptance, committee, report and operator.', owner='readGoalPlan', depends='W1', state='OPEN', evidence=''),
 dict(id='W2d', rc='RC12', what='An owner-usable readiness state for a research-grounded plan, separate from the money-commitment gate.', owner='goals/plan.ts', depends='W2c', state='OPEN', evidence=''),
 dict(id='W2e', rc='', what='Convert the chosen route into an executable step plan (who, when, cost, first action, acceptance) on the owner surface (C36).', owner='goals/arrangementSteps.ts / stepTitle', depends='W2c', state='OPEN', evidence=''),
]
PROGRESS = [
 dict(at='2026-11-25', measure='dec1125c 10 goals, production', usable='0/10', note='PLANNING-ROUTE-GENERATION-2026-11-25'),
 dict(at='2026-11-26', measure='30Q test p02/p06/p10, 12 Brain outputs, blind', usable='0/3 goals (0/12 outputs); 3/12 credible-incomplete', note='INTELLIGENCE-TEST-30Q-2026-11-26'),
]

# ---- Evidence added after the first build (2026-11-26, later the same day) ----
ROOT_CAUSES['RC1']['wrong'] += ' Measured cause: the GPU pod proxy closes a connection idle for 100 s; a non-streamed reasoning reply that thinks longer arrives empty or as HTTP 524 (model exam 2026-11-26: every such item served once streamed).'
ROOT_CAUSES['RC13'] = dict(name='The owner\'s plan is built from generic constructed arrangements that never read the owner', kind='coordination+reasoning',
   wrong='Until route openings exist, readGoalPlan models the arrangement constructor\'s generic designs (fractional aircraft ownership, HVAC referral brokering) for every goal; the constructor and its research steps never read the owner\'s words, means or place, so the plan the owner is handed fits any request.',
   owner='cash/construct.ts / goals/plan.ts goalArrangements',
   proof='A fresh goal\'s plan reading names only strategies whose buyer, offer or means come from the owner\'s words or from the route proposer\'s owner-read routes.',
   evidence='Production read fm1126a f01 (Tulsa, pickup truck, weekends, $200): plan = 12 constructed estimates incl. "Fractional ownership of aircraft" and HVAC firms; steps = research their buyer counts. Integration diagnosis: owner words do not reach the constructor.')
ROOT_CAUSES['RC14'] = dict(name='The production reasoning models are below the bar the outcome needs', kind='model',
   wrong='In isolation, on complete-information commercial questions, gpt-oss-120b answers 14/30 correctly, 4/11 commercial planning, 0/4 complete executable plans, with 61 evidence-interpretation errors; the fallback (laguna-xs-2.1) 1/30; Claude Opus 28/30, 10/11, 4/4. No prompt or software repair raises a model past its own ceiling.',
   owner='model selection: routeProposal strongRouteModels (BRAIN_ROUTE_MODEL + key), operator models',
   proof='Route asks served by a model that passes the commercial-planning exam (>=9/11) on the same prompts.',
   evidence='docs/model-exam-2026-11-26/REPORT.md (blind, 4 models, 30 questions, mechanical cross-check).')
def setq(cid, dim, status, ev, rc=None, comp=None):
    for c in CAPS:
        if c[0]==cid:
            q=c[4][dim]; q['status']=status; q['evidence']=ev
            if rc is not None: q['rc']=rc
            if comp is not None: q['component']=comp
            return
    raise KeyError(cid)
setq('C01','P','FAIL','Fresh batch fm1126a (30 goals, production 4dcef5c-era reader): 4 refused (monthly figure with a start month x2, "spending more than $1,000", "about two weeks"), 1 read as OTHER ("go from nothing to $3,500 a month"), "3 hours a week at most" read as 3 hours total, "zero time" / "not going to do any of the work" read as no limit. Repaired W1i; recheck on the next batch.','RC15')
ROOT_CAUSES['RC15'] = dict(name='The objective reader misses common phrasings', kind='software',
   wrong='The regex reader has no reading for several ordinary ways people state a window, a spending cap, an hours rate or no time at all, so a goal is refused or carries a wrong limit into every later step.',
   owner='industry/construction/intent.ts readObjective',
   proof='Every goal of a fresh batch is read with the amount, window, capital and hours a person would read.',
   evidence='fm1126a create log: 4 of 30 refused, 3+ misread (see C01-P).')
setq('C02','M','PASS','Model exam: given complete facts, Claude Opus reads constraints with 3 violations in 30; gpt-oss 8, fallback 22. The 4/4 invented refusals were the fallback\'s.','RC14')
setq('C05','M','FAIL','Model exam: gpt-oss 8 and the fallback 22 constraint violations in 30, Claude 3; date and window arithmetic errors concentrate in the open models.','RC14')
setq('C07','M','FAIL','Model exam commercial planning: Claude 10/11, gpt-oss 4/11, Qwen 1/11, fallback 0/11. 30Q control (Claude Sonnet, Brain\'s prompt) also missed p06\'s strongest path, so the prompt shares the failure (RC5).','RC14,RC5')
setq('C11','M','NEEDS RECHECK','Not run on the question prompt; the model exam\'s evidence-interpretation errors (gpt-oss 61, Claude 1) predict the gap.','RC14')
setq('C23','M','PASS','Model exam: re-asked with streaming, gpt-oss served 30/30; the empty replies are the proxy idle cut, not the model (repaired W1j).','RC1')
setq('C24','M','FAIL','Model exam evidence interpretation: gpt-oss 1.00/2, Claude 1.93/2; 30Q control 0/3 usable but best evidence hygiene.','RC14')
setq('C25','M','FAIL','Model exam reasoning correctness: gpt-oss 1.13/2, fallback 0.23, Claude 1.97; mechanical key numbers gpt-oss 7/9.','RC14')
setq('C31','M','NEEDS RECHECK','Not run as critic; exam constraint and evidence errors predict false drops from open models.','RC14')
setq('C36','P','FAIL','Model exam: complete executable plan Claude 4/4, gpt-oss 0/4, Qwen 0/4. Production fm1126a f01: the owner\'s plan is research steps on generic constructed arrangements.','RC14,RC13','goals/plan.ts steps; route→plan')
setq('C04','X','FAIL','fm1126a f01: the plan reading is built from constructed arrangements while the route proposer\'s owner-read directions are not yet openings; two generators, no arbiter.','RC11,RC13')
REPAIRS += [
 dict(id='W1i', rc='RC15', what='Objective reader: monthly figure with a start month (deadline end of that month), "more than" spending limits, bare spans ("about two weeks"), "N hours a week at most" read as a rate, "zero time"/"not going to do any of the work" as zero hours, "don\'t want to put any money in"/"nothing, no savings" as no capital.', owner='intent.ts', depends='', state='MERGED_PENDING_PRODUCTION', evidence='tests/objectiveFreshPhrasings.test.ts; all 30 fm1126a goals read locally'),
 dict(id='W1j', rc='RC1', what='chatFor streams every turn without tools, so reasoning past the 100 s proxy idle cut still answers.', owner='cheap/modelBench.ts', depends='', state='MERGED_PENDING_PRODUCTION', evidence='tests/chatStreaming.test.ts; model exam pass 2'),
 dict(id='W3a', rc='RC13', what='The owner\'s plan must not be built from constructed arrangements that read nothing of the owner: route the owner\'s words and means into construction, or hold generic arrangements out of the owner plan until owner-fit is shown.', owner='cash/construct.ts; goals/plan.ts (integration owner session_01QF5Tk7etm6MGmaFuHMd6eZ)', depends='', state='MERGED_PENDING_PRODUCTION', evidence='PR #1345 (8a2c568): a constructed design reaches a goal plan only if its precedent is one of that goal\'s own route openings; tests/ownerRoutesLeadConstruction.test.ts. Motivating production read: dev6 0/12 usable on a8c4699 (6 QUANT critical on generic arrangements, 6 no-candidate).'),
 dict(id='W3b', rc='RC14', what='A route and critique model that passes the commercial-planning exam: BRAIN_ROUTE_MODEL with an Anthropic key (owner), or the owner lifting the §84 reservation so Claude routines may plan goals.', owner='owner decision; routeProposal strongRouteModels', depends='owner', state='BLOCKED_MISSING_AUTHORITY', evidence='model exam'),
]

# ---- UNKNOWN questions answered from evidence already held (no test repeated) ----
_E = {
 'C01-F': ('PASS', 'fm1126a create log: unread phrases are named and the goal is refused rather than guessed ("nothing was created. Unread: …").'),
 'C13-R': ('PASS', 'p06 trace: searches answered (6) reached the free-lane worker and pages were read (3).'),
 'C13-I': ('FAIL', 'stall 2026-11-26: every queued research fragment sits at priority 9 (eval) or 8/6 by purpose, never by the decision its answer changes; 1,167 waiting.'),
 'C14-I': ('FAIL', 'stall priority_hist: eval and non-eval fragments share priority 9; nothing orders by decision value.'),
 'C15-R': ('PASS', 'p06 trace: pages read → 3 claims extracted.'),
 'C16-R': ('PASS', 'p06 trace: accepted claims appear in findings_now and were shown to a route ask (findingsShown 1).'),
 'C16-X': ('PASS', 'stall rejections: extraction then verification ("source does not directly support" 12 rejected).'),
 'C17-I': ('PASS', 'groundsOf cites only shown findings of a fitting lane (tests); production gate rejects unsupported claims before they become findings.'),
 'C20-R': ('PASS', 'Integration diagnosis: 80 buyers linked to Census counts reach arrangement buyer counts.'),
 'C20-I': ('FAIL', 'Integration diagnosis: a wrong link reads "buyers established … the next research round asks for conversion".'),
 'C20-X': ('FAIL', 'Integration diagnosis: the knowledge library feeds arrangements only; route asks never read it.'),
 'C22-X': ('FAIL', 'Integration diagnosis §4.1: no shared per-goal working state.'),
 'C24-R': ('PASS', '30Q probes: every parsed route was critiqued (critique records per route).'),
 'C24-F': ('PASS', '30Q p06 R1all: Upwork route contradicted by payout-hold facts dropped by the critic, correctly (grader).'),
 'C26-R': ('NEEDS RECHECK', '30Q all-findings arm: payout facts shown; under the old 40 cap they were cut. Cap raised (W1e); production recheck pending.'),
 'C26-F': ('NEEDS RECHECK', 'W1b: a disputed timing is a repair the code re-checks (tests); production pending.'),
 'C28-R': ('NEEDS RECHECK', 'As C26-R, for fulfiller facts.'),
 'C29-R': ('PASS', '30Q: the critic cited A.R.S. 32-101 survey law from the findings.'),
 'C30-R': ('PASS', 'Route events record rejectedByRule; probe parsed.rejected lists rule and reason.'),
 'C32-P': ('NEEDS RECHECK', 'Code: critiqueAndRevise asks replacements when fewer than ROUTES_MIN_SURVIVING survive; not exercised by the eval probe, production effect unmeasured.'),
 'C32-R': ('NEEDS RECHECK', 'Code: replacements are parsed and ranked after kept routes, not critiqued again.'),
 'C32-F': ('PASS', 'Code + event detail: replacement failures are named in critique.reason.'),
 'C33-R': ('FAIL', 'Integration diagnosis: four different "best" strategies in one production reading.'),
 'C33-I': ('FAIL', 'Same: the chosen route does not decide the plan reading (fm1126a f01 plan built from constructed arrangements).'),
 'C33-F': ('PASS', 'fm1126a f01 read: "NOT ACCEPTED: no candidate plan yet" — says so.'),
 'C33-X': ('FAIL', 'RC11/RC13: generators are not arbitrated.'),
 'C35-R': ('PASS', 'fm1126a f01 read: report lines and acceptance sentence shown.'),
 'C36-R': ('PASS', 'fm1126a f01 read: steps reach the owner view (their content fails C36-P).'),
 'C37-I': ('NEEDS RECHECK', 'W1h: rethinks of earlier asks are now read (code); production effect pending.'),
 'C38-R': ('NEEDS RECHECK', 'planningEval update writes the owner\'s change into target resources read by routeContext (code); not exercised.'),
 'C01-I': ('NEEDS RECHECK', 'Same path as C38-R; not exercised on production.'),
 'C04-F': ('UNKNOWN', ''),
 'C39-R': ('PASS', 'Route events record why an ask failed (NO_ANSWER reasons in trace route_asks).'),
 'C40-R': ('FAIL', 'Integration diagnosis: 4 of 6 live goals "[NOBODY] Brain judges each idea on its next pass".'),
 'C41-R': ('FAIL', 'Code: operationsReport.ts:327 judges model adequacy by tool-call success; no route-outcome measure changes routing.'),
 'C41-F': ('FAIL', 'Code: the fallback (1/30 on the model exam) is never benched; challengerModels order is fixed.'),
 'C42-P': ('FAIL', 'fm1126a f01: chosen null; steps are research on generic arrangements.'),
 'C42-R': ('PASS', 'fm1126a f01: the reading reaches the owner surface (read output).'),
 'C25-I': ('NEEDS RECHECK', 'W1c: economics line + ACQUISITION refusal (tests); production pending.'),
 'C09-I': ('NEEDS RECHECK', 'Rejections and critique drops are fed to the next ask (code); multi-ask effect unmeasured.'),
 'C23-X': ('NEEDS RECHECK', 'Capacity 2026-11-26: GPU 8/16 slots with "errors acceptable"; route-ask behaviour under that load unmeasured.'),
}
for qid,(st,ev) in _E.items():
    cid,dim=qid.split('-')
    for c in CAPS:
        if c[0]==cid:
            c[4][dim]['status']=st; c[4][dim]['evidence']=ev
            if qid in ('C13-I','C14-I'): c[4][dim]['rc']='RC6'
            if qid in ('C20-I','C20-X'): c[4][dim]['rc']='RC10'
            if qid in ('C22-X','C40-R'): c[4][dim]['rc']='RC7'
            if qid in ('C33-R','C33-I','C33-X'): c[4][dim]['rc']='RC11,RC13'
            if qid in ('C41-R','C41-F'): c[4][dim]['rc']='RC1,RC14'
            if qid=='C42-P': c[4][dim]['rc']='RC13'

# ---- fm1126b (2026-11-26 06:24Z, frozen revision a8c46995): intake ----
for c in CAPS:
    if c[0]=='C01':
        c[4]['P']['status']='PASS'
        c[4]['P']['evidence']='fm1126b on a8c46995: 30 of 30 fresh goals read and created (fm1126a on the earlier reader: 26, with 3+ misread). Amount, window, capital and hours match a human reading on all 30 (local read of the batch).'
PROGRESS.append(dict(at='2026-11-26 06:24Z', measure='fm1126b: 30 fresh goals created on frozen revision a8c46995; plans to be read and graded blind after research runs', usable='pending', note='create log in scratchpad; read and grade to follow'))

# ==== Phase 4: independent reviews (2026-11-26 ~06:40Z), applied ====
import json as _json, os as _os
_D=_os.path.dirname(_os.path.abspath(__file__))
REVIEWS = {k:_json.load(open(_os.path.join(_D,f'review_{k}.json'))) for k in ('coverage','validity','causes')}

# Reviewer 1: every uncovered component becomes a capability examined on all five dimensions.
for i,g in enumerate(REVIEWS['coverage']['gaps']):
    cid=f'C{43+i}'
    comp=g['code']
    CAPS.append((cid,'Reviewer-1 coverage',g['capability'],g['why'],dict(
        P=d(g['question'],'Correct as stated; failure observable as: '+g['observable'],U,'',comp),
        R=d(f'Does what {g["capability"]} decides reach the components downstream of {comp.split(":")[0]}?','Its result is read where the plan is decided.',U,'',comp),
        I=d(f'Does a change in {g["capability"]}\'s result change the plan reading?','The owner\'s plan changes when it does.',U,'',comp),
        F=d(f'When {g["capability"]} fails (throws, returns nothing, or returns a wrong answer), is it detected and recovered?','The failure is recorded and the plan does not silently rest on it.',U,'',comp),
        X=d(f'Does {g["capability"]} still work combined with the route proposer, research and acceptance on a fresh goal?','The combined plan is consistent with it.',U,'',comp),
    )))

# Reviewer 2: status disputes the evidence supports, applied as stated.
def _set(qid, st, why):
    cid,dim=qid.split('-')
    for c in CAPS:
        if c[0]==cid and dim in c[4]:
            c[4][dim]['status']=st; c[4][dim]['evidence']=(c[4][dim]['evidence']+' | REVIEW 2: '+why).strip(' |'); return
for qid in ['C17-P','C18-I','C20-R']: _set(qid,'FAIL','test-validity review: the evidence cited contradicts PASS.')
for qid in ['C02-M','C10-P','C15-I','C16-F','C17-X','C34-P','C37-P','C02-I','C13-R','C14-R','C24-F','C28-I','C29-I','C35-R','C36-R']:
    _set(qid,'RECHECK','test-validity review: rests on one example, a field existing, or a contract — not a demonstration.')
for qid in ['C21-P','C21-X','C19-I','C23-F','C25-R','C25-F','C31-F','C31-R','C09-F','C30-F','C03-P','C03-I','C05-I','C05-F','C08-I','C37-R']:
    _set(qid,'RECHECK','test-validity review: the evidence describes code since changed; the repaired behaviour must be re-demonstrated on production.')
_set('C23-M','FAIL','root-cause challenge + validity review: empty replies arrive in 47–85 s (< the 100 s cut) — they are the token budget, not the proxy; the proxy explains the 524s only.')
_set('C01-P','RECHECK','validity review: f07 and f24 were misread on fm1126b; repaired W2c and checked against blind expected readings of all 30 (tests/objectiveFreshBatchBlind.test.ts, 30/30) — production re-demonstration pending.')
_set('C01-F','RECHECK','validity review: the earlier evidence came from the old reader.')

# Reviewer 3: the root-cause map restructured on the evidence.
ROOT_CAUSES['RC1']['wrong'] = 'A model turn is not checked before it counts. Two distinct mechanisms: (a) HTTP 524 after ~125 s — the GPU pod proxy closes a non-streamed connection idle for 100 s (exam pass 2: streaming served every one); (b) content "" with no error in 47–85 s — the output budget (2,500–4,000 tokens) is spent on hidden reasoning (RC16). An empty reply was never treated as a failed turn.'
ROOT_CAUSES['RC2']['kind'] = 'SYMPTOM of RC17 (and RC14)'
ROOT_CAUSES['RC2']['evidence'] += ' | REVIEW 3: most cited misreadings were written by the fallback (laguna, 1/30) critiquing its own routes after one primary failure; the code-level veto weakness is real but secondary.'
ROOT_CAUSES['RC8']['kind'] = 'SYMPTOM of RC17/RC14 (code check is the safeguard)'
ROOT_CAUSES['RC8']['evidence'] += ' | REVIEW 3: every concrete instance came from the fallback model.'
ROOT_CAUSES['RC5']['kind'] = 'SYMPTOM of RC3'
ROOT_CAUSES['RC5']['evidence'] += ' | REVIEW 3: the anchoring questions were written under a LIMITS block carrying the standing online-only rule.'
ROOT_CAUSES['RC11']['kind'] = 'SYMPTOM of RC7 (no shared goal record)'
ROOT_CAUSES['RC12']['kind'] = 'CONTRADICTED as a cause of unusable plans (graders judged content, not acceptance state); kept as a readiness-signal defect'
ROOT_CAUSES['RC3']['wrong'] += ' REVIEW 3 + fresh batch: the lift reached none of the prompts actually sent — every final 30Q prompt, the strong control\'s included, carried "run entirely online" for owners offering work; the phrase reader missed 14 of 30 fresh owners who stated hours.'
ROOT_CAUSES['RC16'] = dict(name='Output budgets too small for a reasoning model', kind='software+model',
   wrong='Route, critique and direction asks gave gpt-oss-120b 2,500–4,000 max_tokens; hidden reasoning consumed them and the reply arrived empty or cut mid-JSON.',
   owner='routeProposal.ts (ROUTE_TOKENS)', proof='Production route asks show no empty or truncated primary replies; exam at 16,000 had 0/47 empty.',
   evidence='Root-cause challenge: empty replies in 47–85 s with error:null (planner/final_*.txt, probe1_*.txt); question replies cut mid-JSON (questions/*.raw.txt).')
ROOT_CAUSES['RC17'] = dict(name='Model fall-through has no competence floor; the proposer critiques itself', kind='coordination+model',
   wrong='After one primary failure the fallback combo (laguna-xs-2.1: 1/30, 0/11 planning, 19 critical errors) both proposed and critiqued; the critic order puts the proposing model first, so the check is not independent.',
   owner='routeProposal.ts operatorChats / critiqueAndRevise', proof='No route ask is answered or critiqued by a model below the planning bar; production route events show the fallback never serves.',
   evidence='Root-cause challenge: 6 of 12 probes and 2 of 3 question sets served by the fallback; routeProposal.ts "The model that proposed critiques first".')
ROOT_CAUSES['RC18'] = dict(name='The evaluation was underpowered and its grading standard drifted', kind='measurement',
   wrong='Three goals, one sample per arm, one grader per goal whose bar moved between days; the rubric had no cause categories separating model, research capacity, timing and code.',
   owner='evaluation (planningEval, grading rubric)', proof='30 fresh goals on one frozen revision, graded blind with a fixed rubric that records a cause category per failure.',
   evidence='30Q report: "Today\'s grader was stricter"; validity review on GRADING.md / GRADING-E2E.md.')
for qid,rc in [('C23-R','RC16'),('C41-F','RC17,RC14'),('C31-P','RC17,RC2'),('C25-P','RC17,RC8'),('C11-P','RC3,RC5')]:
    cid,dim=qid.split('-')
    for c in CAPS:
        if c[0]==cid and dim in c[4]: c[4][dim]['rc']=rc
REPAIRS += [
 dict(id='W2a', rc='RC17', what='Route asks, critiques and direction asks never use a model measured unfit (ROUTE_UNFIT_MODEL_LABELS: the fallback combo); with no fit model left the ask records NO_ANSWER and retries on the failure interval.', owner='routeProposal.ts operatorChats; planningEval probe parity', depends='', state='BRANCH_PENDING_DEPLOY', evidence='tests/planningFailureMapWave2.test.ts; sensitivity C41-F'),
 dict(id='W2b', rc='RC16', what='Output budgets 14,000 / 12,000 / 10,000 (route / direction / critique); attempt bound 300 s, ask budget 720 s.', owner='routeProposal.ts ROUTE_TOKENS', depends='W1j streaming', state='BRANCH_PENDING_DEPLOY', evidence='sensitivity C23-R'),
 dict(id='W2c', rc='RC3', what='An owner who gives the goal hours has offered their work (ownerLabourWithHours), in route asks and discovery; "I can work all day / full time" read as an offer.', owner='domain/operatingModel.ts; routeProposal routeContext; discovery', depends='', state='BRANCH_PENDING_DEPLOY', evidence='sensitivity C03-P; blind fixture 30/30'),
 dict(id='W2d', rc='RC15', what='Reader: negated "spend more than" only (own regression removed); a floor ("more than $600") never a ceiling; a named break is the window; a job\'s hours are not time given, the extra hours are.', owner='intent.ts', depends='', state='BRANCH_PENDING_DEPLOY', evidence='tests/objectiveFreshBatchBlind.test.ts (blind readings, 30/30); sensitivity C01-*'),
 dict(id='W2e', rc='RC1', what='A stream that ends without a finish reason or [DONE] is an error, not an answer.', owner='modelBench.ts readStream', depends='', state='BRANCH_PENDING_DEPLOY', evidence='sensitivity C23-I'),
 dict(id='W2f', rc='RC2', what='A route kept against the critic ranks after every route the critic kept (the earlier fixture hid that it did not).', owner='routeProposal.ts applyCritique', depends='', state='BRANCH_PENDING_DEPLOY', evidence='sensitivity C31-X'),
 dict(id='W2g', rc='RC8', what='Capital plus the first buyer\'s cost must fit the limit; the critic is told when the target needs reinvested proceeds; the critique prompt is tested to carry the computed line.', owner='routeProposal.ts parseRoutes/economicsLine', depends='', state='BRANCH_PENDING_DEPLOY', evidence='sensitivity C25-X, C25-R'),
 dict(id='W2h', rc='RC18', what='Fresh 30-goal evaluation on one frozen revision; blind graders with a fixed rubric recording a cause category per failure.', owner='planningEval; GRADING-E2E', depends='', state='IN_PROGRESS', evidence='fm1126b created 06:24Z on a8c46995'),
]

# ==== fm1126b production observations (07:10–08:10Z) and RC19 ====
ROOT_CAUSES['RC19'] = dict(name="A goal's research never starts: its ideas are not judged within the goal's window", kind='coordination+software',
   wrong="The tick's judge pass judged at most 5 goal ideas a tick under database pressure, ticks run many minutes when dozens of goal plans are read in sequence (30–40 s each), and the goal-idea queue held ideas of cancelled and paused goals (matched by how they were made, never by whether their goal still runs) ahead of live goals'. 30 fresh goals produced 605 ideas; none was judged in 1.5 h, so no mission, fragment or claim existed and every plan stayed on generic constructed estimates.",
   owner='russell/loop.ts judge-unjudged pass; goals/goalWork.ts goalIdeaSql',
   proof="On a fresh batch, each live goal's first ideas are judged within one tick and its first research fragments are queued within the hour.",
   evidence="planningEval judging (08:00Z): run ideas 605 CAPTURED unjudged, head of the goal queue created 05:56–06:08Z by the retired fm1126a and paused goals, updated_at = created_at; judge-one: one judgment 1.75 s; judge-pass: the pass body judged 18 in 20 s — so the pass works and is starved by budget and queue, not broken.")
setq('C14','P','FAIL','fm1126b: 0 research fragments, 0 work items, 0 claims for 30 fresh goals 1.5 h after creation (stall, items, judging probes).','RC19')
setq('C14','I','FAIL','The goal-idea queue is not ordered by live goal or decision value: cancelled and paused goals\' ideas head it (judging probe 08:00Z).','RC19')
setq('C10','R','FAIL','fm1126b f01: 4 owner-fit directions filed with decisive unknowns; their 4 validation dives sat CAPTURED, unjudged, so the unknowns never became research.','RC19')
setq('C07','P','RECHECK','fm1126b f01 (production, revision a8c46995 with wave 1): the scout named 4 directions fitting the owner (gig grocery delivery, local business delivery partner, holiday decoration transport, weekend junk haul) where fm1126a\'s plan had led with fractional aircraft ownership. One goal; the batch read will decide.','RC5,RC3')
setq('C42','P','FAIL','fm1126b f01: the plan the owner is handed is still the constructed estimates ("No found opening is far enough along to model"), because the owner-fit directions have no research yet (RC19) and constructed arrangements read nothing of the owner (RC13).','RC19,RC13')
REPAIRS.append(dict(id='W2i', rc='RC19', what="Goal ideas are goal work only while their goal is live (goalIdeaSql: LIVE_GOAL_PROJECT_IDS_SQL); the judge pass judges up to 40 goal ideas a tick until a 45 s budget, halved under pressure instead of falling to 5.", owner='goals/goalWork.ts; russell/loop.ts', depends='', state='BRANCH_PENDING_DEPLOY', evidence='tests/goalIdeasEachProjectsTurn.test.ts (production-shaped backlog); sensitivity C14-I'))
PROGRESS.append(dict(at='2026-11-26 08:10Z', measure='fm1126b mid-run: research never started on any of 30 goals (RC19); the batch measures RC19, not planning. Acceptance restarts on a new frozen revision after wave 2 deploys.', usable='n/a', note='judging, judge-one and judge-pass probes'))

# ---- wave 2 merged (PR #1346, dcc34fed), deploy 45783978454 ----
for r in REPAIRS:
    if r['state']=='BRANCH_PENDING_DEPLOY': r['state']='MERGED_PENDING_PRODUCTION'; r['evidence']+=' | PR #1346'
    if r['state']=='MERGED_PENDING_PRODUCTION' and r['id'].startswith('W1'): r['evidence']+=' | PRs #1339/#1341 deployed; production verification pending the next batch'

# --- 2026-11-26 09:26-09:55Z: fm1126b read on dcc34fe (wave 2 live) ---
next(r for r in REPAIRS if r['id']=='W2i').update(state='DEPLOYED_PARTIAL', evidence='Deploy 45788180566 (dcc34fe) success. Judging on production: fm1126b 143 ideas judged WORTH_DOING with compiled missions by 09:40Z (was 0 at 08:00Z); 944 still unjudged behind other live eval goals. Judging works; launch does not (RC20).')
PROGRESS.append(dict(at='2026-11-26 09:30Z', measure='fm1126b read on dcc34fe: 30/30 NO_CANDIDATE. Every goal holds 1-4 owner-fit openings (89 total, e.g. Tulsa truck: junk haul, delivery partner, holiday setup), all unpriced; 0 missions, 0 fragments, 0 claims for the run.', usable='0/30', note='read_fm1126b_0926, stall, judging and launching probes; the blocker is launch, not planning (RC20)'))
ROOT_CAUSES['RC20'] = dict(name="A live goal's judged ideas never launch: the launch window ranks paused and ended goals' price questions and rounds as goal work", kind='coordination+software',
   wrong="goalPriceSql and goalRoundSql (goals/goalWork.ts) named ideas as goal work by how they were made, never by whether their goal still runs, so in nextLaunchable's order (fits, goal tier, per-project turn, tier) paused and ended goals' price questions (tier 0) and rounds (tier 1) stood ahead of a live goal's dives and ideas (tiers 2-3). A tick fills 5-30 launches inside a 30 s budget and ticks run ~17 min, so the head was refilled from other projects every tick. The packet runner's plan-read boost used the same ungated predicate.",
   owner='goals/goalWork.ts goalPriceSql, goalRoundSql (read by russell/loop.ts nextLaunchable and research/packetRunner.ts servesGoalPlanRead)',
   proof="On a fresh batch, each live goal's judged ideas launch missions within a tick or two of being judged, and its first fragments run within the hour.",
   evidence="planningEval launching (09:45-09:55Z, dcc34fe): run 143 judged ideas, all with missionSpec, 30 grants at 6 free slots each, run ideas first at launch-window position 33, 0 run missions in 3 h; Brain-wide 31-86 missions an hour across 22-41 projects; 152 projects with 2483 launchable ideas. Isolated: tests/goalIdeasEachProjectsTurn 'launches a live goal's judged idea before a paused goal's judged price questions' fails on the unfixed predicate (paused price question first) and passes with the gate.")
setq('C14','R','FAIL',"fm1126b on dcc34fe: ideas judged, missions 0 — the launch window ranked paused and ended goals' price questions and rounds as goal work (launching probe 09:45Z).",'RC20')
REPAIRS.append(dict(id='W2j', rc='RC20', what="Every goal tier is a live goal's work: goalPriceSql and goalRoundSql are gated on liveGoalProjectSql (LIVE_GOAL_PROJECT_IDS_SQL), as goalIdeaSql and goalDiveSql already were; goalRoundsAwaitingLaunch keeps its reading.", owner='goals/goalWork.ts', depends='W2i', state='BRANCH_PENDING_DEPLOY', evidence="tests/goalIdeasEachProjectsTurn.test.ts known-bad fails without the gate, passes with it; test:impacted 117 passed; launch-window and price-priority suites 264 passed"))
PROGRESS.append(dict(at='2026-11-26 09:59Z', measure="dev6 (12 goals, integration owner's read) on dcc34fe vs 442a657: still 0/12. 10/12 moved from QUANT-critical or no-candidate on generic constructed arrangements (RC13, #1345 effective: no $18M-$30M readings) to 'no live opportunity far enough along to model' (unpriced openings); d06 and d07 now lead with found openings. Research 7-10 RESEARCHING packets per goal, before RC20.", usable='0/12', note='reported by session_01QF5Tk7etm6MGmaFuHMd6eZ; next read about 60 min after 2f91d08 is live'))
next(r for r in REPAIRS if r['id']=='W3a').update(state='DEPLOYED_EFFECTIVE_PARTIAL', evidence=next(r for r in REPAIRS if r['id']=='W3a')['evidence']+' Production dev6 09:59Z on dcc34fe: the generic constructed readings are gone in 10/12 cases; plans now wait on pricing the owner-fit openings (RC20/RC6).')
setq('C02','F','FAIL',"Controlled proof run (2026-11-26, C01-C42 agent): the owner-profile reader drops only fields its own reply marks 'not stated'/'none'/'n/a'; it never compares the profile with the owner's words, so a skill or asset the model invents is kept and reaches the route ask. The map's expected behaviour (a profile contradicting the owner's words is corrected) is not implemented.",'RC17')
next(r for r in REPAIRS if r['id']=='W2j').update(state='DEPLOYED_VERIFIED', evidence="Deploy 45807923254 (baa7192) success. planningEval launching 11:3xZ on baa7192: run ideas first in the launch window at position 0 (was 33), 168 fitting the run's free slots, 12 fm1126b missions RUNNING (was 0 for 3 h). Two releases before it were refused only by pre-existing test timeouts (routeCritique 31.8 s, calebDurability 34.2 s), now bounded by their measured time.")
setq('C14','R','PASS',"fm1126b on baa7192 (RC20 live): judged ideas launch — first in the window, 12 missions RUNNING within minutes of release (launching probe).",'RC20')
PROGRESS.append(dict(at='2026-11-26 11:35Z', measure='RC20 verified on production: fm1126b research launches (12 missions RUNNING). Plans still unpriced; first research results expected over the next hours at about 20 fragments/h Brain-wide.', usable='0/30 (research in progress)', note='launching probe on baa7192'))
REPAIRS.append(dict(id='W2k', rc='RC17', what="The owner profile holds only skills and assets the owner's own words support (ownerProfileOf with the words; groundedInWords), so a skill or asset the model invents never reaches the route ask, the critic or discovery.", owner='goals/routeProposal.ts', depends='', state='BRANCH_PENDING_DEPLOY', evidence="tests/planningFailureMapWave2 'C02-F: the owner profile holds only what the owner said' fails without the grounding, passes with it; test:impacted 200 passed"))

# ---- Current Opus + Brain workflow coverage (2026-11-27) ----
# The capabilities above (C01-C75) describe Brain's own autonomous planner. The
# owner's workflow is now: an objective given in the Claude app, Opus driving
# Brain through the brain_planning_* tools (server/mcp/planningTools.ts over
# server/services/planning/sessionPlanning.ts), checked by
# server/domain/sessionPlanning.ts checkRevision, reviewed and verified by a
# second identity dealt through Brain's work queue. Each row says which owner
# does the work, what it reads and produces, what evidence holds, and what
# remains. Status: PASS (verified), PARTIAL (verified with a named gap), FAIL
# (a known defect), BLOCKED (needs the owner's action), LEGACY (superseded path).
_J = 'docs/planning-session-reliability-2026-11-26'
WORKFLOW = [
 dict(id='W01', name='Objective to goal and contract', status='PASS',
   behavior='The owner\'s words become a goal with a contract (target, window, capital, owner hours, scope) that every later check reads; an unstated term stays unstated.',
   component='sessionPlanning.establishContract / currentContract; tool brain_planning_contract', inputs='objective text from the Claude-app session', output='GoalContract row', consumer='checkRevision constraints; runBrain; grader',
   evidence=f'{_J}/journeys j1/j2 state (contracts established through the isolated MCP host); tests/sessionPlanningPath.test.ts', remaining='—'),
 dict(id='W02', name='Discovery from a raw objective', status='PARTIAL',
   behavior='With no supplied candidates, the session proposes routes, Brain admits them as openings with a stated mechanism, and refuses inadmissible ones with the values it accepts.',
   component='sessionPlanning.admitRoutes; goals/routeProposal.ts (mechanism refusal lists CASH_MECHANISMS)', inputs='routes the author proposes from the objective and Brain context', output='opportunities rows linked to the goal', consumer='runBrain planner; planningContext',
   evidence=f'{_J}/journeys/j2-admit-mechanism-retry.json (refusal fixed, retry admitted); J2 published NO_PLAN with a $150 experiment', remaining='No bench rubric grades raw-objective discovery yet; final acceptance includes discovery cases graded on the published plan by the §2 rule (a generic refusal or no openings fails).',
   legacy='goals/routeProposal open-model route ask and russell scout (Brain-autonomous discovery, C03-C10) are not on this path'),
 dict(id='W03', name='Decisive research questions', status='PASS',
   behavior='Brain names the question whose answer changes the plan, per opening and link.',
   component='sessionPlanning.openQuestions; goals pathResearch', inputs='planner links not ok', output='research needs with link and decision', consumer='author research; brain_planning_research',
   evidence=f'{_J}/journeys j2-summary.json (questions opened and answered)', remaining='—'),
 dict(id='W04', name='Research execution by the session', status='PASS',
   behavior='The author researches with its own tools and records each answer with sources; no answer without a source.',
   component='sessionPlanning.answerResearch; tool brain_planning_research', inputs='web sources the session reads', output='evidence facts attached to the need', consumer='verification (W05); planner rerun',
   evidence='J1, J2 journeys; tests/sessionPlanningPath.test.ts', remaining='—', legacy='research/packetRunner fragments (Brain fleet research) remain for autonomous goals, not this path'),
 dict(id='W05', name='Independent evidence verification', status='PASS',
   behavior='Every answer is verified by a principal other than its author, dealt as a PLAN_VERIFY work item; completion requires the recorded verdict.',
   component='sessionPlanning.requestVerification / leasedVerificationFor / verificationRecordedBy; mcp/tools.ts brain_complete_work guard', inputs='answer + sources', output='verification verdict', consumer='planner facts; checkRevision',
   evidence='J2: 2 verifications by the fleet via the queue; tests/sessionPlanningPath.test.ts', remaining='—'),
 dict(id='W06', name='Geography of evidence', status='PASS',
   behavior='UNSTATED geography does not reject a claim when the question needs no market; a required market keeps its restriction.',
   component='research gate geography rule', inputs='claim scope, question scope', output='claim admitted or refused', consumer='facts the planner reads',
   evidence='commit 635bbed narrow gate geography rule; matched unrestricted/market-specific controls in tests/evidenceLanes.test.ts and tests/cashPipelineRepair.test.ts', remaining='—'),
 dict(id='W07', name='Quantitative checks and cash ledger', status='PASS',
   behavior='The plan\'s arithmetic is recomputed: costs under prices, capital including owner float (FUNDING), net targets after direct costs, settlement inside the window.',
   component='domain/sessionPlanning.checkRevision (cash ledger, ECONOMICS, SETTLES_IN_TIME)', inputs='revision strategy, cash ledger, contract', output='check codes', consumer='author revision; publication gate',
   evidence='tests/sessionPlanningChecks.test.ts (48 checks/path tests)', remaining='—'),
 dict(id='W08', name="Brain planner's link judgement", status='PASS',
   behavior='Each link of an opening (buyer, demand, offer and price, conversion, MARKET_VOLUME, fulfiller, economics, settlement) is judged from the evidence.',
   component='goals/plan.ts; goals/goalScenario.ts; tool brain_planning_run_brain', inputs='opening card, facts, contract', output='Brain run summary (considered, excluded, verdict, nextTest)', consumer='author; checkRevision BrainFacts',
   evidence=f'{_J}/mv-04-determination.md; repaired 2026-11-27 in cash/volume.ts readVolume (a category total spread across N sellers is one listing\'s average share): tests/volumeRead.test.ts controls (no sellers named, 4 sellers, orders from 40 stores) and tests/investmentCommitteeWorld.test.ts mv-04 planner regression (MARKET_VOLUME not ok across 40 sellers; ok across 4)', remaining='—'),
 dict(id='W09', name='Strategy comparison', status='PARTIAL',
   behavior='Alternatives are compared on the same evidence; excluded openings stay visible with their card, facts and agreements, and can be disputed with a stated reason.',
   component='sessionPlanning.consideredOpenings / openingRecord; checkRevision EXCLUSION_DISPUTE_UNSTATED', inputs='Brain run (considered + excluded)', output='strategy with disagreements', consumer='reviewer; publication',
   evidence='tests/sessionPlanningChecks.test.ts exclusion dispute (2 tests)', remaining='No check that the chosen strategy dominates a considered alternative; comparison is the author\'s reasoning, examined by the reviewer.'),
 dict(id='W10', name='Fulfilment and capabilities', status='PASS',
   behavior='Every member names who fulfils it; owner-performed work counts owner hours; Brain- or provider-performed work does not.',
   component='goals/goalScenario.ts foundOwnerHours / fulfiller; checkRevision FULFILMENT', inputs='opening card', output='labour hours', consumer='W11',
   evidence='tests/sessionPlanningChecks.test.ts', remaining='—'),
 dict(id='W11', name='Owner constraints; unknown availability', status='PASS',
   behavior='Capital, deadline, scope and hours bind; owner hours the goal does not state stay unknown — the plan is at most CONDITIONAL and Brain asks the owner — never zero, never unlimited.',
   component='checkRevision UNKNOWN_IN_EXECUTABLE / OWNER_HOURS_OVER; goals/plan.ts askHours', inputs='contract hoursCeiling, plan labour', output='check codes; nextTest by PERSON', consumer='author; owner',
   evidence='tests/sessionPlanningChecks.test.ts unknown owner availability (3 tests)', remaining='—'),
 dict(id='W12', name='Commercial payer versus a program', status='PASS',
   behavior='A buyer registered with, enrolled in or funded by a program is the buyer; only a program or funder that is itself the payer is excluded as not a sale.',
   component='domain/paymentNature.ts payerHead / arrangementExclusion', inputs='opening payer text', output='exclusion or none', consumer='planner exclusions (W09)',
   evidence='tests/commercialHoldout.test.ts 64/64 incl. fx-15 and controls', remaining='—'),
 dict(id='W13', name='Constraint versus missing evidence', status='PASS',
   behavior='Missing demand evidence cannot establish an arithmetic ceiling; a constraint cites EVIDENCE facts.',
   component='checkRevision CONSTRAINT_FROM_MISSING_EVIDENCE; CONSTRAINT_INPUTS', inputs='constraints with basis', output='check codes', consumer='author',
   evidence=f'{_J}/run5-frozen regression; tests/sessionPlanningChecks.test.ts', remaining='—'),
 dict(id='W14', name='Independent review', status='PASS',
   behavior='A clean revision is dealt to a second identity as PLAN_REVIEW; the reviewer\'s conditions each cite evidence or a missing prerequisite; the author answers every condition against the records.',
   component='sessionPlanning.requestReview / recordReview / conditionProblems; checkRevision REVIEW_CONDITION_UNANSWERED; brainOnly workItemPurposeAdmits (§118 owner-directed)', inputs='revision digest', output='review verdict + conditions', consumer='author revision; finalize',
   evidence='J1 reviewed by the fleet via the queue (21.5 min); J2 2 reviews; tests/sessionPlanningPath.test.ts, tests/brainOnlyMode.test.ts', remaining='—'),
 dict(id='W15', name='Revision loop', status='PASS',
   behavior='Checks and review conditions return to the author, who revises until clean or concludes no plan with the decisive blocker.',
   component='sessionPlanning.submitRevision / revisions', inputs='check codes, review conditions', output='new revision', consumer='review; finalize',
   evidence=f'{_J}/run5-frozen; journeys', remaining='—'),
 dict(id='W16', name='Publication', status='PASS',
   behavior='Only a reviewed, clean revision is finalized; outcome EXECUTABLE, CONDITIONAL, NO_PLAN with an experiment.',
   component='sessionPlanning.finalizePlan; tool brain_planning_finalize', inputs='revision + PASS review', output='published plan', consumer='owner; grader',
   evidence='J1 EXECUTABLE rev_04068c407b1e_13c8a5; J2 NO_PLAN rev_d3e0d4b02959_317031', remaining='—'),
 dict(id='W17', name='Persistence and resume', status='PASS',
   behavior='All state is rows; a new session resumes from planningState without the transcript.',
   component='sessionPlanning.planningState; tool brain_planning_state', inputs='goal id', output='state', consumer='resumed author session',
   evidence='journeys j1/j2-state.json read back from the database', remaining='—'),
 dict(id='W18', name='Recovery from operational failure', status='PASS',
   behavior='A reviewer or verifier that dies loses its lease and the item is dealt again; a tool error names the failed operation and the retry succeeds.',
   component='repos/workQueue.ts lease expiry; mcp error mapping', inputs='lease state', output='redelivered item', consumer='another fleet member',
   evidence='J2 mechanism refusal → retry; tests/sessionPlanningPath.test.ts "a reviewer that dies loses its review" (no second owner while live; lapsed lease grants nothing; redealt to another member)', remaining='—'),
 dict(id='W19', name='Permissions', status='BLOCKED',
   behavior='The owner\'s app connector holds operator rights on the planning project; reviewers need only project:read + queue:complete and a lease.',
   component='scripts/admin.ts access grant-planning; planningTools authorize', inputs='owner admin action', output='membership scopes', consumer='app connector',
   evidence='production connector worker-05 holds operator:act on no project (app-readiness.md)', remaining='MISSING_AUTHORITY: owner runs grant-planning after release.'),
 dict(id='W20', name='Claude-app access', status='BLOCKED',
   behavior='The owner\'s Claude app lists and calls the brain_planning_* tools on production.',
   component='server/mcp planning tools on the production MCP endpoint', inputs='deployed build', output='tools in the app', consumer='owner',
   evidence='production serves no brain_planning_* tools (app-readiness.md); isolated host proves the tools end to end', remaining='MISSING_AUTHORITY: merge and Deploy authorization.'),
 dict(id='W21', name='Automatic coordination', status='PARTIAL',
   behavior='Review and verification are dealt to the fleet by the queue with no manual shuttling; the author resumes when they finish.',
   component='workQueue PLAN_REVIEW/PLAN_VERIFY; brainOnly §118 admission; goal ownership via PATCH /api/goals/<goal>/terms', inputs='queued items', output='verdicts', consumer='author',
   evidence='J1/J2 fleet reviews and verifications via the queue', remaining='Author polls brain_planning_state (no push); production routines must recognize the new work types (unverified until release); connector-created goals need an owner for §118 admission.'),
 dict(id='W22', name='Acceptance grading', status='PASS',
   behavior='Published plans of unfamiliar objectives are graded per COMPLETION-SPEC §4 with denominators, Wilson intervals and critical counts; hidden cases are authored by another agent.',
   component='scripts/planningReliabilitySession.ts', inputs='published plans + rubrics', output='verdict/usable/e2e counts', consumer='completion claim',
   evidence=f'{_J}/run5-frozen (11/14, 0 critical)', remaining='Final acceptance on the frozen build carrying the W08/W11/W12/W18 repairs.'),
]
