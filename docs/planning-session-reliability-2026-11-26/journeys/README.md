# Two complete planning journeys (2026-11-27)

Both journeys ran on Brain's real MCP router (`scripts/planningMcpHost.ts`), each on an isolated world. Each used:
- **One author session**, standing in for the owner's Claude app session, holding operator scopes on the project.
- **One fleet worker** holding only the research connector set, like the owner's existing workers. It was never told
  which goal or revision to work on. It only claimed `PLAN_REVIEW` / `PLAN_VERIFY` items from Brain's queue and followed
  each item's payload.

Nobody passed revisions between sessions. The author read every verdict from `brain_planning_state`.

## Journey 1: an objective with established opportunities (`j1-*.json`)

- **Objective:** fx-17, marina shrink-wrap, $8,000 in 40 days with no up-front capital. Three written acceptances and a
  quoted supplier are on record.
- **Path:**
  1. The session called contract, run_brain and context, then submitted a revision.
  2. Brain refused it with `CAPABILITY_NOT_HELD`: a separate ORDER step needed PAY_A_SUPPLIER, which Brain does not
     hold. The author moved the supplier payment into the delivery step and resubmitted; the check was clean.
  3. Brain queued `PLAN_REVIEW`. The fleet worker claimed it, reviewed and recorded PASS, then completed the item.
  4. The author finalized.
- **Published:** `rev_04068c407b1e_13c8a5`, **EXECUTABLE**. $9,600 is collected by day 14. Harbor Wrap is paid its
  $1,400 per marina from settled receipts, with $0 capital. Review wait: 21.5 minutes, most of it the fault below.
- **Reviewer's notes (not blocking):**
  - The supplier has not confirmed its timing or payment terms in writing.
  - Messaging and invoicing are not connected.

## Journey 2: the owner's objective with no supplied opportunities (`j2-*.json`)

- **Objective:** the owner's $10,000-in-30-days brief, verbatim. The world held **no openings**.
- **Path:**
  1. The session created the goal with `brain_operator_create_goal`, then recorded the contract.
  2. It discovered routes from public sources and admitted two, after the refusals listed below:
     - SEO blog packages for US small businesses, written by Textbroker;
     - print-on-demand t-shirts on Etsy, made by Printful.
  3. It researched two decisive questions with real sources. Brain queued `PLAN_VERIFY` for each.
  4. The fleet worker opened the sources and verified both claims through the evidence gate. Both were **rejected on
     population and definitions**: an EFA freelancer rate survey is not what US small businesses pay; Etsy's total
     buyers are not holiday-gift shoppers. Nothing unverified reached a card.
  5. The first clean revision (CONDITIONAL) was reviewed by the fleet worker: **REVISE, with 3 formal conditions** (price,
     supplier cost, fulfilment), each citing its record. The author accepted all three against the records.
  6. The NO_PLAN revision was clean and the fleet worker passed it. The author finalized.
- **Published:** `rev_d3e0d4b02959_317031`, **NO_PLAN**.
  - **Decisive links:** CURRENT_DEMAND, OFFER_AND_PRICE, ECONOMICS.
  - **Experiment:** $150 inside the $300 pre-proof cap. Read Textbroker's checkout price, warm two sending domains, then
    offer 1,000 US small businesses four SEO posts for $1,000 prepaid.
  - **Proof:** at least one paid checkout by day 22, with Textbroker's cost at or below $250 per package.
  - **Stop and continue:** both rules stated. The plan says plainly that even a successful test leaves about 8 days,
    so the $10,000 is unlikely in this window.
- **Reviewer's notes:**
  - Textbroker does publish client prices (from 2.3¢ per word), so supplier cost can be settled by desk research before
    any money is spent.
  - More openings with an existing buying signal should be sought.

## Each failed operation, its cause, the fix and the retry

| journey | failed operation | cause | fix | retry |
|---|---|---|---|---|
| both | planning writes from a connector worker | the owner's connector (`worker-05`) holds `operator:act` on no project | `npm run admin -- access grant-planning` (prepared; production needs the owner) | on the isolated world, the author held operator scopes |
| both | independent review / verification | needed `operator:act` and a second session the owner switches to | queue-dealt `PLAN_REVIEW` / `PLAN_VERIFY`; a lease authorises one review or verification; completion requires the recorded verdict | both journeys reviewed and verified by a fleet worker with research scopes only |
| 1 | fleet worker's `brain_claim_work` | refused: "brain-only mode: Claude routines take only Brain-improvement work". No bin owns planning items, so §84's project rule denied them | §118's owner-directed exception now admits these two item types for an owner-directed goal only (tests with controls) | claim succeeded; review recorded; item completed |
| 2 | the same claim, after that fix | the goal created through the connector has no owner (a worker carries no person identity), so it is not owner-directed | **the owner's step:** take ownership of the goal (`PATCH /api/goals/<goal>/terms` with `ownerUserId`); done here through the same `setTerms` service | items admitted; both verifications and both reviews completed |
| 1 | `brain_planning_submit_revision` | an ORDER step needs PAY_A_SUPPLIER, which Brain does not hold | correct refusal; the author restructured | clean on resubmit |
| 2 | `brain_planning_admit_routes` | the refusal "mechanism … is not one Brain records" named no accepted value, so the author read server source | the refusal now lists every accepted mechanism | retried with a wrong mechanism: the refusal names all 13 (`j2-admit-mechanism-retry.json`) |
| 2 | `brain_planning_admit_routes` | "Brain performs it, but it is none of the deliverables Brain has proved" | correct refusal | resubmitted with named fulfillers; admitted |
| 2 | `brain_planning_submit_revision` | 7 problems (5 unstated disagreements with Brain's links, 2 steps missing fields) | the checks working as designed | clean on resubmit |

**Not shown by these journeys:** the Claude app itself. Production's connector serves no `brain_planning_*` tool until
the branch is deployed. See `../app-readiness.md`.
