# Cash Mode: cheap commercial screening before deep research

`server/services/cash/screening.ts` decides, from rows Brain already holds, whether an opening has earned an expensive look. It is the module behind CLAUDE.md §59.

## Why it exists

Production, Cash Mode 1, 2026-10-08, read with `closeout-report` (`refinement`) on revision `18152b3`:

- **40 openings**: 37 `BLOCKED`, 1 `RUNNING`, 1 `PENDING`, 1 `NEEDS_PERSON`.
- **31 had spent both deep dives** (`ROUNDS_SPENT`). Most of those dives ended `mission=FAILED packet=CANCELLED` after 3–8 research passes.
- **Each dive was the full fourteen-question qualification.** The subjects were mostly a vendor's own price list (GoTranscript, Rev, Verblio, WriterAccess, Depositphotos, Adobe Stock), a resale listing (Coachella, FIFA, sneakers, trading cards) or a domain appraisal (dujo.com, VJN.com).
- **All 8 live research missions holding the grant were needs-path follow-ups** about those same price lists, for example "Exposure for Verblio…" and "Direct costs: Arbitrage — Air Jordan…".

Before screening, every eligible opening got the full dive. Every signal also raised three needs (payer, access, buying evidence), and every candidate raised one need per blank. Each need is its own research mission.

## What it decides

Screening applies to each live opening (`DISCOVERED` or `EVIDENCE_CARD`). It checks the rules below in order and returns one verdict.

| # | Rule | Verdict | Reason |
|---|------|---------|--------|
| 1 | The opening's recorded `expires_at` has passed | SCREEN_OUT | `OPENING_EXPIRED` |
| 2 | The economics owner's verdict (`tier.ts`) is NEGATIVE | SCREEN_OUT | `ECONOMICS_NEGATIVE` |
| 3 | An accepted NEGATIVE_EXISTENCE claim from one of its dives shows that a field the kind depends on (exit, acquisition, payer) does not exist, and nothing has answered that field since | SCREEN_OUT | `ESTABLISHED_ABSENT` |
| 4 | The same signal kind from the same source host was **declined by a person** (timed by the decline's own event), or read NEGATIVE by the economics owner, and no decisive EVIDENCE or PERSON fact has been recorded on this opening since | SCREEN_OUT | `MECHANISM_REJECTED` |
| 5 | The economics owner's verdict is POSITIVE | PRIORITIZE | `ECONOMICS_POSITIVE` |
| 6 | Every gate in the kind's ladder is answered | PRIORITIZE | `GATES_ANSWERED` |
| 7 | A one-question round was answered | PRIORITIZE | `DECISIVE_QUESTION_PASSED` |
| 8 | The decisive question was asked narrowly (a targeted round or a need whose research ran a completed pass) and nothing answered it, or a documented search found it does not exist, or no path is left that could ask it | PARK | `DECISIVE_QUESTION_UNANSWERED` |
| 9 | A dated direct-demand signal with a known payer | PRIORITIZE | `DIRECT_DEMAND_PAYER_KNOWN` |
| 10 | Anything else | TARGET | `DECISIVE_UNKNOWN` |

What each verdict spends:

- **PRIORITIZE** gets the full deep dive and takes a slot ahead of TARGET.
- **TARGET** asks its one decisive question exactly once:
  - as a need, if the question is a card field (payer, access, buying evidence);
  - otherwise as a one-question dive, using the same phrases the full question uses, so it passes `RUSSELL_CASH_VALIDATION_V1`'s screen.
- **PARK** and **SCREEN_OUT** spend nothing. The opening raises no new needs, and its open needs are deferred (left open, with no candidate), not closed.

### The decisive ladder

Each kind's ladder is its `doesNotEstablish` turned into questions, cheapest first. Existence questions (is it still open, does anything actually sell, who pays) come before estimation questions (what it costs, how long it takes).

- `PRICING_OR_INFORMATION_ASYMMETRY`, `RESALABLE_ASSET_OPENING`: exit evidence → acquisition → direct costs → payer
- `ACTIVE_BUYER_DEMAND`: payer → access → eligibility → price → costs
- `PAID_TASK_OR_CONTRACT`: payer → eligibility → price → costs → hours → scaling lever
- `EXPIRING_OPENING`: still open → payer → eligibility → price → costs
- `SUPPLY_DEMAND_MISMATCH`: payer → acquisition → eligibility → price
- `RECURRING_OUTSOURCED_WORK`: payer → price → costs → scaling lever

### What is deliberately *not* a rejection

The first version had three of these wrong, and an independent review caught them:

- **An archived opening.** Archiving also closes a deal that delivered and was paid for. Reading it as a rejection would screen out the next opening of the kind that worked.
- **An established absence.** "dujo.com has no recorded sale" is a fact about one domain, not about every domain on Afternic. It stops that opening and spreads to no other.
- **A need whose mission failed.** A mission that failed because the fleet was quarantined, or that somebody stopped, asked nothing. Only a `DONE` mission whose packet ran a completed pass counts as having asked.

### The two-round cap, stated plainly

A one-question dive is a round, and an opening gets `MAX_VALIDATION_ROUNDS` (2).

- **If the one question is answered**, round 2 is the full qualification (`DECISIVE_QUESTION_PASSED`).
- **If it is not answered**, the opening parks and the full qualification is never bought. This is the intended saving.
- **The cost:** an opening whose cheap question found nothing does not get a broad second look unless new evidence answers that question.

## What it never does

- **It invents no threshold.** No rule reads a price as a reason to look or not to look. This Brain has no approved "too small" figure, so the screen has no such rule.
- **It does not re-derive economics.** That is `tier.ts`'s job, and another workstream is extending it to carry `economics` and `route`. `economicsOf` reads those fields structurally. When they are absent, the reading is null, and null screens nothing out.
- **It moves no state, tier or card.** The tier meanings (SIGNAL → CANDIDATE → QUALIFIED → READY_TO_TEST) are unchanged.
- **It touches no evidence gate.**
- **It matches no prose.** Rejection keys are the signal kind plus the source URL's host, so two transcription marketplaces are two keys.

## Measuring it

`npm run report:refinement`, or `closeout-report` with `what=refinement`, prints a `COMMERCIAL SCREENING` section with:

- the verdict, reason, decisive question and asker for every opening;
- tier counts;
- **before/after**, split at the project's first `CASH_OPPORTUNITY_SCREENED` row: dives started (per day), one-question dives, research passes, passes per dive, and question needs raised;
- how many openings currently spend nothing, and how many open questions are deferred.

The report claims no saving until a dive has started after screening began.
