# RELEASE 01 — Implementation Priority and Interpretation Addendum

Delivery: November 9, 2026 | Status: First implementation handoff; the architecture remains open for additions. Complete source: §§1–38 below, preserved without omission. This addendum governs scheduling and interpretation; it does not replace or summarize those sections. Baseline: Brain production branch production at implementation intake; verify its current commit and state anew rather than assuming the version recorded during this conversation is current.

## R01-A. Latest owner intent controls interpretation

1. Open commercial search: brokerage, subcontracting, distribution, AI, manufacturing, insurance, logistics, etc. are illustrations, never the fixed list of preferred business categories. Let the system discover and compare mechanisms that neither owner nor assistant named. If older sections describe “middleman first,” interpret this as an interest in asset-light, capital-efficient, remotely operable roles when economics justify them, not a restriction or whitelist.

2. Highest immediate economic value: the urgent outcome is substantial, rapidly collectible cash through sound commercial execution, while developing general reusable intelligence. The current $10K goal is a real cash-collection target with its own constraints, but $10K→$100K→$1M numbers elsewhere are examples, not universal programmed stages.

3. Complete economic causality: no fixed five-metric or ten-component template. Choose appropriate variables, equations, evidence and relationships for each case. Retain dollar-by-dollar lineage, correlated risk, conversion, capacity, obligations and all important unknowns. The goal’s 90% acceptance standard is a meaningful evidence requirement where configured, never a universal guaranteed worst case or simulated-coverage percentage.

4. Intelligence before mere volume: methods for generating new possibilities, learning unfamiliar mechanisms, selecting mathematics, turning reasoning into reusable deterministic algorithms, testing predictions and self-improving should receive early effort when they unlock better commercial results. More documents or AI jobs alone is not success.

5. Autonomy with real authorization: autonomous discovery, coding, planning, testing, recovery and improvement can proceed under existing authority; customer contact, contracts, payments, spending, accessing restricted sites and other consequential external actions obey existing permissions. Missing authorization does not end unrelated useful work.

6. Dragon world plus real operations: the first desired visual theme is a dragon-themed living management simulator with numerical truth and drill-down controls available throughout. Fake worker states, invented cash, and a decorative game in place of actionable operating information fail the specification. Other themes may be added without rewiring the backend.

7. Complete architecture stays in scope: prioritization is about when, never which approved requirements may disappear. Prepared and deferred capabilities get promoted when they become prerequisites for high-priority work. The architecture remains extensible as owner decisions are added.

## R01-B. Priority is dynamic; these are initial scheduling guides, not fixed gates

Immediate critical path (P0):

- Protect full-spec coverage and establish one program-level implementation owner. If Factory cannot yet preserve/trace/decompose a program of this size, repair that safeguard first as a bounded objective. Do not ask Factory to swallow 25,000 words in one prompt and trust its summary.

- Keep Brain’s current live cash goal operating. Fix the earliest proven obstacle to commercially usable outcomes across research → acquisition → fulfillment → realistic quantification → authorization-ready offer → collected cash. Prioritize provider/worker recovery when a live lane is genuinely down, without recurring broad re-audits.

- Make opportunity generation open world: discover economical commercial starting points regardless of industry, connect independently sourced demand and supply, generate and morph viable roles, and establish transaction economics, realistic reach, margin, timing and constraints.

- Verify the configured acceptance policy accurately rejects unsupported 90% claims while continuing to improve provisional plans; distinguish accepted goal attainment from engineering milestones.

- Maintain authorization boundaries and accounting integrity from the beginning.

Early parallel multipliers (P1):

- Improve throughput and useful-research yield using existing feed collection, algorithmic detectors, economic joins, batched source ingestion, verified extraction and model routing. Prioritize the actual bottleneck from measured production behavior; add compute only when it increases useful output.

- Build adaptable economic mechanism representations, reasoning-method selection, reusable algorithms/compilation, model self-critique, evidence lineage, uncertainty and fallback evaluation. Connect these directly to active commercial decisions; do not build an untested “intelligence layer.”

- Strengthen the complete transaction lifecycle and external counterparty coordination wherever a current commercial pathway requires it.

- Run a visual-concept/UI data-contract workstream in parallel when possible: prototype the dragon world + hard-number operations view against real read-only state, select visuals via genuine screenshots before product-wide rollout.

Expand complete operations (P2):

- Coordinated businesses and multiple overlapping goals; financing/capital buckets and asset roles; supplier and workforce management; business continuity; organizational memory; generalized planning and execution; dynamic capacity and resource allocation; deeper multimodal UI/telemetry.

Prepare and promote when needed (P3):

- Full enterprise formation and long-term competitive ventures, general manufacturing/product/company creation, extensive hiring, broad external-website autonomy and additional world themes. If P0/P1 evidence shows a dependency on one of these, promote it immediately; do not wait for its nominal stage.

Scheduling rule: derive a dependency graph from source requirements and current proven capabilities. On each cycle, choose the highest decision-impact work that is ready and actually funded by available workers, model capacity and authority. Independent tasks run concurrently. Do not idle available useful capacity simply because one P0 prerequisite is blocked. Do not overspend or assume worker capacity from subscription price.

## R01-C. End-to-end acceptance and no premature closure

- Each source requirement, subrequirement, cross-system dependency and test is traceable (see SECTION_INDEX.json and SECTION_INDEX.tsv for a section index, not a replacement for atomic requirement extraction). Preserve the original source and compare it to a stable, exhaustive atomic requirement registry before coding.

- Record existing implementation and whether it is verified on current production. Reuse existing owners. A task-name match or passing unit test does not close a behavioral requirement.

- Start with bounded, deliverable Factory objectives; validate that the installed Factory architect can coordinate multiple dependent campaigns, retry/recover, maintain immutable acceptance criteria and reject unverified completion. Where this capability is missing, implement it first, then launch the rest of the program. The handoff session must maintain parent-program ownership until Factory demonstrates it can.

- Production proof must show correct integration: real market information creates a supported opportunity; model calculates it; authorized actions move it toward settled cash; errors and fallbacks update the same economic and operating state. Separately prove open-world exploration, resource and method improvement, multi-goal progression and the interactive UI.

- Report two independent statuses: (1) cash goal achieved or not, measured by actual collected cash and the goal’s acceptance policy; (2) architecture coverage completed or not, measured per

requirement. A successful release or working Factory campaign is not cash-goal success, and a cash result does not waive unfinished architecture requirements.

- New owner ideas are append-only numbered amendments until explicitly superseded by the owner; Factory should be able to ingest incremental releases without restarting or duplicating completed work.

# UNABRIDGED MASTER SPECIFICATION — ORIGINAL §§1–38

# Brain — Master Thinking, Business and Operating Architecture

Working draft v1.4 — November 9, 2026 Status: OPEN FOR ADDITIONS. NOT APPROVED AS A FINAL IMPLEMENTATION SPECIFICATION.

This document preserves the user’s intended behaviors from the ongoing conversation and arranges them into an implementable system. It is a working source of truth for further discussion—not a compressed prompt, a completed design, or an instruction to deploy unreviewed changes. New user decisions should be appended, dated, and traced to affected requirements. No requirement disappears just because a feature of the same name exists in code.

## 1. What Brain is meant to become

Brain is an autonomous economic reasoning and business-operation system. Its work includes finding economic openings, creating new commercial structures, decomposing uncertainty, figuring out viable transaction routes, managing multiple businesses, allocating capital across distinct purposes, improving its own methods, and moving toward evolving owner-specified objectives. It should adapt its work as observed cash, relationships, demand, prices, delivery capacity, financing and market conditions change.

The design must not reduce Brain to a database search, a catalog of fixed business plays, a linear research checklist, a price/package recommender, or a single goal-specific script. Existing knowledge is a reusable resource, not the limit of future options. It must be capable of asking what commercial roles could exist that are not presently represented in its records, then constructing and evaluating them.

## 2. Goals: adjustable conditions, not a hard-coded dollar ladder

The examples $10,000 → $100,000 → $1 million are illustrative stages. They are not permanent thresholds, mandatory next steps, nor an instruction to close one goal before investigating the next. Financial goals may express cash collected, deployable capital, retained earnings, reliable monthly distributions, enterprise value, or dedicated funding. Each must preserve its actual metric and deadline. For example, the current $10K SQUEEZE goal’s collected/settled cash metric cannot be satisfied by hypothetical sales, equity value, or a future promise; subsequent reinvestment is tracked separately.

Goals coexist and influence one another. While completing an immediate objective, Brain should prepare future possibilities, build capabilities with long-term usefulness, and recognize when a present revenue stream creates an asset, channel or supplier relationship that makes a different next goal feasible. It should change the resource allocation when evidence changes. It should not create a new financial stage or take a strategic turn merely because a milestone number was reached.

The owner’s ambition includes substantial personal economic growth, lavish lifestyle spending in a later phase, and capital for filmmaking/fashion. Such ambitions direct exploration but are not themselves verified success forecasts. Brain should surface upside cases, timelines, risks and evidence; never turn an aspirational date into a calibrated 90% claim.

## 3. The business opportunity field: open-ended and generative

Brain maintains a rich, continuously growing population of commercial possibilities. It can initiate exploration from:

- remembered research, businesses, contacts, suppliers, customer needs, strategies and past transactions;

- newly observed activity outside its own database;

- first-principles economic structures inferred backward from a goal;

- candidate recombinations of useful pieces of prior businesses, including unsuccessful ones;

- discovered constraints, surprises, inefficiencies, unmet demands and unused supply.

This is an open world of potential arrangements, not a closed list of approved industries or the current stock of 31 modeled pathways. Exploration must accommodate B2C, B2B, services delivered by AI, brokered physical services delivered by independent people, logistics, consulting, reselling and unfamiliar mechanisms. These examples do not become preferential categories or a ceiling on discovery. Do not default to the owner’s current geographic location: prefer markets based on economics and remotely controllable execution.

### 3.1 Transformational operators

For any partial or complete commercial structure, Brain can meaningfully change:

- payer, economic buyer, beneficiary and decision-maker;

- offer, deliverable, product or service scope, bundling and specialization;

- price, fee model, licensing, subscription, wholesale/retail, revenue share and payment timing;

- distribution, channel, intermediaries, reseller rights, partnerships, referral structure and acquisition mechanism;

- who fulfills, supplier network, capacity, automation, subcontracting and guarantees;

- transaction role: introduction, brokerage, coordination, delegation, principal contracting, resale and other structures when permitted;

- geography, timing, seasonality and target customer segment;

- capital structure, settlement, deposits and financing when commercially legitimate;

- single-sale versus repeatability, recurrence and order size.

One change can alter the feasibility of another. Transformations should propagate through related assumptions, economics, sourcing requirements and allowable actions. The engine should generate multiple branches, recombine compatible components across markets, then transform those products further. It should recognize when two apparently different ideas share a failure dependency, and should not count them as independent portfolio diversification.

### 3.2 Retain components even when businesses fail

Failure to sell, excessive cost, slow cash, inaccessible buyers or insufficient margin may invalidate one arrangement without invalidating its supplier, technology, acquisition path, customer insight, price signal or delivery capability. Record useful components and the specific failure mode, so Brain can recombine them later. Avoid permanently discarding a whole market from one failed model.

### 3.3 Exploration and pruning

The idea space is intentionally unbounded; available attention, model calls, verification throughput, server resources, capital and outreach are not. Brain should maintain diverse frontier candidates, prefer genuinely distinct mechanisms and high-option-value discoveries, and spend deeper research on branches whose answers could change the next decision. ‘More ideas’ is a useful output only to the extent that it improves useful diversity or commercial outcomes. Explicitly record why a branch is parked, superseded, combined or advanced.

## 4. Reasoning backward from a goal, forward from the world

The engine can start with an objective, derive transaction structures and constraints, then find real economic entry points. It can equally start with evidence of a buyer need, supplier capacity or pricing, then construct roles and test compatibility with one or several goals. Both directions occur continuously.

For each candidate, represent the full transaction path, including payer, value proposition, offer, acquisition method and realistically reachable buyer count, conversion estimates and their basis, delivery/fulfillment, cost and margin, recurrence and capacity, payment terms and usable-cash timing, capital needed and tied up, rights and authorization, and correlations with other pathways.

Every input is marked evidence-backed, estimated with a justified range, or unknown. Quantification must establish the required threshold for a candidate to matter; research then prioritizes decision-changing unknowns. An unknown is not an automatic favorable assumption or a reason to abandon a partial arrangement. Brain should construct the cheapest path to learn or supply the missing component.

The quantitative engine should influence the strategy itself: insufficient acquisitions prompt channel and buyer transformations; poor margins prompt offer/fulfillment/payment changes; too-slow settlement prompts structurally faster and legitimate cash paths; small per-sale revenue prompts volume/repeatability analysis, not premature exclusion. Inferences about realistic sales must reflect specific channels and capacities, not universal cold-outreach conversion guesses.

## 5. Business portfolio and autonomous execution

Operate multiple independent revenue streams when feasible. A portfolio should contain a leading combination, alternates, contingency options, current working operations, and future bets. Model correlations, cash flow timing, delivery obligations, workforce capacity, quality assurance, outreach limits, market crowding and shared constraints.

AI can perform substantial discovery, writing, research, analysis, coding, sales preparation, coordination and, when proven suitable, fulfillment. When human or physical capability is required, Brain can find and organize independent providers while the owner remains physically absent. Do not credit Brain with a delivery capability merely because it can discuss it; demonstrate capability with appropriate real-world or production evidence. Don’t confuse self-operable businesses with services that the owner must perform personally.

The SQUEEZE system should make commercially responsible offers as soon as authorized and offerable, without mandatory preliminary market-testing. Research and sales run in parallel. Commercial activity must respect customer-contact, invoicing, contracting, spending and payment permissions, channel rules and the specific goal’s financial limits. Missing permission stops that external action, not independent research, construction, modeling or software work.

## 6. Different businesses have different jobs

Business archetypes are adjustable roles, not rigid permanent taxonomies:

- Distributable cash-flow businesses: reliably pay out money for lifestyle or other commitments.

- Compounding growth businesses: retain and reinvest for enterprise growth and optionality, potentially for long periods.

- Capital generators: finance new experiments, acquisitions and launches.

- Strategic infrastructure/assets: acquire channels, software, supply, relationships, capabilities or strategic rights.

- Creative funding operations: build dedicated financial capacity for independent film, fashion and other artistic work.

One business can play several roles and change roles over time. Brain should not score a business negatively merely because it retains rather than distributes profits, nor overrate it merely for impressive gross revenue. Assess it against its designated role and portfolio effects.

### 6.1 Capital buckets

Track collected cash, gross revenue, costs, operating profit, taxes, required reserves, debt service, capital deployed and capital remaining; do not confuse them. Model money available for growth, reliable lifestyle distributions, filmmaking/creative projects, reserves and obligations. Funds recycled into another business are not lost, but neither are they still liquid or automatically counted twice as new wealth.

The owner presently expects to reinvest a substantial share during a foundation-building phase, potentially dedicating several hundred thousand dollars later to stable lifestyle cash flow after reaching a substantial capital base. These are provisional preferences, not coded automatic thresholds. The owner may use financing against assets where legitimate and prudent; Brain must model borrowing terms, collateral, debt service, liquidation exposure and cash-flow risk, rather than treat loans as free withdrawals.

## 7. Research: constant learning, measured commercial value

Brain researches continuously, both externally and about its own capabilities and methods. Research activity includes (at least):

1. broad economic discovery;

2. converting promising arrangements into actual transaction routes;

3. optimizing and supporting businesses already operating;

4. capability improvement, provider/worker reliability and engineering repair;

5. forward-looking strategic exploration and future goal preparation.

These purposes share finite compute, model, verification and human-authorization capacity. The research coordinator should reallocate dynamically based on evidence of useful outcomes, impending deadlines, expected decision value and bottlenecks. Preserve minimum exploration and system-health capacity to avoid myopically serving only one objective.

### 7.1 Telemetry

Expose rolling one-hour, six-hour and 24-hour reporting on: submitted research jobs by provider and purpose; accepted and rejected claims; audit completion; readable source quality; filed commercial openings; openings with real buyer/price/fulfiller evidence; constructed variants and meaningful mechanism diversity; usable offers; real sales and receipts; job queues; utilization; idle time; retries; provider quota/failure; cost and resource limits; and improvement PR outcomes. Use explicit denominators and time windows. Separate job count from useful claims and commercially actionable findings.

Observed historical figures have included roughly 239 free/GPU job submissions across one six-hour diagnostic, 21.5 accepted claims/hour system-wide and 6.7 claims/hour goal-related for one sample, plus poor commercial conversion of research. These are prior window readings, NOT a reliable daily throughput estimate or a current machine-capacity ceiling. Current implementation must read fresh production telemetry before deciding to upgrade CPU, memory, GPU or model capacity.

### 7.2 Self-improvement

Brain should detect repeated research failures, poor evidence yield, context limitations, stalled workflows, inadequate model-task fit, uneven worker allocation and missing general capabilities. Route genuinely recurring structural software gaps to existing Factory ownership; don’t create duplicate engines. Prefer fixing the first reversible blocker, testing live behavior, then moving on. A productive engine evaluates whether the repair improved its original goal.

## 8. Interaction, website and mouthpiece

Provide a polished unified product whose conversation is always easily accessible alongside real goal, opportunity, transaction, portfolio and research views. The conversational model is a replaceable interface to Brain’s live state and existing authoritative action systems, not a second disconnected agent claiming actions succeeded. Explain current decisions, transactions, evidence and remaining blocks, and link directly to records. Preserve user authorization on action execution.

The website should show an intuitive whole-system picture, research allocation, actual throughput and quality, business family trees and recombination, objective progression, current versus future resource usage, collected cash and assets, business archetypes and earmarked capital. Maintain one component/design system and verify full workflows and responsive rendering to avoid piecemeal UI regressions.

## 9. Concrete current constraints versus future capabilities

Current $10K SQUEEZE task: collected cash by its actual deadline, low pre-return capital at risk, multiple streams, remotely operated; no owner’s own physical labor, no government contracting, no fake ready offers, no blind geo anchoring. Customer contact, contracting/invoices and payment must stay under existing permissions. This task’s specific ceilings and deadline are not default constraints on all future objectives.

Future Brain: capable of designing variable-size engagements, from small high-frequency sales to expensive consulting, automation and implementation projects, depending on buyer value, deliverability, credible demand and achievable distribution. The exact $900 content pack is one provisional offer, not a universal business archetype or the definition of the user’s intended strategy.

Goal acceptance: if a goal explicitly requires a defensible 90% likelihood of a specified outcome, no hypothetical scenario coverage, unmeasured conversion assumption or promising business package qualifies as 90% proof. A candidate and a qualifying accepted plan must be separate. If insufficient historical data exists for calibrated probabilities, say so and continue improving the candidate; don’t counterfeit assurance. Operational execution can still pursue appropriately qualified, authorized offers while planning remains unproven.

