# Brain's research process, mapped and read against production (§88)

Owner's order, 2026-11-04: map what a reliable autonomous research system needs,
compare every requirement with production, fix the connected gaps together,
make it reusable, and prove the whole process on production.

The map is `server/domain/capabilityMap.ts`; production reads it with
`admin capabilities show [hours]` (Admin workflow). Every figure below was
printed by production; none is estimated.

## 1. Before the fixes (readings 2026-11-04 23:39Z – 2026-11-05 00:05Z)

| reading | value | source |
|---|---|---|
| source reads, 24 h | 12 readable of 37 | `sources show 24` |
| largest failure class | 404 on official deep links that never existed (sba.gov, census.gov, gsa.gov, business.gov.au, nasscom.in) | `sources show 24` |
| free-lane fragments, 24 h | 10 submitted of 99 settled; NO_READABLE_SOURCE 40, PROVIDER_EXHAUSTED 26, CITATION_DROPPED 21 | `improvement show` |
| free lane activity 20:56Z → 00:05Z | **none**: 0 leases, 0 attempts, 34 commercial items queued | `free-lane show`, production log |
| improvement objectives | every one inferred HIGH risk ("Measured in production"), so none auto-released; HELD "closed without merging" | `improvement show`, `inferRisk` |
| rejected claims "without a reason" | 373 / 7 d — unjudged claims counted as rejections | `improvement show`, `scoreboard.ts` |

## 2. The first full assessment (2026-11-05 00:53Z, 24 h window, mostly before release)

`{"WORKING":9,"BROKEN":10,"MISSING":0,"UNPROVEN":5}`

| stage | requirement | answer | reading |
|---|---|---|---|
| INTAKE | INTAKE.PLAN | WORKING | 41/42 |
| DISCOVERY | DISCOVERY.SEARCH | BROKEN | 1/76 (search shipped minutes before) |
| DISCOVERY | DISCOVERY.READABLE | BROKEN | 36/76 |
| ACCESS | ACCESS.READ | BROKEN | 55/127 (external part: bot walls) |
| ACCESS | ACCESS.ROUTINE_FETCH | UNPROVEN | 3 attempts |
| EXTRACTION | EXTRACTION.CITED_CLAIMS | BROKEN | 11/36 |
| EXTRACTION | EXTRACTION.ACCEPTED | WORKING | 79/132 |
| VERIFICATION | VERIFICATION.REASONS | WORKING | 53/53 |
| VERIFICATION | VERIFICATION.GATE | BROKEN | 39/141 (behind discovery/extraction) |
| VERIFICATION | VERIFICATION.ITEMS | WORKING | 51/51 |
| ANALYSIS | ANALYSIS.SYNTHESIS | WORKING | 37/37 |
| ANALYSIS | ANALYSIS.AUDIT | WORKING | 102/108 |
| ANALYSIS | ANALYSIS.FILED | UNPROVEN | 1 attempt |
| DECISION | DECISION.JOB_OUTCOME | BROKEN | 1/5 (behind the gate) |
| DECISION | DECISION.AUTONOMOUS | UNPROVEN | 3 attempts |
| DELIVERY | DELIVERY.WRITEBACK | UNPROVEN | 1 attempt |
| RECOVERY | RECOVERY.RETRY | BROKEN | 74/130 |
| RECOVERY | RECOVERY.LEASES | WORKING | 1268/1268 |
| RECOVERY | RECOVERY.PROVIDERS | BROKEN | 130/760 (external: free-provider quotas) |
| RECOVERY | RECOVERY.STALLS | BROKEN | 20/54 |
| RECOVERY | RECOVERY.IDLE_CAPACITY | BROKEN | 22/33 |
| LEARNING | LEARNING.DETECT | WORKING | 5/5 |
| LEARNING | LEARNING.DELIVER | WORKING | 2/3 |
| LEARNING | LEARNING.METHODS | UNPROVEN | probe unreadable (fixed in #506) |

Connected gaps, ranked: ACCESS.READ and DISCOVERY.SEARCH first (13 and 12
requirements downstream); the gate, extraction, decision and delivery gaps sit
behind them.

## 3. What was fixed (#505, #506)

1. Discovery (missing): keyless web search, rotated across two endpoints, tried
   before remembered URLs; a SEARCH route answers a dead deep link with the
   site's own page.
2. Idle capacity (broken): `claimWork` pages past declined rows; the lane
   records `FREE_LANE_IDLE` with its decline reasons.
3. Learning delivery (broken): improvement risk from mutation scope.
4. Repairs (broken in the free lane): repair strategy and guidance reach it.
5. Measurement (broken): only judged claims count as unexplained rejections;
   every probe is tested against the real schema.

## 4. After the release

(filled from production readings below)
