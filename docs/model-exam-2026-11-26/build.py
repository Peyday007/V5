"""Builds exam/questions.json (sent to models) and exam/key.json (grader only).

Isolated model-capability examination, 2026-11-26. Nothing here imports or
touches Brain. Every scenario, company and figure is invented for this exam;
the prompt states each fact the answer needs.
"""
import json, pathlib

SYSTEM = (
    "You are an experienced business analyst. Answer using only the information in the "
    "question; you have no internet access or tools. Where you rely on anything not stated, "
    "say so explicitly. Be precise with numbers and dates. Keep your answer under about "
    "1,200 words and follow the requested output format."
)

Q = []
def q(id, caps, prompt, key, critical, followup=None):
    Q.append({"id": id, "caps": caps, "prompt": prompt.strip(), "followup": followup.strip() if followup else None,
              "key": key.strip(), "critical": critical})

# ---------------------------------------------------------------------------
q("Q01", [1, 12], """
OWNER'S STATED CONSTRAINTS (verbatim): "I have $3,000 to start. I personally will not make phone calls. Whatever we do has to be legal in Ohio. I can give it 10 hours a week."

A consultant drafted a plan to resell refurbished commercial espresso grinders to independent cafes in Columbus, Ohio. The plan's elements:
(a) Hire a commission-only sales rep who phones cafe owners to book demos; the rep is paid 12% of each sale, only after the cafe pays.
(b) Buy the first 4 grinders on the refurbisher's net-30 terms (total invoice $2,400), so no cash leaves before the first sales.
(c) "Because the owner will not make calls, all customer contact must be by email only; no in-person visits."
(d) The owner spends about 6 hours/week on emails, listings and coordinating deliveries.
(e) A 2-day regional coffee trade show booth costing $4,200, paid upfront 60 days before the show.
(f) "To be safe we will avoid any business requiring a vendor's license." (Facts: Ohio requires a vendor's license, a one-time $25 fee and online application, for retail sales of tangible goods. The plan sells tangible goods at retail.)
(g) A part-time technician (independent contractor) installs and calibrates grinders on site for $60 per install, billed to the owner.

TASK: For each element (a)-(g), state COMPLIES, VIOLATES (name the stated constraint violated), or INVENTED RESTRICTION (the element imposes a limitation the owner never stated), with a one-sentence reason. Then list what the corrected plan should change.
""", """
(a) COMPLIES - owner said HE personally will not call; a rep calling is delegation, not a violation.
(b) COMPLIES - $2,400 on net-30 with no upfront cash is within the $3,000; (note risk of having to pay if unsold within 30 days, but still within capital).
(c) INVENTED RESTRICTION - owner restricted only his own phone calls; email-only and no-visits are not stated constraints.
(d) COMPLIES - 6 h/week within 10.
(e) VIOLATES - $4,200 upfront exceeds the $3,000 capital.
(f) INVENTED RESTRICTION / wrong - the constraint is legality in Ohio; a $25 vendor's license makes it legal and is required; avoiding licensed businesses is not an owner constraint and would wrongly exclude this very plan. Correct move: obtain the license.
(g) COMPLIES - delegation to a contractor is legitimate.
Corrected plan: drop the trade show (or find one within budget), remove email-only/no-visit rule, get the vendor's license, keep rep and technician.
""", ["Marks (a) as a violation (treats delegated calls as owner calls)", "Marks (e) as compliant", "Accepts (f) as a valid constraint"])

# ---------------------------------------------------------------------------
q("Q02", [2, 17, 8], """
OWNER: $5,000 capital, 20 hours/week, no trade licenses today, located in Harlan County (fictional), wants a business producing profit within 4 months. Open to any legal model.

VERIFIED MARKET EVIDENCE:
1. County ordinance 14-210: every commercial and multi-family property with a backflow prevention device must have it tested annually by a state-certified backflow tester and the test report filed with the water utility. Non-compliance after a 30-day notice: water service shut-off.
2. The utility's public register lists 4,100 registered devices. Last year 920 devices (22%) were reported overdue; the utility sent 920 notices.
3. The state's certified tester list shows 3 certified testers with a business address in the county. Two of them told a caller (recorded call notes) they have a 5-6 week wait and "turn away work in spring".
4. Typical prices quoted by those testers: $95-$150 per device test; repairs (when a device fails, ~15% of tests) billed separately at $250-$900.
5. State tester certification: 40-hour course, $1,450, plus a test-kit costing $1,600; course offered monthly; pass rate 80%; certification needs no prior trade license.
6. A tester can test about 8 devices per working day including travel.
7. Testers in the adjacent county (35 miles away) have no waitlist and said they'd take overflow work in Harlan County at $70 per device paid to them, if someone else books and schedules the jobs.
8. Property managers in the county manage about 60% of the devices; the remainder are owner-operated businesses.

TASK: Without being told what to do, identify the commercially viable strategies this evidence supports (at least two distinct ones), estimate the economics of each from the figures given (state assumptions), compare them, and recommend one, including how it is sold, who pays, who performs the work, and the first 30 days of actions. Do not invent facts beyond what is given; label assumptions.
""", """
Expected strategies: (A) Booking/brokerage of overflow tests: owner sells and schedules tests to overdue/waiting properties (property managers first, using the public overdue register), subcontracts to adjacent-county testers at $70, charges ~$95-$150 -> $25-$80 margin per device, near-zero capital, starts immediately. (B) Owner (or hire) becomes certified: $3,050 cost + ~1 month, then $95-150/device at up to 8/day but owner has only 20h/week (~2.5 days -> ~20 devices/week), plus repair revenue. (C) Compliance-management/annual scheduling service sold to property managers (recurring) possibly combined with A. Demand signal: 920 overdue + local capacity shortage (waitlists). Payer: property owner/manager (not utility). Good recommendation: start with A (brokerage) immediately for cash, targeting property managers with multiple devices, potentially pursue B later. Economics sanity: e.g., 920 overdue x $50 margin ~ $46k gross potential; capacity of overflow testers matters (assumption).
""", ["Says the owner cannot do anything until licensed / rejects the opportunity because owner lacks a license", "Identifies the utility or county as the payer", "Only one strategy offered"])

# ---------------------------------------------------------------------------
q("Q03", [3], """
VERIFIED FACTS (from documents the owner has):
F1. A university lab-surplus auction sells used benchtop centrifuges; the last 12 auctions' winning bids averaged $640 (range $410-$980).
F2. The auction house charges a 15% buyer's premium on the winning bid.
F3. Lots are sold "as is"; no testing or warranty.
F4. On an online lab-equipment marketplace, 23 listings of the same centrifuge models sold in the last 90 days; sold prices averaged $1,850; 9 of the 23 listings stated "serviced and calibrated".
F5. A calibration service in the same city charges $220 per centrifuge for service + calibration certificate.
F6. Freight for one centrifuge on a pallet within the region costs $140.

DRAFT MEMO STATEMENTS:
S1. "We can expect to buy units for about $736 all-in at auction before freight."
S2. "Units sell for about $1,850."
S3. "Serviced, calibrated units sell for more than untested ones."
S4. "Roughly 1 in 4 auction units will be defective."
S5. "Demand is about 7-8 units a month on that marketplace for these models."
S6. "After servicing ($220) and freight in and out, margin is comfortably over $500 per unit."
S7. "The marketplace takes a 10% fee."
S8. "We will be able to sell everything we buy within 30 days."

TASK: Classify every statement as SUPPORTED (follows from the facts; show the derivation), PARTLY SUPPORTED (explain which part is assumption), or UNSUPPORTED ASSUMPTION (not in the facts). For any statement that depends on an assumption, say what fact would be needed to verify it. Output a table: statement | classification | reason | fact needed.
""", """
S1 SUPPORTED: 640 x 1.15 = $736.
S2 PARTLY: $1,850 is the average sold price across all 23 listings, mixing serviced and unserviced; what an unserviced/serviced unit from us fetches is assumption.
S3 UNSUPPORTED (or at most suggestive): facts give counts of serviced listings but not price by condition; need price split.
S4 UNSUPPORTED: no defect rate given.
S5 SUPPORTED/PARTLY: 23 in 90 days = ~7.7/month for those models on that marketplace (historical sold count; capacity to absorb extra supply is assumption). Either SUPPORTED with that caveat or PARTLY is acceptable.
S6 PARTLY/UNSUPPORTED: 1,850 - 736 - 220 - 140 - 140 = $614 before marketplace fees, defects, unknown fee; "comfortably over 500" depends on fees (unknown) and price; with a 10% fee (assumed) 614-185=429 < 500. Must recognize fee/defects not given. Correct classification: not supported.
S7 UNSUPPORTED: fee not in facts.
S8 UNSUPPORTED: sell-through time not given.
""", ["Classifies S7 (10% fee) or S4 (defect rate) as supported", "Classifies S6 as supported without noting the fee/defect unknowns"])

# ---------------------------------------------------------------------------
q("Q04", [4, 16], """
CITY OF BRENNICK (fictional) - VERIFIED FACTS:
1. From March 1 next year, Ordinance 22-7 requires every food-service business generating over 1 ton/week of food waste to separate it and have it collected by a permitted organics hauler. Fine for non-compliance: $500/month, levied on the food-service business.
2. The city does not collect commercial organics and does not pay haulers; commercial waste collection is a private contract between the business and a hauler.
3. Two permitted composting facilities accept food waste and charge a tipping fee of $48/ton to whoever delivers it. They sell finished compost to landscapers at $28/cubic yard.
4. The city's Organics Infrastructure Grant: $50,000 maximum, reimburses capital costs of building or expanding a permitted composting or anaerobic-digestion facility; applicant must hold the facility permit.
5. Under the ordinance, each covered business must file an annual compliance report (tonnage and hauler permit number) with the city; the hauler typically provides tonnage data.
6. Hauler permit: $1,200/year, requires a leak-proof truck and insurance.

A founder's pitch deck states:
(i) "Revenue line 1: the city pays us per ton collected."
(ii) "Revenue line 2: the composting facilities pay us for the food waste we deliver."
(iii) "Revenue line 3: we apply for the $50,000 city grant to buy our collection truck."
(iv) "Revenue line 4: restaurants pay us a monthly collection fee."
(v) "Revenue line 5: we sell the compost to landscapers."
(vi) "Revenue line 6: restaurants pay us to prepare their annual compliance report."

TASK: For each line, state who (if anyone) actually pays whom, whether it is real revenue for a hauler, a cost, or not available, citing the fact number. Then state the business's actual revenue model and its per-ton cost structure as far as the facts allow.
""", """
(i) Not available - city pays no one (F2); city fines restaurants.
(ii) Wrong direction - the hauler PAYS the facility $48/ton tipping fee (F3): a cost.
(iii) Not available - grant reimburses composting/AD facility capital for permit holders (F4); a hauler's truck is ineligible.
(iv) Real revenue - restaurants (covered businesses) pay the hauler under private contract (F1, F2), motivated by the $500/month fine.
(v) Not available - facilities sell compost (F3); the hauler does not own compost.
(vi) Plausible add-on revenue - restaurants must file (F5); preparing the report is a service a restaurant could pay for (price not given, assumption).
Actual model: restaurant pays hauler; costs include $48/ton tipping, permit $1,200/yr, truck, insurance, labor. Price per pickup not given.
""", ["Treats the city as a payer", "Treats tipping fees as revenue", "Says the truck is grant-eligible"])

