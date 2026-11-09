#!/usr/bin/env python3
"""
Release 01 of the Brain architecture program: the requirement map (§97).

Reads the items Factory's own extractor found in the verbatim source
(`factory program-skeleton` output, or the JSON this script is handed) and
writes the map: every item cited by exactly one requirement, every ambiguity
carried with a proposed reading, priority and readiness per R01-B, the existing
owner per §10.3/§20.4, and one production probe per requirement. A probe named
`r01.*` that is not yet registered answers UNKNOWN — never PASS — so nothing is
counted verified until reviewed acceptance code reads production rows.

Usage: python3 -I scripts/program-map-release-01.py <items.json> <out.map.json>
"""
import json, sys

items = json.load(open(sys.argv[1], encoding='utf-8'))

# Section heading prefix -> requirement definition.
#   key, subsystem, priority, prepared, existing paths (or []), evidence, work paths, missing work, depends
S = {}
def r(prefix, key, title, subsystem, priority, paths, missing, existing=None, evidence='', deps=(), prepared=False, behavior=None):
    S[prefix] = dict(key=key, title=title, subsystem=subsystem, priority=priority, paths=list(paths), missing=missing,
                     existing=list(existing or []), evidence=evidence, deps=list(deps), prepared=prepared, behavior=behavior)

FP = ['server/services/factory/program/**', 'server/domain/factoryProgram.ts']
PROGRAM_EVIDENCE = ('§96 programs (verbatim source, omission-refusing map, dependency-ordered campaigns, production-verified status) '
                    'and §97 amendments/priority/prepared scheduling; tests/factoryProgramCoordinator.test.ts, tests/factoryProgramAmendments.test.ts.')

# --- Release 01 addendum (itemized below, per directive) and program governance ---
r('RELEASE 01', 'R01-HEAD', 'Release 01 is the first handoff and the architecture stays open for additions', 'factory-program', 'P0', [], '',
  existing=FP, evidence=PROGRAM_EVIDENCE)
r('Brain — Master Thinking', 'GOV-DRAFT', 'The master specification is a living draft preserved verbatim', 'factory-program', 'P0', [], '',
  existing=FP, evidence=PROGRAM_EVIDENCE)
r('10.1', 'GOV-10-1', 'Preserve the source design; append dated decisions', 'factory-program', 'P0', [], '', existing=FP, evidence=PROGRAM_EVIDENCE)
r('10.2', 'GOV-10-2', 'Traceable atomic requirement catalog; nothing disappears in summarization', 'factory-program', 'P0', [], '', existing=FP, evidence=PROGRAM_EVIDENCE)
r('10.3', 'GOV-10-3', 'Inventory and reuse existing systems; no giant PR; explicit ownership and merge/deploy checkpoints', 'factory-program', 'P0', [], '', existing=FP, evidence=PROGRAM_EVIDENCE)
r('10.4', 'GOV-10-4', 'Every requirement progresses specified → mapped → implemented → integrated → production verified', 'factory-program', 'P0', [], '', existing=FP, evidence=PROGRAM_EVIDENCE)
r('10.5', 'GOV-10-5', 'Delivery streams interact; later features are not deferred when an earlier production test needs them', 'factory-program', 'P0', [], '', existing=FP, evidence=PROGRAM_EVIDENCE)
r('11.', 'GOV-11', 'Owner decisions recorded; open design questions kept open, not frozen', 'factory-program', 'P1', ['docs/programs/brain-architecture/**'],
  'Keep the open-questions list of §11 as a maintained register beside the program and re-map it when the owner answers.', existing=FP, evidence=PROGRAM_EVIDENCE)
r('12.', 'GOV-12', 'Change log retained', 'factory-program', 'P0', [], '', existing=FP, evidence=PROGRAM_EVIDENCE)
r('17.1', 'GOV-17-1', 'Comprehensive coverage and economic, dependency-aware execution order', 'factory-program', 'P0', [], '', existing=FP, evidence=PROGRAM_EVIDENCE)
r('17.2', 'GOV-17-2', 'P0–P3 starting work order, revisable by production evidence', 'factory-program', 'P0', [], '', existing=FP, evidence=PROGRAM_EVIDENCE)
r('17.3', 'GOV-17-3', 'Factory governance: safeguards, exact requirements per worker, one parent status, post-deploy evaluation, measured capacity', 'factory-program', 'P0',
  ['server/services/factory/release/outcome.ts'], 'After every deploy, record whether the release increased useful commercial output or unlocked the next causal link (17.3.4), read from cash and goal rows.',
  existing=FP, evidence=PROGRAM_EVIDENCE)
r('17.4', 'GOV-17-4', 'The architecture stays open until every requirement is verified; additions are re-mapped without loss', 'factory-program', 'P0', [], '', existing=FP, evidence=PROGRAM_EVIDENCE)
r('17. Added', 'GOV-17', 'Revenue first, complete architecture preserved', 'factory-program', 'P0', [], '', existing=FP, evidence=PROGRAM_EVIDENCE)
r('18.7', 'GOV-18-7', 'Priority correction: no category anchoring in plans or acceptance tests', 'factory-program', 'P0', [], '', existing=FP, evidence=PROGRAM_EVIDENCE)
r('22.', 'GOV-22', 'Capabilities prepared in advance; priority promoted by actual dependencies', 'factory-program', 'P0', [], '', existing=FP, evidence=PROGRAM_EVIDENCE)
r('22.1', 'GOV-22-1', 'Readiness separate from urgency; scheduler compares value, urgency, reuse and cost; demotes vanished needs', 'factory-program', 'P1',
  ['server/services/goals/priority.ts'], 'Promote a prepared requirement from a measured blocker in goal/cash rows (several blocked transactions, cheaper reuse, changed interface), not only from a declared edge.',
  existing=FP, evidence=PROGRAM_EVIDENCE)
r('22.2', 'GOV-22-2', 'Prepositioned options are cheap and are not production integrations', 'factory-program', 'P2', ['server/services/capability/**'],
  'Record a prepared option (feasibility note, tool inventory, interface sketch) against the capability map without counting it as an integration.', existing=FP, evidence=PROGRAM_EVIDENCE)
r('28. Added', 'GOV-28', 'Cross-cutting gap register is a dated source, not a competing contract', 'factory-program', 'P0', [], '', existing=FP, evidence=PROGRAM_EVIDENCE)
r('28.9', 'GOV-28-9', 'Priority logic for the gap areas, revised by observed dependencies', 'factory-program', 'P0', [], '', existing=FP, evidence=PROGRAM_EVIDENCE)
r('38.', 'GOV-38', 'Every §29–37 requirement and interaction traced to source, code, acceptance and production verification', 'factory-program', 'P0', [], '', existing=FP, evidence=PROGRAM_EVIDENCE)

# --- P0: live cash goal, open-world generation, acceptance policy, authorization and accounting ---
CASH = ['server/services/cash/**']
GOALS = ['server/services/goals/**']
QUANT = ['server/services/quant/**', 'server/services/scenario/**']
IND = ['server/services/industry/**']
FEEDS = ['server/services/feeds/**']
FREE = ['server/services/freeLane/**', 'server/services/cheap/**']
RES = ['server/services/research/**']
UI = ['client/src/**']
r('1.', 'ARCH-01', 'Brain is an autonomous economic reasoning and business-operation system, not a fixed catalog', 'opportunity', 'P0', ['server/services/industry/expand.ts'],
  'Prove open-world construction beyond held records (see OPP-03).', existing=IND + CASH, evidence='industry kernel/graph/expand and cash construct/discovery construct arrangements from evidence.', deps=['OPP-03'])