## 10. Full-coverage implementation program

### 10.1 Preserve the source design

This file is the living design narrative. On further conversation, append the exact new decision in a dated revision note, reconcile it with previously written assumptions, and maintain an explicit open-questions/contradictions section. Don’t freeze or implement prematurely while the owner is still defining the mechanism.

### 10.2 Translate into atomic behaviors

Maintain a traceable requirement catalog for each intended ability: ID; original user language; precise behavior; scope; trigger; inputs; decision rule; required integration; current component/owner; gap; tests; real-world evidence; deployment revision; status. No broad ‘has goal intelligence’ item substitutes for its constituent requirements. No requirement may disappear in summarization.

### 10.3 Reuse the existing system

Inventory production code and actual operation before designing new components. Map existing discovery, constructed arrangements, goal scenarios, pathway transformation, cash authority, Instantly messaging integration, task scheduling, free/GPU research, capability maps, Factory, telemetry and UI. Integrate with those systems instead of creating duplicates. Avoid one giant PR; coordinate independent work with explicit ownership and merge/deploy checkpoints. Preserve active commercial execution during engineering.

### 10.4 Demonstrate emergent behavior

Acceptance tests must demonstrate on actual or comparable real evidence: open-world creation beyond the held catalog; transformation of buyer/offer/channel/supplier/settlement; recombination across distinct businesses; economic propagation through transformed branches; salvage of components from failed arrangements; quantitative selection of high-value unknowns; realistic customer and fulfillment capacity; rolling multigoal progression; business archetype capital policy; dynamic research allocation; self-improvement; concurrent authorized operations; and unified user interaction.

Every requirement progresses through specified → existing/gap mapped → implemented → integrated → production verified. ‘Test passed’, ‘PR merged’ and ‘report written’ are intermediate milestones. Success requires observed behavior and a complete coverage audit. Continue useful autonomous work while waiting on independent external dependencies.

### 10.5 Suggested delivery streams (not exclusionary stages)

A. Generative possibilities and evolving economic memory. B. Transaction/quant intelligence, research relevance, and realistic sales modeling. C. Rolling multigoal portfolio, business roles, capital deployment and autonomous operations. D. Research allocation, resource telemetry, provider/task routing and capability repair. E. Unified product/chat UI and complete cross-system production validation.

Workstreams interact continuously; later-stage features must not be deferred if required for an earlier production test. All architecture requirements remain visible throughout implementation.

## 11. Working decisions and open design questions

Decisions established by the owner - Financial milestones such as 10K/100K/1M are examples, not hard-coded progressions. - Near-term collected-money objectives matter, but substantial reinvestment is expected during the build phase. - Different businesses are permitted to have different extraction, growth and creative-funding roles. - The range of commercial possibilities must not be limited to Brain’s database or to presently fashionable AI services. - Ideas should morph repeatedly, combine across markets and generate new opportunities from their own transformed elements. - The user will continue adding and refining the architecture; preserve the unabridged intent. - Avoid repeated rhetorical restatements and oversimplified explanations. Engage at a technical and strategic level.

To define as the user continues - Exact mechanics and representation of the ‘thinking map’ and idea-transforming operations. - What degree of novelty/diversity is useful, and how the system should prioritize emerging branches. - Capital-governance policies and financial structures for differing business archetypes. - How aggressively future objectives may consume scarce resources from present obligations. - Exact target levels for concurrent research throughput, worker utilization and minimum exploration. - Full product interaction and visualization requirements. - Calibration/decision rules for optional or mandatory confidence thresholds in future goals.

## 12. Change log

- 2026-11-09 — v0.1 established: Preserved the discussion’s evolving idea-generation architecture, multi-goal logic, business/capital archetypes, research resource allocation, UI and implementability requirements. Recorded the owner’s clarification that 10K/100K/1M are arbitrary examples and the near-term plan is to reinvest heavily. Added distinction between ambitious growth scenarios and defensible forecasts.

## 13. Added 2026-11-09 — Asset-light commercial control, heterogeneous wedges, and compressed growth

Owner’s addition (substantive; must be preserved, not reduced to ‘AI consulting’): Brain’s commercial opportunity universe includes AI-delivered services and subcontracting, distribution, marketing, manufacturing, cleaning and concrete contracts, mortgage-related and insurance-related opportunities, and many other mechanisms not preselected by the owner. The intention is to identify and assemble the cheapest and fastest legitimate ways to capture large economic flows while owning as little fixed infrastructure and employing as little direct labor as necessary. A lack of owned trucks, warehouses, machinery or full-time staff must not be mistaken for a lack of commercial access. Use third-party fulfillment, partner capabilities, buyer prepayment/deposits, referral/agency arrangements, licensed partnerships, and other viable rights-based arrangements when their terms truly support the transaction.

### 13.1 Model the role Brain can control, separately from the industry

For each discovered or constructed flow, identify the available commercial positions: lead source, distributor, affiliate/referrer, broker/agent, representative, marketplace, booking/dispatch coordinator, reseller, prime contractor, outsourced operator, technology provider, capital arranger where permitted, and principal bearing delivery risk. Determine which role Brain can legally and contractually occupy, what it controls (demand, supply, distribution, information, payment, financing, coordination, fulfillment rights), what value that control

adds, and which duties/risks follow. Don’t assume one role or one acquisition channel is best for all markets. A physical service performed by others remains a candidate for remotely owned or operated participation.

### 13.2 Treat commercial leverage as composable

A candidate may simultaneously use AI labor, contractor/supplier fulfillment, distribution through existing channels, marketing reach, buyer prepayment, financing, and organization-wide shared infrastructure. Explicitly trace how each combination affects cash conversion, margin, supplier risk, delivery capacity, liability, acquisition speed and repeatability. A low balance of initial owned capital should not limit the size of a transaction by arbitrary revenue ceilings; enforce actual cash-exposure, authority, capacity and contract constraints. Prepayment is an available design possibility, not a presumption: verify buyer willingness, refund obligations and when funds are usable relative to supplier payment.

### 13.3 Explore volume-based and high-ticket modes without anchoring on either

The owner supplied one million outbound emails as a thought experiment about distribution leverage, not as an instruction to send them or as a proven reachable prospect count. Brain must model the complete funnel for any outreach mechanism: permission/provider terms, unique relevant prospects, deliverability, sending account throughput and reputation, response, qualification, close rate, payment settlement, fulfillment and repeat purchase. It must separately consider high-value deals, large numbers of small deals, partners with existing customer access, customer-request marketplaces and other ways to reach demand. Search for the economically strongest mix, not a predetermined small-package or cold-email play. Do not equate messages sent with buyers reached, sales, or revenue.

### 13.4 Evaluate money velocity and deal structure

For every route quantify customer-funded versus self-funded expenditure, time from lead to commitment, commitment to funds received, funds received to usable cash, supplier outlays and timing, refunds/chargebacks, receivables and working capital at peak overlap. Revenue generated before fulfillment and capital advanced by customers can make asset-light growth possible, but money may be restricted, refundable, or needed to fulfill liabilities. Keep gross billings, gross margin, net profit, settled cash, retained cash, owner distributions, enterprise value and borrowed proceeds distinct. Optimize capital turnover and risk-adjusted collectible contribution for the particular objective, not an automatic requirement to retain all cash.

### 13.5 Industry-specific rights and regulatory constraints

Mortgage and insurance arrangements can provide valuable distribution/referral/administration opportunities, but the legal ability to earn commissions, originate, advise, broker, solicit or receive referral payments depends on product, location, licensing, contracts and other requirements. Brain should find compliant positions (including authorized licensed partners) before counting their economics. Apply the same role-specific due diligence to manufacturing, subcontracting, deposits, consumer protection and advertising. Don’t turn a regulated industry into a blanket excluded category; don’t treat commercial role changes as a way to evade applicable rules.

### 13.6 Growth ambition and evidence discipline

Owner emphasizes that exceptionally fast movement through financial milestones might be achievable with effective automation, asset-light operations, concurrent commercial wedges and reinvestment; the system should search and model aggressive compressed timelines, not assume conventional annual growth periods. This is a search and optimization directive, not evidence that any particular timeline or ≥90% likelihood has been established. Brain should explore genuine 30/60/90-day and other timelines, solve backward for required deal economics and distribution, compare independent combinations and confirm settlement timing. If a stated confidence requirement cannot be calibrated, keep candidate and accepted states distinct while developing viable actions.

### 13.7 Acceptance behaviors added

- From an arbitrary physical-service demand signal, construct and compare at least two different remote commercial roles using independent fulfillers; identify real control points and quote the resulting economic and responsibility differences.

- From a supplier/industry with no owned equipment or warehouse, propose only contractually supportable, capital-feasible access paths; show every unfunded or unverified dependency explicitly.

- For an outreach channel with a very large theoretical audience, demonstrate how qualified reachable prospects, throughput and full funnel—not audience size alone—bound collectible cash by deadline.

- Generate a portfolio mixing distinct industry families and commercial positions without a hard-coded AI-services preference, and calculate shared resource constraints and dependency concentration.

- Model buyer-funded fulfillment and the genuine cash obligations, including refund and settlement exposure, without counting restricted or owed funds as free profit.

- Assess regulated commercial roles based on rights and obligations, not superficial category exclusion or casual assumption of permission.

- When the owner requests rapid 10× growth, produce competing rigorous, economically coherent routes with deadlines and evidence gaps; neither dismiss short timelines by convention nor fabricate a success probability.

Change log update — 2026-11-09 v0.2: Added full commercial-control/asset-light leverage layer in response to the owner’s explicit correction that the field extends across AI, subcontracting, distribution, marketing, manufacturing, mortgage/insurance, concrete/cleaning and other business mechanisms. No implementation authorization implied by this draft.

## 14. Added 2026-11-09 — Complete causal transaction model, traceable dollars, and confidence engineering

Owner’s addition: Do not reduce transaction economics to a fixed list of five numbers or five jobs. Brain should be capable of laying out every relevant part of a particular deal or business and accounting for how the whole system works. It should be able to state, at the appropriate level of detail, exactly what is being done, who/what performs each action, what each step requires, what it costs, what it can yield, when money moves, and how every estimate is justified. The number and kinds of variables must emerge from the actual arrangement. This is a general-purpose economic/operating reasoning requirement, not a five-item template.

### 14.1 Represent the transaction as an extensible causal graph

For any business, opportunity, operating model or composite portfolio, Brain must construct a typed, extensible graph of the relevant economic and operational system. A node or relation may represent an actor, payer, beneficiary, asset, right, supplier, channel, offer, obligation, contract, approval, capability, workflow step, time dependency, resource, price, fee, tax, acquisition event, capacity limit, fulfillment output, acceptance condition, payment, refund, debt, liability, recurring relationship, failure mode, or another factor the arrangement itself requires. This list is illustrative rather than exhaustive. Brain can discover a missing variable and expand the graph, including new node/relation types when the existing vocabulary is insufficient. It must connect upstream causes to downstream effects, including cross-business and portfolio-level dependencies.

Each operational action needs clear prerequisites, responsible actor, required permissions, expected effect, timing, external dependencies, evidence, and an observable completion condition. Each financial claim must state the causal route to the money: who pays, for what, under which terms, through which channel, when it is invoiced, when collected, what must be paid out, when those outflows occur, and what amount is genuinely free to use. The owner should be able to inspect or ask about any part of the graph, expand it, and trace implications both forward and backward. Do not force a service, brokerage, manufacturing, distribution, licensing, insurance-adjacent or mortgage-adjacent arrangement into an ill-fitting standard business checklist.

### 14.2 Give every number a lineage and an economic identity

Every monetary amount and material input must carry (a) its precise meaning and unit, (b) source or derivation, (c) status: observed/contracted, externally evidenced, modeled/estimated, assumed for a scenario, or unknown, (d) relevant time window and geography, (e) counterparty/transaction or cohort scope, (f) confidence or uncertainty bounds only where supported, and (g) the dependencies that would invalidate it. An arithmetic derivation must point to its inputs. A provider’s public price is evidence of that provider’s asking price, not proof of Brain’s obtainable sale price or its net margin. A total addressable market is not a count of reachable, paying customers. A signed contract is not settled cash. Collected customer money subject to fulfillment or refund obligations is not automatically free profit.

Brain should reconcile the economic identities that actually apply to the deal: contracts booked, gross billings, fees, third-party pass-throughs, revenue recognized, cost of customer acquisition, cost of fulfillment, contribution margin, fixed overhead, net operating income, taxes, debt service, money tied up, deposits, available cash, distributable cash, and retained capital. Use double-entry or equivalent cash/obligation reconciliation when applicable. Each rollup must be reproducible from individual evidence and accounting events. Expose discrepancies rather than silently plugging them with a guess. If an input is unknown, show the unknown and calculate the threshold or range needed for the plan to work.

### 14.3 Calculate the complete chain, including nonfinancial constraints

Derive achievable outcomes from the actual dependency chain: eligible demand → accessible acquisition path → reachable unique buyers → contact/click/response/qualification → purchase agreement → supplier or AI capability → capacity and quality → delivery and acceptance → invoice/payment → cleared funds → obligations and reusable cash, as relevant to that business. Other routes may bypass, add, or reorder steps. Brain should not assume cold outbound is the only acquisition method, or that every business uses an identical funnel.

Trace quantity limits, elapsed time, concurrency, working capital, platform/provider terms, geography, availability, service-level obligations, refund exposure, conversion variation, supplier reliability and customer concentration. Verify that upstream volume can actually pass every downstream bottleneck before representing it as revenue. A modeled increase in ad spending or leads cannot be assumed to preserve the original acquisition cost or conversion as scale changes; model saturation and constraints where material. Evaluate heterogeneous revenue streams with shared-resource and correlated-failure relationships rather than summing their independent best cases.

### 14.4 Make the model executable, interrogable, and transformable

A business graph must drive real decisions, not remain explanatory prose. Brain should be able to answer: Show the money path; why does this dollar arrive; who receives it first; what do we owe afterward; what breaks if the supplier delays; where does an added $1,000 of advertising go; which constraint caps sales; what happens if we change the payer, role, prepayment terms, channel, product, or delivery? It must propagate these changes through price, capacity, cash timing, profitability, capital exposure, risk, and other connected opportunities; generate new viable branches when a changed assumption opens a different route; and send decision-critical unknowns to targeted research or authorized action.

When the owner asks for a complete account, present the full graph and expandable trace rather than arbitrarily summarizing it to five metrics. Prioritize important details for routine navigation without discarding the rest. The graph must retain its sources and history as new information replaces old estimates; claims are versioned and can be audited after execution.

### 14.5 Model commercial uncertainty mathematically and validate the inputs

The owner wants systems whose economics are so thoroughly understood, diversified, and protected that failure becomes extremely unlikely, ideally meeting an evidence-backed 90% goal requirement. Treat this as a design and verification objective: search for independent channels, contractual safeguards, diversified counterparties, redundancies, reserve capacity, hedges where economically sound, faster cash cycles, and contingency responses. Quantify how much each control changes the downside. Do not automatically label a failed high-confidence plan a “black swan” or proof that arithmetic has broken: arithmetic identities may be

certain while buyer behavior, supplier performance, platform access, payment processing, and market response remain uncertain and can fail under ordinary conditions. The distinction is between a model that adds up correctly and inputs/relationships verified well enough to justify a forecast. Claim ≥90% only from appropriately calibrated evidence, with relevant dependencies, sample limitations, changing conditions and tail risks accounted for; otherwise show the strongest currently defensible probability range or state that calibration is unavailable.

### 14.6 Verification requirements

- Given any material dollar in a projected deal or portfolio, trace it from its originating counterparty/event through contract, settlement, obligations, fees, capital use, and final allocation; reproduce the amount from evidence or label the unsupported input precisely.

- Given two commercially different arrangements, independently discover their necessary variables and graph structures; do not force both into a fixed five-metric list.

- Given a new upstream assumption (buyer access, conversion, cost, supplier quality or payout date), propagate it through dependent transactions, capital scheduling and portfolio forecasts; prove that stale downstream totals do not survive.

- Given a large outreach or advertising budget, demonstrate the evidence-backed funnel, realistic throughput, diminishing returns where present, and financial downside rather than substituting potential audience for expected sales.

- Given a proposed prepayment/subcontracting deal, reconcile received cash with delivery cost, supplier obligations, refund risk and cleared/reusable cash; prohibit counting the same money twice.

- Given a claimed ≥90% plan, audit the support for the probability, correlated risks and failure alternatives; reject unsupported confidence even when the arithmetic is internally consistent.

- In production, explain at least one real incomplete goal-pathway end-to-end, enumerate its genuinely missing causal links, resolve a material one through existing research or authorized execution, and demonstrate the revised financial result. Avoid “implemented” status based on a graph schema or test alone.

Change log update — 2026-11-09 v0.3: Added the owner’s requirement for an unrestricted, fully explorable causal/economic model of each business and deal, complete dollar provenance, transaction-level reconciliation, constraint propagation, and evidence-based downside engineering. This explicitly supersedes any interpretation that the earlier five quantitative questions form a fixed or exhaustive thinking map. The full intended model remains open to additions.

### 14.7 Commercial uncertainty belongs inside the quantitative model (owner correction, 2026-11-09)

Clarification of 14.5: Do not define “mathematical certainty” and “commercial certainty” as two separate domains or imply that buyer behavior, supplier reliability, demand, fulfillment, financing, and market risks somehow sit outside mathematics. The economic model must explicitly include them, using probability, statistics, conditional models, stochastic processes, operational research and scenario analysis as appropriate. What differs is whether the numerical inputs and causal assumptions have enough evidence to justify the reported confidence. A mathematically correct calculation with invented conversion inputs is not an evidence-backed prediction; that is a validation problem within the quantitative workflow, not an exemption of commercial activity from mathematical reasoning.

For an established market such as subcontracted cleaning, construction, logistics, distribution, manufacturing or regulated-industry partnerships, Brain should actively acquire and use existing historical data: transaction counts, actual prices and spreads, bid/win rates, accessible customer cohorts, sales cycles, fulfillment times, cancellations, supplier performance, late or disputed payments, capacity, geographic/seasonal variation and other transaction-specific variables. It should not presume every variable must be discovered by selling its own first order. Use external market data as an initial evidence-supported distribution, then condition or recalibrate it for Brain’s actual offer, buyer channel, customer segment, scale and commercial role. Do not treat industry averages as if they were guaranteed to transfer unchanged.

For each proposed business, model the full conditional path to usable cash, with business-specific structure: who can be reached, who responds, who is eligible, who agrees, the agreement terms, fulfillment and