# ---------------------------------------------------------------------------
q("Q05", [5], """
BUSINESS: Supplying custom-printed high-visibility safety vests to construction contractors.
VERIFIED TERMS:
- Factory: unit cost $6.40; minimum production run 500 units (orders from several contractors can be combined into one run). 50% of the run's cost is paid as a deposit when the run is ordered (day 0); the remaining 50% is paid when production finishes, 14 days later.
- Freight from factory to customers: $0.55 per unit, paid on the day production finishes (day 14). Transit 21 days, so delivery is day 35.
- Contractors are invoiced on delivery and pay 45 days after delivery. All customer payments are by card through a processor charging 2.9% + $0.30 per payment; the processor settles funds 2 days after the customer pays.
- Selling price: $14.50 per unit. The average contractor order is 300 units, paid as one payment.
- Owner's capital: $8,000. No credit or financing is available. Ignore taxes and owner time.

TASK:
(a) Contribution per unit after all variable costs including processing.
(b) Number of days from the deposit until the cash from that run is in the owner's account.
(c) The maximum number of units the owner can have in production/transit/receivables at the same time using only the $8,000, respecting the 500-unit minimum run.
(d) The sustainable monthly volume (units/month, 30-day month) and monthly contribution if capital is recycled continuously and demand is unlimited.
(e) A large contractor offers to pay 50% of its order value upfront at order (day 0) and the balance on the usual terms. Quantify how this changes the capital required per unit and what then limits growth.
Show calculations.
""", """
(a) Processing per 300-unit payment: 0.029 x 4,350 + 0.30 = $126.45 -> $0.4215/unit. Contribution = 14.50 - 6.40 - 0.55 - 0.42 = ~$7.13/unit.
(b) Day 35 delivery + 45 = day 80 payment + 2 settlement = day 82 (accept 80-82 if reasoning clear about settlement).
(c) Cash out per unit = 6.40 + 0.55 = $6.95; one 500 run = $3,475; 2 runs = $6,950 <= $8,000; 3 runs = $10,425 > $8,000 -> 1,000 units max.
(d) ~1,000 units per ~82 days -> ~366 units/month -> ~$2,600/month contribution (accept $2,450-$2,750).
(e) Customer deposit = $7.25/unit at day 0 vs owner outlay $3.20 day 0 + $3.75 day 14 -> customer cash exceeds owner's cash outlay per unit; capital need per unit ~0 (self-funding, net positive ~$0.30/unit minus processing on deposit). Growth then limited by demand/sales capacity, MOQ batching and the share of customers who accept deposit terms, not capital.
""", ["Ignores the 500 MOQ in (c) (e.g., 1,151 units)", "Cycle off by more than 10 days", "Contribution off by more than $0.15"])

# ---------------------------------------------------------------------------
q("Q06", [6, 5], """
OWNER GOAL: "Make $40,000 net profit within 60 days from today."
BUSINESS: Reconditioned hospital beds sold to assisted-living facilities.
VERIFIED FACTS:
- The only supplier can sell at most 12 used beds per week (hard cap; one batch per week, first batch can be bought on day 1, later batches on days 8, 15, 22, ...). Purchase price $410/bed.
- A subcontractor reconditions beds for $180/bed; it takes exactly 14 days from purchase to a delivered bed (day 1 purchase -> delivered day 15).
- Delivery to facility: $95/bed.
- The facilities buy through a group purchasing contract that caps the price at $1,150/bed. Nine facilities have signed letters of intent for a combined 135 beds over the next 3 months.
- Fixed costs: warehouse $600/month, insurance $300 one-time. Capital available: $60,000 (sufficient to fund all purchases).
- Profit counts when a bed is delivered (accrual).

A team member writes: "84 beds x $1,150 = $96,600 revenue, so $40k profit is easy."

TASK: Determine whether the goal is reachable under these facts. Show the maximum achievable net profit within 60 days and the binding constraint. If unreachable, say what would have to change (quantify) and state what the owner can realistically achieve. Evaluate the team member's statement.
""", """
Batches bought days 1,8,15,22,29,36,43 deliver days 15..57; day-50 purchase would deliver day 64 > 60. 7 batches x 12 = 84 beds max. Contribution/bed = 1,150-410-180-95 = $465. 84 x 465 = $39,060 - fixed (600x2 + 300 = $1,500) = $37,560 < $40,000 -> UNREACHABLE. Binding constraint: supplier cap (and 14-day lead time), not demand (135) or capital. Price capped at $1,150 by GPO. To reach $40k would need ~90 beds (6 more; i.e. a second supplier) or ~$29-30 more per bed, which the cap forbids. Team member confused revenue with profit. Realistic: ~$37.5k.
""", ["Declares the $40k reachable", "Max beds not 84 (e.g., 96 or 72) without justification", "Accepts revenue as profit"])

# ---------------------------------------------------------------------------
q("Q07", [7, 4], """
OWNER: Lives in Arizona, speaks only English, has $4,000 and 15 hours/week. Wants a profitable service business.
VERIFIED FACTS:
1. Immigration and court filings in the U.S. require certified English translations of Portuguese documents (birth certificates, diplomas, court records). Certification = a signed statement by the translator attesting competence and accuracy; no state license is required to sell translation services.
2. Freelance Brazilian-Portuguese-to-English translators on a professional directory charge $0.08-$0.11/word and will sign certification statements for documents they translate. Turnaround: 2-3 business days.
3. Translation agencies charge U.S. immigration law firms and individuals $0.20-$0.25/word for certified translations, with a minimum of $45 per page (~250 words).
4. Immigration law firms in Phoenix that handle Brazilian clients (32 firms identified on the state bar directory by practice area) say documents are usually 1-3 pages; firms often pass the cost to the client; agencies are typically paid by card at order.
5. Errors cause USCIS Requests for Evidence that delay cases by months; firms rank accuracy and speed above price.
6. Professional liability (E&O) insurance for a translation business: $900/year.

TASK: Is this a viable business for this owner? If so, describe the operating model (who does what, who signs what, who pays whom, when money moves), quality controls, per-page economics at a typical 1-page and 3-page order, capital needs, and the main risks. If not, explain why with reference to the facts.
""", """
Viable as a brokerage/agency: owner sells to immigration law firms (and individuals), subcontracts translation to freelance translators who sign the certification; owner manages intake, QA (second-translator review or spot checks), delivery, invoicing. Payer: law firm (or client via firm), paid at order by card -> owner pays translator after; negative working capital. Per-page: 1-page order min $45 vs translator cost ~250 x $0.08-0.11 = $20-27.50 -> ~$18-25 margin (minus card fees); 3-page = 750 words x $0.20-0.25 = $150-187.50 (or $135 by minimum) vs translator $60-82.50 -> ~$70-105 margin. Capital: insurance $900 + small marketing; well under $4,000. Risks: accuracy (RFEs), translator reliability, attestation must be by translator (not owner), competition from agencies, volume uncertainty. Must NOT reject because owner doesn't speak Portuguese.
""", ["Rejects because owner does not speak Portuguese", "Has the owner sign the certification of accuracy himself as translator"])

# ---------------------------------------------------------------------------
q("Q08", [8, 5], """
OWNER: $10,000 capital, 15 hours/week, 90 days. Objective: maximize net profit actually received in cash by day 90. Any combination of strategies is allowed if capital and hours allow.
STRATEGY A - Restaurant equipment lot flipping: buy a liquidation lot for $3,500; it resells for $5,600 on average; marketplace fee 8% of sale price; transport $300 per lot; a lot takes 50 days on average from purchase until the sale cash is received. Owner time 6 hours per lot in total (mostly in its first week). Each lot needs its own $3,500 at purchase.
STRATEGY B - Appointment setting for a commercial roofer: roofer pays $250 per qualified inspection appointment, accepts at most 3 per week, pays 30 days after each appointment. Setup: lead list $200 one-time plus email tools $150/month. Owner time 3 hours/week. First appointments in week 4 (days 22-28); 3 per week from then on.
STRATEGY C - HOA common-area pressure washing via subcontractor: HOA pays $2,200 per job; subcontractor charges $1,300 per job, paid by the owner on completion; insurance $400 one-time at start; the subcontractor can do 1 job per week; first job completes at the end of week 4 (day 28), then one completing at the end of each following week (day 35, 42, ...). HOAs pay 5 days after completion. Owner time 4 hours per job. Contracted HOA demand exceeds capacity.

TASK: Compute, for each strategy alone, the net profit received in cash by day 90 and its capital need. Then determine the best overall course of action for the objective, checking capital and weekly hours. Show your arithmetic and state your recommendation clearly.
""", """
A: profit per lot 5,600 - 448 - 300 - 3,500 = $1,352. 50-day cycle -> only lots bought ~day 1-40 cash out by day 90. Capital $10k allows 2 lots concurrently (7,000) -> cycle 1 cash by day ~51; a second cycle bought day 51 would cash at day ~101 (missed) -> 2 lots = $2,704 (if 2 concurrent; with all $10k alone 2 lots; a third lot later from proceeds also misses day 90 unless bought by day 40). Alone with $10k: 2 lots ($7,000) + nothing else -> $2,704.
B: appointments weeks 4-8 paid by day 90 (week 8 ends day 56 +30 = 86; week 9 day 63+30 = 93 misses) -> 15 x 250 = $3,750 - 200 - 450 = $3,100. Capital ~$650.
C: jobs completing days 28,35,...,84 paid by day 89 -> 9 jobs x $900 = $8,100 - $400 = $7,700; capital ~$1,700 (insurance + one sub payment float).
Best single: C. Best overall: all three are compatible: peak capital ~7,000 + 400 + 1,300 float + ~500 = ~9,200 <= 10,000; hours fine (C 4/wk, B 3/wk, A ~12 total front-loaded). Combined ~ $13,500. Recommend C as anchor plus B and A. Accept answer recommending C+B (+A) with consistent math; choosing A alone or B alone is wrong.
""", ["Recommends A (or B) as the single best", "Does not consider combining strategies"])