r('2.', 'GOAL-02', 'Goals are adjustable conditions with their own metric and deadline; no hard-coded ladder', 'goals', 'P0', ['server/services/goals/target.ts'],
  'Verify the $10K goal metric counts only collected/settled cash; goals coexist and change allocation on evidence.', existing=GOALS, evidence='goals target/policy/portfolio; §95 acceptance at defensible 90%.')
r('3. The business', 'OPP-03', 'Open-ended, generative opportunity field from memory, the world, first principles, recombination and constraints', 'opportunity', 'P0',
  ['server/services/industry/expand.ts', 'server/services/cash/discovery.ts'], 'Seed exploration from all five origins with no category whitelist; record origin per candidate; prefer markets by economics and remote control, not owner location.',
  existing=IND + ['server/services/cash/discovery.ts'], evidence='§82/§92 constructed arrangements and industry positions.')
r('3.1', 'OPP-03-1', 'Transformational operators that propagate and detect shared failure dependencies', 'opportunity', 'P1', ['server/services/industry/construction/**'],
  'Apply each listed operator (payer, offer, price, channel, fulfiller, role, geography, capital, repeatability) to a structure, propagate effects, and flag shared failure dependencies between ideas.', deps=['OPP-03'])
r('3.2', 'OPP-03-2', 'Retain useful components and the failure mode when an arrangement fails', 'opportunity', 'P1', ['server/services/industry/construction/**'],
  'Store components (supplier, channel, insight, price signal, capability) of a failed arrangement with its failure mode for later recombination.', deps=['OPP-03'])
r('3.3', 'OPP-03-3', 'Diverse frontier with explicit park/supersede/combine/advance reasons', 'opportunity', 'P1', ['server/services/industry/allocate.ts'],
  'Record why each branch is parked, superseded, combined or advanced; spend deep research where answers change the next decision.', existing=['server/services/industry/allocate.ts'], evidence='§65 dead ends as watches; §47 no possibility discarded for rank.', deps=['OPP-03'])
r('4.', 'OPP-04', 'Reason backward from goals and forward from world evidence; full transaction path with marked inputs', 'goals', 'P0', ['server/services/goals/pathways.ts'],
  'Every candidate path marks each input evidence-backed, ranged estimate or unknown; quant results transform strategy (channel, offer, settlement, volume).',
  existing=['server/services/goals/pathways.ts', 'server/services/goals/plan.ts'], evidence='§93 goal-to-transaction reasoning loop.')
r('5.', 'PORT-05', 'Portfolio of independent streams; AI work credited only when proven; responsible offers as soon as authorized', 'portfolio', 'P1', ['server/services/goals/portfolio.ts'],
  'Model correlations, cash timing, obligations and shared constraints across streams; sales run beside research within permissions.',
  existing=['server/services/goals/portfolio.ts', 'server/services/cash/portfolio.ts'], evidence='goal and cash portfolios.', deps=['OPP-04'])
r('6.', 'PORT-06', 'Business archetypes are adjustable roles, judged against their designated role', 'portfolio', 'P2', ['server/services/cash/portfolio.ts'],
  'Give each business one or more archetype roles that change over time and score it against its role and portfolio effect.', deps=['PORT-05'])
r('6.1', 'PORT-06-1', 'Capital buckets kept distinct; borrowing modeled with terms and risk', 'money', 'P2', ['server/services/cash/money.ts'],
  'Separate collected cash, gross revenue, costs, profit, taxes, reserves, debt service, deployed and remaining capital; model loans with collateral and liquidation exposure.',
  existing=['server/services/cash/money.ts'], evidence='§37 money figures from append-only entries.', deps=['PORT-05'])
r('7. Research', 'RES-07', 'Continuous research across five purposes with dynamic reallocation and protected minimum exploration', 'research-allocation', 'P1', ['server/services/goals/researchYield.ts'],
  'Attribute research to the five purposes and reallocate by useful outcome, deadline and bottleneck while keeping a minimum exploration and system-health share.',
  existing=['server/services/goals/researchYield.ts', 'server/services/research/lanes.ts'], evidence='§72/§85/§90 research allocation.')
r('7.1', 'TEL-07-1', 'Rolling 1h/6h/24h telemetry with denominators, separating job count from useful and actionable findings', 'telemetry', 'P1', ['server/services/cash/screenMetrics.ts'],
  'Serve one telemetry reading over 1h/6h/24h for every listed measure with explicit denominators; read fresh production telemetry before any capacity change.',
  existing=['.github/workflows/productivity-report.yml', '.github/workflows/cheap-lane.yml'], evidence='productivity and cheap-lane reports.')
r('7.2', 'IMP-07-2', 'Detect repeated failures and route structural gaps to Factory; evaluate whether the repair improved its goal', 'self-improvement', 'P1', ['server/services/improvement/**'],
  'Close the loop: a repair records the before/after of the goal measure it targeted.', existing=['server/services/improvement/loop.ts'], evidence='§87 one improvement loop.')
r('8.', 'UI-08', 'Unified product with conversation grounded in live state and permission-aware actions', 'product-ui', 'P1', ['client/src/**'],
  'Conversation alongside goal/opportunity/transaction/portfolio/research views; explain decisions and blocks with links to records; one design system.',
  existing=['server/services/russell/**', 'client/src/russell/**'], evidence='§24 Russell, §57 six destinations.', deps=['UI-27-2'])
r('9.', 'GOAL-09', 'Current $10K constraints vs future capabilities; goal acceptance separates candidate from accepted plan', 'goals', 'P0', ['server/services/goals/policy.ts'],
  'Verify on production that no hypothetical coverage qualifies as 90% proof and that operational execution of authorized offers continues while planning is unproven.',
  existing=['server/services/goals/policy.ts'], evidence='§95 defensible 90% acceptance.')
r('13. Added', 'COM-13', 'Asset-light commercial control across any mechanism, not reduced to AI consulting', 'opportunity', 'P0', ['server/services/industry/expand.ts'],
  'Construct third-party fulfillment, prepayment, referral/agency and licensed-partner arrangements from evidence across industries.', deps=['OPP-03'])
r('13.1', 'COM-13-1', 'Model the controllable commercial role separately from the industry', 'opportunity', 'P0', ['server/services/industry/construction/**'],
  'For each flow enumerate available positions, what each controls, its value, duties and risks.', existing=['server/services/industry/kernel.ts'], evidence='§92 positions.', deps=['COM-13'])
r('13.2', 'COM-13-2', 'Composable commercial leverage traced through cash, margin, risk and capacity', 'quant', 'P1', ['server/services/quant/mechanism.ts'],
  'Trace each leverage combination through conversion, margin, supplier risk, capacity, liability and speed; verify prepayment willingness and refund obligations.', deps=['COM-13-1'])
r('13.3', 'COM-13-3', 'Full outreach funnel for volume and high-ticket modes; messages are not buyers', 'quant', 'P0', ['server/services/cash/funnel.ts'],
  'Model permission, unique prospects, deliverability, throughput, reply, qualification, close, settlement and repeat for any channel.',
  existing=['server/services/cash/funnel.ts', 'server/services/cash/outreach.ts'], evidence='§94 Instantly replies as measurements.')