supplier availability, successful acceptance, collection, refunds/chargebacks, deadlines and residual obligations. Include shared causes that could fail many transactions together (platform shutdown, economic shock, same supplier network, correlated channel performance, payment-provider restrictions). Derive the distribution for the whole portfolio and check goal attainment under realistic variation, not just its mean or a sum of favorable line-item assumptions. Use alternative models, sensitivity analysis and stress cases to expose material model uncertainty rather than hiding it in a single precise number.

When Brain says a plan has a ≥90% chance, it should be able to provide an auditable path: sources and relevant samples → estimated parameter ranges/distributions → assumptions about dependence and scale → complete transaction/portfolio simulation or analytic calculation → out-of-sample or comparable historical calibration where feasible → probability of meeting the actual collected/available cash condition before the deadline. If the evidence only supports bounds or conditional forecasts, report those precisely. It is permissible to design a highly redundant strategy whose downside is very low; it is impermissible to equate “many possible wedges” or correct arithmetic with proof of a 90% outcome.

Additional verification: - For a well-documented, mature subcontracting or distribution market, derive buyer, price, close, capacity and settlement estimates using existing market records before any Brain-originated sales occur; distinguish the transferable evidence from the offer-specific unknowns. - For a proposed 90% cash outcome, reproduce the full source-to-probability calculation, test materially different conversion and fulfillment assumptions, and demonstrate the effect of correlated failures and shared resources. - Show that new actual sales, supplier quotes, changed contract terms or observed response rates update the corresponding distributions and propagate through goal probability, capital schedule and downstream business decisions, without waiting for a complete reimplementation.

Change log update — 2026-11-09 v0.4: Clarified that commercial uncertainty is quantitatively modelable and must live inside the same mathematical framework as every other deal variable. The distinction is between provable calculations and empirically supported parameter/causal assumptions, not between mathematics and commerce. Added mature-market evidence, conditional cash-chain modeling, calibrated probability, and integrated production tests.

## 15. Added 2026-11-09 — Rapid capability acceleration, accountable models, and a middleman-research surge

Owner’s addition: Brain’s errors in commercial probabilities, AI-delivery forecasts, or outcome predictions are problems for Brain’s evidence-gathering, modeling, calibration, or execution to diagnose and improve—not reasons to declare the domain unknowable. The desired pace of capability development is sharply faster than incremental one-defect-at-a-time progress. “Ultron” is shorthand among the builders for a highly capable, integrated system that can rapidly reason, research, build, and operate across many tasks; this is a performance ambition, not a request to discard authorization, oversight, or production verification. In the immediate phase, prioritize extensive, useful research into asset-light commercial intermediation and the fastest defensible routes to collected cash.

### 15.1 Model failure as a diagnostic and correction trigger

A prediction is an auditable claim about a defined outcome, horizon and population, based on particular data and assumptions. When an observed outcome contradicts a forecast, Brain must identify which parts were wrong: evidence quality, external-data transfer, missing economic mechanism, selection bias, parameter estimates, dependency/correlation assumptions, capacity, timing, model implementation, execution behavior, or changed conditions. Distinguish ordinary expected misses within a well-calibrated probability distribution from a systematically miscalibrated model; do not automatically call every miss a black swan, nor imply that a calibrated 90% forecast forbids the 10% downside outcome.

Keep prediction versions, exposure and actual-outcome ledgers; evaluate calibration across comparable opportunities and time windows, not a single isolated win/loss. Correct the smallest underlying reusable cause: improve evidence sources, structure, estimators, models, acquisition assumptions, fulfillment procedures, or execution. Recompute dependent plans and compare the next production observations. Factory owns software fixes when warranted; research and commercial operations own nonsoftware corrections. No redundant new quality-control mechanism if an existing one can own the behavior.

### 15.2 Decompose novel AI businesses into observable causal subproblems

When a business or AI-enabled service lacks long commercial history, Brain should break it into concrete subcomponents with evidence sources or measurement methods: actual deliverables, generation and review workflow, acceptance criteria, model and tool reliability, revisions, capacity per unit time, customer value, comparable substitutes, acquisition channels, payable price, customer contracts, returns, fees, and settlement. Discover additional domain-specific factors as needed. Link these components back into a complete commercial cash model. Reuse mature analogues and established operational data when transferable; label the degree of transfer and validation. A new business category does not justify replacing every unknown with a guess or refusing to estimate anything.

### 15.3 Rapid capability sprints with outcome-level proof

Brain should be able to make step-changes in useful capability over short, intensive engineering/research intervals by identifying several independent current bottlenecks, dividing owned work across already-available Factory/Claude/free-lane resources, integrating as improvements land, and testing complete journeys on production. Parallelism must increase completed useful work, not PR count, queue length, model calls, or duplicate investigation. Assign one owner per overlapping code path; reuse existing scheduling, metrics, goal and completion systems. If a prerequisite is met, the next dependent work should become runnable without a fresh owner prompt.

An overnight or one-day improvement sprint must establish observable before/after outcomes such as transaction models moving from hypothetical to buyer-reachable, supplier-supported, offer-ready; research questions producing accepted decision-changing evidence; research throughput rising without quality collapse; or actual authorized commerce progressing. Define which independent streams are runnable, which are blocked by external permission, and which have no usable capacity. Never promise a one-day architectural transformation on prompt wording alone, and never treat more deployments as proof of broader intelligence.

### 15.4 Middleman commerce: broad, systematic research program

Make commercial intermediation a current high-priority research and construction family because it can use supplier assets, buyer-funded fulfillment and existing industry capacity while requiring little direct owner labor. It must not become a hard-coded forever-only market. For each potential transaction, examine alternative lawful and economically distinct positions—introducer, referrer, representative, lead supplier, broker, coordinator, distributor, reseller, subcontracting principal, marketplace, control-right holder and other positions Brain discovers. Investigate relevant contracts, rights, liabilities, restrictions and counterparty expectations at the exact chosen position.

Research must span different buyer types and market structures, not merely run near-duplicate industry searches. Discover both buyer-first and supply-first entry points; search explicit purchase requests, direct inquiries, unused supplier capacity, repeat services, under-served channels, pricing spreads, bundled supply, distributor/partner inventory, contract renewal points, recurring flows, and existing intermediary economics. Consider cleaning, concrete, trades, logistics, distribution, manufacturing, marketing, AI, and relevant regulated-industry partnership opportunities as examples, not limits. Do not default to the owner’s city, physical presence, existing catalog, cold email, or AI-produced digital work.

The research deliverable is commercially usable evidence per constructed position, not industry fact dumps: exact payer and reachable channel, observed demand, contractual/proposed offer, supplier or capacity source, price and spread, acquisition costs and throughput, fulfillment obligations, margin and timing, buyer-funded cash structure where defensible, capital exposure, transaction rights, limits, uncertainties, and the fastest meaningful next action. Where a source establishes only a public asking price or total market size, identify and separately investigate the remaining buyer-access and conversion gaps.

### 15.5 Allocate by useful yield, not by fixed quotas or server size assumptions

Use existing production instrumentation to record, over consistent windows: total and per-lane job submissions, completions, accepted claims, source quality, packets filed, distinct newly discovered mechanisms, evidence-qualified transaction positions, executable offers, real paid transactions, time and

costs per useful result, utilization of available models/GPUs/workers, queue wait, and rate-limit/failure causes. Attribute resources to commercial discovery, specific deal development, ongoing operation, model/system self-improvement, and forward goals. A job may contribute to several purposes but its actual resource cost must be counted once.

Adapt allocation to marginal useful outcomes: if the free lane generates many claims but almost no actionable buyer/price/fulfillment links, change question design, evidence sources or capable model routing before simply raising job limits. If the queue contains qualified useful jobs and measured machine limits cause delay, add/repurpose capacity as justified by the bottleneck and incremental cost. Respect the availability and real reliability of GPUs, provider quotas, API permissions, and existing worker ownership. Make research capacity and decisions visible in the product. Maintain long-horizon discovery without starving the urgent commercial goal, and preserve the ability to move resources when new evidence changes priority.

### 15.6 Full causal integration and verification

The open-ended causal graph specified in Section 14 is the common substrate: each useful middleman finding must update connected transaction roles, supplier/buyer relations, payment and fulfillment paths, quantitative forecasts, and candidate transformations. Novel AI services must be decomposed into their own needed components rather than pushed through a universal five-metric checklist. A failure should generate a targeted repair or alternate commercial path; a successful transaction should improve both the live portfolio and relevant future-goal possibilities.

Required demonstrations:

1. Use a real production middleman candidate with partial market evidence to construct and compare at least two materially different intermediation roles, including rights, counterparties, unit economics, reachable buyer channel and settlement chain; trace every material figure to evidence or an explicitly bounded estimate.

2. Use a novel AI-performed service to decompose delivery and customer acceptance into evidence-backed subproblems, then produce a traceable economic model with an explicit fulfillment capability test.

3. Show a forecast versus actual event (or a real historical outcome) causing concrete model diagnosis and an updated downstream decision; evaluate calibration across an appropriate set of observations rather than treating a single adverse outcome as proof of impossibility.

4. Run a bounded, resource-measured research improvement interval, demonstrating that accepted commercially decisive findings or executable offers per unit time improved, or clearly identify the external constraint preventing improvement. No credit for raw job count alone.

5. Demonstrate that several independent commercial constructions progress concurrently where resources permit, and that shared resource/capital limits are modeled without suppressing unrelated work.

Change log update — 2026-11-09 v0.5: Added model accountability and diagnosis, detailed decomposition of novel AI commerce, rapid integrated capability sprints, broad middleman-first commercial research, evidence-yield-based research-resource allocation and production behavioral proof. These additions extend the prior architecture; no fixed five-metric schema or new software subsystem is authorized merely by its mention.

## 16. Added 2026-11-09 — High-volume algorithmic research independent of LLM throughput

Owner’s addition: Brain’s research cannot depend on passing every new observation to an LLM. The owner wants broad, intensive research into middleman commerce, existing money flows, suppliers and demand, alongside research into Brain itself. AI can discover and interpret initially, but durable algorithms should continue collecting, categorizing, reconciling, connecting, and calculating information at volume. Expand compute where useful, while distinguishing a lack of CPU/RAM from model outages, research-scheduling constraints, poor sources, or a blocked verification pipeline. This is a permanent general capability, with current emphasis on commercial intermediation.

### 16.1 Five cooperating functions, not five fixed business variables

1. Code-first sensing: A source-specific connector fetches permitted public feeds, APIs, structured pages, directories, records and changes on a schedule or event trigger. Store raw or normalized records once, with source, timestamp, identifier, schema/version, coverage and change history. Use incremental reads, cursors, caching and deduplication to avoid paying for the same observation repeatedly. Discover and add new source families as justified by commercial value rather than maintaining a permanent fixed catalog.

2. Deterministic extraction and reconciliation: For sources with stable structure, ordinary programs parse prices, requests, dates, locations, quantities, product/service descriptions, buyer and provider identities, permits, capacity announcements and other source-specific facts. Normalize units and currencies, entity identifiers and time windows; handle conflicting and stale observations without presenting them as established facts. Preserve a link from every normalized fact back to its exact raw evidence. Do not turn a job posting, supplier advertisement or platform price into fabricated confirmed customer demand.

3. Relational/event reasoning: Maintain an evidence-linked graph of economic actors, wants, capacities, offers, prices, timing, channels, roles and rights. Update only affected neighborhoods when a new event arrives. Rules detect changes and relationships: a buyer request against an available supplier; repeated regional demand against limited supply; a contract renewal against a provider’s capacity; a published buy/sell spread after all necessary costs; a concentration of buyer requests that could be served through a partner. Detection produces a hypothesis with provenance and explicit missing conditions, not a verified opportunity.

4. Algorithmic construction and numerical evaluation: Traverse and join compatible graph elements; enumerate transaction roles and applicable transformations; test hard feasibility, rights, capital, buyer access, capacity and settlement constraints; calculate price and margin bounds, available deal counts, sensitivity and portfolio interaction. Use cheap pruning, diversity and expected decision value to choose which candidates deserve costly investigation. Preserve genuinely different commercial mechanisms and valuable components of failed ones, rather than repeating near-identical combinations.

5. Selective model intervention: Send work to an appropriate LLM only when rules cannot reliably interpret an ambiguous source, infer a genuinely new economic mechanism, resolve a material contradiction, generate a novel structured hypothesis, or plan a nonroutine intervention. Batch related facts when practical. Verify claims by independent evidence methods already installed. Model output is never silently upgraded to a commercial fact, an authorization or an accepted probability.

These are processing responsibilities, not an exclusive sequence. New evidence can trigger recomputation, construction, targeted search, or reassignment concurrently. Computations should happen without paying for one LLM call per record or rerunning the entire goal against unchanged data. The algorithmic lane must remain useful when every LLM provider is down, although it cannot substitute for language understanding when truly needed.

### 16.2 Extend existing owners, not another parallel research system

The repository already has code-first feed collection (services/feeds/run.ts), versioned code detectors with SHADOW/ACTIVE mode (services/feeds/detectors.ts), trigger buckets (services/cash/triggers.ts), source deduplication, numeric extraction (services/cash/volume.ts), transaction construction (services/cash/construct.ts), quant and the free-model lane. Implement the non-LLM expansion through these owners wherever possible. The existing feed path still sends uncovered individual records through free-model screening and limits shortlists; the code-first recognizers presently cover specific patterns, not the full economic field. The trigger buckets still rely on model-generated research prompts. Generalize coverage and composition without losing the existing gates or duplicating schedulers, stores or authority paths. Make use of deterministic code able to filter and score millions of structured events if real infrastructure measurements support that scale; do not assume a headline records/day rate means useful opportunities/day.

### 16.3 Research resources and real capacity limits

Separate and measure at least: source fetching/ingestion, parsing and indexing, graph/detection/quant computation, model-based interpretation, evidence verification, and human/authorized commercial execution. Collect per-stage queue size, oldest useful item, items processed/hour, unique usable facts, dropped/duplicate records, model calls avoided, model/provider failures, CPU/RAM/DB/network use, elapsed time and incremental dollar cost. Attribute productive work across immediate commercial discovery, deal completion, continuous broader-world research, self-improvement and future-goal preparation without counting the same job multiple times.

Current-turn production checkpoint (GitHub Cheap lane run 42577770227, reported around 2026-11-09 07:16 UTC for its previous six-hour window): brain-a submitted 4 jobs and the RunPod Qwen3-4B lane 3; the report separately lists 318 and 325 not-accepted results respectively; accepted claims averaged 0.7/hour overall and 0/hour for the $10K goal, with 0 newly filed openings/hour and 0 harvested goal rounds. It also reports a failed GPU probe and substantial model-call failures. Earlier six-hour intervals had ~14.5 accepted claims/hour, so capacity and delivery are currently unstable. These figures are window-specific historical telemetry, not a daily estimate or evidence that the server itself is saturated. Source: https://github.com/Peyday007/V5/actions/runs/42577770227. First remedial action: restore functioning model/verification throughput and observe whether existing queued work advances; identify actual cause (provider availability, credentials, task routing, broken GPU, DB or CPU) from current signals. Do not enlarge the Fly web process merely because a research queue is long. Scale independent worker replicas, CPU, memory, networking, storage and model instances only after measurements identify the constrained stage, with a measured expected gain in accepted commercially decisive facts per hour and dollars spent. The web/API service must remain responsive while bulk ingestion and computation run.

### 16.4 Autonomous rule improvement

A model can propose new source connectors, extraction schemas, normalizers, anomaly detectors, link rules and opportunity-construction operators when observed facts or repeated missed opportunities justify them. Factory implements durable code; tests compare against known records and recent genuine production inputs. New detectors run SHADOW first, recording candidate counts, false joins, misses and evidence quality; promote to ACTIVE only after verified output, retaining rollback and the provenance chain. Rule changes must not silently suppress entire allowed industries or consumer/brokered services. If a rule degrades decision quality, retire or correct it. Data-version and rule-version changes should trigger only necessary affected recomputations.

### 16.5 Completion proof

Demonstrate on real production source families that (a) code-first ingestion continues and produces evidence-linked structured events without an LLM on every item; (b) related facts from different sources generate genuinely new, economically specified middleman hypotheses; (c) qualified hypotheses correctly enter existing construction, research, quant and goal workflows; (d) the source-to-goal evidence chain remains auditable; (e) the model-call reduction and accepted commercially useful outputs per hour improve without precision/recall collapsing; (f) after a provider outage, the deterministic lanes continue making useful progress and backlog catches up after recovery; and (g) capacity additions are chosen from actual stage-level utilization. Do not mark this implemented based on a parser, a new queue, a longer list of triggers or synthetic test data alone.

Change log update — 2026-11-09 v0.6: Added high-volume code-first sensing, structured extraction, incremental commercial-event graph reasoning, algorithmic combinations and quant pruning, selective LLM escalation, rule promotion via SHADOW/ACTIVE, stage-specific capacity planning and production outcome tests. Preserved the earlier open-ended economic architecture and immediate middleman-research priority.

## 17. Added 2026-11-09 — Implementation sequencing: revenue first, complete architecture preserved (revised by §18)

Owner’s priority direction: The full architecture is to be implemented, not reduced to a small subset. Its implementation order should reflect what unlocks the fastest real, usable cash generation right now, through whatever commercial mechanisms Brain can discover, construct, quantify, and execute most effectively. The owner mentioned middleman models as examples of potentially lean, fast-capital-cycle structures, not as approved categories, preferred industries, or search boundaries. Brain must be free to find better mechanisms the owner has never heard of. The owner expects a possibly very large specification and a Factory-driven program; priorities may differ, but no requirement may be silently omitted because it is not first. Subscription/API/worker capacity is finite and must be measured rather than guessed. Do not infer a one-week completion commitment from a subscription price or an aspiration.

### 17.1 Two separate requirements: comprehensive coverage and execution order

- Coverage is comprehensive: preserve the entire immutable master specification; give every requirement and cross-system interaction stable source-linked IDs, implementation ownership, a dependency graph, acceptance conditions and production proof. The Factory program may group, sequence, or parallelize requirements but may not compress their meaning or declare parent DONE with missing requirements.

- Priority is economic and dependency-aware: choose what to implement first based on how much it unlocks genuine commercial discovery, offer construction, customer access, authorized selling, cash collection, fulfillment, and profitable capital reuse. An enabling prerequisite can outrank an apparently lucrative feature when it is the actual first blocker. Predictive ROI and timelines are hypotheses until measured.

- Do not wait for the complete architecture to generate revenue: keep existing business research, deal development and any authorized sales running. Ship improvements in usable vertical slices with production proof, while preserving the rest of the implementation queue.

### 17.2 Starting work order, revisable by production evidence