# ---------------------------------------------------------------------------
q("Q09", [9, 3], """
QUESTION THE OWNER NEEDS ANSWERED: For a business that files residential solar interconnection applications on behalf of small installers in Pell County (fictional), what is the application fee and how many applications are there per year?
SOURCES:
S1. Pell Electric Cooperative fee schedule (PDF dated January 2025): "Residential interconnection application (<=25 kW): $350."
S2. A solar installer's blog post (dated June 2023): "Pell Co-op charges just $200 to apply for interconnection."
S3. Pell Co-op board minutes (October 2024): "Board approves increasing the residential interconnection application fee from $200 to $350 effective January 1, 2025."
S4. State Utility Commission annual report (2025): "Pell Electric Cooperative received 1,240 residential interconnection applications in 2024."
S5. Pell Co-op's 2024 annual report: "We connected 860 new residential solar systems in 2024."
S6. A trade newsletter (2025): "Over 2,000 Pell County homes went solar last year."
S7. Pell Co-op service territory map: the co-op serves about 70% of Pell County; the rest is served by a municipal utility.

TASK: Give the best-supported current fee and annual application volume. Explain each apparent contradiction, which sources remain valid and for what, and what (if anything) remains uncertain. Do not discard a source unless it is actually wrong for the question.
""", """
Fee: $350 currently (S1+S3); S2 was correct in 2023 (pre-increase) - not wrong, just outdated. Volume: 1,240 applications (S4, 2024) vs 860 connected (S5): different measures - applications vs completed connections (withdrawn/pending/rejected), both valid. S6 "2,000+ homes" is county-wide (includes the municipal utility's 30% territory per S7) and "went solar" may count installs, so not a contradiction with co-op figure; also secondary source. Market for the business: ~1,240 apps/yr in co-op territory plus unknown municipal-utility applications (that utility's fee unknown). Uncertain: 2025 volume, municipal utility's fee/process, whether S6 is accurate.
""", ["Treats S2 as an error/untrustworthy instead of outdated", "Picks 860 or 2,000 as application count without reconciling", "Discards S5 or S6 as wrong without explaining the definitional difference"])

# ---------------------------------------------------------------------------
q("Q10", [10, 19], """
PLAN UNDER REVIEW: Brokering mobile tire-replacement for delivery-van fleets in a metro area. The owner sells contracts to fleet managers; a licensed mobile-tire subcontractor performs the work on the fleet's lot overnight.
VERIFIED FACTS IN THE PLAN FILE:
1. Fleets pay $38 per tire mounted on-site (3 signed quotes from fleets at $36-$40); tires are supplied by the fleet.
2. The subcontractor charges $22 per tire and has capacity of 120 tires/night with 2 trucks; it confirmed in writing.
3. Three fleets with a combined 410 vans have requested service; vans need ~4.3 tires/year each on average (fleet records).
4. No state or local license is required to broker the service; the subcontractor holds the required business license and $2M liability insurance naming clients as additional insured.
5. Fleets pay net-30; the subcontractor accepts net-45 terms from the owner.
6. Owner capital: $2,500; insurance for the broker (general liability) $1,100/year.

A REVIEWER'S CRITICISMS:
C1. "The tire-service market is saturated; there's no room for a new entrant."
C2. "The owner lacks the required license to provide tire services."
C3. "Margins are too thin to sustain the business."
C4. "Annual volume from the three fleets is only about 1,760 tires, which caps gross margin around $28k/year unless more fleets are signed."
C5. "Cash flow will be negative because the owner pays the subcontractor before fleets pay."
C6. "The plan depends on a single subcontractor; if it drops out, service stops."

TASK: For each criticism, decide whether it is SUPPORTED by the facts, CONTRADICTED by the facts, or UNSUPPORTED (no evidence either way), with reasoning and numbers. Then give your overall verdict on the plan.
""", """
C1 UNSUPPORTED - no evidence of saturation; three fleets requested service with signed quotes.
C2 CONTRADICTED - fact 4: no license needed for broker; subcontractor licensed.
C3 CONTRADICTED - $16/tire, 42% gross margin; fixed cost $1,100/yr is small.
C4 SUPPORTED - 410 x 4.3 = 1,763 tires x $16 = ~$28.2k gross margin/yr.
C5 CONTRADICTED - fleets pay net-30, sub paid net-45 -> owner receives before paying.
C6 SUPPORTED (valid risk) - single subcontractor dependency is real; mitigate with backup sub. (Capacity 120/night far exceeds need.)
Verdict: sound, proceed, with growth (more fleets) and backup subcontractor as real issues.
""", ["Accepts C1 or C2 or C5 as valid", "Rejects the plan based on unsupported criticisms"])

# ---------------------------------------------------------------------------
q("Q11", [11], """
An owner has a contract to deliver 400 custom embroidered jackets to a client. Work begins Monday, November 1, 2027. Business days are Monday-Friday; all parties (owner, designer, factory, mill, couriers, freight carrier and client) do not work on Thursday November 25 and Friday November 26, 2027. Every duration below is in business days; a task starts on the business day after its predecessors finish, and its last day is the day it completes (a 2-day task starting Monday completes Tuesday).
TASKS:
T1. Designer prepares artwork proof: 2 days (starts Nov 1).
T2. Client approves artwork: 3 days (after T1).
T3. Mill supplies 400 blank jackets to the factory: 15 days (starts Nov 1, independent of T1/T2).
T4. Factory makes one sample using a stock blank: 4 days (after T2).
T5. Courier delivers sample to client: 2 days (after T4).
T6. Client approves sample: 2 days (after T5).
T7. Bulk production: requires T3 and T6 complete; factory produces 40 jackets per business day.
T8. Ground freight to client: 3 days (after T7); goods arrive on the last freight day.
Contract delivery deadline: Friday, December 17, 2027.

QUESTIONS:
(a) Completion date of each task, earliest delivery date, and whether the deadline is met (and by how many business days of slack).
(b) Which tasks are on the critical path?
(c) If the client rejects the first sample, the factory remakes it (T4 again, 4 days), courier (2 days), and approval (2 days) repeat once. What is the new delivery date? Is the deadline met?
(d) In scenario (c), options are: expedited freight (1 day instead of 3) for $900; factory overtime raising output to 50 jackets/day for $1,200; or pay the mill $700 to deliver blanks 5 days sooner. Which options (alone) meet the deadline, and which is cheapest?
""", """
(a) T1 Nov 2; T2 Nov 5; T4 Nov 11; T5 Nov 15; T6 Nov 17; T3 Nov 19; T7 starts Nov 22, 10 days: Nov 22,23,24,29,30, Dec 1,2,3,6,7 -> Dec 7; T8 Dec 8-10 -> delivery Fri Dec 10. Met, 5 business days slack.
(b) Critical path T3 -> T7 -> T8 (sample chain has 2 days slack).
(c) Rework: T4' Nov 18,19,22,23 -> Nov 23; T5' Nov 24, Nov 29 -> Nov 29; T6' Nov 30, Dec 1 -> Dec 1. T7 Dec 2-15 (Dec 2,3,6,7,8,9,10,13,14,15); T8 Dec 16,17,20 -> Mon Dec 20. Misses by 1 business day.
(d) Expedited freight: arrives Dec 16 -> meets ($900). Overtime: 8 days Dec 2..13 -> freight Dec 14,15,16 -> meets ($1,200). Mill faster: no effect (sample chain now critical) -> does not meet. Cheapest: expedited freight $900.
""", ["Wrong earliest delivery date in (a)", "Wrong date in (c) or claims deadline met in (c)", "Recommends paying the mill"])

# ---------------------------------------------------------------------------
q("Q12", [12, 1, 8], """
OWNER CONSTRAINTS, stated at the start of the engagement:
1. Keep my day job: I am unavailable 8:00-17:30 Monday-Friday.
2. Maximum $2,000 tied up in inventory at any time.
3. No products sold to minors (personal ethics), and nothing involving alcohol or tobacco.
4. Must be producing profit by the end of month 3.
5. I don't want my home address public.
6. My spouse can help up to 5 hours/week on weekends.

OPTIONS (all facts verified):
O1. Weekend booth reselling handmade-style vape accessories at a flea market: profit $900/month, inventory $1,500, Saturdays only.
O2. Evening/weekend virtual bookkeeping clean-up for small landscaping firms via a subcontracted bookkeeper; owner sells and manages by email in evenings; profit $1,400/month from month 2; no inventory; client meetings happen on weekday lunchtimes 12:00-13:00 at the client's office (firms insist on this).
O3. Online store of collectible trading-card sealed boxes: profit $2,600/month from month 2; inventory needed $6,000; buyers include many teenagers.
O4. Weekend mobile car-detailing via a subcontracted detailer; owner books jobs online evenings; profit $1,100/month from month 2; no inventory; business registered with a UPS-store mailbox address; detailer handles weekday jobs too, owner only coordinates by text in evenings.
O5. Weekend pop-up selling craft beer accessories (bottle openers, glassware, no alcohol) at farmers markets: profit $800/month from month 1; inventory $1,800; spouse staffs the booth 5 hours each Saturday; owner sources stock evenings.
O6. Wholesale of refurbished office chairs to startups: profit $3,000/month from month 3; inventory $4,000 per batch; pickups only on weekdays 10:00-15:00 from the supplier.

TASK: Check every option against every constraint, list each violation precisely, and recommend the best option or combination that satisfies ALL constraints, explaining the trade-off.
""", """
O1 violates 3 (tobacco/vape). O2 violates 1 (weekday lunchtime client meetings during unavailable hours). O3 violates 2 ($6,000 inventory) and 3 (sales to minors). O4 complies (mailbox address satisfies 5; subcontractor weekday jobs are not owner's time). O5 complies (no alcohol sold; $1,800 <= $2,000; spouse 5h/week on weekend <= 5; owner evenings) - note beer accessories are not alcohol; age restriction not stated but not a sale of alcohol; acceptable. O6 violates 2 ($4,000) and 1 (weekday pickups) unless delegated (pickup could be delegated - partial credit if noted, but inventory still violates). Best: O4 + O5 combined (inventory 1,800 total; profits 1,100 + 800 = $1,900/month; both profitable by month 3). Must not invent extra violations (e.g., saying O5 violates alcohol constraint).
""", ["Recommends O2, O3, O1 or O6", "Marks O4 or O5 as violating without valid reason"])