r('13.4', 'MONEY-13-4', 'Money velocity and deal structure; distinct cash identities', 'money', 'P0', ['server/services/quant/deadline.ts'],
  'Quantify customer- vs self-funded spend, lead→commit→funds→usable timing, refunds, receivables and peak working capital per route.', existing=['server/services/quant/deadline.ts'], evidence='quant deadline model.')
r('13.5', 'COM-13-5', 'Regulated roles assessed by rights and obligations, never blanket excluded', 'compliance', 'P1', ['server/services/cash/exclusions.ts'],
  'Find compliant positions (licensed partners) before counting economics; no category exclusion.', existing=['server/services/cash/exclusions.ts'], evidence='cash exclusions.')
r('13.6', 'GOAL-13-6', 'Search aggressive compressed timelines without inventing probabilities', 'goals', 'P1', ['server/services/goals/plan.ts'],
  'Solve backward for 30/60/90-day economics and keep candidate and accepted states distinct.', deps=['GOAL-09'])
r('13.7', 'ACC-13-7', 'Acceptance behaviors for asset-light commercial control', 'acceptance', 'P1', ['server/services/goals/plan.ts', 'server/services/industry/construction/**'],
  'Demonstrate each listed behavior on production records.', deps=['COM-13-1', 'COM-13-3', 'MONEY-13-4', 'COM-13-5'])

# --- Causal transaction model (§14) ---
r('14. Added', 'CAUSAL-14', 'No fixed five-number template; every relevant part of a deal laid out', 'causal-model', 'P1', ['server/services/quant/mechanism.ts'],
  'Represent an arbitrary deal with emergent variables.', existing=['server/services/quant/mechanism.ts', 'server/services/quant/reconstruct.ts'], evidence='§79/§81 reconstruction.')
r('14.1', 'CAUSAL-14-1', 'Typed, extensible causal graph with actions and the causal route to money', 'causal-model', 'P1', ['server/services/quant/graph.ts'],
  'One graph per business/deal/portfolio: open node/relation vocabulary, prerequisites/actor/permission/effect/timing per action, payer→terms→channel→invoice→collection→outflows→free cash.', deps=['CAUSAL-14'])
r('14.2', 'CAUSAL-14-2', 'Every number has lineage and an economic identity; double-entry reconciliation', 'causal-model', 'P1', ['server/services/quant/graph.ts'],
  'Attach meaning, unit, source, status, window, scope, bounds and invalidating dependencies to every figure; reconcile identities; expose gaps rather than plug them.', deps=['CAUSAL-14-1'])
r('14.3', 'CAUSAL-14-3', 'Complete dependency chain including nonfinancial constraints and saturation', 'causal-model', 'P1', ['server/services/quant/graph.ts'],
  'Pass volume through every bottleneck before calling it revenue; model saturation and correlated failure.', deps=['CAUSAL-14-1'])
r('14.4', 'CAUSAL-14-4', 'Executable, interrogable, transformable model', 'causal-model', 'P1', ['server/services/quant/graph.ts', 'server/routes/**'],
  'Answer money-path and what-if questions from the graph; propagate changes; send decision-critical unknowns to research or authorized action.', deps=['CAUSAL-14-2', 'CAUSAL-14-3'])
r('14.5', 'CAUSAL-14-5', 'Commercial uncertainty modeled mathematically; validated inputs', 'causal-model', 'P1', ['server/services/quant/graph.ts'],
  'Quantify each safeguard\'s effect on downside; claim ≥90% only from calibrated evidence.', deps=['CAUSAL-14-2'])
r('14.6', 'ACC-14-6', 'Causal-model verification requirements', 'acceptance', 'P1', ['server/services/quant/graph.ts'],
  'Demonstrate each listed verification on production.', deps=['CAUSAL-14-4', 'CAUSAL-14-5'])
r('14.7', 'CAUSAL-14-7', 'Commercial uncertainty inside the quantitative model with calibrated, auditable probability', 'causal-model', 'P1', ['server/services/quant/portfolio.ts'],
  'Portfolio distribution with shared causes, mature-market evidence, the source→probability path, and propagation of new observations.', deps=['CAUSAL-14-5'])

# --- §15 ---
r('15. Added', 'ACC-15', 'Rapid capability acceleration, accountable models, middleman-research surge', 'acceptance', 'P0', ['server/services/goals/researchYield.ts'], 'Covered by its subsections; demonstrated by ACC-15-6.')
r('15.1', 'LEARN-15-1', 'Model failure diagnosed and corrected; prediction ledger and calibration', 'model-learning', 'P1', ['server/services/quant/forecast.ts'],
  'Versioned predictions, exposure and outcome ledgers; diagnose which part was wrong; correct the smallest reusable cause; recompute dependents.', existing=['server/services/cash/forecast.ts'], evidence='cash forecast.')
r('15.2', 'CAUSAL-15-2', 'Decompose novel AI businesses into observable causal subproblems', 'causal-model', 'P1', ['server/services/quant/graph.ts'],
  'Decompose deliverables, workflow, acceptance, reliability, capacity, value, substitutes, channels, price, contracts and settlement, labeling transfer from analogues.', deps=['CAUSAL-14-1'])
r('15.3', 'SPRINT-15-3', 'Rapid capability sprints with outcome-level before/after proof', 'self-improvement', 'P1', ['server/services/improvement/**'],
  'Each sprint records runnable / externally blocked / no-capacity streams and before/after outcome measures.', deps=['IMP-07-2'])
r('15.4', 'RES-15-4', 'Broad, systematic intermediation research producing usable evidence per constructed position', 'research-allocation', 'P0', ['server/services/cash/researchRoom.ts'],
  'Research spans buyer types and market structures, buyer- and supply-first entries, and returns per-position payer/channel/demand/supplier/spread/timing/rights/next action.', deps=['COM-13-1'])
r('15.5', 'RES-15-5', 'Allocate research by useful yield, cost counted once', 'research-allocation', 'P1', ['server/services/goals/researchYield.ts'],
  'Per-lane yield per window; change question design or routing before raising limits; capacity only to a measured constraint.', existing=['server/services/goals/researchYield.ts'], evidence='research yield.', deps=['TEL-07-1'])
r('15.6', 'ACC-15-6', 'Full causal integration and the five required demonstrations', 'acceptance', 'P1', ['server/services/goals/plan.ts'],
  'Demonstrate all five on production.', deps=['RES-15-4', 'CAUSAL-15-2', 'LEARN-15-1', 'RES-15-5', 'PORT-05'])

# --- §16 code-first research ---
r('16. Added', 'ALGO-16', 'Research does not depend on an LLM per observation; algorithmic lanes at volume', 'code-first-research', 'P1', FEEDS, 'Covered by its subsections.',
  existing=FEEDS, evidence='feeds run/detectors/sources.')
r('16.1', 'ALGO-16-1', 'Sensing, deterministic extraction, relational event graph, algorithmic construction, selective model intervention', 'code-first-research', 'P1', ['server/services/feeds/**', 'server/services/industry/graph.ts'],
  'Incremental connectors with cursors/dedup; deterministic parsers with raw-evidence links; neighborhood-updating graph rules; constraint-pruned construction; batched LLM escalation only for ambiguity/novelty.',
  existing=FEEDS, evidence='feeds detectors SHADOW/ACTIVE.', deps=['ALGO-16'])