P0 — Goal-directed economic intelligence and cash execution. Develop and operate the general ability to discover, compare, construct, and execute the most promising economically feasible mechanisms across the open world, regardless of whether the owner named their category. Fix the earliest concrete blocker preventing a promising arrangement from reaching a buyer and collecting spendable cash: commercially viable offer, permitted and authorized acquisition channel, counterparty and fulfillment identification, rights/terms, price and real margin, accepted payment path and settlement timing, then operations and reinvestment. Use the existing Instantly integration and cash/quant architecture wherever appropriate; validate that account configuration and permissions actually work before declaring live outreach. Never treat the lack of owner permission as a reason to stop unrelated planning. Preserve hard risk and operating limits. Success is a verified improvement in executable transactions and eventually actual receipts, not more candidate ideas, PRs, or mockups.

P1 — Systems that immediately multiply P0 throughput. Restore any failing research/model route first when it is blocking useful work; expand code-first public-source ingestion, matching, quantitative reconstruction, evidence verification, economic-actor and capability matching, deduplication, causal/quantitative reasoning, and targeted LLM escalation. Measure verified commercially consequential findings per hour per dollar. Eliminate repeated global screens, stalled queues and over-filtering; add measured compute or worker capacity only to an actual constrained stage. Develop Factory program completeness safeguards to the point required before handing it the large architecture, while other directly revenue-relevant work proceeds.

P2 — Compounding intelligence and scale. Implement open-ended idea transformations, a general mechanism search, learning how to reason about newly encountered industries, cross-source economic graph, causal/dollar traceability, automatic reuse of components, dynamic portfolios, capital velocity, coordination of many simultaneously operated lines, and overlapping horizon goals. Prioritize the specific units whose absence limits real P0 and P1 performance; deploy other independent units concurrently where resources permit.

P3 — Wider platform capabilities and product surfaces. Implement the remaining full architecture, research allocation across purposes, company archetypes, long-term lifestyle/film/growth capital management, comprehensive website and conversation improvements, ongoing self-improvement, and end-to-end product verification. The tier is not permission to indefinitely defer requirements or to leave usability blocking P0; promote a task immediately whenever it becomes a revenue or operational prerequisite.

The order is an initial dependency-aware priority framework, not fixed industry preferences, fixed percentages, or a hardcoded four-stage pipeline. Any requirement may move up when current evidence proves greater urgency or leverage. Independent tasks should run in parallel within measured provider/worker capacity, without conflicting owners or deploying stale changes. Aim for minimum cohesive working releases, never superficial stand-ins that pass a keyword check.

### 17.3 Factory governance for this program

1. Verify or build the required lossless source preservation, coverage map, dependency edges, cross-campaign coordination, completion refusal and production-evidence linkage before relying on Factory to implement a lengthy specification. Reuse its existing planner, scheduler, contract, scope, integration, review, repair and release machinery; do not duplicate them.

2. Assign requirements to Factory campaigns based on ownership boundaries and real prerequisites. Each worker receives its exact requirements and relevant system interfaces, not an abbreviated aspirational summary. Preserve program-level continuity after contexts, restarts and worker failures.

3. Keep one authoritative parent status: required capabilities proved in production, underway, waiting on actual dependencies, or blocked with exact action. Feature DONE and financial goal DONE are different verdicts.

4. After every deploy, evaluate whether it increased useful commercial output or unlocked the next causal link. If not, do not falsely claim the cash objective advanced. Continue the next highest-value unblocked work.

5. Track actual available Claude accounts/quotas, Factory surfaces, GPU/free-model throughput, API ceilings and their utilization; the owner’s approximate subscription spend is not itself evidence of throughput. Prioritize around measured bottlenecks and the nearest cash-relevant dependency.

### 17.4 Non-negotiable end state

The whole architecture remains open until every originally specified requirement is implemented, integrated and verified, regardless of the order chosen. The immediate commercial priority must remain market- and mechanism-agnostic, not a hardcoded list of intermediation industries; it is not an excuse to shrink the architecture; the large architecture is not an excuse to postpone revenue-generating work. Subsequent additions from the owner amend this source document and are re-mapped without losing prior requirements.

Change log update — 2026-11-09 v0.7: Recorded owner’s explicit revenue-first implementation priority, middleman commerce as the urgent focus, full specification coverage, prerequisite-sensitive sequencing, concurrent work, Factory safeguards, capacity realism and continuous implementation without waiting for the entire program to finish.

## 18. Added 2026-11-09 — General economic intelligence, learned reasoning methods, mathematical breadth, and target overperformance

### 18.1 Owner correction: do not anchor the intelligence to examples

The owner’s examples (brokerage, subcontracting, distribution, insurance, manufacturing, and others) reflect what the owner currently knows, not what Brain is instructed to search first or consider best. The owner is explicitly asking Brain to discover superior mechanisms neither the owner nor the original prompt identified. Every category should be treated as a hypothesis that must compete on estimated economics, feasibility, risks, time to usable cash, capital requirements, and achievable scale. No permanent industry shortlist, fixed wedge count, canonical list of business models, or quota by example category may narrow the search. Search over mechanisms, relationships, market conditions, and possible positions, not merely a catalog of labeled industries. An unfamiliar category with favorable evidence must be able to outrank all

familiar ones. Priority should follow what currently unlocks the financial objective and the broader capability base, not the vocabulary of this document.

### 18.2 Three separate kinds of intelligence, all required

1. Knowledge acquisition: Learn what a market or process is, the actors and legal/operating rules, how buyers and suppliers behave, prices, constraints, timing, competition, available infrastructure, performance data, and what evidence exists. Store atomic, sourced claims and their provenance; keep conflicting, missing, outdated, or locally inapplicable claims explicit.

2. Mechanism-specific economic understanding: Construct causal and quantitative models of how a transaction actually happens in that domain—who initiates it, how access is won, what rights are needed, whose balance sheet carries risks, what triggers purchase, who delivers, how money moves, what can fail, and what is reusable. Represent the graph as open-ended variables, entities, actions, contracts, states, constraints, probabilities, and feedback; do not assume a universal five-factor or fourteen-factor form is exhaustive.

3. Metareasoning / learning how to reason: Determine which analytical method, experiment, decomposition, analogy, optimization technique, research method, or tool is appropriate for a problem; compare competing methods; detect weak inferences; learn reusable procedures from successes and errors. If it cannot reason well about subcontracting (or any unfamiliar domain), identify which methodological capability is absent, obtain or derive a better method, verify it, and apply it broadly—not merely collect more subcontracting facts.

The third layer must be operational: a controller identifies information needs and failure modes, selects tools and alternative representations, decomposes tasks, generates multiple independent hypotheses, compares them against real evidence, chooses the next action based on decision value, tracks results, and modifies its method when results invalidate the reasoning. It should use existing Brain/Factory systems where available and avoid building a second competing orchestration engine.

### 18.3 Mathematical toolkit as a tool-selection system, not a fixed list

The number of mathematical disciplines is not itself the goal. Brain must be able to select, compose, extend, and validate the appropriate mathematics for each economic question. Relevant families may include probability and Bayesian inference, statistical estimation and calibration, causal inference, sensitivity analysis, value-of-information and experimental design, optimization under constraints, robust and stochastic optimization, Monte Carlo and scenario simulation, time-to-event and settlement models, queuing theory, network and graph algorithms, matching/assignment, flow and routing models, portfolio theory and dependence, financial accounting and cash-flow identities, operations research, game theory and competitive response, real options, forecasting and state estimation, and reliability engineering. This is an illustrative toolbox, not a fixed ceiling or a demand to use every method on every job.

For every material number or claimed probability Brain must retain: what quantity it represents (gross billed, cash received, net contribution, retained cash, enterprise value, etc.), its units and time horizon, its source and retrieval date, computation and formula, alternative plausible parameterizations, uncertainty and interdependence, sensitivity to input changes, and evidence that the method applies to the particular opportunity. Financial identities can be exact conditional on inputs; success probabilities are only as reliable as their calibrated evidence and assumptions. The system should compare its forecasts with realized results and correct systematic error. Unknowns must not be filled with convenient figures.

### 18.4 Design for target overperformance and a robust floor

A monetary objective is a minimum performance threshold for the optimization problem, not a reason for the system to stop exploring further value once it sees one route to that number. Brain must look for plans whose expected and upper-range outcomes exceed the threshold and whose adverse-case outcomes remain defensible. It may choose different targets for expected collections, downside protection, growth of capabilities, and reusable capital, and should explicitly trade off cash velocity, uncertainty, shared dependencies, opportunity cost, and upside. Surplus revenue can finance successors; hitting an arbitrary milestone must not terminate other productive opportunities.

Crucially, the owner’s aspiration that the worst case still hit the target must be represented correctly. A 90% chance of at least $10K means at most a modeled 10% probability of being below $10K (if the model is reliable); it does not mean the literal worst possible outcome is $10K. A true cash floor requires stronger commitments, guarantees, escrow, diversified enforceable receivables or comparable mechanisms—and may still be limited by correlated or systemic risks. Brain should design and quantify downside protection, including cash buffers and over-target portfolios, rather than manufacture a guaranteed floor. Make the optimization objective configurable rather than presupposing that all goals require the same confidence threshold or upside objective.

### 18.5 Rapid intelligence advancement: a one-week measurable sprint, not a magical model upgrade

The owner wants a steep near-term increase in the quality and speed of Brain’s reasoning, not months of small fixes. A high-priority sprint should identify and implement the smallest general improvements that create a step change in demonstrated goal-solving competence, using existing LLMs, code-first algorithms, Factory, research and quant capabilities. This can include a method library that is selected by task and evaluated, explicit counter-models and adversarial checks for expensive decisions, causal-graph generation, automated decomposition and dimensional validation, cross-market mechanism transfer, active-learning query selection, and closed-loop forecast evaluation. It does not require training a frontier foundation model from scratch and must not be presented as proof that a general superintelligence can be created in seven days.

Within the sprint: benchmark representative, held-out real commercial problems; establish the current rate of producing economically supported, actionable transaction pathways (not mere ideas, claims or PRs), and measure method quality, decision time, required human interventions, calibration and robust target coverage; implement the highest-leverage missing general reasoning capabilities; rerun the same benchmark plus new held-out tasks, and verify improvements in production. Failures should feed the existing Factory repair path; don’t wait for the full specification before providing useful capability upgrades. Compare the general method against simpler baselines to ensure extra complexity earns its resource cost.

### 18.6 Behavioral acceptance tests for the Factory implementation program

- No category anchoring: Given economic evidence in an unlisted sector, Brain can independently identify a strong money-making mechanism there, and it outranks weaker examples previously mentioned by the owner.

- Learn the reasoning method: Given a previously unfamiliar domain, Brain identifies which analytical approach is needed, obtains/reuses/develops it, tests its applicability, and generates a grounded decision—not merely more industry facts.

- Open-ended causal detail: Given a deal with extra contractual, regulatory, operational or financial dependencies, Brain can represent them without modifying a narrow static checklist; changing one cause propagates to its effects.

- Math selection and provenance: Brain uses different mathematical methods where they are warranted, records each input and assumption, detects invalid units/unsupported forecasts, and avoids inventing confidence.

- Over-target robust plan: Given several possible portfolios, Brain examines target attainment, downside outcomes, upside and correlated failure; it prefers an evidenced robust portfolio over a fragile portfolio that barely crosses the stated threshold, under the configured risk appetite.

- Rapid real-world improvement: The intelligence sprint must demonstrate materially better results on representative production work and held-out commercial cases, independent of its PR/test counts.

### 18.7 Priority correction to §17

The top priority is the general capability to identify and execute the highest-value feasible route to the current goal, whatever commercial mechanism that route requires, while building stronger general intelligence. In the near term, commercial research and revenue-producing operations matter most; the system must not cement the owner’s current examples into permanent search preferences. Factory must map this correction to the authoritative requirements and preserve it through all future implementation plans

and acceptance tests. Code-first intelligence and scalable LLM reasoning are complementary; the selection must be based on the task’s demands and measured marginal value.

Change log update — 2026-11-09 v0.8: Removed category anchoring from §17, specified domain learning vs economic modeling vs metareasoning, open-ended mathematical tool selection, target overperformance with defensible downside bounds, and a measurable high-priority intelligence capability sprint.

## 19. Adaptive mechanism blueprints and multiplicative, non-LLM intelligence (2026-11-09)

### 19.1 Owner’s concept and non-anchoring requirement

The owner describes Brain learning all the operative mechanisms of a business and then laying those mechanisms out like a blueprint on which multiple interdependent components can be placed, changed, compared, and recombined. The reference to “ten different things” is an analogy for compositional structure, not a requirement for ten modules, ten factors, a ten-step workflow, or a single universal blueprint. Brain is responsible for discovering the appropriate representation for each unfamiliar domain, explaining why that representation captures the important causal and economic relationships, and revising it when the model misses a mechanism.

Brain must learn both (a) how a domain functions and (b) how best to model, reason about, and operate in that domain. Neither the owner’s vocabulary nor the first architecture devised by an LLM is an immutable ontology. More detail is valuable only insofar as it makes decisions, execution, or trustworthy predictions materially better.

### 19.2 A generative mechanism graph, not a static checklist

Use or extend the existing economic/industry, construction and quant representations rather than adding an independent world model. The logical representation should be extensible and compositional: entities, actions, events, states, resources, rights, incentives, constraints, contracts, ownership and responsibilities, evidence, uncertainty, decisions, dependency edges, money and other flows, transformations, and time. These are illustrative kinds of structure, not an exhaustive taxonomy. A system must be able to add a novel kind of relationship or variable when a business requires it.

For a particular business, the model should expose an understandable end-to-end causal blueprint: what starts a transaction, what creates value, which parties act, what must happen before other things can happen, what changes hands and on which terms, which resources and permissions are necessary, what can break, and where the enterprise can position itself. It must represent interactions (including many-to-one and conditional dependencies), not merely a sequence of boxes. A changed price, buyer channel, supplier, contract term, or regulation must propagate through every dependent calculation and action. Keep uncertainty and source references attached to individual claims, relationships, and numbers.

The same structure must support deriving many different roles and offers from the same evidence, and transferring reusable mechanisms between otherwise unrelated sectors without asserting that a transfer works until its constraints are checked. It should retain useful components of commercially unsuccessful structures.

### 19.3 Multiply the work done per LLM call

The owner’s “ten apples from AI, plus three from one algorithm, plus two from another” describes increasing total productive output without proportionally increasing LLM inference. It is not a fixed throughput target or instruction to count duplicate outputs as extra work. There are two distinct gains:

1. Offload routine work: ordinary programs fetch and refresh permitted public datasets; normalize entities and units; compare changes; deduplicate; join buyer/supplier/price/location/availability observations across sources; extract fields from reliable structured formats; maintain indexes; calculate contract economics; enforce constraints and detect contradictions; and update affected models incrementally. These tasks need not each invoke an LLM.

2. Turn expensive reasoning into reusable machinery: an LLM analyzes an unfamiliar market or document format once, proposes a parser, detector, economic relationship, matching rule, calculation, or research procedure; Factory tests and validates that procedure; a versioned software rule then applies it to many further records. Ambiguous, newly shaped or strategically difficult cases return to AI, which can devise another reusable method.

As a result, some work is avoided (cached established facts, no repeated judgment), some is cheaper (code vs model calls), some is created (cross-source matches or implications that were invisible when records remained separate), and the saved AI capacity can be redirected to new markets, sophisticated reasoning, capability improvement or active goal execution. A code-derived implication is a hypothesis until underlying evidence and the necessary commercial conditions support it.

### 19.4 Operational architecture and routing

Implement through the current owners for feeds, research, industry knowledge, triggers, construction, quantitative planning and Factory. A conceptual loop, with non-prescriptive boundaries:

- Observe: fetch/ingest source records once, with access permissions, timestamps, provenance, and change tracking.

- Structure: deterministic extraction and normalization for known formats, with selective AI assistance for previously unseen or uncertain cases.

- Connect: incremental joins and graph operations surface buyer–supplier fits, economic disparities, unmet needs, new dependencies and cross-sector patterns.

- Derive: constraint propagation, matching/assignment, arithmetic, optimization, sensitivity and uncertainty calculations create and rank possible transactions and missing-link questions.

- Reason selectively: route high-decision-value ambiguity, unconventional mechanisms, invalidating evidence and method design to capable LLMs; avoid model calls on routine records merely because they are new.

- Codify and verify: convert repeatable discovered procedures into tested, versioned, reversible rules through the existing Factory pathway; compare their output with a high-quality evaluation sample before promoting them from observation/shadow mode.

- Act and learn: pass supported transaction paths to existing authorized execution; use measured results and counterexamples to recalibrate, repair or replace the relevant algorithms and reasoning methods.

This does not require a single fixed order: multiple processes may act in parallel, and any stage may trigger a return to discovery or a change in representation. Every action and computation must remain reproducible from its source facts and software versions, or state clearly when a judgment was not deterministic.

### 19.5 Scaling decisions, constraints, and real value

Increase both model capacity and the fraction of useful work performed without model calls, but do not equate provisioned concurrency with productive throughput. Measure records ingested per unit compute; data sources covered; deduplication and parsing coverage; code-derived matches; AI calls per useful finding; time to verified commercial candidate; accepted economic evidence; offer-ready pathways; cash outcomes where authorized; model and algorithm error rates; saturation, queue delays, and idle resources. Compare the contribution of each added parser, detector, worker, or model route against its ongoing cost and downstream effect.

A software algorithm cannot produce reliable facts that sources do not contain. When extraction, relationship, market demand, delivery capability, or payment timing remain unknown, expose the gap and choose the highest-value way to obtain the information. Keep legal/data-access constraints and commercial contact permissions intact. Additional hardware is justified only by measured saturation of a working path or a clear marginal throughput gain; current provider failures or unavailable GPU capacity must be repaired rather than simply met with a larger application server.

### 19.6 Factory implementation and acceptance requirements

Factory must receive these requirements as a complete, traceable section of the master architecture, not condense the concept into a dashboard or a fixed business-template generator. Reuse existing subsystem owners and code-first detectors. Require evidence of the following behaviors on real data, with focused synthetic tests for failure cases:

1. Unfamiliar business: Brain discovers an appropriate mechanism representation without a preset fixed number of steps; it names causal dependencies and revises the representation when an essential relationship is missing.

2. Recombination: mechanisms extracted from multiple unrelated markets can be recombined into a novel transaction candidate, with all newly introduced constraints and unknowns exposed.

3. Code-first multiplication: one AI-assisted method discovery yields a tested, versioned parser/detector/algorithm that processes a substantial new batch without an LLM call per record; compare useful verified output and cost against the existing model-per-record path.

4. Independent analysis: for known structures, code-based matching, calculations and change propagation continue and produce useful new results during a model-lane outage, without silently promoting hypotheses to facts.