# ---------------------------------------------------------------------------
q("Q13", [13], """
Below are inferences a junior analyst drew. For each, state whether the evidence ESTABLISHES the conclusion, PARTLY SUPPORTS it, or DOES NOT ESTABLISH it, and explain the logical gap precisely (what else would be needed).
E1. Evidence: Search interest in "sauna blanket" rose 300% in 18 months. Conclusion: "A sauna-blanket rental service will have strong paying demand."
E2. Evidence: The dominant local competitor for dog-grooming has 4.8 stars on 2,100 reviews. Conclusion: "The market is underserved, so a new groomer will fill up quickly."
E3. Evidence: A county permit database shows 312 permits for in-ground pools issued in the last 12 months, each requiring a final safety-fence inspection before occupancy. Conclusion: "Around 300 pool owners a year must obtain a compliant safety fence (or have one) before using their pool."
E4. Evidence: 40 small manufacturers answered a survey; 34 said they "would consider" outsourcing their safety training. Conclusion: "85% of small manufacturers will buy outsourced safety training."
E5. Evidence: A competitor raised prices 20% last year and its revenue rose 15%. Conclusion: "Customers in this market are price-insensitive, so we can price 20% above the competitor."
E6. Evidence: The state's procurement portal shows 14 awarded contracts for courthouse interpreting in the last 2 years, average value $180,000, all to firms with 10+ certified interpreters. Conclusion: "A new two-person firm can expect to win a share of these contracts."
E7. Evidence: Three hotels each signed a letter of intent to buy at least 200 linen sets at $42 if delivered by May 1. Conclusion: "There is at least $25,200 of conditional demand."
""", """
E1 NOT: search interest != paying rental demand; need rental willingness to pay, hygiene concerns, purchase vs rent.
E2 NOT: high rating suggests satisfied customers, not unmet demand; need wait times/capacity.
E3 ESTABLISHES (largely): permits + mandatory inspection -> ~312 owners/yr need compliant fence (some already have one; conclusion says "or have one"). PARTLY acceptable if notes some permits not built.
E4 NOT/PARTLY: "would consider" != will buy; sample of 40 respondents, selection bias; not 85% of population.
E5 NOT: revenue rise could come from volume/other causes; one competitor's elasticity; brand; doesn't support pricing ABOVE competitor.
E6 NOT: winners all had 10+ certified interpreters, suggesting a qualification barrier; evidence points against.
E7 ESTABLISHES: 3 x 200 x $42 = $25,200 conditional on May 1 delivery (LOI non-binding caveat OK).
""", ["Says E1, E2, E4, E5 or E6 establishes its conclusion", "Says E7 does not establish the $25,200 conditional figure"])

# ---------------------------------------------------------------------------
q("Q14", [14], """
An owner forwards this message and asks whether to commit:
"Hi - I'm facilities director at Corvane Logistics (3 warehouses in the region). We need someone to take over our pallet program: collecting broken pallets from our docks, repairing what's repairable, and supplying us repaired pallets. We go through a lot of pallets. We pay vendors net-60. We'd want you to start in about 6 weeks. Can you send a proposal?"
Known about the owner: $12,000 capital, no truck, no pallet-repair experience, 25 hours/week, located 20 miles from Corvane's nearest warehouse. There is a pallet recycler 15 miles away that buys broken pallets and sells repaired ones (prices unknown).

TASK: Before any proposal can be priced or a commitment made, what information is genuinely missing? List the questions (to Corvane, to the recycler, or to others) ranked by how much each answer could change the decision, and for each say which decision or number it determines. Do not ask anything already answered above. Then state what the owner can already conclude without those answers.
""", """
Top questions: (1) Volumes: broken pallets/week per warehouse and repaired pallets needed/week (sizes/grades e.g. GMA 48x40, Grade A/B). (2) Current price paid per repaired pallet and current vendor/what they pay or are paid for broken pallets (Corvane's pricing expectations). (3) Recycler: price it pays for broken pallets, sells repaired ones, capacity, whether it would subcontract/supply and whether it collects (truck) - the brokerage feasibility. (4) Contract term, exclusivity, volume commitment, and penalties/SLA for supply shortfall. (5) Pickup frequency, dock windows, trailer drop vs truck, site requirements, insurance requirements (COI amounts). (6) Whether Corvane already has a vendor and why switching. (7) Who owns broken pallets / credit for cores. (8) Net-60 implication -> working capital needed: what's the cash cycle vs recycler terms. Owner can conclude: net-60 means owner funds ~2 months of supply; $12k capital constrains volume; no truck -> needs transport partner/brokerage with recycler; 6-week start is feasible only if partner arranged; repair skill can be subcontracted.
Grade: questions specific and decision-linked; no redundant questions (e.g., asking payment terms, start date or location).
""", ["Asks about already-given facts (payment terms, start time) as top questions", "Fails to ask about volumes or prices"])

# ---------------------------------------------------------------------------
q("Q15", [15, 20], """
OWNER: $6,000 capital, 15 hours/week, wants a profitable product-resale business.
VERIFIED FACTS:
1. A liquidator sells B-grade (cosmetic blemish) 400-watt solar panels at $38 each, in pallets of 26.
2. Comparable new panels retail at $140-$170; B-grade panels of this type sell online at $90-$100 each (recent sold listings).
3. The buyers in those listings were mostly off-grid cabin owners and DIY homeowners buying 4-8 panels.
4. Online marketplace fee: 10% of sale price.
5. LTL freight for a full pallet (26 panels) to a commercial dock in the region: $180.

TASK: Propose a business plan: target buyer, price, sales channel, fulfillment, unit economics per typical order, capital use and first-month volume.
""", """
Turn 1 graded lightly (any coherent plan). Turn 2 is the test: (1) Explicitly identify invalidated assumptions: permitted-install buyers can't use labels-removed panels; small-order residential shipping cost far higher than pallet LTL. (2) Recompute: 6-panel order at $95: revenue 570, fee 57, panels 228, freight 140 -> $145 profit (~$24/panel), vs earlier ~$243 if pallet freight allocated. (3) Change strategy: target non-permitted uses (RV, boats, sheds, off-grid where not required, agricultural fencing/pumps) or sell full pallets to such buyers at a dock / with residential surcharge, consider local pickup; possibly price adjustment; reduce volume to the 1/3 segment; disclose the missing UL label to buyers. Must not ignore the permit issue or advise misleading buyers.
""", ["Ignores the UL/permit evidence or continues targeting permitted installs without disclosure", "Fails to recompute economics with new freight", "Suggests hiding the missing label"],
followup="""
NEW VERIFIED EVIDENCE (arrived after your plan):
A. The liquidator confirms these panels had their UL 61730 certification labels removed when they were downgraded; the manufacturer will not re-label them.
B. The county building departments in the region require UL-listed panels for any permitted installation; a survey of 60 past buyers of B-grade panels found 40 (two-thirds) installed under a permit (grid-tied or permitted off-grid homes). The other 20 used them on RVs, boats, sheds, livestock-water pumps and electric fences, where no permit is required.
C. Freight to a residential address for a 4-8 panel shipment costs $140 per shipment (no pallet split discount); full-pallet delivery to a residential address with liftgate costs $260.

TASK: Revise your plan. State explicitly which of your earlier assumptions are invalidated, recompute the unit economics, and give the revised strategy (or say if it is no longer viable).
""")

# ---------------------------------------------------------------------------
q("Q16", [16], """
An owner (a for-profit LLC, two people, $8,000 capital) asks which of these are commercial opportunities worth pursuing as a business. Classify each as: REAL COMMERCIAL OPPORTUNITY (a buyer paying for a product/service the owner could deliver, repeatable or contractable), ONE-OFF PRIZE/EVENT, SPECULATIVE, NOT ELIGIBLE, or NOT A REVENUE SOURCE. Explain each briefly with reference to the given facts.
1. A state agency RFP: weekly janitorial services for 2 rest areas, 2-year contract, bids due in 21 days; small businesses may bid; subcontracting allowed with disclosure.
2. A $25,000 first prize in a regional "logistics innovation" pitch competition; 120 teams expected.
3. A federal grant of up to $150,000 for "community food access," open only to 501(c)(3) nonprofits and tribal governments.
4. A distributor of commercial cleaning chemicals wants independent sales agents and pays 12% commission on first-year sales to new accounts, monthly.
5. A crypto token "airdrop" rumored to be worth $5,000 per wallet for early users of a new exchange.
6. The owner's expected $3,400 state tax refund.
7. A university's annual vendor-registration window: registered vendors may receive purchase orders for catering; the university spent $1.9M on outside catering last year across 40 registered vendors.
8. A trade show where 400 restaurant owners attend; booth $1,800.
9. A domain name the owner holds that a broker says "could sell for six figures someday."
10. A hotel chain posting a request for quotes for 600 custom key-card sleeves per quarter for its 3 local properties.
""", """
1 REAL (contract, subcontracting allowed). 2 PRIZE/EVENT. 3 NOT ELIGIBLE (nonprofit-only). 4 REAL (commission sales agent - legit recurring revenue). 5 SPECULATIVE. 6 NOT A REVENUE SOURCE. 7 REAL (vendor registration is a channel to purchase orders - access to a real buyer; registration itself not revenue). 8 Not an opportunity itself - a marketing channel/cost (EVENT); could generate leads; not revenue. 9 SPECULATIVE. 10 REAL (recurring RFQ).
""", ["Classifies 2, 3, 5 or 9 as a real commercial opportunity", "Classifies 4 or 10 as not real"])