r('16.2', 'ALGO-16-2', 'Extend the existing feed/detector/trigger/volume/construct owners', 'code-first-research', 'P1', ['server/services/feeds/**', 'server/services/cash/triggers.ts'],
  'Reduce free-model screening of uncovered records and model-generated trigger prompts by generalizing deterministic coverage, keeping gates.', existing=['server/services/feeds/run.ts', 'server/services/cash/triggers.ts', 'server/services/cash/volume.ts'], evidence='as named in §16.2.', deps=['ALGO-16-1'])
r('16.3', 'CAP-16-3', 'Stage-level research capacity measurement; restore model/verification throughput first', 'capacity', 'P0', ['server/services/freeLane/**'],
  'Measure per stage; restore the failing provider/GPU/verification route from current signals before any scale-up; keep the web service responsive.', existing=FREE, evidence='free lane capacity.')
r('16.4', 'ALGO-16-4', 'Autonomous rule improvement through SHADOW/ACTIVE promotion with rollback', 'code-first-research', 'P1', ['server/services/feeds/detectors.ts'],
  'Model-proposed connectors/parsers/detectors land through Factory, run SHADOW with counts and false joins, promote only on verified output.', existing=['server/services/feeds/detectors.ts'], evidence='detector modes.', deps=['ALGO-16-1'])
r('16.5', 'ACC-16-5', 'Code-first research completion proof (a)–(g)', 'acceptance', 'P1', FEEDS, 'Demonstrate on real production source families.', deps=['ALGO-16-2', 'ALGO-16-4', 'CAP-16-3'])

# --- §18 general intelligence ---
r('18.1', 'META-18-1', 'No anchoring to example categories; unfamiliar categories can outrank familiar ones', 'reasoning', 'P0', ['server/services/industry/expand.ts'],
  'Rank by estimated economics, feasibility, risk, time to cash and scale; no industry shortlist or quota.', deps=['OPP-03'])
r('18.2', 'META-18-2', 'Knowledge acquisition, mechanism understanding and an operational metareasoning controller', 'reasoning', 'P1', ['server/services/research/method.ts', 'server/services/research/methodRules.ts'],
  'A controller that selects method/representation, generates competing hypotheses, chooses next action by decision value and changes method when results invalidate it — reusing research and Factory.',
  existing=['server/services/research/method.ts'], evidence='research method rules.', deps=['CAUSAL-14-1'])
r('18.3', 'META-18-3', 'Mathematical toolkit as tool selection with per-number provenance', 'reasoning', 'P1', ['server/services/quant/**'],
  'Select and validate methods per question; record quantity, units, horizon, source, formula, alternatives, sensitivity and applicability.', deps=['CAUSAL-14-2'])
r('18.4', 'GOAL-18-4', 'Target overperformance with a defensible downside and configurable objective', 'goals', 'P1', ['server/services/goals/policy.ts'],
  'Optimize expected, upper and adverse outcomes; represent a 90% goal correctly; no manufactured floor.', existing=['server/services/goals/policy.ts'], evidence='§95 defensible-90% goal policy.', deps=['CAUSAL-14-7'])
r('18.5', 'SPRINT-18-5', 'One-week measurable intelligence sprint on held-out real commercial problems', 'reasoning', 'P1', ['server/services/improvement/**'],
  'Benchmark → implement highest-leverage reasoning capabilities → rerun on held-out tasks → verify in production against baselines.', deps=['META-18-2'])
r('18.6', 'ACC-18-6', 'Behavioral acceptance tests for general intelligence', 'acceptance', 'P1', ['server/services/improvement/**'], 'Demonstrate all six.', deps=['META-18-1', 'META-18-2', 'META-18-3', 'GOAL-18-4', 'SPRINT-18-5'])

# --- §19 mechanism blueprints ---
r('19.1', 'BLUE-19-1', 'Brain discovers the representation of each domain and revises it', 'mechanism-blueprint', 'P2', ['server/services/industry/graph.ts'],
  'Per-domain representation with stated rationale and revision when a mechanism is missed.', deps=['CAUSAL-14-1'])
r('19.2', 'BLUE-19-2', 'Generative mechanism graph extending existing representations', 'mechanism-blueprint', 'P2', ['server/services/industry/graph.ts'],
  'End-to-end causal blueprint with conditional interactions, propagation, attached uncertainty, many roles from one evidence set, cross-sector transfer with constraint checks.', deps=['BLUE-19-1'])
r('19.3', 'ALGO-19-3', 'Multiply work per LLM call: offload routine work and compile reasoning into rules', 'code-first-research', 'P1', ['server/services/feeds/**'],
  'Measure calls avoided and work created; code-derived implications stay hypotheses.', deps=['ALGO-16-1'])
r('19.4', 'ALGO-19-4', 'Observe/structure/connect/derive/reason/codify/act loop through current owners, reproducible', 'code-first-research', 'P1', ['server/services/feeds/**', 'server/services/industry/**'],
  'Every computation reproducible from source facts and software versions or marked non-deterministic.', deps=['ALGO-19-3'])
r('19.5', 'CAP-19-5', 'Scale decisions from measured contribution per parser/detector/worker/model', 'capacity', 'P1', ['server/services/freeLane/**'],
  'Compare each addition\'s contribution against cost and downstream effect.', deps=['CAP-16-3'])
r('19.6', 'ACC-19-6', 'Mechanism blueprint acceptance demonstrations 1–7', 'acceptance', 'P2', ['server/services/industry/**'], 'Demonstrate on real data.', deps=['BLUE-19-2', 'ALGO-19-4', 'CAP-19-5'])

# --- §20 autonomy ---
r('20.1', 'AUTO-20-1', 'Brain originates work from its own observations, including method inadequacy', 'autonomy', 'P1', ['server/services/improvement/**', 'server/services/selfmodel/**'],
  'Generate objectives from goal constraints, failure patterns, idle resources and missed opportunities.', existing=['server/services/selfmodel/**', 'server/services/improvement/loop.ts'], evidence='§87/§88.')
r('20.2', 'AUTO-20-2', 'Notice → hypothesis → search existing → value → acquire → verify → integrate → continue', 'autonomy', 'P1', ['server/services/improvement/**'],
  'Each loop step recorded on a capability gap row, with reuse checked first and continuation after context loss.', deps=['AUTO-20-1'])
r('20.3', 'AUTH-20-3', 'Graduated authority in the existing permission system with a durable ledger', 'authority', 'P0', ['server/services/cash/authority.ts'],
  'Classify actions into internal / standing-grant engineering / third-party authenticated / externally consequential; ask for the smallest missing approval and remember it.',
  existing=['server/services/cash/authority.ts', 'server/services/russell/authority.ts', 'server/services/improvement/authority.ts'], evidence='§16/§17/§50 authority.')
r('20.4', 'AUTO-20-4', 'Extend existing owners; measure gaps identified and closed without owner input', 'autonomy', 'P1', ['server/services/improvement/scoreboard.ts'],
  'Report gaps identified/closed, time to use, regressions and cost.', existing=['server/services/improvement/scoreboard.ts'], evidence='improvement scoreboard.', deps=['AUTO-20-2'])