5. Selective escalation: ambiguous, novel or high-impact cases are surfaced to AI with relevant evidence; routine cases remain in code; method errors trigger a repair or a return to shadow mode.

6. Integrated goal impact: the new output genuinely enters the existing economic and goal models and is judged by buyer access, fulfillment, economics, collection timing, and measured commercial value—not by raw records processed or theoretical ideas generated.

7. Resource proof: benchmark throughput, accepted useful findings, per-finding AI cost and latency before and after. Demonstrate a gain in real downstream decision quality or commercially usable paths, not merely more background activity.

Change log — v0.9: Added adaptive mechanism blueprints, explicit non-anchoring of metaphor/step counts, AI-to-reusable-code conversion, scalable code-first research, selective LLM escalation, and end-to-end production acceptance standards.

## 20. Self-directed operational and capability autonomy (2026-11-09)

### 20.1 Owner intent: initiative without constant human orchestration

Brain is intended to become capable of recognizing for itself that a missing resource, skill, procedure, dataset, integration, software capability, provider, or business relationship would advance an objective; deciding whether obtaining it is worthwhile; then acquiring, developing, testing, integrating and using it. The owner should not have to notice each small shortcoming, invent a prompt for it, assign a Factory job or repeatedly return to unfinished work. The owner wants useful progress to occur even when he has not noticed the need.

This goes beyond scheduling tasks or looping until a checklist is complete. Brain must be able to originate the necessary work from its own observations of goals, evidence, failed attempts, idle resources and changing economic conditions. It must also discover that its way of thinking or working is inadequate and improve the underlying method, rather than endlessly re-running it.

This is an open-ended requirement, not a demand to implement a fixed list of autonomous behaviors. Brain selects the approach appropriate to the problem; the examples below do not constrain what kinds of resources or methods it may need.

### 20.2 Autonomy as a repeated decision-and-improvement process

A possible implementation pattern, explicitly non-prescriptive:

1. Notice a useful missing capability or resource. Infer from real goal constraints, bottlenecks, research failure patterns, repeated manual work, unexploited economic opportunities, and

counterfactual improvements. Example: a commercially promising transaction repeatedly needs supplier capacity that the system cannot access.

2. Form an explicit causal hypothesis. Identify what the missing piece would enable, which measurable outcome would change, what makes the evidence credible, and how the decision could fail. Distinguish a missing dataset from a reasoning defect, a permission gap, an unavailable provider and a genuine market limitation.

3. Search existing capabilities and the outside world. Check Brain’s skills, code, knowledge, data contracts, plugins, external tools, public sources, installed connectors, standard libraries and existing Factory ownership before building anything new. Discover appropriate alternatives without using a closed list of favored vendors or methods.

4. Calculate the value of the next step. Compare developing an integration, buying permitted access, using an existing export, building a code-first detector, commissioning research, asking a human for one necessary credential, changing an algorithm, or abandoning the direction. Evaluate expected decision value, cost, latency, opportunity cost, dependencies and constraints, not an arbitrary priority tag alone.

5. Acquire or construct the missing piece. Use the existing execution owner: Factory for software changes; research/ingestion for information; existing integration managers for connectors; commercial workflows for independently authorized interactions. Allocate actual workers and time; do not stop at a recommendation or spec.

6. Verify that it works in reality. Compare against a baseline in the actual environment, including source reliability, coverage, correctness, operating cost and downstream effects. Automated tests and code review are necessary for software, but not a substitute for real-world goal impact when the problem is commercial.

7. Integrate, reuse and learn. Register a versioned reusable capability with its provenance, preconditions, operating boundaries, costs, known failure modes and owning subsystem. Update dependent goals and models. Adapt or retire it when evidence changes. Discover whether the new capability opens adjacent opportunities or a more effective reasoning method.

8. Continue without prompting. Resume other high-value work and periodically reconsider incomplete goals, opportunities and capacity. Persist context and program state through worker/context loss and deploys. Do not merely generate an unbounded backlog and call that autonomy.

Multiple loops may run concurrently, share dependencies and inform one another. A discovery may generate an engineering objective; a code improvement may unlock a new dataset; a new dataset may change the entire portfolio; a sales result may invalidate an earlier model. A single rigid pipeline is not intended.

### 20.3 Graduated authority, not constant owner interruptions

The owner’s preference is that routine progress be autonomous and unobtrusive. The system should make consequential actions accountable through a durable, inspectable event ledger instead of requiring a chat message for every ordinary success. An owner can request explanations later: what Brain obtained, when, why, what it cost, what it changed and whether it actually helped.

Brain should use the authority it already has; it should not silently grant itself new authority. Distinguish, in the existing permission system rather than a duplicate policy engine:

- Independent internal actions: public-source research where permitted, read-only analysis, parsing, non-production experiments, calculations, deduplication, method design, benchmark generation, and reversible state changes within authorized scope.

- Standing-grant engineering actions: Factory coding, tests, merges and deploys where the applicable release rules and approval envelope expressly allow them.

- Third-party authenticated operations: only within the permissions, account scope, site rules, rate limits, and previously approved action types of the authorized account. Secrets are held in an appropriate secrets store and cannot be copied into prompts, outputs or source code.

- Externally consequential actions: buyer outreach, purchasing, spending, new financial commitments, publishing externally, signing agreements, account creation, or materially changing business operations require the applicable existing authority. If a decision needs owner involvement,

ask for the specific smallest missing approval, carry out all other useful work, and remember the answer for the approved scope.

Not notifying the owner about every routine change is a presentation choice. It must never erase the audit trail, hide unapproved spending, bypass access controls or obscure an actual commercial risk. Brain needs bounded autonomy that can safely increase as demonstrated competence and explicitly granted permissions increase.

### 20.4 Capability ownership and avoiding a duplicate Brain

Extend the existing systems for Factory, capabilities, evidence, goals, research, execution, permissions, external connectors, repair-to-goal, and operational measurements. If a capability registry or objective-to-Factory handoff already provides the behavior, use it. Add only the minimal missing coordinator or interfaces. A capability proposal should identify the existing owner and evidence for whether it already works. The owner does not need another self-improvement subsystem that merely audits and produces PRs without changing the real outcome.

Success requires that Brain can independently recognize and close gaps it was not specifically told to look for. Measure the useful gaps identified, gaps closed without owner input, time to actual capability use, productive work resumed, change in goal quality, regressions and costs. Count neither speculative recommendations nor merged PRs as economic success.

### 20.5 Acceptance demonstrations

The architecture implementation is incomplete until production evidence demonstrates:

1. Brain encounters a real unfamiliar missing dependency on an active goal and initiates the correct investigation or development without an explicit owner prompt for that dependency.

2. It searches the existing system and external options, avoids duplicating a working capability, chooses a cost-justified method and names what evidence could change the decision.

3. It autonomously creates or reuses an authorized tool, dataset connection or software repair; verifies the working result; incorporates it into the actual goal process; and resumes productive work.

4. A worker failure, model outage or restart does not lose the original objective; continuation is proven through durable records and an end-to-end result.

5. A requirement for an external credential, account change or financial/customer action is surfaced as a precisely scoped permission request, not silently performed or used to block unrelated autonomous work.

6. Repeated recurrence of a gap causes correction of the reusable method or capability rather than a collection of narrow, repeated prompts.

7. A later question such as “What did Brain improve while I was away?” can be answered from events, costs, tests and production outcomes, including failed experiments—not reconstructed from a worker narrative.

## 21. Universal information acquisition and website operation without mandatory APIs (2026-11-09)

### 21.1 Owner intent and relationship to other systems

Brain must not be limited to sites with API keys or to documents a person manually uploads. When it needs an external resource or a website’s functionality, Brain should independently determine which available access method is appropriate, use that method, and where repeated work is justified, build a reliable reusable connector or automation. The owner’s example is a website with useful functionality but no public API: Brain should be capable of operating its interface under the legitimate account and permission available to it without someone repeatedly logging in and clicking through the same workflow.

The same principle applies to obtaining large quantities of useful documents, market records, company data, industry material and research evidence. A source-discovery process should find existing corpora, bulk

exports and catalogs before writing a bespoke crawler. These are two complementary capabilities: operate systems and acquire/maintain information. Neither may be conflated with authorization to contact strangers, evade site defenses or make business commitments.

### 21.2 Access-method selection: choose what fits the source

For each desired source or action, dynamically select among appropriate methods, favoring reliable, permitted, low-cost routes:

- Native/first-party integrations: official APIs, authenticated exports, webhooks, event subscriptions, CLI clients, standard protocols and existing connected applications.

- Bulk/offline sources: publicly available archives, downloadable datasets, periodic exports, RSS/Atom feeds, sitemaps, published indexes, research repositories, open-data catalogs, file servers, and licensed commercial data products where authorized.

- Lightweight deterministic web access: ordinary HTTP requests, stable JSON/CSV/XML/HTML documents, public structured-data annotations and permitted paginated downloads, honoring server requirements and source terms.

- Browser automation: an authorized browser session for a real website whose interactive interface is the supported access method, with navigation, search, filtering, form entry, download handling and bounded workflows. Prefer reliable locators, explicit success checks and reusable routines to model-per-click operation.

- Model-assisted browser work: an LLM helps interpret an unfamiliar or changed interface, determine a workflow, recover from an unanticipated but permitted UI change, or propose a reusable automation. Convert stable recurring interaction patterns to tested scripts to reduce LLM cost.

- Human handoff at genuine access boundaries: if authentication, account owner consent, CAPTCHA or a site’s bot restrictions block automation, stop at the boundary and seek permitted access, an official export, a license, a partner integration or a specific human step. Do not treat bypassing defenses as a core capability or as an autonomous workaround.

This list illustrates a selection space, not a fixed priority hierarchy for all problems. Some data legitimately requires a paid license, an authorized account, or human involvement. Access methods must respect source terms, rate limits, privacy, licensing and the use permitted for the retrieved material.

### 21.3 Large information sources Brain can discover before building crawlers

The following are concrete examples, not an exclusive data catalog. A source must still be evaluated for scope, freshness, permitted use, data quality and whether it actually contributes to the goal. Official references were checked on 2026-11-09:

- Common Crawl (https://commoncrawl.org/get-started and https://index.commoncrawl.org/): a massive archive of publicly crawled web content with downloadable records and URL indexes. Useful for broad historical web structure and domain/page discovery; not evidence that a listed buyer currently needs a service, and not necessarily current.

- SEC EDGAR (https://www.sec.gov/search-filings/edgar-application-programming-interfaces): public company submissions and financial statements through keyless APIs, plus bulk ZIP archives refreshed nightly. Relevant for company activity, industry relationships and financial conditions; the SEC’s fair-access rules still apply.

- Data.gov (https://data.gov/developers/apis/): an extensive searchable catalog of government datasets and their source locations. Its CKAN API primarily gives metadata and links, not all underlying dataset contents; Brain must retrieve actual data from the listed data provider. Public data about markets and companies does not imply pursuing prohibited government contracts.

- GDELT (https://gdeltproject.org/data.html): downloadable structured records of global news events and knowledge-graph observations with frequent updates. Useful for event triggers and changing market conditions, not proof of transaction demand without corroboration.

- Wikidata (https://www.wikidata.org/wiki/Wikidata:Data_access): structured public entity and relationship data via query services and dumps. For very large processing, use bulk data where appropriate rather than overloading the public query endpoint.

Brain should also discover domain-specific sources: industry associations, trade catalogs, public rate sheets, permitted marketplaces, procurement and supplier directories, business filings, regulatory records, archives, commercial inventory feeds, transportation/economic datasets, and institutional or academic repositories. No industry, geography, or business model should be automatically privileged merely because one source was easy to connect.

### 21.4 Discovery-to-ingestion-to-usable-knowledge architecture

Use existing feed, sources, research, industry, evidence, entity, retrieval and quant systems rather than inventing a second data lake or second knowledge system without need. The required behaviors, independent of implementation details:

1. Discover the best source for a specific information need. Search registries and existing source inventories; establish the kind of fact needed, freshness, data rights, cost and likely coverage. A million generic pages can be worth less than one reliable buyer-request feed.

2. Resolve how to access the real content. A catalog listing is not the underlying dataset. Determine format, endpoints, bulk export links, update mechanism, authentication and usage constraints. Prefer conditional fetches or event subscriptions over wasteful continuous polling when available.

3. Ingest at scale through code. Implement checkpointed, resumable transfers, incremental updates, deduplication, content hashes and sensible provider-specific pacing. Very large corpora should be filtered in place, queried by index, or processed in shards instead of indiscriminately copied into the application server.

4. Parse and normalize automatically. Use existing format-specific parsers, schemas, tables and deterministic extraction for familiar data. Handle structured records, web text, PDFs, archives and downloads where supported. Model reasoning is reserved for ambiguity, novel formats and consequential interpretation; do not pay for an LLM judgment on every byte or document.

5. Attach provenance at fine granularity. Retain original location, publication time, retrieval time, version, format, applicable license/permissions, extraction code/model version, evidence spans, entities and units. Separate raw observed information, derived relationships, model estimates, counterfactual designs and verified commercial facts.

6. Build and update relationships. Normalize entities without improperly merging different companies, detect events, changes, potential buyer–supplier fits, published prices, capacity, geographic compatibility and business mechanisms; propagate affected facts into the existing open-ended economic blueprints and goal models.

7. Rank useful research over raw volume. Prioritize marginal decision value: relevant evidence that resolves a goal-critical unknown, creates a transaction path, detects a true change or improves a reusable method. Record the share of acquired data that yields accepted information and commercially usable opportunities.

8. Maintain connectors automatically. Detect schema changes, dead endpoints, access refusal, update failures, drift, contradictions and stale records. Distinguish a transient provider outage from a broken parser and from a revoked permission. Route a repeatable repair to Factory or another existing owner and reverify, rather than merely reporting that a source failed.

### 21.5 Browser routines as reusable capabilities

For a repetitive no-API website workflow, Brain should be able to: inspect the allowed interface, identify the legitimate input and output, authenticate using a secure and authorized account, perform a bounded read-only or already-approved action, download or extract the resulting information, and verify that the intended state or dataset was actually obtained. It should distinguish idempotent reads from mutations and detect destructive/externally consequential actions before submitting them.

The first successful workflow can become a versioned connector owned by existing integration infrastructure, with robust selectors, expected page states, timeouts, retry policies, screenshots/logs that do not leak secrets, test fixtures, freshness checks, failure reasons and a maintenance owner. Authentication/session material must be encrypted, protected from repository commits and appropriately reauthorized when it expires. Multiple workers must not accidentally perform the same mutation or violate the website’s request limits.

AI-assisted navigation and normal deterministic execution are complementary: the model may discover how to interact with a new interface once; software may then run that approved workflow thousands of times if the site’s access rules and resources permit. When an interface changes in a way that affects correctness, move to a validation/review state rather than guessing through purchase or publication controls.

### 21.6 Separate autonomous research from externally consequential agency

A read-only mechanism for learning from a website does not authorize using that website to sign a deal, contact buyers, submit a binding bid, initiate payments, scrape protected information or create third-party accounts. The user wants autonomy where it can safely be delegated, with no repetitive handholding, while preserving legitimate permissions and an inspection trail. Use the existing scopes and grants. Routine allowed research should continue even when a particular login or payment operation needs the owner.

### 21.7 Resource-aware scale and measurement

Measure total source records visited, new unique useful documents, refreshed records, raw bytes, parser coverage, structured facts, accepted evidence, code-derived matches, verified buyer/price/fulfillment links, number of usable transaction paths, time-to-goal impact, AI jobs avoided, AI escalations, cost per useful finding, failure/recovery, provider saturation and resulting revenue where available. Allocate work dynamically between active goal demands, open-world exploration, capability building and future planning; don’t require the owner to assign a quota to every category.

Scaling the application server is not equivalent to scaling the research fleet. Evaluate whether independent ingestion workers, bulk processing, object storage, databases/indexes, browser workers, LLM workers or GPU capacity are the constrained resource. Increase only the components whose measured output can improve. A provider outage or failed authorization cannot be repaired by buying more CPU. Match processing placement and data egress costs to the source (for example, filter huge archives in-place when supported).

### 21.8 Production acceptance demonstrations

The future architecture implementation must prove the following against the actual integrated systems, not merely produce a diagram or a list of sites:

1. Source discovery: Given a new economic research question, Brain independently locates a useful existing dataset or feed absent from its current configured source list, identifies whether its catalog contains metadata or actual records, and acquires suitable permitted data.

2. Scale without LLM-per-record: A batch of at least thousands of records is ingested, deduplicated, parsed and indexed with bounded resource consumption; only genuinely uncertain or valuable subsets are escalated to AI. Compare useful accepted output and cost against the previous pipeline.

3. Cross-source construction: Records from multiple sources contribute to a novel, traceable transaction hypothesis whose financial inputs, dependencies and uncertainty enter the existing quant/goal engine; merely increasing document counts is insufficient.

4. No-API site: Through a suitable permitted website and authorized session, Brain completes a real workflow, verifies the result, and later repeats it with a reusable automation and less model work. Show a failure/permission handoff when access legitimately cannot proceed.

5. Automatic repair: A changed source format or interface is detected, a narrowly scoped fix is developed through an existing owner, the connector is validated, and processing resumes without requiring the owner to invent or supervise the repair prompt.

6. Proven autonomy: Brain identifies that a missing integration or dataset is limiting a live objective, independently evaluates acquisition methods, obtains what it can within existing grants, and connects the new capability to the relevant production goal.

7. Safe external boundary: Unauthorized mutations, message sends, spending and anti-bot/access restrictions are not crossed; authorized read-only research remains productive. Credentials never appear in generated reports or code.

8. Economic yield: The new acquisition path produces measurable goal-relevant information (for example an accepted buyer-price pair, a usable supplier, a supported market-volume variable, or a materially improved transaction model), not only an impressive number of downloaded documents.

Change log — v1.0 (2026-11-09): Added Section 20 (autonomous acquisition, development and improvement of capabilities without routine owner prompting, within existing permissions) and Section 21 (open-ended API/bulk/web/browser access, public corpora, scalable ingestion, reusable browser workflows, provenance and end-to-end production evidence). These are new requirements in the working architecture, not claims that Brain has already implemented them.

## 22. Added 2026-11-09 — Capabilities prepared in advance, priorities promoted by actual dependencies

Owner’s design intent. Some capabilities are worth specifying and preparing long before they are the best use of today’s engineering capacity. The no-API browser/website operator is an example: it need not be built now merely because it is imaginable. But if Brain discovers that a high-value present objective genuinely depends on a website with no suitable existing connector, that once-deferred capability may become the next highest-priority task. Priority cannot be a fixed list of modules, industries or dates; it must respond to the work required to accomplish the active goals.

### 22.1 Readiness is separate from implementation urgency

For each proposed capability, retain its intended behavior, interfaces, prerequisites, candidate implementation approaches, validation criteria and known reusable components. Allow states equivalent to specified / prepositioned / needed now / building / verified / suspended, using existing project terminology rather than creating duplicate statuses. A capability can remain specified and ready for later action without continuously consuming premium AI jobs, a worker slot or an unfinished production deployment.

The decision to promote it should follow a concrete dependency, such as:

- several valuable transactions are blocked by the same missing access method, supplier operation, research source, payment path or product capability;

- a higher-value strategy becomes feasible after cash, rights, relationships, personnel or capital change;

- an existing workaround consumes more time or money than developing a reusable capability would;

- multiple planned businesses would benefit from the same new capability;

- a source, partner, market, regulation or interface changes so that the old implementation no longer works;

- downstream dependencies make early development critical despite no immediate transaction being blocked yet.

The scheduler must compare expected value, urgency, reuse, cost, uncertainty, opportunity cost, prerequisites and available parallel workers. It should prioritize the specific blocker and its necessary dependencies, not blindly promote an entire large program. It must also demote work whose need disappears. This is not permission to silently remove long-term requirements from the master specification.

### 22.2 Prepositioned options and proactive construction

Brain may investigate whether a dormant capability is feasible, identify the simplest existing provider or open-source tool, and preserve a tested interface sketch or source inventory when doing so is cheap and useful. Do not treat preparation as evidence of a production integration. Do not build a costly browser automation system simply to keep an option warm. When the benefit becomes material, Brain can hand an exact requirement to the existing Factory and verify its effect on the originating goal. If external credentials, contracts, spending or permissions are needed, prepare all internally authorized work without crossing those gates.

Production acceptance: A deferred no-API integration remains recorded without consuming regular scarce workers. A real commercial or research objective later requires it; the system identifies that dependency, compares permitted alternative access methods, reprioritizes the minimum missing capability, implements/reuses a suitable mechanism, and demonstrates that the original goal’s blocked work actually resumes. No manual owner instruction of the form “now remember that old feature” is necessary.

## 23. Added 2026-11-09 — Repeatable goal production as evidence of an operating capability

The owner initially proposed the $10K goal partly as proof of Brain’s competence. One apparent plan succeeding once is insufficient proof of a general ability to turn goals into money. The stronger desired demonstration is to reconstruct the same financial outcome through numerous materially different, viable paths—illustratively ten different plans capable of reaching the same $10K objective. The amount and the count are examples of a desired reproducibility and breadth test, not universal constants that should be coded into every goal.

This calls for several distinct measures:

1. Discovery breadth: Can Brain originate different economic mechanisms, buyer channels, fulfillment structures, risk exposures and revenue streams instead of generating ten cosmetic variants of one agency offer?

2. Independent plan viability: For each candidate, can it establish an actual acquisition and fulfillment route, costs, capital, timing, controls and defensible evidence that the plan could meet the specified goal? Each candidate must satisfy the goal’s configured acceptance condition, or be marked provisional; a comparison of ten plans does not automatically make ten of them qualified.

3. Operational repeatability: Can the relevant mechanisms perform again under realistic changes in customers, sources, channels, suppliers, budgets and market conditions? A historical success does not prove an unchanged future conversion rate.

4. Portfolio resilience: Which plans genuinely provide alternatives after a common channel or supplier fails, versus sharing risks and counting the same customers or cash twice?

5. Real execution: Distinguish ten plausible researched plans from ten authorized and executed attempts; distinguish observed collections from modeled scenarios. Brain may generate and verify alternatives without spending ten times the money or contacting ten sets of buyers without authorization.

The demonstration should test whether Brain can reconstruct successful methods, not merely reproduce a written plan. Capture why each arrangement works, which mechanisms transfer, when they stop transferring, and what changes would reproduce its economics. A failed candidate contributes useful causal evidence and reusable components when recorded precisely.

Production acceptance: On a user-selected sample goal, Brain independently creates a meaningfully diversified set of candidate plans; each has a complete, traceable model and clear acceptance status. At least one plan reaches practical authorized execution when commercial access exists, and the system shows how it can rebuild alternatives after an important change. It must prove distinctness rather than inflate the count with paraphrases. Its published confidence must be supported by calibration or explicitly withheld.

## 24. Added 2026-11-09 — General enterprise formation, product creation, and competitive strategy

Owner’s future capability requirement, currently lower-priority unless made necessary by another goal: Brain must eventually be capable of receiving an open-ended objective such as “build a company that competes with Xbox,” “compete with Magic: The Gathering,” “make televisions,” or “manufacture cars,” and constructing a complete credible route from the owner’s resources to an operating business. These names are illustrations of very different market and product challenges, not sectors to favor or competitors it must literally imitate. Brain should also discover that a direct competitor, niche wedge, complementary product, distribution business, licensing structure, component supplier, technology provider, or different market position may be economically superior—and say why.

### 24.1 Reconstruct the actual competitive system

For an unfamiliar industry or proposed product, determine from evidence what the system entails, with no fixed ten-box blueprint: customer segments, buyer motivations and switching costs; competing products and substitute solutions; performance and quality requirements; design and engineering; intellectual property and rights; sourcing, components and materials; manufacturing/production options; procurement and supplier

reliability; distribution and marketing; after-sales/service operations; regulation, standards and liability; financial and capital requirements; sales cycles, cash conversion and working capital; and any other mechanisms that turn out to be causal in that market. The number and type of mechanisms must emerge from the problem.

Brain should identify how industry participants actually earn profits, which resources or assets matter for competitive advantage, which activities can be rented, contracted, licensed or partnered for, and which capabilities must be owned or developed. It should reason about the difference between creating a product, making a company capable of selling that product, and winning a durable position in its market.

### 24.2 Construct a venture, not merely write a business plan

Derive a connected, revisable path through market research, positioning, product specification, technical feasibility, unit economics, prototype/validation, sourcing and contracting, production, pricing, channel establishment, service and quality systems, launch, financing and scale. Some may occur in parallel, and the order must follow the real dependencies. Each output should identify an actual decision, resource, artifact, responsible actor, budget, evidence and completion condition. Brain must challenge impossible combinations and build materially different feasible alternatives when the original strategy is economically weak.

As Brain’s capital and capabilities evolve, it should revisit earlier ventures automatically: a product that was uneconomic with $10K, no suppliers and no distribution may become viable after a successful commercial operation creates capital, demand access or manufacturing partners. This must use the same evolving knowledge/possibility store and goal system, not a stand-alone “startup ideas” chatbot.

### 24.3 Workforce and organization formation (later-stage capability)

Eventually Brain should identify organizational roles that an expanding operation cannot fulfill through AI or already available contractors: engineering, creative, production, commercial, operations, finance, compliance, supply-chain and management functions as demanded by the actual venture. It should derive roles from responsibilities and bottlenecks rather than imitate a generic corporate org chart.

When suitable, it should prepare role specifications, cost models, sourcing routes, recruitment processes, evaluation criteria, onboarding, task allocation, accountability and operational management. It may coordinate approved external contractors now; hiring employees, making binding offers, sharing sensitive candidate data, engaging paid recruiters or signing agreements require the applicable authorization and lawful processes. Hiring automation must be assessed for job-specific quality and fairness, rather than treating LLM fluency as proof that it can independently select reliable employees.

This future capability should remain specified and ready for promotion, not consume current cash-goal capacity unless an active objective truly depends on it. It may use existing Factory, browser, research, industry, labor, project and financial subsystems instead of inventing separate owners.

### 24.4 Acceptance demonstrations

- Give Brain a new goal in an unfamiliar manufacturing, consumer product or entertainment industry. It constructs a sourced industry mechanism map and distinct potential competitive positions without receiving a business template from the owner.

- It builds an operationally and financially traceable product/company pathway, shows realistic make/buy/partner alternatives, and identifies the first economically defensible entry point rather than assuming it must immediately replicate an incumbent’s entire company.

- A changed budget, buyer channel, intellectual-property constraint or supplier capability causes an intelligible revision of the dependent design, cost and deployment path.

- The system can specify the required people, contractor capabilities, organizational controls and future recruitment pipeline without treating unapproved recruitment as authorized.

- The complete venture remains in the possibility store and is reconsidered when its conditions change. It can be promoted to a real implementation program by goal priority rather than owner repetition.

## 25. Added 2026-11-09 — Increase useful knowledge velocity, not merely downloaded bytes

Owner’s near-term priority: Brain must acquire, integrate and actually understand much more relevant information much faster, because more well-grounded variables, better economic relationships and fresher market activity allow faster commercial decisions and wider business construction. This must not collapse into indiscriminate bulk scraping, raw storage growth, an uncited summary flood, or weak understanding that only appears detailed.

Section 21 specifies the available classes of sources and the ingestion architecture. This section adds the time-to-usable-knowledge performance objective: for any decision-relevant unknown, how quickly can Brain acquire reliable material, extract and reconcile its meaning, connect it to an economic mechanism, and use it in an actual decision?

### 25.1 An expandable ingestion and understanding pipeline

Brain should dynamically choose methods appropriate to a source and a question. Possible stages include source indexing, query planning, permitted feed/API/bulk retrieval, resumable change-data capture, parsing and normalization, entity identification, event detection, economic relationship extraction, contradiction and freshness checks, evidence attachment, mathematical reconstruction, and goal/venture updates. This is an adaptable processing graph, not a mandatory linear sequence or a fixed recipe for every dataset. Code handles repeatable transformations; LLM reasoning is applied where ambiguity, novelty, source interpretation or consequential decisions justify it.

- Get data cheaply and early: Prefer authoritative structured sources, existing open datasets and bulk/stream feeds, with incremental updates, parallel retrieval within permitted limits, checkpointing and failure recovery. Source discovery can itself be an autonomous research task. Large downloadable collections are useful when the needed signal can actually be extracted efficiently.

- Avoid recreating old understanding: Version source records, use content fingerprints and delta processing, and preserve established entity mappings and tested parsing methods. A changed record should trigger recomputation of affected facts and dependent models, not a whole-database rewrite.

- Make data decision-ready: Store normalized facts with original source, exact evidence span or record, observation date, jurisdiction/scope, units, parser/model version, confidence basis and contradiction status. Distinguish provider’s advertised price from a buyer’s actual paid price, available market size from reachable leads, and published capacity from contractually available fulfillment.

- Cross-source reasoning: Link the same entities, locations, products, time periods and dependencies across permitted feeds. Resolve identity collisions before matching; different entities with similar names must not be fused. Transform a new link into goal-relevant variables and transaction hypotheses when it improves the current decision.

- Selective deepening: Cheap algorithms may discover a million candidate relationships; they should promote only high-value, uncertain or nonroutine questions to LLMs or costly verification. The decision threshold should depend on the economic value of information and available capacity, not a permanent global keyword whitelist.

- No false speed: If fast imports produce stale, duplicated, contradictory or unverified information, they have not increased Brain’s usable intelligence. Maintain an explicit difference between raw intake, successfully parsed records, normalized facts, evidence accepted, economic relationships updated and goal-impacting decisions.

### 25.2 Measure and remove the limiting stage

For each domain, ingestion route and time window, Brain should quantify: newly discovered relevant sources; records/documents considered and newly fetched; bytes and transfer time; processed and deduplicated records; accepted facts and confidence/evidence quality; distinct economic relationships and corrected contradictions; variables resolved; commercial candidates improved; time from published source

change to updated economic blueprint and goal plan; compute/API/storage cost; and queue depth, worker utilization, retries and backpressure per stage.

Capacity decisions should come from those measurements. If network/source access is limiting, improve access or source selection. If parsing is limiting, add efficient code workers. If entity reconciliation or verification is limiting, give those stages more worker/model capacity. If the database or application CPU is limiting, consider isolated processing and measured infrastructure expansion. If the bottleneck is weak commercial relevance, change questions, not server size. The resource allocator must compare the marginal gain from another LLM job with the gain from another non-LLM algorithm, worker, source connector or improved indexing strategy.

Immediate operational principle: Before substantially increasing hardware spend, inspect the latest healthy live measurements and remove a known reversible blockage such as an unavailable model or failing audit handoff. Then measure whether the added capacity actually increases accepted and commercially useful output. Independent ingestion workers and optimized bulk processing should be available as scaling options, rather than forcing every job through the same application request loop.

### 25.3 Production acceptance demonstrations

1. Source to understanding: From a previously unintegrated but relevant public dataset, acquire thousands of distinct records through an allowed route, normalize them, attach traceable evidence, and update at least one economic decision model. Measure time and resource use; don’t require an LLM call for each record.

2. Incremental refresh: When a subset changes, update only the affected objects and derived relationships; demonstrate meaningful work saved and correct downstream recomputation.

3. Cross-source value: Independently combine information from different sources to resolve a material buyer, supplier, price, capacity, demand or timing unknown. Verify the information’s meaning and show the resulting change in a commercial pathway or venture design.

4. Quality guard: Present contradictory, stale or misleading source records; Brain identifies what remains unknown and refuses to create a false precise financial input despite high intake volume.

5. Throughput improvement: Establish before/after rates for source-to-accepted-fact and source-to-goal-relevant-decision, identify the actual limiting stage, implement a focused change, and verify the new effective rate under real production work.

6. Capacity aware: When the bottleneck shifts from fetching to verification or database contention, Brain recognizes the shift and changes resource allocation without indiscriminately expanding every service.

7. Owner visibility: The website and conversation interface can answer not only “how many documents arrived?” but also “what did Brain learn, how certain is it, what business decisions changed, and what capacity is still being wasted?”

Change log — v1.1 (2026-11-09): Added §22 on dynamic promotion of prepared capabilities, §23 on reproducible goal completion across distinct plans, §24 on general venture/company creation and eventual workforce formation, and §25 on accelerating reliable research intake to usable, decision-changing knowledge. Examples such as Xbox, Magic, cars, televisions, $10K and ten independent plans are illustrative, not hard-coded constraints. These are architecture requirements, not claims of current production implementation.

## 26. Added 2026-11-09 — Minimum necessary AI, maximum reusable computation: the mechanism-compiler architecture

Owner’s mechanism: The expensive, scarce reasoning resource should establish the smallest sufficient amount of structure that preserves the important information, after which inexpensive and widely repeatable algorithms can elaborate, combine, test and operate that structure at scale. The image of a skeleton being formed and then built upon is a metaphor for layered construction, not a mandate that every domain must use a skeleton-shaped graph, a fixed ten-part template, or a particular order of reasoning.

### 26.1 Optimize useful work per scarce reasoning resource

The objective is to maximize verified, decision-changing and economically useful work per unit of scarce reasoning capacity. Treat LLM calls, model quality, context, latency, available local computing, retrieval, memory, software execution, and verification as different resources with measurable constraints. Standard code is generally cheaper per repeated operation, but is not literally costless.

Neither “send every record to AI” nor “always use AI first” is a universal design rule. The system should use the cheapest adequate method for each subproblem. In familiar cases, deterministic software may produce the initial structure itself; in unfamiliar or ambiguous cases, a strong reasoning model may need to derive it. At other times, a small model, a parser, an existing verified algorithm, or a batch computation is the right tool. Model use must rise when doing without it would lose material information, produce unsound inferences, or prevent the system from recognizing a novel opportunity.

### 26.2 A reusable, evidence-preserving intermediate representation

When AI does foundational reasoning, it should create a reusable mechanism representation rather than merely summarizing a market. Its actual form should be discovered or adapted to the problem. Where appropriate it expresses:

- relevant actors and roles, capabilities, assets, needs, rights, constraints, transactions, states and state changes;

- causal, temporal, contractual, financial, geographic and other relationships among components;

- equations and calculations, including which inputs are observed, estimated, latent or unknown;

- conditions under which a relationship or rule is valid, the exceptions that invalidate it, and the question that would distinguish the cases;

- transformations and candidate construction operators, with downstream implications;

- the source records and evidence spans from which individual claims arise, confidence/calibration basis, freshness, and provenance;

- verification and invariants that inexpensive processing must continue to satisfy.

Use this as an intermediate representation or executable knowledge scaffold, not as a fixed schema that silently truncates what a business requires. Preserve reversible access to original observations; compression of a reasoning representation must never delete material evidence or distinctions. A rule that is not grounded in evidence remains a proposed hypothesis, even if it is computationally convenient.

### 26.3 Grow the structure through algorithms

After a representation or method is established, reusable code should perform as much repeatable work as it can safely perform: ingesting and normalizing records, entity reconciliation, change detection, rule evaluation, relationship joining, matching buyers and suppliers, constructing candidate variants, propagating constraints, recalculating economics, enumerating combinations, optimizing allocations, estimating uncertainty, and triggering updates to affected decisions.

For example, in a market where one supplier can serve many buyers, a costly reasoning pass may identify the meaningful compatibility rules, payment and fulfillment relationships, and available commercial positions. Ordinary software can then examine large volumes of actual records against those rules, generate and calculate candidate matches, and flag new cases that violate the learned model. The software’s scale creates more evaluated possibilities, not automatically more true market facts: every claim of buyer demand, supplier capacity, price, or fulfillment must still have sufficient evidence.

Keep the computation open to iterative transformation. Applying one rule may change the inputs of another, generate a new economic role, expose a contradiction, or reveal a high-value unknown. The resulting system may be a graph, constraint program, optimizer, state machine, database query plan, simulation, or a combination. Brain must select representations based on the mechanism.

### 26.4 Convert expensive discoveries into durable methods

A model can propose a reusable procedure, extraction method, matcher, transformation operator, or calculation. Repeated successful reasoning should trigger a method-compilation opportunity: estimate how many future calls the proposed rule would replace and what failure risk it introduces.

Use the existing Factory and capability improvement systems, where suitable, to turn the method into versioned code with source-specific tests, shadow evaluation against held evidence, quantified precision/recall or calibration where applicable, and a rollback path. The method becomes available to other compatible problems after validation. Do not create a new Factory or silently promote unreviewed model-authored code.

Methods need maintenance. A new source format, market regime, contradiction, or unusual candidate may invalidate a compiled rule. Route those exceptions to the appropriate reasoning method, update the rule when justified, and re-evaluate only dependent results. A successful algorithm should reduce repeated AI work without rendering the system blind to novelty.

### 26.5 Capacity compounding and orchestration

The resource allocator should choose across existing deterministic processing, bulk computation, smaller models, strong models, retrieval, and human authorization as relevant. Select by marginal value of information or action relative to cost, latency, accuracy, throughput and downstream consequence.

Track how a scarce reasoning job produces durable reusable outputs: an improved extraction procedure, validated business mechanism, a better search question, source connector, compatibility rule, optimization method, or an executable business capability. Estimate the reuse count and actual subsequent saving. Spend reasoning capacity on new problems and quality-critical exceptions when compiled methods reliably handle routine instances.

The owner’s “ten apples become twenty” analogy describes multiplying total useful output through complementary computation. Do not assert a particular multiplier in advance: measure the before-and-after increase in verified economic knowledge and resulting decisions, and the change in LLM calls and cost per useful result. Optimize the whole pipeline; moving a bottleneck from AI to database, parsing, verification or browser access does not count as an end-to-end capacity gain.

### 26.6 Integration with existing Brain components

Build on the existing feed collectors and code-first detectors (feeds), research evidence gate, industry/economic mechanisms, quant/scenario models, goals/pathways, source acquisition infrastructure, Factory and self-improvement loop. Determine what is already implemented and proven before adding code. Use one authoritative representation where possible, with explicit transformations where interfaces differ. Unfamiliar economic sectors and unforeseen relationships must remain discoverable; examples in this document must not become a permanent whitelist.

The output should update Brain’s operating understanding, not just generate a larger report: new verified variables and relationships should influence candidate creation, deal structure, economic modeling, research priority, execution preparedness and future capability requirements.

### 26.7 Production acceptance demonstrations

1. One reasoning pass, many observations. Establish a real market mechanism or extraction/matching method with selective AI assistance, then process thousands of distinct relevant observations using reusable software. Measure per-record model calls and all end-to-end costs and delays before and after.

2. Preservation of meaning. Show that the representation retains the critical distinctions, dependencies, original citations and exceptions needed to reconstruct an economically material decision. Introduce a counterexample that an overcompressed representation would misclassify.

3. Novelty routing. Present a genuinely unfamiliar, inconsistent or changed market pattern. Existing rules must identify the limit of their authority and request new reasoning rather than invent a plausible classification; a tested improvement can then be reused on later records.

4. Iterative economic construction. Demonstrate several generations of recombination and constraint propagation on real sourced market components, with changed evidence automatically updating the affected economics.

5. Method compilation and maintenance. Propose one useful repetitive method, validate and deploy it through existing ownership and Factory, prove a real reduction in model calls at equal or better verified quality, and show failure detection plus a permitted update path.

6. Decision-level payoff. Show that increased computational throughput yields more accepted commercial facts, decision-relevant variables, viable candidate transactions or faster justified decisions. Raw documents, cheap classifications and new hypothetical ideas alone do not satisfy this test.

7. Dynamic allocation. Under a constrained model budget and changing workload, show that Brain shifts routine work toward reliable algorithms while preserving model capacity for novelty and consequential decisions; measure actual total output and whether another bottleneck took over.

Implementation priority: This mechanism is a general-purpose multiplier on the current revenue research, commercial construction, Factory learning and future venture design. Promote the smallest high-yield portions early when production evidence shows they improve commercial output. Preserve the full capability in the master program even when a particular component is not immediately urgent.

Change log — v1.2 (2026-11-09): Added §26 on AI-as-scarce-reasoning, evidence-preserving mechanism representations, deterministic expansion, method compilation, adaptive routing, resource compounding and production acceptance. The owner’s skeleton/growth illustration remains a metaphor, not a hardcoded framework.

## 27. Added 2026-11-09 — Living dragon kingdom, operational truth, and interchangeable worlds

Owner-selected starting direction: Brain’s primary interface should be visually delightful and usable as a light dragon-themed management simulator, with a central dragon presence and a living kingdom representing real operations. The owner also requires precise operational numbers, meaningful status, controls, and deep inspection. This is a dual experience with shared underlying truth, not a decorative game instead of a usable business system. Dragon kingdom is the desired first world; future industrial, futuristic, space or other themes should be installable without rewriting Brain’s core or changing the meaning of its data.

### 27.1 Product outcome and the two representations

The owner should be able to open Brain and immediately understand (a) what it has accomplished, (b) what it is doing now, (c) what is changing financially and operationally, (d) which decisions it is making and why, and (e) what genuinely needs attention. A visually alive environment must coexist with first-class, accurate tables, charts, ledgers, timelines, sources, and action controls.

Invariant: spectacle sits on top of truth. Never imply that a worker is actively executing when the real job is queued, blocked, idle, errored or unverified. Never depict simulated cash as received cash, an offer as a sale, a deal estimate as a contract, or a model scenario as measured success probability. Make timestamps, provenance, stale data and missing values accessible. Animation may symbolize operations but its state mapping must be accurate.

The user can explore the world for pleasure without losing access to precise operating information. Conversely, the numbers-first interface should stand on its own without requiring an animation to be understood.

### 27.2 Interactive world and shared telemetry

Treat the visual world as a renderer of authoritative events and states served by existing Brain APIs, not as a second database or business logic engine. Provide a typed, versioned adapter between real entities (goals, work units, workers, research jobs, campaigns, opportunities, suppliers, financial records, permissions and infrastructure) and presentation objects (characters, districts, buildings, queues, signals and scenes). One real fact can have many themed representations; the data meaning remains invariant.

The initial dragon mapping is an art direction, not a fixed architecture:

- Central dragon / citadel — Brain as the coordinating intelligence and conversational control point.

- Arcane libraries and observatories — research acquisition, reasoning, evidence and knowledge.

- Smithies and enchanted forges — Factory campaigns, code-writing workers, integration, deployment and repair.

- Merchant quarters and markets — commercial discovery, offer preparation, sales, supply and fulfillment.

- Treasury — cash received, due, spent, reserved, invested and transferred, each separately represented.

- Roads, caravans, couriers and portals — work moving through actual dependency and execution chains.

- Laboratories or other context-appropriate environments — economic modeling, simulations, uncertainty and scenario decisions.

Themes must not force unfamiliar, new or cross-cutting Brain capabilities into the wrong district. Scene composition should be data-driven and extendable; systems may occupy several representations or none if that is clearer.

Agent characters may have personalities and decorative behavior, but their work-state representation follows real job evidence: working, waiting, blocked, requiring approval, succeeded, failed, idle, or unknown. A current worker count refers to actual running workers, not ornamental characters. Clicking a place or character resolves to the correct Brain record and shows ownership, inputs, output, source data, started/last-changed times, queues, blocker, economic consequence and next available action.

### 27.3 Three complementary modes, one authoritative data model

1. World mode: game-style spatial navigation; zoom, pan, click agents and districts, inspect genuine activity, receive ambient visual cues, and open precise details without leaving the world.

2. Operations mode: high-density, readable factual interface for transactions, goals, research throughput, worker utilization, failures, cash movements, portfolio decisions, approvals, and performance trends. Sort, filter, compare, export if authorized, and trace each number to its source.

3. Goal mode: focus on a chosen objective, its candidate and accepted plans, execution chains, uncertainty, costs, revenue, acquisition methods, dependencies, alternatives, actions, and feedback from real outcomes.

These are interface lenses, not separate products or data stores. Allow fluid movement between them. A selected entity, timeframe, goal and active context should remain coherent across modes. The existing conversation/mouthpiece should be accessible from all modes, grounded in the selected real object, and use the existing permission-aware action route rather than making undocumented changes.

### 27.4 Fun that carries operational meaning

The world should feel alive and reward exploration. Allow original animated characters, a central dragon, evolving architecture, light environmental events, camera movement, optional ambient audio, custom districts, and gradually expanding spaces as real capabilities come online. The owner can enjoy the experience even when no immediate action is needed.

Tie important events to verifiable records: a deployed Factory capability may animate a forge completion; a genuine paid sale may animate treasury activity; a queue saturation event can show congestion; blocked

work can show an interrupted station. Decorative ambient animation can continue, but it must be visibly distinguishable from factual activity. A lively city must not obscure a stopped research system.

Support owner customization, including potentially a future world editor, visual packages and different genres. A theme package supplies assets, mappings, layouts, animation rules and styles but cannot alter transactions, financial facts, permissions, or goal decisions. Themes may be swapped without data migrations or rebuilding operational screens.

### 27.5 Practical implementation, not repeated CSS prompts

Reuse the existing React/Vite application and authoritative Brain routes. Evaluate supported rendering engines for a performant interactive 2D/isometric experience, with paths to richer graphics if later justified. Use compatible component libraries for standard controls, accessible dialogs, tables, navigational components and charts. Investigate quality examples, licensed art packs, and custom original visual design; don’t assume one GitHub template supplies both unique game art and enterprise-grade operating controls.

Start with several visually distinct rendered and clickable proof-of-concepts of the primary experience before spending Factory capacity on every page. Use genuine or clearly marked sample state and compare desktop/mobile behavior. Select art direction with the owner, establish reusable tokens, components, scene contracts, responsiveness, and interaction conventions, then propagate across the entire site using coordinated Factory units. Do not tear out working backend services or force a full framework rewrite merely to adopt a renderer.

Provide graceful behavior when animations are disabled, WebGL is unavailable, bandwidth is limited, or a user prefers reduced motion. Optimize for useful performance on mobile and a clear numbers-first fallback. Accessibility includes keyboard access to critical controls, readable contrast, screen-reader paths to the same facts, and no dependence on interpreting color or motion alone. Avoid running heavyweight continuous animation that starves Brain’s actual research or backend execution.

### 27.6 Detailed truth contract for the visible numbers

At all times the relevant scope should clearly distinguish: actual cash collected, signed but unsettled obligations, invoice status, projected revenue, operating profit, available capital, capital tied up, outstanding liabilities, confirmed and estimated buyers, actual and modeled conversion, work in flight, research claims accepted versus merely generated, execution failures, and last data refresh. Time range, units, entity ownership, source reference, and confidence/unknown status must be inspectable.

Visualized business morphing, economic mechanism blueprints, goal progression, dependencies and source evidence should be navigable and anchored to the same underlying records as the tables and quant model. If the world shows a new opportunity, the detailed view must answer where it came from, what is known, what is inferred, what remains unproven and what can happen next.

### 27.7 Production acceptance demonstrations

1. Render the functioning dragon-kingdom management world connected to actual live Brain activity; demonstrate correct transitions for running, blocked, failed, queued, completed, and unknown statuses.

2. Select an animated worker and trace through to the exact active task, source evidence, log/history and actionable next step. Compare on-screen state with production backend rows.

3. Show accurate live financial and goal metrics in a readable operations interface, including explicit separation of received cash, provisional scenario numbers and pending invoices; demonstrate no false success animation.

4. Maintain one selection and goal context while navigating World, Ops and Goal modes; preserve ability to converse with Brain and follow links to real records.

5. Switch between at least two materially different visual packages while preserving identical live data, navigation semantics, permissions and business calculations. The dragon world is the initial creative target; the second world is a proof of interchangeability, not an owner-selected permanent theme.

6. Demonstrate usable desktop and mobile experiences, keyboard-only access to critical operations, reduced-motion behavior, performance under many concurrent visual entities, and an accessible no-animation fallback.

7. Show before-and-after real screenshots and a completed user journey demonstrating that the interface improves operational comprehension, not merely visual appeal; measure response/performance costs and verify the scene never alters production data incorrectly.

Priority: High product and owner-engagement value; begin visual concept work when it does not block immediate commercial work, and promote data-contract or navigability improvements when they directly improve operating decisions. Full world production should follow selection of a visual prototype, not precede it.

Change note: This section records the owner’s explicit preference for the dragon kingdom together with a management-simulator interface and hard factual numbers. It supersedes any implication that the interface must be strictly a robot factory or strictly a conventional dashboard.

## 28. Added 2026-11-09 — Cross-cutting architecture gap register (candidate requirements, not approved final designs)

This is an audit of areas not yet addressed with sufficient operational specificity, even though parts are mentioned elsewhere. They are proposed subjects for further design and proof, not claims that present production lacks every related capability. Before implementing, Factory must locate the actual existing owner and measure the first unmet behavior. Avoid reducing the architecture to only these categories.

### 28.1 End-to-end customer and contract fulfillment

The architecture covers constructing an offer and collecting cash but has not yet specified a sufficiently complete post-sale lifecycle: quotes, negotiated scope, acceptance terms, contracts, delivery schedules, handoffs, contractor assignment, proof of work, customer acceptance, change orders, revisions, refunds/chargebacks, disputes, warranties and ongoing service. It needs to understand when the seller’s obligations are complete and the real contribution of the transaction, not just whether payment was requested. Proposed proof: trace a legitimate customer request through an authorized fulfilled order, accepted deliverables, settlement, actual costs, and exception recovery, with no omitted liabilities.

### 28.2 Companies and institutional formation

We have covered the objective of starting companies, but not the full lifecycle of legal entities, governance, ownership, accounting, banking, contracts, insurance, tax obligations, licensing, intellectual property rights, regulated activities, acquisition/divestiture, intercompany transfers and jurisdiction choices. This should be decided for the particular enterprise and role, not hardcoded universally. Brain should know when a professional, licensing relationship, owner approval or organizational change is required. Proposed proof: one realistic new venture plan with an actual stepwise institutional formation and operating model, clearly identifying what is executable and what remains to be authorized.

### 28.3 Counterparty, supplier and workforce reliability

The existing design includes contractors and later hiring but under-specifies how Brain verifies counterparties, negotiates and tracks terms, maintains backups, handles unavailable personnel, assesses service quality, pays suppliers, manages performance, and resolves broken commitments. This matters directly to asset-light businesses. Proposed proof: a contractor-delivered transaction with named verified capacity, a backup supplier, agreed economics, and a defined recovery route for nonperformance.

### 28.4 Operating memory and decision continuity

Brain needs a robust way to retain why an important decision was made, under which evidence and assumptions, which alternatives were considered, what was learned, when the decision should be revisited, and what changed since. The existing mechanism/evidence store and project memory should be reused, but a large autonomous organization also needs long-lived, cross-session decision provenance and a way to

distinguish historical plans from current authoritative policy. Proposed proof: new evidence contradicts an old decision; Brain updates affected operations without losing the original reasoning or replaying the entire investigation.

### 28.5 Model validation and independent challenge

The design covers calibration and causal decomposition; it needs an explicit adversarial decision-quality program to catch hidden assumptions, data contamination, selection effects, omitted causal variables, correlated failure and simulated certainty. Independent checks should test important commercial decisions before large commitments and compare predicted outcomes against later observations. Prioritization should depend on consequence, not add a slow review gate to every small task. Proposed proof: an apparently profitable plan with a shared acquisition dependency is found and corrected before Brain overcommits resources.

### 28.6 Live organizational control and authority

Brain’s autonomy needs a complete policy-to-action control plane: who can authorize which actions, how approvals persist and expire, per-business/per-project budgets, audit trails, separation between read-only and external mutation, spending and contract commitments, secrets, and emergency stop/recovery. Existing permission and authority systems are the starting point, not evidence that every future browser or hiring action is covered. Proposed proof: independent authorized work proceeds across multiple business lines while an unauthorized purchase, outreach action or contract is blocked and correctly surfaced, with no silent global shutdown.

### 28.7 Resilience and continuity of a multi-business operation

The current text emphasizes recoverable research and Factory work but insufficiently defines business continuity: payments during outages, duplicated sends, webhooks, account compromise, vendor suspensions, failed integrations, missed customer commitments, backup communications and lost worker capacity. A self-directed operation requires observability and recovery tied to customer and financial consequences, not only server uptime. Proposed proof: simulate service interruption during a legitimate order lifecycle and show reconciliation, no duplicate financial actions, and recovery to a known truthful state.

### 28.8 General-purpose outcome execution beyond money

Business and capital objectives dominate the current specification. Brain should eventually support owner-defined noncommercial goals—for example creative projects, productions, learning, organizing, acquisitions or product development—using the same general ability to reason backward from outcomes, discover dependencies, acquire capabilities and execute authorized work. Goal-specific standards and constraints must remain distinct. Proposed proof: Brain derives and manages a complex non-revenue project without forcibly mapping its success to a dollar target or commercial funnel.

### 28.9 Priority logic for these gaps

Near-term commercial readiness makes 28.1 end-to-end fulfillment, 28.3 counterparties, and the relevant parts of 28.6 action authority particularly consequential. Model challenge (28.5) and operating memory (28.4) multiply decision quality throughout. Business continuity (28.7) becomes increasingly urgent as real operations begin. Full enterprise formation (28.2) and noncommercial goal support (28.8) remain in the complete program and should be promoted whenever a live objective depends on them. This ordering is tentative and must be revised based on observed dependencies and demonstrated economic effect, not treated as a fixed permanent hierarchy.

Status: These are identified design gaps, not completed implementations and not a requirement to introduce duplicate subsystems. The owner may develop them, change their boundaries, or add entirely new domains before approval of the complete master architecture.

Change log — v1.3 (2026-11-09): Added §27 (the owner-selected dragon-themed living management simulator with a first-class numerical operations and goal interface) and §28 (cross-cutting design gap register with proof criteria). Existing §1–26 preserved.

## 29. Added 2026-11-09 — End-to-end commercial operation, not just a constructed opportunity

Owner intent: Brain must be able to operate the entire life of a transaction, not stop at opportunity discovery, a price quote, or an apparently successful sale. The exact process is discovered from the transaction’s role, counterparties, and obligations; the sequence below is an illustrative lifecycle, not a fixed workflow imposed on every industry.

### 29.1 A transaction as a changing system of commitments

Represent the full chain of buyer identification, qualification, offer construction, negotiation, agreement, authorization, deposit or payment, capacity reservation, supplier commitment, delivery, inspection or acceptance, invoicing, settlement, reconciliation, warranty/support, renewal, dispute, and closeout as needed. Each transition records who must do what, by when, under which agreed terms, with which evidence and what outcome. Capture all applicable external dependencies: delivery location and method, scheduling windows, contractual conditions, cancellation provisions, refund exposure, escalation paths, payment holds, insurance/licensing, and quality checks.

No single ‘sale made’ flag may stand in for contract signed, payment authorized, funds settled, work accepted, margin earned, or cash available to reinvest. Brain should know what changes at each stage, including money still owed to a supplier or customer. The state model must support transactions that skip steps, branch, restart, split into milestones, or involve multiple purchasers and providers. It may use different structures for different industries.

### 29.2 Revenue realization, delivery and aftercare

Build an operational path from a credible offer to a customer who can actually receive the promised result, within stated timing and quality. Derive delivery steps from the real scope, not from a generic ‘AI can fulfill it’ assertion. Brain can use its own verified capabilities, existing supplier relationships, or specifically sourced external providers; it should not misidentify a buyer as a fulfiller or claim capabilities that are not proven. Where legal or commercial responsibilities belong to a licensed provider or accountable person, preserve that responsibility.

A completed job should produce evidence of delivery and acceptance, any contractual obligation to correct or redo work, and a truthful accounting result. Record relationships that enable repeat business: follow-up requests, service levels, trust and reputation, customer satisfaction, referrals, renewals, upsells, and cross-sell opportunities. These are new economic evidence and should improve future deal construction.

### 29.3 Exceptions as first-class processes

A buyer may change scope; a supplier may miss a date; a customer may cancel; payment may fail; or a delivered result may be disputed. Brain must detect these as state changes, quantify the contractual and economic consequences, and select from feasible remedies (substitute provider, renegotiate scope, reschedule, partial delivery, approved refund, alternate collection channel, escalation, or orderly cancellation). Safeguard permissions, cash, reputation, and the customer’s real obligations while resolving the exception. Any negotiated legal or financial commitment follows its existing authorization limits.

Acceptance demonstration: Execute or safely rehearse one real, sourced commercial case from request through accepted fulfillment and funds reconciliation, including an actual failure path. Trace each state change, obligation, buyer/supplier identity, financial movement, external action authority, and recovery decision. A simulated pipeline alone does not establish successful commercial operation.

## 30. Added 2026-11-09 — Formation and management of enterprises and institutions

Brain should derive the necessary organizational and institutional machinery for whatever enterprise it proposes. It may need one contractor agreement, a registered business, several subsidiaries, a brand, intellectual property licenses, distribution contracts, manufacturing arrangements, a regulated partner, corporate governance, or none of those. The system determines applicable requirements from the real

activity, geography, parties, financial flows and risk exposures; it does not mechanically apply a fixed company-formation checklist.

Represent legal entities, owners, beneficial interests, roles, signing authority, contracts, permits, licenses, insurance coverage, banking/payment accounts, taxes, accounting books, ownership of IP, intercompany transactions, financing covenants, and external providers as relevant. Track costs, prerequisites, ongoing obligations, renewal dates, and what becomes possible when an institution exists. Separate commercial desirability, legal feasibility, institutional readiness, and authorization to act.

Brain can research, prepare documents, compare structures, plan processes, coordinate authorized service providers and monitor compliance-related obligations. Formation, regulated services, material borrowing, legal commitments, and account opening still require applicable approvals, eligibility and external professional roles. A detected regulatory limitation should generate compliant alternate roles or partners, not an unsupported assertion that the whole market is closed.

Acceptance demonstration: Given an unfamiliar proposed venture, Brain derives and costs its real institutional prerequisites, finds alternative feasible structures, identifies authorizations/professionals genuinely required, and updates its economic plan accordingly. It must not create entities or bind the owner merely because its planning model recommends doing so.

## 31. Added 2026-11-09 — Counterparties, external work, and organizational capacity

Brain should maintain an evidence-backed model of who can perform or enable each commercial commitment, whether they are contractors, carriers, suppliers, agencies, manufacturers, distribution partners, employees, licensed intermediaries or software services. Distinguish a directory listing from actual willingness, current availability, verified capability, quoted price, reserved capacity, contractual commitment and successfully completed work.

For every material dependency, model eligibility, geography, scope, qualifications, performance history, price and payment terms, response speed, available capacity, quality, reliability, lead time, cancellation rights, and switching costs where applicable. Search across suitable markets instead of anchoring to the owner’s present location. Brain should know when an arrangement requires a human operator or a role it cannot personally or legally fulfill.

Use this information to construct and compare supplier-side opportunities, negotiate authorized terms, coordinate project steps, allocate work, check completion, and learn which counterparties actually perform. Avoid double-booking scarce capacity across separate businesses. As Brain scales, support workforce planning, hiring-process preparation, performance management and partner networks without treating full-time employment as a prerequisite for running every business.

Acceptance demonstration: In a sourced contractor-delivered transaction, identify a plausible primary and alternative fulfiller, establish which facts are verified versus pending, compare cost/capacity/timing, reserve only with required authority, and show how the system would transfer the job after a primary failure without double-committing or misreporting a sale as deliverable.

## 32. Added 2026-11-09 — Persistent operating memory, decision history and model learning

Store not only the answer Brain reached, but the decision it faced, the alternatives available, evidence used, conditions assumed, predicted outcomes, authority, timestamp, and the reason for its choice. Preserve a direct link between source evidence, derived variables, economic mechanisms, decisions, actions and eventual results. The owner’s current policies and approved objectives should have explicit versions and precedence: an older report cannot silently override a newer authorized instruction.

Distinguish immutable historical record from the current operational truth. A source changing, an unexpected conversion rate, a new supplier price, an account being disconnected, a fulfilled contract, or a changed capital constraint should trigger reconsideration of affected decisions and strategies. Avoid repeatedly

researching questions answered by still-valid evidence; do not leave obsolete decisions active simply because they were once approved.

Record predictions against actual results and perform calibration/causal error analysis: was the observed difference expected variability, a bad model, low-quality evidence, a changed market, an omitted dependency, or execution failure? Generalize lessons into better reasoning or algorithms, using Factory if software improvement is needed, while retaining supporting and disconfirming evidence. Prevent one unlucky result from forcing a false global rule. Make the history useful across sessions and, where authorized, across compatible projects without violating data boundaries.

Acceptance demonstration: Change one economically material fact after a real plan has used it. Brain identifies the dependent forecasts, opportunities, approvals and actions, updates them once, preserves the earlier decision and its evidence, and independently changes the next justified step. Repeat with a prediction error and demonstrate a specific model or method correction when warranted.

## 33. Added 2026-11-09 — Independent challenge, uncertainty and pre-commitment decision quality

Brain should actively seek ways its own important conclusions could be wrong. Choose scrutiny based on potential loss, irreversibility, model uncertainty, correlated exposures and decision impact. A small reversible action may need only basic invariants; a large obligation or portfolio-wide assumption warrants much deeper checking. Challenge can come from independent models, mathematical checks, counterfactuals, held-out evidence, adversarial search, statistical tests and production-derived historical outcomes. A model agreeing with itself is not independent validation.

Tests should cover unrepresentative source data, survivorship/selection bias, stale prices, market regime changes, confusion between posted prices and actual paid prices, unreachable buyers, supplier constraints, failure to account for obligations, favorable conversion assumptions, dependence on the same marketplace/provider/channel, timing of truly usable cash, refunds and legal counterparty exposure. Model commercial uncertainty inside mathematical reasoning, using empirical evidence, bounds, sensitivity, correlated scenarios and model validation. Preserve the difference between a calculated scenario, a calibrated probability, an accepted plan, and an actual result.

The challenger does not merely say ‘insufficient confidence’. It identifies an assumption that matters, the observation or method needed to test it, and a concrete alternative structure or safeguard that would make the plan more robust. Where the evidence cannot justify a 90% requirement, Brain should work on improving the actual plan and evidence, not declare that the arbitrary mathematical scenario coverage proves the target.

Acceptance demonstration: An apparently attractive multi-wedge plan fails under a correlated supplier, distribution or payment dependency. Brain detects the shared exposure, proposes economically defensible independent substitutes or reductions in commitment, recomputes its outcomes, and refrains from inflating the probability. Then test that a minor reversible action is not held up by the entire heavy review process.

## 34. Added 2026-11-09 — Autonomy, control, credentials and accountable external action

The intended autonomy is substantial: Brain should recognize needs, acquire information, build capabilities, and operate approved work without constant human orchestration. This requires a complete policy-to-action authority model, not either unlimited authority or asking permission for every internal step.

For any action, Brain should determine the responsible principal, allowed scope, affected account/project/business, consequence class, spending/credit/contract/contact ceilings, approval and expiry, available credentials, applicable external provider rules, and whether the action is reversible. Distinguish reading public data, internal code/research, generating a draft, sending an external message, changing a website, committing money, entering a contract, moving funds, and granting someone access. Use short-lived/scoped credentials and authoritative action receipts where possible. Keep sensitive credentials out of research records, prompts, public UI and logs.

Permissions must apply to the actual action path, including browser automation without an API; a permitted ability to view a portal is not approval to submit a form, purchase inventory, send outreach or sign a contract. Revocation should stop future disallowed actions; already-created obligations must still be tracked and honored or resolved. Emergency stop should pause risky mutations without destroying accounting state, current responsibilities or safe recovery work. Maintain audit trails showing exactly what Brain did versus what it proposed, and preserve human review where genuinely necessary.

Acceptance demonstration: A portfolio performs concurrent approved research, software improvement and permissible commercial actions while a prohibited spend, unsolicited send or contract submission is blocked. Mid-flight permission revocation stops further external mutations, and the system records existing obligations, remaining safe work and the precise action needing renewed authorization.

## 35. Added 2026-11-09 — Business continuity, dependable operations and recovery

A real autonomous business cannot assume AI providers, websites, communication accounts, suppliers, payment processors, databases, servers, or customers will remain available. Continuity is an end-to-end commercial property: orders, obligations, data, money and reputation must survive partial failures, not just code processes being restarted.

Persist the durable state of each consequential workflow, including what was attempted, what the outside world may have accepted, what is confirmed, and what remains unknown. Use idempotency keys, deduplication, reconciliation, delivery receipts, financial ledgers, retry budgets, backoff, circuit breakers, escalation and compensating actions where appropriate. A timeout after submitting a payment is not proof it failed; check external transaction identity before any retry. Don’t send duplicate outreach or purchase twice because the server restarted.

Define how Brain operates during partial outages: continue unaffected work, offer a degraded but truthful interface, reroute eligible research to another model/provider, change to a permitted acquisition channel when an account is suspended, switch suppliers if the original fails and an alternative is contractually workable, and preserve time-critical customer commitments. Maintain backup/restoration procedures for essential data and configurations, with verified restore behavior. Distinguish recoverable operational failure from an external constraint no alternate service can legitimately bypass.

Acceptance demonstration: Interrupt a transaction at one of its dangerous boundaries (after an uncertain payment request, during supplier reassignment, or after an outreach send with no response). Brain reconciles with the external system, does not duplicate commitments, preserves cash/obligations, resumes viable unaffected work, and reports accurately what it knows and what remains uncertain.

## 36. Added 2026-11-09 — General outcome execution beyond commerce

The same intelligence should be able to pursue owner-defined noncommercial objectives: film production, fashion launches, product development, learning, organizational projects and unfamiliar ventures. These may require creative quality, time, permits, personnel, equipment, logistics, reputational constraints, financing and acceptance criteria very different from a short cash sprint.

Brain must infer or establish the necessary capability/dependency structure, model actual requirements and alternative routes, schedule and coordinate authorized work, carry context between stages, identify what is blocked, and refine the plan using real-world feedback. It must not force every project into a revenue funnel or treat the owner’s illustrative goal ladder as a fixed sequence. Where specialist humans or institutions are needed, plan and coordinate the relevant roles while remaining within authority.

Acceptance demonstration: Given a real noncommercial project with several dependencies, Brain derives a concrete, evidence-backed execution plan; identifies external professionals and resources; performs the authorized parts; adapts to a changed requirement; and reports completion only when the project’s own acceptance criteria—not cash metrics—are satisfied.

## 37. Added 2026-11-09 — Systematic fallbacks, safeguards and engineered resilience

Owner’s additional requirement: Brain should have multiple fallback options throughout its thinking and operations so that one failed assumption, provider, person, algorithm, opportunity, website, or business does not unnecessarily derail the objective. Fallbacks are part of planning and operating the system, not something Brain improvises only after failure. The aim is to materially reduce the chance and severity of mistakes while preserving speed, opportunity generation and commercial upside.

### 37.1 Plan alternatives at every consequential dependency

For each important activity, commitment and goal pathway, determine the relevant failure modes, detection signals, time to harm, recovery window, substitute mechanisms and consequences. Build fallback structures appropriate to the situation, rather than imposing a universal fixed count. Some steps need one reliable primary and one tested substitute; high-impact commitments may require several independent alternatives. A fallback can change the mechanism itself (different customer segment, payer, supplier, distribution arrangement, price, financing structure, payment terms, business role or entire venture), not merely swap equivalent vendors.

Examples are illustrative, not a list to anchor on:

- Evidence/research: alternate legitimate sources, previously captured primary records, independent verification methods, different extraction techniques and model routes; never promote unverified data merely because the primary route failed.

- AI and computation: model substitution based on task fit, deterministic processing where validated, queue persistence, workload shedding, batching, retry/circuit breaking, degraded functionality and recoverable task continuation.

- Customer acquisition: multiple independent channels, partnerships, inbound demand sources, alternative segments, and different offers where economics justify them; respect channel permissions and provider rules.

- Supplier and delivery: alternative qualified fulfillers, verified substitute stock/capacity, resequencing, staged delivery, changed scope, recourse against nonperformance and permitted cancellation.

- Money: alternative approved payment pathways, deposits/prepayments where legitimately agreed, reserves, working-capital options, collection reconciliation and realistic settlement timing; never assume payment is collected because an invoice was sent.

- Organization and infrastructure: backup information and restore paths, alternative operators, account and credential recovery, different implementation routes, and independent execution capacity.

- Whole financial objective: multiple commercial engines with genuinely different dependencies, fallback portfolios, preserved candidate opportunities, alternate target-achievement routes and contingency capital allocation.

### 37.2 A machine-readable fallback structure

For any high-impact dependency represent, when useful: primary path → failure condition → evidence that failure occurred → replacement options → eligibility/authority → switching cost → time to switch → estimated impact on cash/capability → verification that recovery worked. This is a conceptual contract, not an instruction to hardcode a single schema into every domain.

Keep paths connected to the underlying causal/economic model: if Supplier A fails, Brain must recalculate lead time, supplier cost, client delivery obligation, acquisition economics, cash timing and the target portfolio as needed. Identify where a backup has been located but not validated, and where it has been negotiated/reserved. A possible substitute is not guaranteed available capacity.

### 37.3 Independence matters more than backup count

Three acquisition channels on the same suspended account are one correlated failure. Two suppliers relying on the same warehouse may both fail in the same outage. Several businesses exposed to one payments provider, jurisdiction or platform may collapse together. Brain must model common causes, dependency concentration and correlated tail events, and score actual independence, not the number of named backups. It should seek diversity only where the incremental reliability/option value justifies the cost and capital exposure.

The system must also evaluate when the fallback itself makes things worse: extra commitments, duplicate purchases, conflicting contracts, low-quality replacements, compliance breaches, data divergence, liquidity strain or slower execution. A fallback is eligible only if it meets the relevant obligations, authority and safety constraints. Unknown external confirmation calls for reconciliation before action, not blind retries.

### 37.4 Triggering, verification and learning

Build preconditions and switch criteria for consequential fallbacks. Prefer automatic failover for authorized, reversible internal work and previously approved alternatives. Escalate where a switch would expand contractual terms, spend unapproved money, bypass an access restriction, move customer data improperly or incur new obligations. Use early-warning signals (failure rates, projected deadline miss, capacity exhausted, price increase, provider incident, customer cancellation, model forecast drift) to take justified preventive action before a crisis.

For major objectives, calculate reliability at multiple levels: pathway reliability, goal portfolio reliability, correlated downside and time-to-recovery. Run sensitivity analyses, scenario trees, stress cases and calibrated probability models where evidence supports them; show the impact of each safeguard on both chance of success and expected net economics. An illustrative example is not evidence of an assured worst-case floor. Brain should be able to seek a 90% outcome but must not invent assurance where available data cannot justify it.

Whenever a path fails, record whether detection was timely, what Brain tried, whether recovery worked, how much cash/time/reputation was lost or preserved, and which general methods need improvement. Successful recovery patterns can be compiled into tested algorithms, and recurring failure classes can become Factory improvement objectives.

### 37.5 Fallback acceptance demonstrations

1. Multi-route commercial continuity: Under a realistic failed acquisition channel or unavailable primary supplier, Brain selects a truly independent permitted alternative, quantifies switching costs and timing, and keeps the commercial goal under evaluation instead of simply abandoning it.

2. Financial integrity: In a payment timeout, charge dispute or ambiguous external response, Brain reconciles against the processor and ledger; no duplicate charge, invoice, supplier payment or customer promise occurs.

3. AI and research resilience: During model/provider failure, useful work continues with approved deterministic methods and alternate suitable models where available; verified evidence standards remain unchanged and real useful throughput is measured.

4. Correlated failure: A portfolio with several apparently distinct businesses sharing a single critical dependency is recognized as concentrated. Brain constructs and evaluates meaningful independent protections rather than counting nominal backup names.

5. Authorization boundary: An automated fallback that would require new external authority stops at that specific boundary, while independent authorized work continues; no silent expansion of permission.

6. Tested recovery, not a pretty diagram: Inject a realistic interruption into the live system or an authenticated isolated rehearsal; show recorded detection, recovery, external-state reconciliation, correct economic updating and continued progress. Require a production reading for the actual implemented behavior before reporting VERIFIED.

7. Risk/cost optimization: Demonstrate that adding safeguards improves measured downside resilience without automatically consuming more expected value, capital, or worker time than justified; reject harmful or redundant fallbacks.

### 37.6 Priority and scope

Prioritize fallbacks where failure could cause financial loss, unauthorized external action, broken customer commitments, lost data, corruption of economic decisions, or a blocked revenue objective. Prepare low-cost and reversible backups early; allow additional safeguards to move ahead of nominal priority when a live dependency makes them necessary. Preserve ongoing commercial discovery and execution during improvements. Reuse Brain’s existing authorization, research recovery, Factory repair, state/ledger, and quant systems; do not establish a second operating control plane.

Status: These are detailed architecture requirements to preserve for the planned Factory program. They are not claims that the existing production code implements them or that all business failure can be mathematically excluded.

## 38. Added 2026-11-09 — Verification, priorities and implementation traceability for §§29–37

The eight areas initially listed as gaps in §28 are now elaborated in §§29–36; system-wide fallbacks are specified in §37. The original §28 register remains as its dated source, not a competing or superseding implementation contract. Factory must link each requirement and each necessary cross-system interaction to the original specification, existing code if relevant, observable acceptance conditions, and production verification. Preserve the full specifications; stage labels or short summaries are not substitutes.

Integration relationships that must be verified: Deals and customer commitments (§29) draw on reliable people and institutions (§§30–31); decisions and models retain provenance and challenge (§§32–33); all actions obey authority (§34); business state survives interruption (§35); the same general planning engine supports other kinds of goals (§36); fallbacks (§37) span the entire chain and update economics and permissions when used. These are interfaces and feedback loops, not independent feature checkboxes.

Implement by current decision value and actual dependencies. Work that directly improves the fastest responsible route to collected cash and its failure resistance can move early; a future hiring or manufacturing capability can remain prepared until a specific opportunity depends on it. None is permanently excluded, and no example business mechanism becomes an architecture-wide restriction. Existing proven capabilities should be reused, with only demonstrated gaps assigned new engineering work.

Change log — v1.4 (2026-11-09): Expanded the eight §28 operating gaps into detailed requirements and acceptance demonstrations (§§29–36). Added systematic, economically and operationally integrated fallback design (§37), including correlated risk, alternate paths, authority-aware switching, and tested recovery. Added integration and coverage requirements (§38). All earlier sections retained.