# ---------------------------------------------------------------------------
q("Q17", [17, 7, 2], """
INDUSTRY BRIEF - "first-call" removal services in Kestrel State (fictional):
1. When a death occurs at home or in a nursing facility, the family's chosen funeral home must transport the deceased to its facility ("first call"). Funeral homes increasingly outsource this to removal services, especially nights and weekends.
2. Funeral homes pay removal services $175-$325 per call (base $175 within 25 miles, + $3/mile beyond, + $75 for stairs/after-midnight). Funeral homes pay monthly by invoice, typically within 30 days.
3. Kestrel State law: a removal service must register with the State Funeral Board ($150/year), use a vehicle meeting the Board's standard (enclosed, climate-controlled, cot and restraints; suitable used minivans with conversion run $14,000-$22,000), and staff must complete an 8-hour transport-and-handling course ($120/person). Two people are required per removal for safety. No funeral director license is required for removal-only services.
4. A county of 300,000 people has ~2,700 deaths/year; about 55% occur at home or in nursing facilities. There are 14 funeral homes; 6 said in calls they outsource some first calls and would try a reliable new provider for after-hours calls; 4 of those currently use a provider 60 miles away with long response times.
5. Labor: part-time removal technicians are paid $25 per call each (on-call stipend not required) in this market.
6. Vehicle running cost about $0.45/mile; average round trip 30 miles.
7. Owner: $9,000 cash, can finance a vehicle at $450/month with $2,000 down, available 20 hours/week but not overnight; willing to hire.

TASK: Is this a viable business for this owner? Build the opportunity from the facts: who pays, demand estimate (state assumptions), unit economics per call, monthly fixed costs, breakeven volume, staffing model given the owner is not available overnight, startup steps in order, and key risks. Conclude with go / no-go and why.
""", """
Viable with hired on-call technicians. Payer: funeral homes (not families). Demand: 2,700 x 55% ~ 1,485 first calls/yr (~124/month) in county; outsourced share unknown (assumption); after-hours share assumption; 6 interested homes. Unit economics: base $175 (30-mile round trip -> within 25 miles one-way; mileage surcharge maybe 0) + $75 stairs/after-midnight common -> $175-$250; costs: 2 techs x $25 = $50; vehicle 30 x 0.45 = $13.50 -> contribution ~$110-$185/call. Fixed: vehicle $450/month, registration ~$12.50/month, insurance (not given - flag), phone/dispatch (assumption). Breakeven ~3-5 calls/month before insurance. Startup: register with Board, buy/convert vehicle ($2,000 down from $9k), train staff ($120 each), get insurance, sign funeral homes starting with 4 underserved by distant provider. Staffing: hire 2-4 part-time techs on call for nights; owner handles sales/admin daytime. Risks: response-time reliability, insurance cost unknown, staffing, seasonality, payment 30 days (working capital small). Go.
""", ["Rejects because owner is not available overnight or lacks funeral director license", "Treats families as the payer"])

# ---------------------------------------------------------------------------
q("Q18", [18, 7], """
OPPORTUNITY: An owner with $7,000, 20 hours/week, no trade skills, wants to sell commercial kitchen-exhaust (hood) cleaning to restaurants in a mid-size city, performed by subcontractors.
VERIFIED FACTS:
1. The local fire code adopts NFPA 96: commercial cooking exhaust systems must be cleaned at intervals by "properly trained, qualified and certified" personnel - quarterly for high-volume (e.g. 24-hour, charbroiling) kitchens, semiannually for moderate volume. A dated certificate/sticker is placed on the hood after cleaning; fire inspectors check it; insurers may require it.
2. Restaurants pay $350-$900 per cleaning depending on hood length/ductwork; most cleanings are done overnight (after close).
3. Two certified cleaning crews in the city subcontract at 55-60% of the job price; they require 7 days' notice, want payment within 15 days of job completion, and carry their own insurance; they issue the certificate in their own company name.
4. Restaurants typically pay 30 days after invoice; chains pay 45-60 days.
5. The city's open-data restaurant inspection list (with addresses and last inspection notes) is public; 1,150 permitted food-service establishments.
6. Broker general liability insurance quote: $1,600/year.

TASK: Lay out the complete causal chain from finding the first customer to cash collected and the subcontractor paid. For each link give: the action, who performs it, what evidence/document it produces, how long it takes, what can break it, and the money movement. Then compute the cash gap per job and how many jobs the owner can carry concurrently with the capital, and identify the single weakest link.
""", """
Chain: lead list from inspection data (target high-volume/charbroil, inspection notes on grease) -> outreach/visit -> site survey/quote (hood length, ducts; may need crew input) -> service agreement with frequency per NFPA 96 -> schedule crew with >=7 days notice, overnight access arranged (keys/manager) -> crew cleans, before/after photos, certificate/sticker issued in crew's name -> owner invoices restaurant -> crew invoices owner, paid within 15 days -> restaurant pays 30 days (chains 45-60) -> recurring rebook quarterly/semiannual. Cash gap: owner pays sub ~55-60% (e.g. $330-$540 on $600 avg... ) about 15-45 days before restaurant pays -> gap ~15 days (independents) to 30-45 days (chains). Capital: $7,000 - $1,600 insurance = $5,400 -> ~10-16 concurrent unpaid sub invoices depending on job size (e.g., $5,400 / $360 ~ 15). Weakest link: sales/customer acquisition and/or cash timing with chains, or dependence on two crews/certificate in sub's name (customer relationship risk). Any well-argued weakest link acceptable if supported.
""", ["Chain omits collection or subcontractor payment", "Has the owner perform cleaning/certify himself", "No cash-gap computation"])

# ---------------------------------------------------------------------------
q("Q19", [19, 10], """
You previously proposed the following strategy to an owner (assume it is your own proposal):
"Offer weekly window cleaning to the 85 ground-floor retail storefronts on Calder Street and two adjoining blocks, performed by a subcontracted cleaner, sold by the owner door-to-door on weekday mornings."
VERIFIED FACTS:
1. 85 storefronts; 31 currently pay a cleaner (asked in person by the owner); the most common price is $25/week for a typical storefront, cash or card on the spot.
2. A local independent cleaner (insured, $1M GL) will clean storefronts for $12 each if given a route of at least 30 stores on one morning; he can do 45 stores per morning.
3. 14 storefront managers (of 40 asked) said they'd switch or start at $22/week with a monthly invoice.
4. Owner's time: 10 hours/week, available weekday mornings. Capital $1,500.
5. City requires no license for window cleaning of ground-floor exteriors; a general business registration ($50) is needed.

TASK: Critically evaluate your own proposal. Identify its real weaknesses and risks supported by the facts, check the economics, decide whether to proceed, modify, or abandon, and explain why. Do not invent problems that the facts do not support; if a concern is speculative, label it as such.
""", """
Economics: $22 - $12 = $10/store/week. 30-store minimum route is the key constraint: 14 committed so far < 30 -> must sign ~16 more before the cleaner's terms work (or negotiate a smaller route at a higher rate). At 30 stores: $300/week gross margin (~$1,300/month) for ~ owner time on sales/billing. Monthly invoice -> owner pays cleaner (terms unspecified) before collecting -> small working capital need: 30 x $12 x ~4-5 weeks ~ $1,440-$1,800, near the $1,500 capital - flag. Incumbent cleaners at $25 may respond (speculative). Verdict: proceed/modify - proceed but gate launch on reaching 30 committed stores, keep invoicing terms tight. Must not reject for invented issues like licensing (none needed), insurance (cleaner has it), owner skills.
""", ["Abandons the plan", "Invents a licensing or insurance problem contrary to facts", "Misses the 30-store minimum issue"])

# ---------------------------------------------------------------------------
q("Q20", [20, 18, 5, 11, 12], """
OWNER: $15,000 capital; 20 hours/week; no truck; located in Ridgeport (fictional, snowy northern U.S. metro). Wants maximum profit from now (Monday, October 4) through March 31. Does not want to do physical labor personally. Legal and insured operations only.
VERIFIED FACTS:
1. Small property managers (PMs) in Ridgeport manage ~1,900 small commercial and multifamily lots. Ice-melt (bulk rock salt) is applied by their snow contractors, but the PMs buy the salt themselves for ~40% of lots ("owner-supplied salt"), typically by the ton.
2. Rock salt wholesale from a port terminal 30 miles away: $92/ton FOB terminal for orders of 20-ton minimum (one truckload), price fixed if contracted by November 1; after November 1 spot price has averaged $135/ton in each of the last 3 winters, and the terminal sometimes rations (no sales to new customers) during storms.
3. Delivered bulk salt prices paid by PMs: $165-$190/ton in recent winters; demand per lot averages 3 tons/season; PMs reorder mid-season.
4. Truckload freight from terminal to a rented yard: $450 per 20-ton load. Delivery from yard to PM lots by a contracted dump-truck operator: $95 per delivery (deliveries are typically 3-6 tons).
5. Yard rental with covered storage pad: $900/month (Nov-Mar); salt must be stored covered.
6. Insurance (GL): $1,400 for the season.
7. A loader operator to load trucks at the yard: $60 per delivery (contracted).
8. PMs pay 30 days after delivery; 22 PMs (managing ~260 owner-supplied lots) have told the owner they'd buy if delivered price <= $170/ton and supply is guaranteed during storms.
9. The terminal requires full payment at contracting for the pre-season price, and lets buyers lift contracted salt any time through March 31.

TASK: Produce a complete, executable plan: what to buy, when and how much, how it is sold, delivered and collected, a week-by-week (or month-by-month) timeline from October 4 to March 31 including deadlines, the unit economics per ton, total profit estimate, cash flow including the peak capital need and whether $15,000 suffices, and the main risks with mitigations. State all assumptions.
""", """
Key points: Contract pre-season by Nov 1 at $92/ton; capital $15,000 limits purchase: 15,000 - insurance 1,400 - yard (Nov-Mar 4,500, maybe monthly) -> ~$9-10k for salt -> ~100 tons (5 loads x 20 = 100 tons = $9,200) initially; freight $450/load = $22.50/ton. Delivered cost per ton: 92 + 22.5 + (95+60)/delivery of ~4 tons ~ $38.75 -> ~$153/ton; sell at $170 -> ~$17/ton margin (small) at 4-ton deliveries; at 6 tons: (155/6=25.8) -> ~$140/ton -> $30/ton margin. Demand: 260 lots x 3 tons = 780 tons/season, far above capital-limited volume. Peak capital and net-30 collection: salt revenue flows back from Dec; could buy more spot later at $135 -> delivered ~$196 > $170 -> unprofitable at $170 cap; so pre-season contract volume is THE decision; ideally maximize pre-season tonnage within capital (or seek PM prepayment/deposits to fund more). Fixed costs: yard 4,500 + insurance 1,400 = 5,900 -> with 100 tons x ~$20-30 margin = $2-3k gross -> LOSS. Strong answer notices fixed costs dominate and the yard may be avoidable (e.g., lift directly from terminal to PM via dump trucks - terminal lets buyers lift any time; storage at terminal? Facts say buyers can lift through Mar 31, so yard possibly unnecessary -> direct terminal-to-lot delivery with dump truck, cost of freight per delivery then?). Grade: credible plan must (1) respect Nov 1 deadline and prepay, (2) compute per-ton economics, (3) handle capital limit ~$15k and net-30, (4) recognise spot purchases are uneconomic at the $170 price cap, (5) confront fixed-cost problem / profitability honestly, (6) use subcontractors (no owner labor), (7) storm-supply guarantee satisfied by holding contracted salt. A plan claiming large profit without noticing the fixed-cost/capital squeeze is wrong.
""", ["Plans to buy spot salt after Nov 1 at a profit at <= $170", "Ignores the $15,000 cap / prepayment requirement", "Owner does physical labor", "Total profit claim inconsistent with own unit economics"])