r('20.5', 'ACC-20-5', 'Autonomy acceptance demonstrations 1–7', 'acceptance', 'P1', ['server/services/improvement/**'], 'Demonstrate on production.', deps=['AUTO-20-4', 'AUTH-20-3'])

# --- §21 acquisition ---
r('21.1', 'ACQ-21-1', 'Not limited to API sites or uploads; operate systems and acquire information as separate capabilities', 'acquisition', 'P2', ['server/services/sources/**'],
  'Select access method per need and build reusable connectors when repetition justifies.', existing=['server/services/sources/**'], evidence='sources.')
r('21.2', 'ACQ-21-2', 'Access-method selection across native, bulk, HTTP, browser, model-assisted, human handoff', 'acquisition', 'P2', ['server/services/sources/**'],
  'Record the chosen method and why, respecting terms and limits.', deps=['ACQ-21-1'])
r('21.3', 'ACQ-21-3', 'Discover large existing corpora (Common Crawl, EDGAR, Data.gov, GDELT, Wikidata, domain sources) before crawlers', 'acquisition', 'P1', ['server/services/feeds/sources.ts'],
  'Evaluate each corpus for scope, freshness, permitted use and goal contribution; add those that pay.', deps=['ACQ-21-1'])
r('21.4', 'ACQ-21-4', 'Discovery → access → code ingestion → parsing → provenance → relationships → ranking → maintenance', 'acquisition', 'P1', ['server/services/feeds/**'],
  'Checkpointed resumable ingestion with hashes; fine-grained provenance; connector health distinguishing outage, broken parser and revoked permission, routed to Factory.', deps=['ACQ-21-3', 'ALGO-16-1'])
r('21.5', 'ACQ-21-5', 'Browser routines as versioned reusable capabilities', 'browser-operator', 'P3', ['server/services/sources/browser/**'],
  'Authorized bounded workflows with selectors, checks, secret-free logs and idempotency.', prepared=True, existing=['.github/workflows/browser.yml'], evidence='browser workflow exists.')
r('21.6', 'AUTH-21-6', 'Read-only learning never authorizes consequential agency', 'authority', 'P0', ['server/services/cash/authority.ts'],
  'Enforce on the action path; routine research continues when a login or payment needs the owner.', deps=['AUTH-20-3'])
r('21.7', 'CAP-21-7', 'Resource-aware acquisition measurement; scale only the constrained component', 'capacity', 'P1', ['server/services/feeds/**'],
  'Measure records, bytes, parser coverage, facts, matches, paths, AI avoided, cost per useful finding.', deps=['ACQ-21-4'])
r('21.8', 'ACC-21-8', 'Acquisition acceptance demonstrations 1–8', 'acceptance', 'P2', ['server/services/feeds/**', 'server/services/sources/**'], 'Demonstrate on integrated systems.', deps=['ACQ-21-4', 'CAP-21-7', 'AUTH-21-6', 'ACQ-21-5'])

# --- §23–25 ---
r('23.', 'GOAL-23', 'Repeatable goal production: many distinct viable plans, proven distinct', 'goals', 'P1', ['server/services/goals/pathways.ts'],
  'Generate a diversified plan set with complete models and acceptance status; prove distinctness; rebuild after a change; withhold uncalibrated confidence.', deps=['OPP-04', 'CAUSAL-14-7'])
r('24.', 'VENT-24', 'General enterprise formation, product creation and competitive strategy', 'ventures', 'P3', ['server/services/manufacturing/**'],
  'Open-ended venture objectives via the same goal and possibility store.', prepared=True)
r('24.1', 'VENT-24-1', 'Reconstruct the competitive system of an unfamiliar industry', 'ventures', 'P3', ['server/services/manufacturing/**'], 'Evidence-sourced mechanism map; profit pools; rent vs own.', prepared=True, deps=['VENT-24'])
r('24.2', 'VENT-24-2', 'Construct a venture path and revisit it as capital changes', 'ventures', 'P3', ['server/services/manufacturing/**'], 'Dependency-ordered venture graph; automatic reconsideration.', prepared=True, deps=['VENT-24-1'])
r('24.3', 'VENT-24-3', 'Workforce and organization formation (later-stage)', 'ventures', 'P3', ['server/services/labor/**'], 'Role specs, cost models, recruitment prep; no unapproved hiring.', prepared=True, deps=['VENT-24-2'])
r('24.4', 'ACC-24-4', 'Venture acceptance demonstrations', 'acceptance', 'P3', ['server/services/manufacturing/**'], 'Demonstrate all five.', prepared=True, deps=['VENT-24-3'])
r('25.', 'KNOW-25', 'Knowledge velocity: time from unknown to usable decision', 'knowledge-velocity', 'P1', ['server/services/feeds/**'], 'Measure time-to-usable-knowledge per unknown.', deps=['ACQ-21-4'])
r('25.1', 'KNOW-25-1', 'Expandable ingestion-and-understanding processing graph', 'knowledge-velocity', 'P1', ['server/services/feeds/**', 'server/services/knowledge/**'],
  'Delta processing, decision-ready normalized facts, identity resolution, selective deepening by value of information, no false speed.', deps=['KNOW-25'])
r('25.2', 'CAP-25-2', 'Measure each stage and remove the limiting one', 'capacity', 'P1', ['server/services/freeLane/**', 'server/services/feeds/**'],
  'Per-domain stage measures; allocator compares marginal gain of an LLM job vs an algorithm/worker/connector.', deps=['KNOW-25-1', 'CAP-16-3'])
r('25.3', 'ACC-25-3', 'Knowledge velocity acceptance demonstrations 1–7', 'acceptance', 'P1', ['server/services/feeds/**'], 'Demonstrate on production.', deps=['CAP-25-2'])

# --- §26 mechanism compiler ---
r('26. Added', 'COMP-26', 'Minimum necessary AI, maximum reusable computation', 'mechanism-compiler', 'P1', ['server/services/feeds/**'], 'Covered by subsections.', deps=['ALGO-19-3'])
r('26.1', 'COMP-26-1', 'Cheapest adequate method per subproblem; model use rises when needed', 'mechanism-compiler', 'P1', ['server/services/providers/**'], 'Route by measured adequacy and cost.', deps=['COMP-26'])
r('26.2', 'COMP-26-2', 'Reusable, evidence-preserving intermediate representation', 'mechanism-compiler', 'P1', ['server/services/industry/graph.ts'],
  'AI reasoning outputs actors/relations/equations/validity conditions/operators/evidence spans/invariants; reversible access to observations.', deps=['COMP-26', 'CAUSAL-14-1'])
r('26.3', 'COMP-26-3', 'Grow the structure through algorithms at volume', 'mechanism-compiler', 'P1', ['server/services/industry/**'], 'Rules applied to large record volumes generating evaluated candidates.', deps=['COMP-26-2'])
r('26.4', 'COMP-26-4', 'Compile repeated reasoning into versioned, shadow-evaluated methods with maintenance', 'mechanism-compiler', 'P1', ['server/services/feeds/detectors.ts'],
  'Estimate calls replaced; Factory builds; shadow precision/recall; rollback; exceptions return to reasoning.', deps=['COMP-26-2', 'ALGO-16-4'])
