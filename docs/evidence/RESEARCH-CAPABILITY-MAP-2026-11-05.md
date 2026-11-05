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
| rejected claims "without a reason" | 373 / 7 d. Restricting the count to judged claims (#505) did not change it, so these are judged rejections from earlier in the week; the last 2 h read 21/21 explained | `improvement show`, `capabilities show 2` |

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
5. Measurement: only judged claims count as unexplained rejections (this did
   not change the 373: they are judged rejections from earlier in the week);
   every probe is tested against the real schema.
6. Boot load (#507): two Deploys released and passed verification 261/261, then
   timed out on the database after the restart, when the newly active lane and
   two capability assessments landed together. The assessment now waits 15 min
   after boot and runs hourly; the lane holds its start size for 10 min.
   Deploy 41949122885 then passed both passes.

## 4. After the release

**2 h window, 2026-11-05 01:56Z** (`capabilities show 2`):
`{"WORKING":12,"BROKEN":8,"MISSING":0,"UNPROVEN":4}` (was 9 / 10 / 0 / 5).

| requirement | before (24 h) | after (2 h) |
|---|---|---|
| DISCOVERY.READABLE | BROKEN 36/76 (47%) | **WORKING 28/34 (82%)** |
| ACCESS.READ | BROKEN 55/127 (43%) | **WORKING 404/712 (57%)** — 5.6× the reads in a twelfth of the time |
| ACCESS.ROUTINE_FETCH | UNPROVEN 3 | **WORKING 10/10** |
| LEARNING.METHODS | UNPROVEN (probe unreadable) | **WORKING** 1 232 accepted method claims |
| DISCOVERY.SEARCH | BROKEN 1/76 | BROKEN 8/34 (window mostly before #506's endpoint rotation) |
| EXTRACTION.CITED_CLAIMS | BROKEN 11/36 | BROKEN 10/28 — free-model output (unparseable references, no claims offered); owned by the loop's CITATION_DROPPED candidate |

- **The lane runs again.** 0 leases 20:56Z → 00:05Z; after #505, 7 leased and
  8 completed within minutes (`free-lane show`, 00:55Z).
- **Search works from production.** `sources search "small business size
  standards"` (Admin, 2026-11-05) returned 8 results, the first
  `https://www.sba.gov/document/support-table-size-standards` — the page the
  lane had been guessing at with invented deep links.

**The hour after search rotation (#506), 01:31Z → 02:31Z** (`capabilities show 1`):

| requirement | 24 h before | this hour |
|---|---|---|
| DISCOVERY.SEARCH | 1/76 (1%) | 18/27 (67%; bar 70%) |
| DISCOVERY.READABLE | 36/76 (47%) | **25/27 (93%)** |
| ACCESS.READ | 55/127 (43%) | **359/480 (75%)** |
| VERIFICATION.ITEMS / ANALYSIS.SYNTHESIS / ANALYSIS.AUDIT | 51/51 · 37/37 · 102/108 | 11/11 · 5/5 · 12/15 |
| RECOVERY.PROVIDERS | 130/760 | 41/174 — free providers failing three calls in four (external) |
| RECOVERY.STALLS | 20/54 | 8/45; idle: RESEARCHING with work queued 27, QUEUED with nothing queued 7, PLANNING 2, INTERRUPTED 1 |

**The reusable path, end to end on production** (`improvement show`, 02:0xZ):
the map raised three gaps no detector covered — CAPABILITY:RESEARCH.RECOVERY.RETRY,
.RECOVERY.STALLS and .RECOVERY.IDLE_CAPACITY (combined into RETRY, same
owner). Each went DIAGNOSE → RESEARCHING (method research settled) → ENGINEER →
Factory, submitted `risk: LOW, release: automatic release granted (LOW risk)`
(fcr_7295c8a1…, fcr_e4e0550d…). Before the risk fix no improvement objective had
ever been released automatically.

## 5. Later readings (2026-11-05 03:34Z – 06:25Z)

**5 h window to 04:48Z** (`capabilities show 5`, probes now print causes):
`{"WORKING":14,"BROKEN":7,"MISSING":0,"UNPROVEN":3}`. Gate blocks: WORK_FAULTED
34, REQUIRED_LANE_EMPTY 20, NOTHING_SURVIVED 8; packets ended CANCELLED×21 "No
fragment cleared its evidence gate". Fragments were spending their attempts on
answers whose every citation Brain dropped, with the model never told why —
fixed in #513 (one repair prompt naming the drop reasons; the same checks).
`packets parks` showed the eight October judge parks sit in projects with no
standing grant, so `answerUnaskedParks` (#511/#512) correctly leaves them.

**Search refusals are rows now** (`sources search`, 05:0xZ): both DuckDuckGo
endpoints answered 202 every 10–20 min (04:14, 04:29, 04:33, 04:39Z), each a
ten-minute pause — the public endpoint's rate limit, not a Brain defect.

**The hour after #513, 05:24Z → 06:24Z** (`capabilities show 1`,
`free-lane show`): the free providers failed **178 of 184** calls; the lane
recorded `FREE_LANE_IDLE` — 35 items waiting, declined because "cooling down
after a provider failure" — and then grew itself back (brain-b 1 → 32 slots,
06:20–06:24Z) as errors fell. Too little research ran to measure #513.
Over 24 h the free lane filed **13 packets** with 130 of 196 claims accepted.

**Recovery without the owner, observed on production:**
- head-of-line starvation (3 h idle) → the lane leased again within minutes of #505;
- dead deep links → a readable source for 83–93% of fragments (was 47%);
- provider outage → attempts refunded, items cooled down, capacity shrank to 1
  and regrew to 32 by itself, nothing failed for the outage;
- expired leases → 630/630 ended and reclaimed (5 h);
- restarts → three releases passed hosted verification on both sides of the
  restart once the boot load was bounded (#507, #509, #513);
- gaps no detector saw → raised by the map, researched, and sent to Factory as
  LOW-risk auto-released objectives.

## 6. After the database and audit fixes (2026-11-05 11:56Z → 13:56Z)

`capabilities show 2`: `{"WORKING":12,"BROKEN":5,"MISSING":0,"UNPROVEN":7}`.

| requirement | first reading (24 h to 00:53Z) | this window |
|---|---|---|
| DISCOVERY.SEARCH | BROKEN 1/76 | **WORKING 26/26** |
| DISCOVERY.READABLE | BROKEN 36/76 | **WORKING 26/26** |
| ACCESS.READ | BROKEN 55/127 | **WORKING 290/317** |
| EXTRACTION.ACCEPTED | WORKING 79/132 | WORKING 39/50 |
| EXTRACTION.CITED_CLAIMS | BROKEN 11/36 | BROKEN 10/26 (was 7/10 the hour before; the RunPod Qwen3-4B slot's answers drop citations most) |
| VERIFICATION.GATE | BROKEN 39/141 | BROKEN 10/26 (38%, bar 40%; was 13/75 at its worst) |
| VERIFICATION.ITEMS | WORKING 51/51 | WORKING 16/16 |
| ANALYSIS.SYNTHESIS | WORKING 37/37 | WORKING 10/10 |
| ANALYSIS.AUDIT | WORKING 102/108, then BROKEN 6/27 | **WORKING 21/21** |
| RECOVERY.LEASES | WORKING 1268/1268 | WORKING 130/130 |
| RECOVERY.PROVIDERS | BROKEN 130/760 | BROKEN 43/137 — external |
| ANALYSIS.FILED / DECISION.JOB_OUTCOME | — | UNPROVEN (1 filed, 4 settled in the window) |

What moved audit: production logs showed the audit step had thrown "The
database pool had no free connection … 593 caller(s) waiting" (#523 makes that
a refunded outage and records the real reason; #524 holds the lane's slots to
three per database connection). Factory's own two improvements (#508 retries
with a plan, #510 idle-packet sweep) were merged and released, and the release
gate no longer holds an improvement for a MINOR note (#520).