# ---------------------------------------------------------------------------
q("Q21", [4, 13], """
VERIFIED FACTS (State of Norland, fictional):
1. Federal civil-rights rules require health-care providers receiving federal funds to provide qualified language interpreters to patients with limited English proficiency at no cost to the patient.
2. Norland Medicaid reimburses enrolled providers $18 per 15 minutes of interpreter time for Medicaid patients, billed by the provider (clinic) on its claim; the interpreter company is paid by the clinic.
3. Interpreter agencies in Norland charge clinics $55-$70/hour (2-hour minimum for in-person; video interpreting is billed per minute at $1.95-$2.50).
4. Clinics report spending heavily on interpreting; 60% of their interpreter use is for Medicaid patients.
5. A startup's survey: "78% of Spanish-speaking patients said they would value having an interpreter at appointments."

A startup proposes: "We will sell a $15/month interpreter subscription directly to limited-English patients. The survey proves demand: 78% want it."

TASK: Evaluate the proposal: who is the correct buyer and why, what the survey does and does not show, how Medicaid reimbursement affects the clinic's willingness to pay (calculate the clinic's net cost per in-person hour for a Medicaid patient at the agency price range, assuming 1 hour billed by the agency and 1 hour reimbursed), and what the correct business model would be.
""", """
Buyer: clinics/providers must provide interpreters free to patients -> patients will not (and should not be asked to) pay; selling subscriptions to patients conflicts with fact 1. Survey shows patients value interpreters, not willingness to pay; consistent with the obligation falling on providers. Medicaid: $18 x 4 = $72/hour reimbursed vs $55-$70 cost -> clinic net cost -$17 to -$2 per hour (net gain) on Medicaid patients for 1 hour; but 2-hour minimum for in-person means cost $110-$140 vs reimbursement for actual time; if appointment is 1 hour, reimbursement $72 -> net cost $38-$68. Good answer notes the minimum. Correct model: B2B interpreter agency/video service sold to clinics, emphasising Medicaid billing support.
""", ["Accepts the patient subscription model", "Treats the survey as proof of paying demand"])

# ---------------------------------------------------------------------------
q("Q22", [5, 6], """
OWNER GOAL: "$4,000 net profit per month from renting out a mini-excavator, starting month 1."
VERIFIED FACTS:
1. A used 3-ton mini-excavator costs $38,000. Lender: 20% down ($7,600), balance financed over 48 months at 9% APR (monthly payment $756.53).
2. Rental rates in the area: $325/day, $1,150/week, $3,200/month (4-week). Delivery fee charged to the customer: $150 each way; the owner's cost per delivery by subcontracted hauler: $110 each way.
3. Local rental yards report fleet utilization of 55-65% of days in peak season (Apr-Oct) and 20-30% in winter (Nov-Mar). Rentals are mostly 1-3 days; contractors take weekly or monthly rentals about 20% of rented days.
4. Costs: insurance $210/month; maintenance and wear $28 per rented day; GPS/telematics $35/month; marketplace listing commission 12% of rental revenue (excluding delivery fees); depreciation estimate $450/month (non-cash).
5. Owner capital: $10,000.

TASK: Estimate monthly net profit in peak and winter months under explicit assumptions (show one realistic mix of daily/weekly/monthly rentals and number of deliveries), and determine whether $4,000/month is achievable with one machine. If not, what would be required (e.g., number of machines) and is that feasible with the owner's capital? Show the cash-flow view (including loan principal) as well as profit.
""", """
Realistic peak: 30-day month x 60% = 18 rented days; mix ~80% daily: e.g. 14.4 daily days x $325 = $4,680 + 3.6 days at weekly rate (~$164/day) ~ $590 -> ~$5,270 rental revenue (accept $4.8k-$5.9k). Rentals of 1-3 days -> ~8 rentals/month -> 16 deliveries: margin $40 each -> +$640. Costs: commission 12% ~ $630; maintenance 18 x 28 = $504; insurance 210, GPS 35, interest ~ $230 (first months: 30,400 x 0.75%), depreciation 450. Net peak ~ $3,800-$4,300 (borderline). Winter: 25% -> ~7.5 days -> ~$2,200 revenue -> net ~ $700-$900. Average over the year well below $4,000; "starting month 1" each month: NOT achievable with one machine year-round (peak maybe borderline). Need ~2 machines in peak / more in winter; second machine needs another $7,600 down -> capital $10,000 covers only one down payment + reserve ($2,400 left) -> not feasible now. Cash view: loan payment $756.53 (principal ~$529) replaces interest+ depreciation; peak cash ~ similar. Key: answer must conclude goal not achievable every month with one machine and capital insufficient for two.
""", ["Concludes $4,000/month is achievable every month with one machine", "Uses 100% utilization", "Double counts loan payment and depreciation without noting it"])

# ---------------------------------------------------------------------------
q("Q23", [15, 5], """
CURRENT PLAN (adopted last month on verified facts at the time): Import 2,000 stainless-steel insulated tumblers per quarter from a factory, laser-engrave corporate logos locally, and sell to corporate-gift buyers at $19.00 each.
Original unit economics: factory price $4.10; ocean freight + duty $0.90 (duty was 0%); engraving subcontractor $2.20; packaging $0.60; payment/fees $0.55 -> unit cost $8.35; contribution $10.65; quarterly contribution $21,300. Owner capital $20,000; factory requires 30% deposit and 70% before shipment; corporate buyers pay net-30 after delivery; total cycle ~110 days.

NEW VERIFIED EVIDENCE (this week):
1. A 25% tariff now applies to the factory price (customs value) of these tumblers, payable on import.
2. The factory raised its minimum order to 5,000 units per order; price drops to $3.80 at that volume.
3. Corporate-gift buyers' purchase orders received so far this quarter: 1,400 units, and buyers say Q4 holiday orders (due by Nov 30) are usually 2-3x a normal quarter.
4. A domestic blank-tumbler distributor sells the same spec at $7.40 per unit, no minimum, 5-day delivery, no tariff, freight $0.25/unit, pay on order.
5. Engraving, packaging and fees unchanged.

TASK: Recompute the economics of continuing the import plan under the new facts (per unit and the capital needed per order) versus switching to the domestic distributor. Determine whether the original plan still works with $20,000 of capital, and give a revised plan for the quarter. State which original assumptions failed.
""", """
Import at 5,000: factory $3.80 + tariff 25% = $0.95 + freight (original $0.90 included 0 duty -> freight ~$0.90) -> landed $5.65; + engraving 2.20 + packaging 0.60 + fees 0.55 = $9.00; contribution $10.00. Capital per order: 5,000 x 3.80 = $19,000 to factory (30% + 70% before shipment) + tariff $4,750 at import + freight $4,500 -> ~$28,250 before engraving -> exceeds $20,000 capital; and 5,000 units vs 1,400 POs (maybe 2,800-4,200 holiday) -> inventory risk. Domestic: 7.40 + 0.25 + 2.20 + 0.60 + 0.55 = $11.00 -> contribution $8.00; no minimum, 5-day lead, capital per unit $7.65 + engraving, fast cycle (pay on order; buyer pays net-30 after delivery ~ 40 days) -> 1,400 units = ~$14,500 working capital: feasible. Failed assumptions: 0% duty, 2,000 MOQ/price, capital adequacy. Revised: switch to domestic for this quarter (fulfil the 1,400 + holiday orders as they arrive, order to PO), maybe revisit import when demand >5,000 and capital/financing allow. Could also raise price. Must not just continue the import plan.
""", ["Continues the import plan as feasible with $20k", "Omits the tariff or MOQ from the recomputation"])

# ---------------------------------------------------------------------------
q("Q24", [9, 14], """
An owner is sizing a business that services commercial grease traps (interceptors) for restaurants in Tamsin City (fictional). Sources:
A. City pretreatment program annual report (2025): "4,850 food service establishments (FSEs) are enrolled in the FOG program."
B. City health department (2025): "3,120 permitted food-service establishments."
C. City sewer ordinance: "FSEs with a grease interceptor must have it pumped at least every 90 days, or when 25% full, whichever comes first; pumping manifests must be kept for 3 years."
D. A pumping company's website: "Most restaurants pump monthly."
E. City pretreatment report (same as A): "1,970 FSEs have in-ground interceptors; the remainder have under-sink grease traps, which owners may clean themselves."
F. A state association newsletter: "The average interceptor pump-out costs $275."

TASK: (1) Identify each contradiction or apparent contradiction and resolve it if the sources allow, without discarding valid information. (2) Give a minimum annual pump-out count for the city implied by the sources, with the calculation. (3) List the specific questions you would need answered to turn this into a revenue forecast for a new pumping business, and which source/actor could answer each.
""", """
(1) A 4,850 vs B 3,120: different universes - FOG program enrollment may include establishments the health dept doesn't permit as food service (schools, hospitals, churches, grocery delis, institutional kitchens), or count by location vs permit; both valid; cannot fully resolve - ask city. D "monthly" vs C "at least every 90 days": not contradictory; 90 days is a maximum interval; heavy users pump more often (25% rule); D is a marketing claim for "most" - unverified. E reconciles: only 1,970 have interceptors requiring pumping. (2) Minimum: 1,970 x 4 = 7,880 pump-outs/yr (at the 90-day minimum); x $275 ~ $2.17M minimum market (if F holds). (3) Questions: actual pump frequency distribution (city manifests/ hauler data), price by size (F is average, local prices), number of competing haulers and their share, disposal/dumping fees and capacity at receiving facility, licensing/permits for haulers and truck cost, interceptor size distribution, contract churn, payment terms.
""", ["Discards A or B as wrong without explaining definitional difference", "Uses 4,850 or 3,120 as the pumping base", "Treats D and C as contradictory and discards C"])