r('26.5', 'COMP-26-5', 'Capacity compounding: track reuse and savings of each scarce reasoning output', 'mechanism-compiler', 'P1', ['server/services/providers/**'], 'Measure reuse count and real savings.', deps=['COMP-26-4'])
r('26.6', 'COMP-26-6', 'Integrate with existing components; one authoritative representation', 'mechanism-compiler', 'P1', ['server/services/industry/**'], 'New variables influence candidates, structure, models and priorities.', deps=['COMP-26-3'])
r('26.7', 'ACC-26-7', 'Mechanism-compiler acceptance demonstrations 1–7', 'acceptance', 'P1', ['server/services/feeds/**'], 'Demonstrate on production.', deps=['COMP-26-5', 'COMP-26-6'])

# --- §27 dragon kingdom UI ---
r('27. Added', 'UI-27', 'Dragon-kingdom management world as first theme, interchangeable worlds', 'product-ui', 'P1', ['client/src/world/**'], 'Covered by subsections.')
r('27.1', 'UI-27-1', 'Spectacle on top of truth: comprehension of accomplishments, activity, finances, decisions and attention', 'product-ui', 'P1', ['client/src/world/**'],
  'World and numbers-first interfaces from one truth; never imply false states.', deps=['UI-27'])
r('27.2', 'UI-27-2', 'Typed, versioned presentation adapter from real entities to themed objects; drill-down to records', 'product-ui', 'P1', ['server/routes/world.ts', 'client/src/world/**'],
  'Read-only world-state endpoint mapping goals, work units, workers, research jobs, campaigns, opportunities, finances, permissions and infrastructure to districts with real states.', deps=['UI-27'])
r('27.3', 'UI-27-3', 'World, Operations and Goal modes over one data model with shared selection and conversation', 'product-ui', 'P1', ['client/src/world/**'], 'Three lenses with preserved context.', deps=['UI-27-2'])
r('27.4', 'UI-27-4', 'Fun that carries operational meaning; theme packages cannot alter facts', 'product-ui', 'P2', ['client/src/world/**'], 'Events tied to records; ambient vs factual visibly distinct.', deps=['UI-27-2'])
r('27.5', 'UI-27-5', 'Practical implementation: renderer evaluation, prototypes before rollout, accessibility and reduced motion', 'product-ui', 'P1', ['client/src/world/**'],
  'Several clickable prototypes on real read-only state with screenshots; mobile and no-animation fallbacks.', deps=['UI-27-2'])
r('27.6', 'UI-27-6', 'Truth contract for visible numbers', 'product-ui', 'P1', ['client/src/world/**', 'server/routes/world.ts'], 'Each number inspectable for range, units, owner, source and confidence.', deps=['UI-27-2'])
r('27.7', 'ACC-27-7', 'Dragon world acceptance demonstrations 1–7', 'acceptance', 'P2', ['client/src/world/**'], 'Demonstrate on production with screenshots.', deps=['UI-27-3', 'UI-27-4', 'UI-27-5', 'UI-27-6'])

# --- §28 gap register entries (each answered by its elaboration in §29–37) ---
r('28.1', 'GAP-28-1', 'Gap: end-to-end fulfillment (elaborated in §29)', 'transaction-lifecycle', 'P1', CASH, 'Answered by LIFE-29-*.', deps=['LIFE-29-2'])
r('28.2', 'GAP-28-2', 'Gap: companies and institutions (elaborated in §30)', 'ventures', 'P3', ['server/services/manufacturing/**'], 'Answered by INST-30.', prepared=True, deps=['INST-30'])
r('28.3', 'GAP-28-3', 'Gap: counterparty reliability (elaborated in §31)', 'counterparties', 'P1', CASH, 'Answered by CP-31.', deps=['CP-31'])
r('28.4', 'GAP-28-4', 'Gap: operating memory (elaborated in §32)', 'memory', 'P2', CASH, 'Answered by MEM-32.', deps=['MEM-32'])
r('28.5', 'GAP-28-5', 'Gap: model validation and challenge (elaborated in §33)', 'challenge', 'P1', QUANT, 'Answered by CHAL-33.', deps=['CHAL-33'])
r('28.6', 'GAP-28-6', 'Gap: organizational control and authority (elaborated in §34)', 'authority', 'P0', CASH, 'Answered by AUTH-34.', deps=['AUTH-34'])
r('28.7', 'GAP-28-7', 'Gap: business continuity (elaborated in §35)', 'continuity', 'P2', CASH, 'Answered by CONT-35.', deps=['CONT-35'])
r('28.8', 'GAP-28-8', 'Gap: outcomes beyond money (elaborated in §36)', 'general-goals', 'P3', GOALS, 'Answered by GEN-36.', prepared=True, deps=['GEN-36'])

# --- §29–37 ---
r('29.', 'LIFE-29', 'Operate the entire life of a transaction', 'transaction-lifecycle', 'P1', ['server/services/cash/lifecycle.ts'], 'Covered by subsections.',
  existing=['server/services/cash/lifecycle.ts', 'server/services/dealflow/**'], evidence='§45/§55 deal model.')
r('29.1', 'LIFE-29-1', 'A transaction as a changing system of commitments; no single "sale made" flag', 'transaction-lifecycle', 'P1', ['server/services/cash/lifecycle.ts'],
  'State model with branches, milestones, multiple parties, per-transition duty/deadline/terms/evidence.', deps=['LIFE-29'])
r('29.2', 'LIFE-29-2', 'Revenue realization, delivery evidence and aftercare relationships', 'transaction-lifecycle', 'P1', ['server/services/cash/lifecycle.ts', 'server/services/cash/deliverables/**'],
  'Delivery derived from real scope; acceptance evidence; repeat-business evidence feeds construction.', deps=['LIFE-29-1'])
r('29.3', 'LIFE-29-3', 'Exceptions as first-class processes with remedies and a rehearsed failure path', 'transaction-lifecycle', 'P1', ['server/services/cash/lifecycle.ts'],
  'Detect scope change, missed date, cancel, payment failure, dispute; quantify; select remedy within authority; demonstrate end to end.', deps=['LIFE-29-2'])
r('30.', 'INST-30', 'Derive and manage institutional machinery for an enterprise', 'ventures', 'P3', ['server/services/manufacturing/**'],
  'Represent entities, roles, authority, permits, accounts, taxes, IP, obligations; plan and cost formation without creating entities.', prepared=True)
r('31.', 'CP-31', 'Evidence-backed counterparty model: listing → willingness → capability → quote → reserved → contracted → performed', 'counterparties', 'P1', ['server/services/cash/providers/**', 'server/services/labor/**'],
  'Primary and alternative fulfillers with verified vs pending facts; no double-booking; transfer after failure.', existing=['server/services/cash/providers/**'], evidence='cash providers.', deps=['LIFE-29-1'])
r('32.', 'MEM-32', 'Decision history with alternatives, evidence, predictions and versioned owner policy', 'memory', 'P2', ['server/services/goals/decide.ts'],
  'Changed fact triggers reconsideration of dependent decisions once; prediction errors produce method corrections.', existing=['server/services/goals/decide.ts', 'server/services/cash/decisions.ts'], evidence='goal/cash decisions.', deps=['LEARN-15-1'])
r('33.', 'CHAL-33', 'Independent challenge scaled by consequence', 'challenge', 'P1', ['server/services/quant/challenge.ts'],
  'Challenger names the assumption, the test and a safer structure; detect shared exposure; small reversible actions skip heavy review.', deps=['CAUSAL-14-7'])
