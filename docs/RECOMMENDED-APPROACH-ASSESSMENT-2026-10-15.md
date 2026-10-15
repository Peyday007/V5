# Recommended Approach — assessed against Cash Mode 1

**Date:** 2026-10-15. **Serving revision:** `1c61b18` (`SERVING_REVISION`, printed by the
reports below). **Project:** Cash Mode 1, `prj_22fb4fec295f403a8a22`.

The report's recommendations were treated as hypotheses and checked against the
code and production rows. Every figure here comes from one of these committed,
read-only reports, run at 23:48–23:53Z:

- Cash report run 94 (and run 93, 2026-10-14 21:48Z)
- Closeout report run 123, `what=refinement`
- Packet report run 150, `orc_2f0e2c0ae00f461fb612`

## What the report gets wrong about this Brain

| Report assumption | What is true |
|---|---|
| Etsy functionality exists or can be relied on | The word `Etsy` appears nowhere in `server/` or `client/`. No Etsy adapter, capability or envelope exists. |
| Etsy payments and our Stripe integration are the same thing | `TAKE_A_PAYMENT` and `ISSUE_AN_INVOICE` are Stripe adapters (§54). They take payment from *our* buyer. Not one of the three paths below depends on them: Artisanal Sudoku pays contributors by PayPal or Venmo, and the payment would be recorded by a person. |
| Research audit admission gates commercial action | `auditAdmission.ts` decides which *session* may argue an audit role (§23). Commercial action is gated by the commercial grant (`cash_authorities`, §30). That grant reads `commercial_grant=ABSENT`. These are separate rules, and neither should be changed because of the report. |

## The three paths

### 1. Strongest real opening: Artisanal Sudoku, `cop_665f0a845f984d168461`

- **Decision supported:** submit an original puzzle for a published $50 per
  accepted puzzle. The route is email or Discord, with no phone call.
- **Evidence:** dive 1 (`orc_2f0e2c0ae00f461fb612`) produced 7 accepted claims
  across 7 lanes. Its audit read `PASS`, with three distinct sessions plus the
  author. The opening moved from SIGNAL to CANDIDATE, answered 13/17.
- **Execution vs waiting (dive 1):**
  - Approved 00:12Z. Attempt 1 was blocked by `ENOTFOUND
    artisanalsudoku.substack.com` (surface DNS). Attempt 2 was accepted.
  - Synthesis finished 02:02Z.
  - PRIMARY ran at 02:03Z, then ADVERSARIAL at 02:46Z: **43 minutes waiting for a
    distinct session**. JUDGE ran at 02:57Z.
  - The bin used 4 of 5 attempts and had 5 session refusals.
- **Execution vs waiting (dive 2, `orc_aca8bfb9c38947059e4b`):** it waited 62
  minutes before its mission started and settled 2 hours after starting.
- **Repeated work in dive 2:**
  - Attempt 1 hit the same DNS failure.
  - The repair plan then told attempt 2 that "corroboration is missing". Attempt
    2 read that as a demand to corroborate a publisher's own submission terms
    with an independent source, which no other source can do, and blocked on it.
  - Cause: `buildRepairPlan` reported a zero-claim reading failure as a
    corroboration failure. **Fixed here.**
  - Dive 2 also never asked the fields that were still blank.
- **What changed:** the card's payer, access, eligibility, disqualifiers and
  timing went from blank to sourced.
- **Exact condition preventing the next action:** `to advance: delivery,
  directCosts, requiredCapital, recommendation`.
  - **Delivery:** `deliveryReading` withholds it because nothing records what
    delivery needs (`requiredCapabilities=[]`, no labor tasks). The honest answer
    is a gap in capability, not missing research. The puzzle kernel generates
    *classic* sudoku only, and Artisanal wants *variant* puzzles, original work,
    submitted as an F-Puzzles or SudokuMaker link.
  - **Direct costs:** no lane answered them. Nothing is bought to make a puzzle,
    so no source publishes that cost. `requiredCapital` and `recommendation` are
    both composed only from a stated cost, so they stay withheld.
  - Behind the card sit `commercial_grant=ABSENT` and `SEND_A_MESSAGE` for a
    Brain-sent email. A person could submit by hand today.

### 2. A completed task that changed nothing commercial: Campo Brokers, `cop_6ec9dafa33f44c268b1d`

This is the portfolio's **only READY piece**, and it was readied by Brain
(`CASH_OPPORTUNITY_READY=1`).

- **Its own card reads "USD -795.00 expected, being USD 5.00 less USD 800.00".**
  - The "price" of $5 is Campo's annual membership fee, read out of the buying
    signal's own fee schedule.
  - The opening is a broker's sales page, not a request to us.
- **Three dives**, each lasting about 17 minutes. All three were `FAILED` with no
  fragment clearing the gate. The card was still completed from facts on
  BLOCKED fragments.