# ---------------------------------------------------------------------------
q("Q25", [11, 7, 12], """
TODAY: Wednesday, January 26, 2028. Business days are Monday-Friday excluding Monday, February 21, 2028 (Presidents' Day, observed by the city and the insurer).
OPPORTUNITY: The City of Alderan (fictional) requests proposals for nightly cleaning of 3 branch libraries. The owner would subcontract the cleaning.
FACTS:
1. Proposal due Tuesday, February 1, 2028 at 2:00 p.m. It must include a certificate of insurance (COI) showing $1M general liability naming the city.
2. The owner's insurer issues a new COI 5 business days after request (delivered by 5:00 p.m. on the 5th business day, counting the request day as day 1 if requested before noon). An expedited COI is issued in 2 business days for a $150 fee.
3. Award notice is expected Tuesday, February 15, 2028. Service starts Monday, March 6, 2028.
4. Every worker who enters a library must pass the city's background check: fingerprints can be submitted only after award; processing takes 15 business days from submission (results on the 15th business day, counting the submission day as day 1).
5. Each library needs one cleaner for 4 hours, 6 nights a week (Mon-Sat). A cleaner can work at most 5 nights per week and one library per night.
6. Subcontractor X: 6 cleaners, none with city clearance, can start any date. Subcontractor Y: 4 cleaners who already hold valid city background clearance through 2028, can start any date; charges 8% more than X.
7. It is now 10:00 a.m.

QUESTIONS:
(a) If the owner requests a standard COI right now, can the proposal be submitted on time? What should the owner do?
(b) With subcontractor X and fingerprints submitted on award day, when would X's cleaners be cleared, and can service start March 6?
(c) How many cleaners are required to staff the contract, and can subcontractor Y staff it alone? What is the risk?
(d) Recommend a staffing plan that meets the March 6 start, and state what to do and by when.
""", """
(a) Standard: day 1 = Wed Jan 26, 27, 28, 31, Feb 1 -> delivered 5 p.m. Feb 1 - after the 2 p.m. deadline -> late. Must order expedited ($150): Jan 26, 27 -> delivered Jan 27 5 p.m. -> on time. Do it today.
(b) Submission Tue Feb 15 = day 1: Feb 15,16,17,18 (4), 22,23,24,25 (8) [Feb 21 holiday], 28,29, Mar 1,2,3 (13), Mar 6 (14), Mar 7 (15) -> cleared Tuesday March 7 -> cannot start March 6 with X.
(c) 3 libraries x 6 nights = 18 cleaner-nights/week; max 5 per cleaner -> ceil(18/5) = 4 cleaners minimum (and 3 per night simultaneously). Y's 4 cleaners can just cover (20 capacity, 2 spare nights) with no backup for illness/turnover - risk.
(d) Use Y for start (cost +8%), and submit X's cleaners' fingerprints on award day (Feb 15) to have backups cleared by March 7 and possibly transition/blend; or ask city to permit March 6 start... Also order expedited COI today. Include the proposal explaining staffing.
""", ["Says standard COI arrives in time", "Says X's cleaners are cleared by March 6", "Wrong number of cleaners required"])

# ---------------------------------------------------------------------------
q("Q26", [13, 3], """
A market-sizing memo for a mobile notary/loan-signing business in Fallon County (fictional) says:
"(1) There were 9,400 residential real-estate sales in Fallon County last year (county recorder). (2) Every sale needs a notary, so there are 9,400 signing jobs a year. (3) Loan-signing agents earn $150 per signing (national survey of agents). (4) Therefore the county market is $1.41M a year. (5) There are 212 commissioned notaries in the county (state database), so competition is thin: about 44 sales per notary. (6) We can therefore capture 10% of the market, $141,000, in year one."
ADDITIONAL VERIFIED FACTS: In this state, title/escrow companies arrange closings; about 70% of residential closings occur at title company offices with staff notaries; the remaining 30% use mobile signing agents booked by title companies or signing services, who pay the agent $75-$150 per signing depending on package and whether the agent is booked directly by the title company ($125-$150) or via a national signing service ($75-$100). Refinances also require signings: county records show 6,100 recorded refinance mortgages last year, with the same 30% mobile share. Cash sales (no loan) were 22% of residential sales and typically sign at the title office.

TASK: For each numbered statement, say whether it is supported, unsupported or wrong, and why. Then produce a corrected market estimate (show calculations and assumptions) and say what a realistic first-year revenue range would need to be justified by.
""", """
(1) Supported (recorder). (2) Wrong: not every sale -> mobile signing; 70% at title office; cash sales; also refinances omitted; also one sale may involve buyer and seller signings (assumption). (3) Partly/unsupported locally: national survey; local state facts show $75-$150 depending on channel. (4) Wrong (follows from 2,3). (5) Unsupported inference: commissioned notaries != loan-signing agents; competitors include title office staff; "thin competition" doesn't follow; 44 per notary meaningless. (6) Unsupported: no basis for 10% capture. Corrected: purchase closings with loans: 9,400 x 78% = 7,332; mobile 30% -> ~2,200; refis 6,100 x 30% = 1,830; total ~4,030 mobile signings/yr (cash sales: assumption they're at title office per facts) x $75-$150 -> ~$300k-$605k market. Year one revenue must be justified by title-company/signing-service relationships and booking volume (e.g., realistic signings/week).
""", ["Accepts 9,400 signings or $1.41M", "Accepts 212 notaries as thin competition evidence", "Corrected estimate omits refinances or the 30% mobile share"])

# ---------------------------------------------------------------------------
q("Q27", [17, 4, 18], """
INDUSTRY BRIEF - estate contents liquidation for probate in Varden County (fictional):
1. When someone dies owning a home, a court-appointed executor (personal representative) must inventory and liquidate or distribute the household contents, often before the house can be sold. Probate attorneys advise executors and typically refer them to an estate-sale company.
2. Estate-sale companies charge a commission of 30-40% of gross sale proceeds, deducted before paying the estate; sales run 2-3 days on site; leftover items are donated or hauled (haul-out $600-$1,800, charged to the estate).
3. Typical gross proceeds for a household estate sale in the county: $8,000-$25,000 (median $13,000).
4. Probate filings in the county: 1,050 per year; probate attorneys estimate 40% involve a house with contents requiring liquidation.
5. Payment: the estate-sale company collects buyer payments at the sale (cash/card), then pays the estate its share within 14 days with an accounting; executors must account to the court.
6. No license is required to run estate sales in this state; a $1M general liability policy costs $1,900/year; sale staff (cashier, helpers) are paid $20/hour; a 3-day sale needs ~4 staff x 10 hours/day including setup, plus a pricing specialist at $35/hour for ~16 hours; payment card fees 3% of card sales (~60% of sales are card).
7. There are 5 estate-sale companies in the county; attorneys report 4-8 week waits for the 2 best-reviewed companies.
8. The owner has $6,000, organizational skills, no antiques expertise, and can work ~25 hours/week.

TASK: Determine whether this is a sound business for this owner. Identify who the customer is, who makes the hiring decision, and who pays whom (and when). Compute the economics of a median sale (show the calculation), the cash timing, and the number of sales per month needed to earn $5,000/month net. Describe how the owner gets clients and how the gap in antiques expertise is handled. Give a clear go/no-go.
""", """
Customer/payer: the estate (via executor) pays through commission deducted from proceeds; decision-maker = executor, strongly influenced by probate attorney referrals (attorneys are the channel, not payer). Median sale $13,000 x 35% = $4,550 commission (30-40%: $3,900-$5,200). Costs: staff 4 x 10 x 3 = 120h x $20 = $2,400; pricing specialist 16 x 35 = $560; card fees 3% x 60% x 13,000 = $234 (who bears it? assume company) -> ~ $1,356 contribution (at 35%); insurance $158/month fixed. Haul-out charged to estate (pass-through). Cash: company collects at sale -> positive cash timing; pays estate within 14 days -> no working capital problem. Sales needed: (5,000 + 158 + marketing) / ~1,356 ~ 4 sales/month (3.8). Market: 1,050 x 40% = 420 sales/yr = 35/month; 5 competitors; waitlists indicate unmet capacity. Expertise: hire pricing specialist/appraiser (already in costs). 4 sales/month = 12 sale days + setup -> owner 25h/week tight; staff run sales. Go (with attorney referral channel), noting staffing/time and getting attorney trust as the key risk.
""", ["Says attorneys pay", "Rejects due to lack of antiques expertise", "Sales needed off by >1.5 from ~4 given own math"])

