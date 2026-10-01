# Handoff — overnight revenue integration (2026-10-01)

Branch `claude/v5-overnight-revenue-hxf1gz`, based on `production` @ `0041975`
(which is what production serves: `SERVING_REVISION 00419753…`, read 15:43Z).
Nothing here is deployed. A person merges it into `production`; `Deploy` ships it.

## What the branch carries

| Source | What it does for the commercial journey |
| --- | --- |
| PR #69 (`fcp_0de77e…`) | A crashed or timed-out external effect is reconciled, never resent |
| PR #71 (`fcp_7f9811…`) | A hold in another currency no longer reduces this sprint's deployable cash |
| PR #42 (`fcp_943652…`) | Brain records "contacted the buyer" only on a provider receipt (`cash/effects.ts`) |
| PR #45 (`fcp_a90370…`) | A person records quote / invoice / payment-accepted after the first move |
| PR #46 (`fcp_89c081…`) | Re-offer, exhaust and archive controls on the Cash page |
| PR #48 (`fcp_316b42…`) | Commit spend under the grant, release it, settle it, from the Cash page |
| PR #44 (`fcp_a147a6…`) | An idea parked for want of research authority resumes when the grant exists |
| PR #43 (`fcp_57fc1d…`) | Every research kernel opens a question and records its round atomically |
| `bcfac5c` (new) | A READY/EXECUTING piece shows a sendable offer composed only from its card, refusing with a named list when a load-bearing field is blank; owner view only |
| `06877c5` (new) | "Money is in" (`COLLECTED`) refuses until a `SETTLEMENT` on that opportunity, net of refunds, is on the ledger; the page records a payment and a settlement per piece |

Conflicts resolved: `Cash.tsx` (Actions: #45's authority-disabled controls + #46's
reoffer project picker), `cashApi.ts` (#48 `settleCommitment` + #45 `act` docs).

## Verification

- `npm run typecheck`: clean.
- `npm run test:impacted --base origin/production` (SQLite): 41 files, 970 passed,
  1 skipped — on the eight merged PRs. Then the settlement/offer changes:
  `cashMode`, `cashIntegrationPass`, `cashHttp`, `cashDeploymentSmoke`,
  `russellNervousSystem`, `step12bProduct`, `cashSection`, `cashOffer`,
  `sharedCashAccess` all green.
- Postgres impacted run: see the PR description for the result.
- The full gate runs once on `production` after merge (`Postgres suite`, `Deploy`).

## The journey, as it now stands on this branch

discover → qualify (deep dive) → card → READY → **sendable offer** → person sends
it and records the first move → quote / invoice / payment accepted recorded →
delivering → **customer payment + settlement recorded on the piece** → money is in.
Every step after "READY" is a person acting outside Brain and Brain recording it
with references. Brain itself sends nothing: no messaging or invoicing adapter
is registered, so `SEND_A_MESSAGE` and invoicing read `MISSING`.

## What still prevents a first real commercial attempt

1. **Merge + deploy** this branch (a person; `production` is the only deploy path).
2. **A qualified opportunity.** Production reported 0 qualified / 0 ready (§47).
   Deep dives are bounded at 2 in flight; not raised tonight on purpose.
3. **A commercial authority grant** on the operating project, naming
   `CONTACT_BUYER`, `QUOTE_AND_INVOICE`, `ACCEPT_PAYMENT` — a person's decision
   on the Cash page.
4. **Provider choice** for Brain-performed messaging / invoicing (not established
   in the repo). Until chosen, the person sends the offer and Brain records it.
5. Production reading, 2026-10-01 15:44Z (`Cash report` run 36886582426, serving
   `0041975`): Cash Mode 1 (`prj_22fb4fec295f403a8a22`) ACTIVE, USD; research
   grant ACTIVE; **commercial authority ABSENT**; 100 ideas, all QUEUED. The report
   then died inside `cashRoadmap` on its own one-client pool's ten-second wait —
   fixed on this branch in `scripts/cash-report.sh` (the `factory.sh` remedy:
   sixty seconds of patience, not more clients). Opportunity/tier counts were not
   reached, so "0 qualified" is still the §47 reading, not tonight's.

## Not taken, deliberately

- PR #36 (Russell → software delivery back into the thread): sound, not on the
  money path; left for its own review.
- Remaining Factory PRs (#40–#87 not listed above): correctness work, not merged here.

## Next executable task

Merge this branch's PR, deploy, read `Cash report`, then grant commercial authority
and take the top qualified piece through the offer card.