r('34.', 'AUTH-34', 'Policy-to-action authority: principal, scope, ceilings, expiry, revocation, emergency stop, audit', 'authority', 'P0', ['server/services/cash/authority.ts'],
  'Applies on every path including browser; revocation stops further mutations and keeps obligations; prohibited spend/send/contract blocked while others proceed.', deps=['AUTH-20-3'])
r('35.', 'CONT-35', 'Business continuity: durable workflow state, idempotency, reconciliation before retry, degraded truthful operation', 'continuity', 'P2', ['server/services/effects/**'],
  'Interrupt at a dangerous boundary and reconcile without duplication.', existing=['server/services/effects/**'], evidence='§20/§25 effects engine.', deps=['LIFE-29-3'])
r('36.', 'GEN-36', 'Noncommercial objectives with their own acceptance criteria', 'general-goals', 'P3', ['server/services/goals/**'], 'Plan and manage a real noncommercial project without a dollar funnel.', prepared=True)
r('37. Added', 'FALL-37', 'Systematic fallbacks throughout thinking and operations', 'fallbacks', 'P1', ['server/services/quant/fallbacks.ts'], 'Covered by subsections.')
r('37.1', 'FALL-37-1', 'Plan alternatives at every consequential dependency, including mechanism changes', 'fallbacks', 'P1', ['server/services/quant/fallbacks.ts'],
  'Failure modes, signals, time to harm, recovery windows and substitutes per dependency.', deps=['FALL-37', 'CAUSAL-14-1'])
r('37.2', 'FALL-37-2', 'Machine-readable fallback structure connected to the causal model', 'fallbacks', 'P1', ['server/services/quant/fallbacks.ts'], 'Switching recalculates economics; located vs validated vs reserved distinguished.', deps=['FALL-37-1'])
r('37.3', 'FALL-37-3', 'Score independence and correlated tails, not backup count', 'fallbacks', 'P1', ['server/services/quant/fallbacks.ts'], 'Common-cause modeling; harmful fallbacks rejected.', deps=['FALL-37-2'])
r('37.4', 'FALL-37-4', 'Switch criteria, early warning, multi-level reliability and learning from failures', 'fallbacks', 'P1', ['server/services/quant/fallbacks.ts'], 'Automatic failover only within authority; record each failure and recovery.', deps=['FALL-37-3', 'AUTH-34'])
r('37.5', 'ACC-37-5', 'Fallback acceptance demonstrations 1–7', 'acceptance', 'P2', ['server/services/quant/fallbacks.ts'], 'Demonstrate with a real or isolated injected interruption.', deps=['FALL-37-4', 'CONT-35'])
r('37.6', 'FALL-37-6', 'Prioritize fallbacks by consequence; reuse existing control planes', 'fallbacks', 'P1', ['server/services/quant/fallbacks.ts'], 'Prepare cheap reversible backups early.', deps=['FALL-37-1'])

out = {'requirements': [], 'context': []}
byKey = {}
def heading_of(item):
    return item['sec'] or ''

def find_def(sec):
    best = None
    for prefix, d in S.items():
        if sec.startswith(prefix) and (best is None or len(prefix) > len(best[0])):
            best = (prefix, d)
    return best

r01_items = {'R01-A': [], 'R01-B': [], 'R01-C': []}
unassigned = []
for it in items:
    sec = heading_of(it)
    if sec.startswith('R01-'):
        r01_items[sec[:5]].append(it)
        continue
    hit = find_def(sec)
    if not hit:
        unassigned.append(it); continue
    d = hit[1]
    key = d['key']
    if key not in byKey:
        byKey[key] = dict(d, items=[])
    byKey[key]['items'].append(it)

if unassigned:
    print('UNASSIGNED', [(u['id'], u['sec']) for u in unassigned]); sys.exit(1)

R01_RULES = [
 ('open commercial search', 'opportunity', 'P0', ['OPP-03', 'META-18-1'], False),
 ('highest immediate', 'goals', 'P0', ['GOAL-09'], False),
 ('complete economic causality', 'causal-model', 'P1', ['CAUSAL-14-2'], False),
 ('intelligence before', 'reasoning', 'P1', ['META-18-2'], False),
 ('autonomy with real', 'authority', 'P0', ['AUTH-20-3'], False),
 ('dragon world', 'product-ui', 'P1', ['UI-27-1'], False),
 ('opportunity generation', 'opportunity', 'P0', ['OPP-03'], False),
 ('live cash goal', 'goals', 'P0', ['GOAL-09'], False),
 ('acceptance policy', 'goals', 'P0', ['GOAL-09'], False),
 ('authorization boundaries', 'authority', 'P0', ['AUTH-34'], False),
 ('useful-research', 'capacity', 'P1', ['CAP-16-3'], False),
 ('economic mechanism', 'reasoning', 'P1', ['META-18-2'], False),
 ('transaction lifecycle', 'transaction-lifecycle', 'P1', ['LIFE-29-3'], False),
 ('visual-concept', 'product-ui', 'P1', ['UI-27-5'], False),
 ('coordinated businesses', 'portfolio', 'P2', ['PORT-05'], False),
 ('enterprise formation', 'ventures', 'P3', ['VENT-24'], True),
]
def r01_req(it, n, block):
    low = it['t'].lower()
    for needle, sub, pri, deps, prepared in R01_RULES:
        if needle in low: return sub, pri, deps, prepared
    return 'factory-program', 'P0', [], False

reqs = []
for block in ('R01-A', 'R01-B', 'R01-C'):
    for n, it in enumerate(r01_items[block]):
        if not it['n']:
            out['context'].append({'item': it['id'], 'reason': 'A lead-in or label that states no obligation of its own.'})
            continue
        sub, pri, deps, prepared = r01_req(it, n, block)
        key = f'{block}-{it["id"][2:]}'
        reqs.append(dict(key=key, title=f'{block}: ' + it['t'][:80], subsystem=sub, priority=pri, paths=[], missing='',
                         existing=FP, evidence=PROGRAM_EVIDENCE, deps=deps, prepared=prepared, items=[it], behavior=None))

for d in byKey.values():
    reqs.append(d)

READING = {
 'as appropriate': 'Brain chooses per case and records which method or structure it chose and why; the choice is revisable.',
 'where appropriate': 'Applied when the case needs it; Brain records when and why it applied or skipped it.',
 'appropriate': 'Brain judges fitness per case from evidence and records the judgment; no fixed rule is implied.',
 'when useful': 'Applied when it changes a decision or reduces measured risk; Brain records the reason.',
 'where useful': 'Applied when it changes a decision or reduces measured risk; Brain records the reason.',
 'if needed': 'Applied when a dependency requires it; Brain records the dependency.',
 'as needed': 'Applied when a dependency requires it; Brain records the dependency.',
 'etc.': 'The list is illustrative, never exhaustive or a whitelist (R01-A1).',
 'e.g.': 'The examples are illustrative, never exhaustive or a whitelist (R01-A1).',
 'illustratively': 'The example count/amount is illustrative, not a coded constant (§23).',
}
def reading(marker):
    m = marker.lower()
    for k, v in READING.items():
        if k in m: return v
    return 'Read per R01-A: the latest owner intent governs; examples are illustrations, Brain decides per case and records the choice.'