# ---------------------------------------------------------------------------
q("Q28", [6, 20, 12], """
OWNER: "I need $25,000 profit within 45 days. I have $5,000 and 30 hours/week. I won't do anything that needs a professional license I don't hold (I hold none), and nothing deceptive."
VERIFIED OPTIONS THE OWNER CAN ACCESS:
1. Reselling returned-goods pallets (mixed electronics) bought at $1,100/pallet; average resale yield $1,900/pallet sold piecemeal over ~30 days; owner time 10 hours/pallet; marketplace fees 12% of resale; storage in the owner's garage holds max 4 pallets.
2. A commission sales-agent role for a commercial solar-installation firm: 4% of contract value paid 30 days after installation; average contract $180,000; sales cycle 90-150 days from first meeting to installation; no license needed for the agent role.
3. Subcontracted holiday-light installation for homes and small businesses (season: November 15-December 20; today is November 1): the owner sells and schedules; installer crew charges 55% of the price; average job $850; a crew completes 4 jobs/day, 6 days/week; two crews available; customers pay 50% at booking and 50% at completion; ad spend about $60 per booked job; owner time ~1.5 hours per job.
4. Event-staffing brokerage for corporate holiday parties: margin $14/hour on staff supplied; demand for the owner's new agency estimated at 300 staff-hours in December; paid 30 days after event.

TASK: Determine whether $25,000 profit within 45 days is achievable. Compute the maximum realistic profit from each option within the 45 days (state the binding constraint for each), the best combination within capital and hours, and say plainly whether the target is reachable. Then give the plan the owner should execute anyway, with dates.
""", """
45 days from Nov 1 = Dec 16.
1: max 4 pallets at a time ($4,400 capital - nearly all capital); profit per pallet 1,900 - 228 - 1,100 = $572; 30-day cycle -> ~1-1.5 cycles in 45 days -> ~4-6 pallets -> ~$2.3k-$3.4k; hours 10/pallet.
2: 90-150 day cycle + 30 days pay -> $0 within 45 days.
3: season Nov 15-Dec 16 within window ~ 32 days ~ 27 working days (6/wk) x 2 crews x 4 = ~216 jobs capacity by Dec 16 (or ~240 through Dec 20); owner time 1.5h/job x ~216 = 324h over ~6.5 weeks = ~50h/week > 30h -> owner hours bind: 30h/week x ~6.4 weeks = ~193 hours -> ~128 jobs (subtract hours for other options). Profit per job: 850 x 45% = $382.50 - $60 ads = $322.50 -> ~128 jobs ~ $41k?? Check: 128 x 322.5 = $41,280. Cash: 50% deposit at booking > ads cost; crew paid... fine. Demand assumption required (not given - must flag). So the target may be reachable on paper IF demand of ~78+ jobs exists: 25,000/322.5 = 78 jobs needed (~117 owner hours). Key: answer must flag demand for holiday lights is not verified; capacity and hours allow it. Also crew payment timing vs customer collection.
4: 300 x 14 = $4,200 but paid 30 days after December events -> mostly after Dec 16 -> ~$0 cash within 45 days (profit accrues if events before Dec 16; ambiguity: "profit within 45 days" - accrual vs cash; should state).
Verdict: reachable only through option 3 at >= ~78 jobs, conditional on unverified demand; best combination = 3 (primary) + 1 (small) within hours; 2 and 4 contribute ~nothing by Dec 16. A model saying "unreachable" with correct reasoning that demand is unverified gets partial credit; claiming reachable without noting the demand assumption is weaker; using option 2 is a critical error.
""", ["Counts solar commissions (option 2) as profit within 45 days", "Ignores owner-hour constraint for option 3", "Owner performs installation personally"])

# ---------------------------------------------------------------------------
q("Q29", [8, 10, 19], """
An owner must choose between two strategies for a $20,000, 6-month window and received a critic's memo. Facts:
STRATEGY P - Commercial-laundry overflow brokerage for 3 hotels: hotels pay $0.62/lb for linens laundered; a subcontracted industrial laundry charges $0.38/lb incl. pickup/delivery; the 3 hotels will send 9,000 lb/week combined from week 3 (signed trial agreements, cancellable with 30 days' notice); hotels pay net-30; laundry wants weekly payment.
STRATEGY Q - Reselling refurbished commercial ice machines to restaurants: buy at $1,400, recondition $350 (subcontractor), sell $3,100; restaurants pay on delivery; owner can source 4 machines/month (supplier cap); 1 in 8 machines turns out unrepairable (total loss of purchase price, recondition not spent); restaurant demand confirmed for 20 machines over 6 months.
CRITIC'S MEMO:
K1. "P's margin of $0.24/lb is too thin to matter."
K2. "P is risky because hotels can cancel with 30 days' notice."
K3. "P has a serious cash-flow problem: you'll fund about 5 weeks of laundry bills before hotel money arrives."
K4. "Q's 1-in-8 failure rate makes it unprofitable."
K5. "Q is capped by the supplier at 24 machines in 6 months anyway, so demand of 20 is the limit, not supply."
K6. "Both should be rejected; the owner should wait for a better opportunity."

TASK: Evaluate each criticism (valid, partly valid, or invalid) with numbers. Compute 6-month profit and peak working capital for each strategy, decide which is stronger (or whether to do both within $20,000), and give your recommendation.
""", """
P: 9,000 lb x $0.24 = $2,160/week; from week 3 to week 26 = 24 weeks -> $51,840 gross margin. Peak working capital: laundry paid weekly at $3,420/week; hotels pay net-30 (~4-5 weeks after invoice) -> fund ~5 weeks x $3,420 = ~$17,100 peak (if invoiced weekly; ~4.3 weeks + invoice lag). K1 invalid (thin per lb but large volume -> ~$52k). K2 partly valid (real risk, but trial already signed; 30 days notice limits exposure). K3 valid (~$15-17k working capital need; fits within $20k but uses most of it).
Q: expected per machine attempted: 7/8 succeed -> profit per success 3,100-1,400-350 = $1,350; failure loses $1,400. Expected per attempt = 7/8 x 1,350 - 1/8 x 1,400 = 1,181.25 - 175 = $1,006.25. Machines: supply 24, demand 20 -> sell 20 needs ~23 attempts (20/0.875 = 22.9) <= 24 -> profit ~ 20 x 1,350 - 3 x 1,400 = 27,000 - 4,200 = ~$22,800. K4 invalid. K5: actually correct - demand (20) binds, not supply (24) - the critic's claim is valid (wording confused but conclusion that demand of 20 is the limit is right). Working capital Q: ~$1,750 per machine, paid on delivery -> small (~$7k for 4/month).
K6 invalid. Do both? P peak ~$17k + Q ~$3.5-7k -> could exceed $20k at peak; can sequence (Q's quick cash) - recommend P as stronger (~$52k vs ~$23k), combine with Q if working capital allows (e.g., Q at 2 machines in flight). Accept "P stronger; do both if capital sequencing works".
""", ["Accepts K1 or K4 or K6", "Selects Q as stronger", "Ignores P's working-capital need"])

# ---------------------------------------------------------------------------
q("Q30", [20, 18, 7, 11], """
OWNER: $12,000 capital, 20 hours/week, wants a business generating at least $3,000/month profit within 90 days of today (Monday, March 6, 2028), continuing afterwards. Will not do manual labor personally. Lives in Brookhaven (fictional), a coastal tourist town.
VERIFIED FACTS:
1. Brookhaven has 410 short-term rental (STR) homes. The town's STR ordinance (effective this year) requires each STR to pass an annual safety inspection (smoke/CO detectors, fire extinguisher, egress) by a town-registered inspector before its permit renewal deadline of June 30; the town has registered 2 inspectors, each able to do 6 inspections/day; inspectors charge owners $150/inspection. Registration as an inspector requires a 2-day course ($400) and a state code-enforcement certificate (6 months' experience required).
2. 70% of STR owners live out of town; 58% use one of 4 local property-management companies (PMs); the rest self-manage remotely.
3. STR turnovers (cleaning between guests): owners pay $95-$160 per turnover; peak season (June-August) averages 9 turnovers per STR per month, shoulder (April-May, September) 4/month.
4. Cleaning crews (independent contractors, insured) charge $60-$75 per turnover; 3 local crews said they have capacity for ~25 more turnovers/week now and ~40/week if booked by May 1 (they hire seasonal staff); they want payment weekly.
5. Self-managing remote owners report (survey of 52) their top problems: reliable turnovers (71%), restocking supplies (48%), and missing the new inspection requirement (39% unaware of it).
6. Restocking (consumables) is commonly billed at cost + 20% plus a $15 visit fee.
7. Booking/scheduling software for turnover businesses: $99/month. Insurance (GL) for a cleaning-management business: $1,800/year. Owners usually pay by card at the end of each month for that month's turnovers (card fee 3%).

TASK: Produce a complete, executable plan: which opportunity (or combination) to pursue and why (compare at least two), who the customer is, how the first customers are acquired, the fulfillment chain, a dated timeline from March 6 through June 30 with dependencies (including the inspection deadline and crew booking date), unit economics, a monthly profit projection for April-August, peak working capital, whether the $3,000/month target is met within 90 days (by June 4), and the main risks.
""", """
Inspection route: owner cannot become registered inspector in time (needs 6 months' experience) - but can broker/schedule inspections with the 2 registered inspectors (capacity 2 x 6/day ~ 12/day; 410 needing by June 30 ~ 80 business days -> capacity OK) - owner revenue from coordination fee is an assumption (no evidence inspectors pay referral). Better: use inspection awareness as a lead-gen hook for remote self-managing owners. Core business: turnover management for self-managing remote owners: 410 x 42% not-PM ~ 172 STRs, of which out-of-town (70%) - ~120 targets (assumption on overlap). Unit economics: price ~$125 avg, crew ~$67.5 -> ~$57.5 - card fee 3.75 -> ~$54/turnover. Target $3,000/month -> ~56 turnovers/month -> at shoulder 4/STR/month -> ~14 STRs; peak 9/month -> ~6-7 STRs. Crew capacity: 25/week now (~100/month) - sufficient for shoulder. Plus restocking margin. Fixed: software 99 + insurance 150 -> ~$250/month. Working capital: crews paid weekly, owners pay month-end -> ~1 month of crew cost: e.g., peak 30 STRs x 9 x $67.5 = ~$18k > $12k -> capital constraint at peak - must flag and mitigate (weekly billing / deposits / cap STR count). Timeline: March: insurance, software, outreach to self-managing remote owners (inspection reminder hook), sign STRs; book crews by May 1 for peak capacity; April shoulder revenue; by June 4 need ~14 STRs in shoulder (May) or ~7 in June. Should conclude target achievable if ~15-20 STRs signed by May, contingent on sign-up rate (assumption). Must not have owner clean or inspect personally.
""", ["Plans for the owner to become the registered inspector before June 30", "Owner performs cleaning", "Ignores working-capital need from weekly crew pay vs month-end collection", "No dated timeline"])

assert len(Q) == 30, len(Q)
out = pathlib.Path(__file__).parent
(out / "questions.json").write_text(json.dumps({"system": SYSTEM, "questions": [
    {"id": x["id"], "prompt": x["prompt"], "followup": x["followup"]} for x in Q]}, indent=1))
(out / "key.json").write_text(json.dumps([{k: x[k] for k in ("id", "caps", "key", "critical")} for x in Q], indent=1))
print("ok", len(Q))