- **The economics line has always said "a reason to decline". Nothing read it.**
  - `markReady` and `cashTier` never consider whether the margin is negative.
  - With a commercial grant in place, `advanceWithinAuthority` would have
    contacted someone about it next.
- **It is now also drawing research.** One of the five live research
  reservations is a monetization commission about it ("Required capability:
  Brokerage — Campo Brokers", `rrv_60448dbe…`). Two more are about the VJN.com
  domain appraisal, which is likewise a market fact rather than a request to us.
- **Fixed here:** Brain neither readies nor contacts for a piece whose own
  `price − exposure ≤ 0`. A person may still decide otherwise.

### 3. Stalled and repeated: St. Louis bid 2027BID000006 (welding and metal fabrication)

- **The opening is held 9 times**: `cop_fd265ed8…`, `cop_ba754728…` and 7 more.
- **Two of the records were each dived twice:**
  - Both records were dived before the duplicate pass reached them.
    `markDuplicateOpenings` "never marks one whose dive has started".
  - `cop_fd265…` failed both rounds on surface egress (`www.stlouis-mo.gov`:
    proxy 403 / DNS) from Brain Research 1-C, 1-D and Caleb 3-A.
  - The first pass of round 1 waited 4 hours.
  - Round 2 repeated the same blocked host, and its second attempt was refused
    as a duplicate submission.
  - `cop_ba75…` read the bid from a different surface. It was dived on
    2026-10-14 23:16Z, after the bid closed on 2026-10-13. It is now NEEDS_HUMAN
    on a judge `MORE_RESEARCH` asking for price, cost and effort on a closed bid.
- **What changed:** nothing commercial. The work is a welding contract that Brain
  cannot deliver.
- **What prevents a next action:** the bid has closed. Even before it closed,
  delivery needed physical work, which `deliveryReading` withholds. Nothing asks
  that question *before* a dive is spent.

## Demonstrated bottlenecks

**Execution failures**
- Source access from surfaces. Over the last 7 days, 264 of 892 judged fragments
  were blocked on `SOURCE_ACCESS`: DNS failures, provider-denied hosts,
  unreadable pages. These are attributed per Routine in the cash report. A
  repair attempt reruns on any surface, including one that just failed that
  host.
- Distinct-session waits during audits: 43 minutes in dive 1, and 5 session
  refusals.
- Queue waits before a mission starts: 62 minutes to 15 hours across dives.
  Both refinement slots are held, and 24 openings are eligible and waiting.

**Research quality**
- A repair misdiagnosed a reading failure as missing corroboration. **Fixed.**
- A seller's own fee schedule was read as the price we would be paid.
  `answers.ts` takes figures from the buying-signal text for every signal kind.
- A closed bid was dived after it closed. The expiry was not set on that record.

**Decision rules**
- A piece with negative economics was readied and would have been contacted.
  **Fixed.**
- Duplicate openings are dived independently once both dives have started.
  There are 133 duplicate records.
- Nothing checks whether Brain can deliver before spending a dive. Welding,
  NEH grants for nonprofits and employment listings were all dived. 18 openings
  were later DISQUALIFIED.
- No lane can answer a zero-input cost, so a puzzle submission can never reach
  QUALIFIED.

**Commercial capability gaps**
- `commercial_grant=ABSENT`. This is a person's decision and was not touched.
- The variant-sudoku authoring the strongest opening needs. Brain generates and
  validates classic sudoku only.
- `SEND_A_MESSAGE` for a Brain-sent submission. This is **not** a prerequisite: a
  person can submit by email.

## Smallest justified changes, ranked

1. **Done.** Decline Brain's own readying and contacting when the card's
   `price − exposure ≤ 0` (`declinedOnEconomics`, `operate.ts`). This removes
   the one false READY and the research it pulls in.
2. **Done.** A repair after an attempt that read nothing names the reading
   failure (`repair.ts`).
3. Ask whether Brain can deliver *before* a dive. Read `deliveryReading`'s
   physical or `MISSING` verdict in `whyNotDiving`, so the slot goes to openings
   Brain could fulfil.
4. Read price only from buyer-side signals. In `proposeTerms`, take figures from
   the buying signal only for the buyer-request family, not from a seller's own
   fee schedule.
5. Let a documented "nothing is bought to do this" answer `directCosts` (a
   `NEGATIVE_EXISTENCE` claim in `cost_evidence` already answers it, because
   `ABSENCE_IS_NOT_AN_ANSWER` holds only `payer`). Ask that lane by name in the
   second-round dive question instead of rerunning the whole qualification.
6. Prefer a different surface for a repair attempt after `SOURCE_ACCESS` on a
   host. The per-Routine attribution already exists.

None of these is whole-fleet recovery, a new integration or a rewrite. For the
Sudoku opening specifically, the next commercial step can be taken by a person
today: author one original variant puzzle and email the link. That needs no
grant change, no Stripe and no Etsy.