for d in reqs:
    key = d['key']
    deps = [x for x in d['deps'] if x != key]
    srcs = [i['id'] for i in d['items']]
    amb = [{'item': i['id'], 'question': f'The source says "{m}" — which reading is meant?', 'interpretation': reading(m)} for i in d['items'] for m in i['amb']]
    existing = {'paths': d['existing'], 'evidence': d['evidence']} if d['existing'] else None
    missing = d['missing'] if (d['paths'] and d['missing']) else ''
    if existing is None and not missing:
        missing = 'Implement every quoted clause.'
    title = d['title'] or key
    behavior = d.get('behavior') or f'{title}. Every quoted clause of the cited source items holds in the running Brain and is demonstrated on production records.'
    out['requirements'].append({
        'key': key, 'kind': 'CAPABILITY', 'title': title[:160], 'subsystem': d['subsystem'], 'source': srcs, 'quote': None,
        'behavior': behavior, 'inputs': [], 'outputs': [], 'constraints': ['Extend the existing owner; no duplicate scheduler, store or authority path (§10.3, §20.4).',
                                                                       'No category, industry or example is a whitelist (R01-A1, §18.1).'],
        'dependsOn': [x for x in deps], 'interactsWith': [], 'existing': existing, 'missingWork': missing,
        'paths': d['paths'], 'verification': [{'kind': 'PROBE', 'probe': f'r01.{key.lower()}', 'statement': f'{key} demonstrated on production rows'}],
        'ambiguities': amb, 'priority': d['priority'], **({'prepared': True} if d['prepared'] else {}),
    })

# §38 integration relationships, as interactions.
INTER = [
 ('INT-38-DEALS', 'Deals and customer commitments (§29) draw on reliable people and institutions (§§30–31)', ['LIFE-29-1', 'CP-31', 'INST-30'], 'transaction-lifecycle', 'P1'),
 ('INT-38-PROVENANCE', 'decisions and models retain provenance and challenge (§§32–33)', ['MEM-32', 'CHAL-33'], 'memory', 'P2'),
 ('INT-38-AUTHORITY', 'all actions obey authority (§34)', ['AUTH-34', 'LIFE-29-3'], 'authority', 'P0'),
 ('INT-38-CONTINUITY', 'business state survives interruption (§35)', ['CONT-35', 'LIFE-29-3'], 'continuity', 'P2'),
 ('INT-38-GENERAL', 'the same general planning engine supports other kinds of goals (§36)', ['GEN-36', 'OPP-04'], 'general-goals', 'P3'),
 ('INT-38-FALLBACKS', 'fallbacks (§37) span the entire chain and update economics and permissions when used', ['FALL-37-4', 'CAUSAL-14-4', 'AUTH-34'], 'fallbacks', 'P1'),
]
src_text = open(sys.argv[3], encoding='utf-8').read() if len(sys.argv) > 3 else ''
target = next(i for i in items if 'Integration relationships that must be verified' in i['t'] or i['t'].startswith('Integration relationships'))
for key, quote, parts, sub, pri in INTER:
    out['requirements'].append({
        'key': key, 'kind': 'INTERACTION', 'title': quote[:160], 'subsystem': sub, 'source': [target['id']], 'quote': quote,
        'behavior': f'{quote}: the participating implementations work together on production records (§38).', 'inputs': [], 'outputs': [], 'constraints': [],
        'dependsOn': [], 'interactsWith': parts, 'existing': None, 'missingWork': 'Prove the joint behavior end to end on production.',
        'paths': ['server/services/goals/**'] if sub == 'general-goals' else ['server/services/cash/lifecycle.ts'],
        'verification': [{'kind': 'PROBE', 'probe': f'r01.{key.lower()}', 'statement': f'{key} demonstrated on production rows'}],
        'ambiguities': [], 'priority': pri, **({'prepared': True} if pri == 'P3' else {}),
    })

# Rollups: a heading whose subsections carry the work, and a §28 gap answered by
# its elaboration. They write no code; each is verified when everything it rolls
# up is, so it depends on its parts (never the reverse) and has no campaign.
ROLLUPS = {
 'ACC-15': ['LEARN-15-1', 'CAUSAL-15-2', 'SPRINT-15-3', 'RES-15-4', 'RES-15-5', 'ACC-15-6'],
 'ALGO-16': ['ALGO-16-1', 'ALGO-16-2', 'CAP-16-3', 'ALGO-16-4', 'ACC-16-5'],
 'COMP-26': ['COMP-26-1', 'COMP-26-2', 'COMP-26-3', 'COMP-26-4', 'COMP-26-5', 'COMP-26-6', 'ACC-26-7'],
 'UI-27': ['UI-27-1', 'UI-27-2', 'UI-27-3', 'UI-27-4', 'UI-27-5', 'UI-27-6', 'ACC-27-7'],
 'FALL-37': ['FALL-37-1', 'FALL-37-2', 'FALL-37-3', 'FALL-37-4', 'ACC-37-5', 'FALL-37-6'],
 'LIFE-29': ['LIFE-29-1', 'LIFE-29-2', 'LIFE-29-3'],
 'CAUSAL-14': ['CAUSAL-14-1', 'CAUSAL-14-2', 'CAUSAL-14-3', 'CAUSAL-14-4', 'CAUSAL-14-5', 'ACC-14-6', 'CAUSAL-14-7'],
 'COM-13': ['COM-13-1', 'COM-13-2', 'COM-13-3', 'MONEY-13-4', 'COM-13-5', 'GOAL-13-6', 'ACC-13-7'],
 'KNOW-25': ['KNOW-25-1', 'CAP-25-2', 'ACC-25-3'],
 'VENT-24': ['VENT-24-1', 'VENT-24-2', 'VENT-24-3', 'ACC-24-4'],
 'GAP-28-1': ['LIFE-29-1', 'LIFE-29-2', 'LIFE-29-3'], 'GAP-28-2': ['INST-30'], 'GAP-28-3': ['CP-31'], 'GAP-28-4': ['MEM-32'],
 'GAP-28-5': ['CHAL-33'], 'GAP-28-6': ['AUTH-34'], 'GAP-28-7': ['CONT-35'], 'GAP-28-8': ['GEN-36'],
}
byk = {q['key']: q for q in out['requirements']}
for rollup, parts in ROLLUPS.items():
    q = byk[rollup]
    paths = sorted({p for part in parts for p in (byk[part]['paths'] or (byk[part]['existing'] or {}).get('paths', []))}) or ['server/services/goals/**']
    q['existing'] = {'paths': paths, 'evidence': f'Rollup: holds when its parts hold — {", ".join(parts)}.'}
    q['missingWork'] = ''
    q['paths'] = []
    q['dependsOn'] = parts
    for part in parts:
        byk[part]['dependsOn'] = [d for d in byk[part]['dependsOn'] if d != rollup]
# Who depended on a rollup now depends on its parts' heads, so nothing waits on a rollup.
for q in out['requirements']:
    deps = []
    for d in q['dependsOn']:
        if d in ROLLUPS and q['key'] not in ROLLUPS[d] and q['key'] not in ROLLUPS:
            deps.extend(x for x in ROLLUPS[d][:1])
        else:
            deps.append(d)
    q['dependsOn'] = sorted(set(x for x in deps if x != q['key']))
for q in out['requirements']:
    if q['kind'] == 'INTERACTION' and q.get('priority') != 'P3':
        q['subsystem'] = 'integration'

json.dump(out, open(sys.argv[2], 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
print('requirements', len(out['requirements']), 'context', len(out['context']))
