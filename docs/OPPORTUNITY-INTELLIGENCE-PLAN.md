# Opportunity Intelligence and Research Expansion: implementation plan

Status: **plan only.** Nothing in this document has been built, migrated or
deployed. It was written on 2026-10-14 against `fd673c6` (Session F release)
after reading the code, not the documentation alone. Every "exists" below names
the file that holds it. Every "missing" names the row or function that would
have to exist and does not.

The next step is implementation, in the six assignments in §6.

---

## 0. The short version

Most of what this brief asks for is already present in pieces. The gaps sit
where those pieces meet.

- **The portfolio is not capped.** `listOpportunities` has no `LIMIT`, and every
  live opportunity is evaluated on every tick. The only "five" is a display
  constant (`BEST_SHOWN`, `portfolio.ts:507`).
- **What *is* capped is re-evaluation.** An opportunity may be deep-dived at
  most twice for its whole life (`MAX_VALIDATION_ROUNDS`, `validation.ts:132`).
  A monetization attribute may be asked about twice (`MAX_COMMISSION_ROUNDS`).
  ARCHIVED has no transition out of it. A disqualifier, once recorded, has
  nothing that checks it again. Requirement 2 (reactivation) fails here, not at
  any count.
- **Blockers exist and are not shared.** `cash_needs` is keyed per opportunity
  (`capability:<opp>:<cap>`, `operate.ts:124`). The only way a capability change
  reaches an opportunity is a full rescan of live opportunities × required
  capabilities on every tick (`reconcileCapabilityNeeds`, `operate.ts:133`). That
  rescan is O(n) every tick, and it does not reach ARCHIVED, DECLINED,
  disqualified or rounds-spent pieces at all.
- **Research loses most of what it gates.** On 2026-10-14, 89 of 901 fragments
  were accepted. 1,336 of 1,906 claims were accepted, and 944 of those sit inside
  BLOCKED fragments. The archive check cannot see those 944.
  `coverBeforeWork` reads `existing_claims`, which is filled only from filed
  documents (`reconcile/coverage.ts:436`). The shared pool requires
  `fr.status = 'ACCEPTED'` (`sharedFindings.ts:72`). So Brain pays to research
  again what its own gate already accepted.
- **Research allocation does not ask whether an answer could change a
  decision**, except in one place. Monetization commissions do ask it
  (`decisiveCriteria`, `commission.ts:214`). Deep dives are ordered by how many
  fields are filled (`closestFirst`). Card-blank needs are raised for every
  discoverable blank (`reconcileDiscoverableGaps`).
- **A blocked fragment's cause is prose.** It is classified only when a report
  reads it (`classifyBlock`, `gate.ts:817`). The repair ladder is keyed by
  failed condition and has no rung for unreadable sources (`repair.ts:33`).
  Nothing remembers which hosts a surface could not reach.
- **The operator cannot see why an opportunity is waiting or dead** in one
  sentence. Archived and declined pieces are dropped from the plan
  (`portfolio.ts:542`). No history records an opportunity's earlier
  evaluations; the tier is derived and never written down when it changes.

The plan adds a typed **reconsideration** layer to the machinery that already
exists, makes research **decision-led and reuse-first**, and makes **standing**
an explicit, explained, recorded projection. It adds two small tables and a
handful of columns. It adds no new queue, scheduler, memory system or
dependency engine. Every pass runs on the existing durable Russell tick inside
`operate()`, derived from rows, idempotent.

---

## 1. Current capabilities (what to build on)

| Area | Exists | Owner |
|---|---|---|
| Opportunity rows, states, guarded transitions | DISCOVERED → EVIDENCE_CARD → READY → EXECUTING → DELIVERING → COLLECTED; DECLINED; ARCHIVED | `services/cash/opportunities.ts`, `repos/cashPortfolio.ts` (`transitionOpportunity`, :453) |
| Tier (evidence vs work) | SIGNAL / CANDIDATE / QUALIFIED / READY_TO_TEST, derived, type-aware, never stored | `services/cash/tier.ts` (`cashTier`, :265) |
| Placement / disposition | EXECUTE_NOW, RUN_IN_PARALLEL, WAIT_FOR_DEPENDENCY, TEST_A_DECISIVE_UNKNOWN, BEING_QUALIFIED, EVIDENCE_ONLY, ARCHIVED, each with `because` | `services/cash/portfolio.ts` (`placements`, :147; `rank`, :326; `isWorkable`, :84) |
| Evidence card and engine card | Field ownership (BRAIN_RESEARCH / BRAIN_PROPOSES / PERSON_ONLY), FACT/ESTIMATE/DECISION/UNKNOWN, margin withheld on unknowns | `card.ts`, `engineCard.ts`, `answers.ts`, `repos/cashCardFacts.ts` |
| Deep dive (qualification) | Bounded commercial-validation packet, eligibility in one function, stall backstop, parked-for-person state | `services/cash/validation.ts` (`whyNotDiving`, :243; `startValidations`, :408) |
| Discovery | 10 search buckets, barren retirement, cool-off, harvest from citable signalled claims | `services/cash/discovery.ts` |
| Needs and continuations | Raised needs with completion conditions, leased continuations with backoff, typed `blocks_state` | `services/cash/needs.ts`, `operate.ts` (`reconcileCapabilityNeeds`, `reconcileDiscoverableGaps`, `runNeedContinuations`) |
| Capabilities | 8 named, read live, PRESENT / MISSING / UNKNOWN | `services/cash/capabilities.ts` |
| Monetization ledger | ~47 methods per subject, derived status, lexicographic rank, rank-movement snapshots, decision-relevant commissions, REVIVE judgments | `services/cash/monetization/*` |
| Research engine | Packets, fragments, 10-condition gate, per-lane floors, repair ladder, verification, synthesis, three audits | `services/research/*` |
| Research Intelligence | Uncertainty graph, depth allocation, director, sufficiency, retrospectives (packet-scoped) | `services/research/intelligence/*` |
| Archive check | `coverBeforeWork` → `assessRequirement`; only SATISFIED stops research | `services/russell/coverage.ts:88`, `services/reconcile/coverage.ts` |
| Shared findings | Cross-project reuse of accepted claims in accepted fragments | `repos/sharedFindings.ts`, `services/knowledge/shared.ts` |
| Surface probe / recovery | Per-host reachability reading (SURFACE_PROBE_V1); operator-run recovery of a surface-blocked fragment | `bins/contracts.ts:379`, `research/surfaceRecovery.ts:132` |
| Change-driven re-checks (precedents) | Watermark re-arm over `updated_at`; archive-marker hash before a goal re-reads the archive | `repos/bins.ts:3974` (`rearmSurfaceDeferredIntents`), `research/goalContinuation.ts:299` (`archiveMarker`) |
| Concurrency and pressure | Grant AT_ONCE slots (`DISCOVERY_CONCURRENCY` = 6), `researchMissionSlotsFull`, DB pressure shedding | `discoveryAuthority.ts:98`, `russell/launch.ts`, `db/pressure.ts` |
| Kernels feeding Cash | Industry SCAN → harvest; dealflow and puzzle promote into `cash_opportunities`; manufacturing and labor read but do not create opportunities | `services/{industry,dealflow,puzzle,manufacturing,labor}/` |
| History | `cash_events` (append-only), `monetization_rank_snapshots`, `cash_outcomes` | migrations 052, 090, 109 |
| Reports | `cash-report.ts` (tier counts, gate outcomes, yield), `refinement-report.ts` (dive latency, why refinement is moving) | `scripts/` |

---

## 2. Missing capabilities, measured against the brief

### 2.1 Portfolio size (brief §1, success A)

**Holds already, apart from one evaluation cap.** No count limits how many
opportunities exist or are evaluated. These limits do throttle progress:

| Constant | Value | Kind | Verdict |
|---|---|---|---|
| `MAX_VALIDATION_ROUNDS` | 2 lifetime | caps *evaluation* | **Must change** (§3.2): rounds become per-change-epoch |
| `MAX_COMMISSION_ROUNDS` | 2 lifetime per path × attribute | caps evaluation | Same treatment; additive to §3.2, in assignment C |
| `MAX_VALIDATIONS_IN_FLIGHT` | 2 per project, fixed | concurrency | **Must change** (§3.4): derive from the grant's free slots, fleet health and DB pressure |
| `BARREN_ROUNDS` 3 + 24h cool-off | per bucket | stops asking a dry question | Keep; becomes reconsiderable on a typed change (§3.2) |
| harvest 10/tick, discovery 1 bucket/tick | rate | rate | Keep |
| `BEST_SHOWN` 5, `TOP_SHOWN` 5 | display | display | Keep as a highlight; add the unbounded actionable list (§3.5) |

### 2.2 Reactivation (brief §2, success C)

- **No typed blocker that two opportunities can share.** `cash_needs.request_key`
  embeds the opportunity id. `required_capabilities` is a JSON array.
  `depends_on_id` is a single parent and is read only by placement.
- **No change detection.** The capability path rescans every live opportunity
  every tick and calls `readCapability` once per opportunity per capability
  (uncached, `capabilities.ts:209`). Nothing detects a new supplier, a new
  payer, a cost decrease, a newly reachable host, a new grant, a new shared
  finding or a manufacturing holding as an event that affects named
  opportunities.
- **Dead ends have no way back:**
  - ARCHIVED is terminal. The archive refusal asks for "the condition that would
    justify reopening it" (`opportunities.ts:149`), stores it as prose in
    `archived_reason`, and nothing ever reads it.
  - DECLINED can only be copied to another project.
  - DISQUALIFIED, ROUNDS_SPENT and EXPIRED are derived dead ends that nothing
    re-examines.
- **No distinction between "reconsider" and "now executable".** The first case
  never happens, so the distinction does not yet arise. It must be designed in
  from the start (§3.2).

### 2.3 Evaluation and progression (brief §3, successes B and E)

- **Qualification is one rigid dive.** Every opportunity receives the same
  16-question commercial-validation packet. On Cash Mode 1, the required
  `payer` lane was missing in 33 blocked fragments: Brain spent a whole dive on
  openings whose payer could not be found. There is no cheap kill question
  first.
- **Card needs are raised for every discoverable blank.** This includes blanks
  whose answer cannot move the tier while an earlier rung is still open.
- **No decision-value ordering for dives or needs.** Monetization has one
  (`feeds()` + `decisiveCriteria`). Cash opportunities do not.
- **Expected revenue, costs and margins** exist on the engine card, with honest
  withholding. This is not a gap. The rule against weighted scores stays.

### 2.4 Research effectiveness (brief §4, success D)

Measured (§4.9 of the Session F closeout; CLAUDE.md §61):
- 89 of 901 fragments accepted.
- 404 blocked fragments have no classified reason.
- Causes of the blocks, over 7 days:

| Cause | Fragments |
|---|---|
| UNCLASSIFIED | 334 |
| VERIFIER_INSUFFICIENT | 144 |
| REQUIRED_LANE_EMPTY | 98 |
| SOURCES_UNREADABLE | 62 |

- Source access failures were mostly DNS/egress failures, so they belong to the
  Routine owner.

What is missing, in code:
1. **Own-project gated claims are invisible to the archive check.** See §0.
   This is the largest single waste in the research loop.
2. **The block cause is not stored.** So the repair cannot be chosen by cause,
   and a BLOCKED fragment cannot be found by "this host is now reachable".
3. **No rung for an unreadable source** (`repair.ts` ladders are keyed by failed
   condition, and an unretrieved claim produces no failed condition).
4. **No memory of host reachability per surface.** The same refused host is
   tried again in the next fragment. Surface recovery is operator-only.
5. **The archive is reread from scratch on every check.** `inventoryProject`
   walks every document, and matching is roughly (claims + 500 shared) ×
   requirements. Only goal continuation skips unchanged archives, by marker
   hash.

### 2.5 Explanation and history (success G)

- No single derived "standing" sentence per opportunity covering advancing,
  waiting on what, dormant until what, or not worth pursuing because of what.
- Archived and declined pieces vanish from the plan. There is no tier or
  standing history; `monetization_rank_snapshots` is per path, not per
  opportunity.

### 2.6 Usefulness metrics (success H)

- `cash-report.ts` prints point-in-time tier counts. It has no throughput over
  time (qualified or ready per week), no reactivation yield, no
  research-per-qualification figure, and no funnel into `cash_outcomes`. It
  does not read `cash_outcomes` at all.

---

## 3. Recommended architecture

Five changes, each an extension of an existing owner.

### 3.1 Standing: one explained, recorded projection per opportunity

**What exists.** State (stored), tier (derived), placement (derived, with
`because`), `whyNotDiving` (derived).

**Missing.** One answer that composes all of them, and a record of when the
answer changed.

**Change.** New pure module `services/cash/standing.ts`:

```
Standing =
  | ADVANCING        { stage, doing: what Brain is doing now, next }
  | WAITING          { on: BlockerKey[] | 'SLOT' | 'PERSON' | 'DEPENDENCY' | 'RESEARCH_IN_FLIGHT', because }
  | DORMANT          { cause: ARCHIVED | DECLINED | DISQUALIFIED | ROUNDS_SPENT | EXPIRED | WEAK_ECONOMICS,
                       reopenWhen: BlockerKey[], because }
  | NOT_WORTH_PURSUING { cause, because }   // dormant with no reconsideration condition
  | DONE             { outcome }
```

- Every field is read from rows: state, tier, placement, `whyNotDiving`, open
  needs and reopen conditions.
- The sentence is composed on the server, as placement already does.
- On every tick, `recordStandingChanges` writes a `CASH_OPPORTUNITY_STANDING`
  event **only when the standing kind or its blocker set differs** from the last
  one recorded. This is the monetization movement pattern
  (`monetization/movement.ts`) applied to opportunities, and it gives the
  per-opportunity evaluation history the brief asks for.
- Nothing about standing is stored as state. The events are history.

**Owner:** `services/cash/standing.ts` (new) and `portfolio.ts`, which carries
standing on each placement.

### 3.2 Reconsideration: typed blockers, change detection, and fan-out

This is the core of the brief. It is built from three existing precedents:
`request_key` (typed need identity), `rearmSurfaceDeferredIntents` (watermark
re-check) and `archiveMarker` (skip unchanged).

**(a) A closed blocker-key vocabulary** (`server/domain/types.ts`). One shared
key per *fact*, never per opportunity:

| Key | Meaning | Who can satisfy it automatically |
|---|---|---|
| `CAPABILITY:<id>` | A cash capability reads PRESENT | Brain (reading) |
| `AUTHORITY:<commercialAction>` | A live grant covers the action | Brain (reading); the grant is a person's |
| `MANUFACTURING:<capabilityKey>` | `capabilities.held_at` set | Brain (reading); the holding is a person's |
| `SOURCE_HOST:<host>` | A RETRIEVED reading for the host after the block | Brain (reading) |
| `FIELD:<cardField>` | A card fact for this opportunity changed | Brain (reading); per opportunity by nature |
| `EVIDENCE:<lane>` | The shared or own citable pool changed in a lane the piece is waiting on | Brain (reading, via marker) |
| `DEPENDENCY:<opportunityId>` | The parent reached a stated state | Brain (reading) |
| `DATE:<iso>` | A date passed (a reopening window, a regulatory effective date) | Brain (clock vs row) |
| `PERSON` | Only a person can say | Never automatic |

The vocabulary is a closed union with a `Record` over it, so adding a key is a
compile error until somebody writes how it is detected. This follows the
`REFUSAL_WAIT` / `INGEST_REFUSAL_NOTES` precedent.

**(b) Where the keys live.**

- **Live opportunities.** `cash_needs.blocker_key` is a new nullable column with
  an index on `(project_id, blocker_key, state)`. Every need raised from a typed
  cause writes one. The existing per-opportunity `request_key` stays as the
  idempotency key. 100 opportunities missing `SEND_A_MESSAGE` are 100 need rows
  sharing one `blocker_key`.
- **Dormant opportunities.** New table `cash_reopen_conditions`:
  - columns: `opportunity_id`, `blocker_key`, `recorded_from` (ARCHIVE |
    DECLINE | DISQUALIFY | ROUNDS_SPENT | EXPIRY | WEAK_ECONOMICS),
    `observed_at_record` (for example `MISSING`), `actor_ref`, `created_at`,
    `triggered_at`, `trigger_change_ref`;
  - append-only, with only `triggered_at` set once, by a guarded UPDATE;
  - indexed on `(project_id, blocker_key) WHERE triggered_at IS NULL`.
- **Why a table, and not more `cash_needs` rows:**
  - a need is something Brain is trying to obtain now, and the review shows it
    as such;
  - a reopen condition is a watch on a fact nobody is pursuing;
  - folding them together would fill "What Brain needs" with dormant work,
    which is the review-clutter defect §33 already corrected once.
- **Brain proposes conditions; it does not invent them.**
  - At ARCHIVE or DECLINE, the route accepts optional `reopenWhen` keys. Brain
    pre-fills what the rows say: the opportunity's open `blocker_key`s and its
    missing capabilities.
  - At DISQUALIFY, the condition is `FIELD:disqualifiers` plus the disqualifying
    claim's contradiction state.
  - At ROUNDS_SPENT, the conditions are the `EVIDENCE:<lane>` keys of the
    unanswered required fields.

**(c) Change detection: incremental, once per project per tick.** New pass
`detectChanges(projectId)` in `services/cash/reconsider.ts`, using a watermark
per source in a tiny table `cash_change_watermarks (project_id, source, through,
marker)`:

| Source | Read per tick | Cost |
|---|---|---|
| Cash capabilities | The 8 readers, once. The result is compared to the last recorded value in `cash_events` (`CASH_CAPABILITY_CHANGED` written only on change) | 8 reads, replacing *n × caps* |
| Commercial authorities | Grants whose `updated_at` > watermark | indexed range |
| Manufacturing holdings | `capabilities.updated_at` > watermark | indexed range |
| Source hosts | RETRIEVED claims and SURFACE_PROBE readings since the watermark (assignment D's derived reading) | indexed range |
| Card facts | `cash_card_facts.updated_at` > watermark | indexed range |
| Evidence pool | `archiveMarker`-style hash of the own citable and shared pools; when it moves, only lanes touched since the watermark | hash + range |
| Dependencies and dates | Opportunity transitions since the watermark; dates ≤ now | indexed range |

**(d) Fan-out.** For each changed key, one indexed query each over `cash_needs`
(OPEN, live) and over `cash_reopen_conditions` (untriggered):

- **Live opportunity:** set `cash_opportunities.reconsider_requested_at` (new
  column) and append `CASH_RECONSIDERATION_TRIGGERED {key, change}`. The
  existing passes re-derive it on the same tick. A capability need closes
  through `closeNeed`, which already exists. The dive allocator treats the flag
  as a new change epoch (§3.3).
- **Dormant from a derived dead end** (DISQUALIFIED, ROUNDS_SPENT,
  WEAK_ECONOMICS, EXPIRY with a new window): the same flag. Brain re-evaluates
  by itself, because nothing a person decided is being overruled.
- **Dormant from a person's decision** (ARCHIVED, DECLINED): no state moves.
  Brain raises one Needs-You item through the existing
  `russell_human_requests` / inbox surface: "the condition you named changed —
  reconsider?". The new guarded transition `reconsider(ARCHIVED|DECLINED →
  DISCOVERED|EVIDENCE_CARD)` records `CASH_OPPORTUNITY_RECONSIDERED` and
  destroys nothing: the archive reason and the row stay. A person's choice is
  never reversed by a clock or by a reading.

**(e) Reconsideration is not readiness.** A triggered opportunity returns to
evaluation. Every gate still applies: tier, `markReady`'s card gate, the
standing commercial authority, `sendGate` and the capability reading. The test
suite asserts that a reconsidered opportunity is never READY or EXECUTING
because of the trigger alone.

**(f) Efficiency.** The pass is O(changed keys × affected rows), not O(portfolio).
After it lands, `reconcileCapabilityNeeds` stops rescanning every live
opportunity. It handles only new opportunities and flagged ones, and the 8
capability readings come from the detection pass. This is the measured
improvement in §5.

**Duplicate-mechanism check.** Brain's own connector was asked on 2026-10-14
whether a blocker index is a new mechanism. It said the owner for periodic
derivation is the Russell tick and that extension is preferred. This design is
exactly that: a pass inside `operate()`, keyed by rows. It is not a scheduler or
a queue. No existing owner holds "which opportunities share a fact".
`cash_needs` cannot, because its key embeds the opportunity and it does not
cover dormant pieces. That is why one column and one table are added.

### 3.3 Decision-led qualification and research allocation

**(a) Staged dive, kill question first.**
- `validation.ts` composes the dive in two stages. Stage 1 asks **payer +
  disqualifiers + whether the opening is still open**.
- An opening that fails stage 1 becomes DORMANT with typed reopen conditions
  (§3.2). It does not consume the full 16-lane packet.
- Stage 2 asks the rest. A stage-1 packet uses a narrower compiler profile:
  `COMMERCIAL_VALIDATION_SCREEN` in `compilerProfiles.ts`, under the same
  envelope `RUSSELL_CASH_VALIDATION_V1`, the same gate and the same evidence
  floors per lane.
- No bar moves. The opportunity still needs every qualification field before
  QUALIFIED. Only the order of asking changes, and a dead opening stops costing
  a full dive.

**(b) Rounds per change epoch.** `MAX_VALIDATION_ROUNDS` becomes "dives per
epoch". An epoch begins at creation and at each `reconsider_requested_at` later
than the last dive start. That keeps `repair.ts`'s rule that the same search
never runs twice: a new epoch means something changed. Hard lifetime backstop:
`MAX_EPOCHS` (proposed 6, with its reasoning written beside it), so a flapping
signal cannot loop.

**(c) Decision-value order for dives and needs.** Lexicographic, never weighted
(the repo-wide rule):
1. reconsidered since its last dive;
2. answer could cross a tier boundary: `tier.toAdvance.length === 1`, or the
   only open fields are stage-1 kill fields;
3. kill questions before refinement questions;
4. known capital ≤ deployable cash, and `timeToCash` known and short (read
   from the card, with unknowns last);
5. the archive already partly answers it (cheaper; the coverage verdict is
   `PARTIALLY_SATISFIED`);
6. arrival order.

`reconcileDiscoverableGaps` raises research needs only for fields on the
opportunity's current `toAdvance` rung. A blank that cannot move the tier until
an earlier rung clears waits, as `WAITING{on: FIELD:<earlier>}`. This is the
`feeds()` principle from `commission.ts` applied to card fields.

### 3.4 Adaptive concurrency without new allocation machinery

`MAX_VALIDATIONS_IN_FLIGHT = 2` becomes the minimum of:
- the grant's free AT_ONCE slots, from `researchMissionSlotsFull`'s arithmetic,
  minus one slot held back for discovery;
- the number of routable research surfaces right now (`capacityReading`);
- 0 while `db/pressure.ts` reports SHEDDING.

The bound is still the person-set grant. There is no new ceiling, and the floor
stays 1 whenever any slot is free. Five or fifty openings can be progressed in
proportion to real capacity. The per-tick `startValidations` limit becomes
`room`.

### 3.5 Research effectiveness, in the research engine

All of this is inside `services/research/*` and `services/reconcile/*`, with no
Cash coupling.

1. **Reuse own gated evidence.**
   - `projectClaims` (`reconcile/coverage.ts:436`) adds the project's own
     *citable* claims (`citableClaims`'s predicate: accepted, sourced,
     uncontested, non-derived, in an ACCEPTED or BLOCKED fragment), projected as
     `ExistingClaim` with `VERIFIED` status and the claim id as provenance.
   - `assessRequirement` is unchanged, so SATISFIED still needs two publishers,
     strength ≥ 0.55 and relevance ≥ 0.5. No bar moves.
   - Cross-project sharing keeps §31's `fr.status = 'ACCEPTED'` boundary.
     Widening it is a separate owner decision and is recorded as an open
     question, not done here.
2. **Store the block cause.**
   - Add a `research_fragments.block_cause` column, written from `classifyBlock`
     in the statement that sets BLOCKED (`submission.ts:353`, the packet-runner
     fault paths).
   - Add a nullable `block_host` when the cause is SOURCE_ACCESS or
     SOURCES_UNREADABLE and one host dominates.
   - `classifyBlock` stays the single classifier; the reports read the column
     first and classify only legacy rows.
3. **A ladder for unreadable sources.** `buildRepairPlan` takes the stored cause.
   For SOURCES_UNREADABLE and SOURCE_ACCESS it uses `UNREADABLE: [RESOLVE_CANONICAL_LINK,
   INSPECT_ARCHIVED_SOURCES, USE_OFFICIAL_FILINGS, TRY_DIFFERENT_REPOSITORIES,
   MARK_UNRESOLVED]`. Each rung is limited to source classes the envelope
   already authorizes; the envelope check is unchanged.
4. **Host reachability as a derived reading, not a table.**
   - `hostReachability(surface?, since)` in `repos/research.ts`: per host, the
     latest outcome from claims' `retrieval_state` with the source host, joined
     to `research_passes.executor_routine_id`, plus SURFACE_PROBE units.
   - (a) The fragment prompt (`prompts.ts`) names hosts this surface recently
     failed to reach, and says to use authorized alternatives.
   - (b) A BLOCKED fragment whose `block_host` later reads RETRIEVED is
     recovered **automatically** through the existing
     `recoverFragmentAfterSurfaceChange`. All its guards stay: the packet must
     not be terminal, the RETRIEVED reading must post-date the block, and the
     ceiling is raised rather than reset. It runs at most once per
     (fragment, reading).
5. **Archive check by marker.** `coverBeforeWork` memoizes its claim set per
   project under a marker (`archiveMarker`'s hash of the project's event
   watermark and the shared-pool watermark) for the life of a tick. Two
   requirement checks in one pass then read the archive once.

### 3.6 Operator surface and usefulness metrics

- Cash shows **Actionable now** (every workable piece, unbounded, paged by 25)
  and keeps the five as a highlight. It adds **Waiting, grouped by blocker key**
  ("17 openings wait on SEND_A_MESSAGE"), **Dormant** (with reopen conditions)
  and **Reconsidered recently**.
- Each opportunity shows its standing sentence and its standing history from
  the events.
- `cash-report.ts` adds a FUNNEL block from rows:
  - signals, candidates, qualified and ready per week;
  - median days from discovery to qualified;
  - reconsiderations triggered, and the outcome of each (advanced, dormant
    again, unchanged);
  - dives per qualified opportunity, and kill-stage savings (stage-1-only
    dives);
  - research reuse: requirements closed by the archive, and own-citable versus
    shared hits;
  - block causes from the stored column;
  - real outcomes from `cash_outcomes` and settlements.

---

## 4. What stays unchanged (constraints honoured)

- Evidence bars are unchanged: gate conditions, lane floors, the two-publisher
  SATISFIED and the three audit roles.
- The rule against weighted or probabilistic scores is kept. Every ordering is
  lexicographic over rows.
- No commercial permission changes. Reconsideration never contacts, spends or
  executes. A person's ARCHIVE or DECLINE is never reversed without that person.
- No new queue, scheduler, memory system or dependency engine. Every pass
  runs inside `operate()` on the Russell tick. History is append-only in
  `cash_events`.
- No deployment, migration or production change is made by this planning pass.

---

## 5. Success criteria and how each is measured

| Brief | Test-level acceptance (both backends) | Production measure, read with `cash-report` / `refinement-report` after release |
|---|---|---|
| A. Growing portfolio | 300 opportunities: all carry a standing; the actionable list returns every workable piece; no count constant gates evaluation | Live opportunities with a standing = live opportunities (no unexplained piece) |
| B. Actionable vs speculative | Standing never ADVANCING or EXECUTE for SIGNAL/CANDIDATE; the existing `isWorkable` tests still pass | Count of EXECUTE_NOW that are not QUALIFIED+ = 0 |
| C. Shared-blocker reactivation | 100 opportunities share `CAPABILITY:SEND_A_MESSAGE`; flip the adapter; **one tick** triggers 100 reconsiderations with ≤ 8 capability reads and a bounded statement count (asserted); a person-archived piece gets one Needs-You item and stays ARCHIVED; a reconsidered piece is never READY from the trigger alone; a replay triggers nothing twice | Reconsiderations per week; % that advanced a tier within 7 days |
| D. Reuse | A requirement answered only by own gated claims in a BLOCKED fragment is SATISFIED pre-mission and launches nothing; a single-publisher answer is still not SATISFIED | Requirements closed by the archive / requirements asked; repeated research on the same requirement down versus the 14-day baseline |
| E. Decision-led allocation | Dive order fixtures; a payer-less opening stops at stage 1 and goes DORMANT with `EVIDENCE:payer`; needs are raised only on the current rung | Mean fragments per qualified opportunity; share of dives ending at stage 1 |
| F. Concurrency | Dive room = min(free grant slots − 1, routable surfaces), 0 under SHEDDING; never above the grant | In-flight dives never above the grant; no SHEDDING caused by dives |
| G. Explanation | Every standing has a server-composed `because`; DORMANT lists its reopen keys; a standing-change event is written only on change | Operator surface: zero opportunities without a sentence |
| H. Usefulness | Funnel block computed from rows; unknown figures print `unknown`, never 0 | Weekly QUALIFIED and READY_TO_TEST throughput and settled outcomes, against today's baseline (2026-10-14: 40 opportunities, 0 qualified; 89/901 fragments accepted) |

Baselines are taken from production at the start of assignment F, before
release, so every "down" or "up" has a measured denominator.

---

## 6. Implementation assignments

Six Claude Code assignments. A and D can start at once. B, C and E start after A
merges. F is last.

```
 Wave 1:  A (foundation) ─────────┐        D (research engine) ──┐
 Wave 2:        ├── B (reconsider)  ├── C (allocation)  ├── E (surface+metrics)
 Wave 3:  F (integration + production verification)  ←───────────┘
```

Migration numbers are reserved now so parallel branches cannot collide. The
latest numbers are 116 (SQLite) and 107 (Postgres). The rule is §25/§47: if
production moves first, renumber your own file and cite migrations by filename.

### A. Foundation: blocker vocabulary, standing, reopen transitions

- **Objective.** The shared vocabulary and schema every other Cash assignment
  builds on.
- **Files (owned).**
  - `server/domain/types.ts`: the `BlockerKey` union and `Standing` types only
  - new `server/services/cash/standing.ts`
  - `server/services/cash/portfolio.ts`: standing on placements; the actionable
    list unbounded in `assemble`
  - `server/services/cash/opportunities.ts`: `archiveOpportunity` and `decline`
    accept `reopenWhen`; new `reconsider` transition
  - `server/repos/cashPortfolio.ts`: transition guard; `reconsider_requested_at`
    mapping
  - new `server/repos/cashReconsideration.ts`: `cash_reopen_conditions` and
    `cash_change_watermarks` CRUD
  - `server/services/cash/needs.ts`: `raiseNeed` accepts `blockerKey`
  - `server/routes/cash.ts`: the `reopenWhen` field and the reconsider route,
    under the existing guards
  - migrations `117_opportunity_reconsideration.sql` and pg `108_…`
- **Schema.**
  - `cash_needs.blocker_key`, plus its index
  - the `cash_reopen_conditions` table
  - the `cash_change_watermarks` table
  - `cash_opportunities.reconsider_requested_at`
  - `cash_opportunities.dive_epoch_started_at`
  - The matching `*Row` types and mappers.
- **Deliverables.**
  - `standingFor` (pure)
  - `recordStandingChanges` (a pass, events only on change)
  - `reconsider` (a guarded transition with an event)
  - Brain-proposed reopen keys at archive, decline and disqualify time
- **Depends on:** nothing.
- **Tests.**
  - new `tests/cashStanding.test.ts`: every standing kind from rows;
    events only on change; replay idempotent
  - `tests/cashReconsiderTransition.test.ts`: archived piece → reconsider → the
    row and archive reason are preserved; refused from live states; refused for
    a worker principal; same 404 body for a forbidden project
  - the existing `cashPortfolio`, `cashOperate` and `cashSection` suites must
    pass
- **Acceptance.**
  - typecheck and `test:impacted` on both backends
  - boots from an empty database and an existing one
  - no behaviour change on any tick until B or C read the new columns, apart
    from the standing events

### B. Reconsideration engine: detection, fan-out, live and dormant handling

- **Objective.** §3.2(c–f).
- **Files (owned).**
  - new `server/services/cash/reconsider.ts`
  - `server/services/cash/operate.ts`: one new pass `reconsiderAffected` before
    `reconcileCapabilityNeeds`; `reconcileCapabilityNeeds` narrowed to new and
    flagged pieces, and it writes `blockerKey` on the needs it raises;
    `reconcileDiscoverableGaps` writes `FIELD:` and `EVIDENCE:` keys
  - `server/services/cash/capabilities.ts`: a single `readAllCapabilities()`
    helper, with no behaviour change
  - an inbox wiring line in `server/services/russell/inbox.ts` for the
    "reconsider?" item
- **Deliverables.**
  - per-source detection with watermarks
  - `CASH_CAPABILITY_CHANGED` events on change only
  - indexed fan-out
  - Needs-You items for person-owned dormancy
  - a statement-count assertion
- **Depends on:** A. It consumes D's `hostReachability` for `SOURCE_HOST:` keys.
  If D has not merged, that source is stubbed to "no change", behind a single
  import, and F wires it.
- **Tests.**
  - new `tests/cashReconsideration.test.ts`, covering the 100-opportunity shared
    blocker case from §5 row C, with read counts asserted
  - authority grant → `AUTHORITY:` fan-out
  - manufacturing holding → fan-out
  - card-fact change only touches its own opportunity
  - person-archived → inbox item, no state change
  - a crash mid-pass resumes without double events
  - wound-down sprint: detection still records, but no Brain re-dive is started
- **Acceptance.**
  - the capability path performs no per-opportunity `readCapability`
  - `cashOperate`, `cashAutonomousFunnel` and `cashFirstDollar` pass unchanged

### C. Decision-led qualification and adaptive concurrency

- **Objective.** §3.3 and §3.4.
- **Files (owned).**
  - `server/services/cash/validation.ts`: staged dive; epoch rounds;
    decision-value order; derived room
  - `server/services/russell/compilerProfiles.ts`: add
    `COMMERCIAL_VALIDATION_SCREEN`, nothing else
  - `server/services/cash/monetization/commission.ts`:
    `MAX_COMMISSION_ROUNDS` per epoch (it reads
    `reconsider_requested_at` for path subjects)
  - `scripts/refinement-report.ts`: the new refusal kinds
- **Deliverables.**
  - two-stage dive
  - `whyNotDiving` gains `STAGE_ONE_FAILED` and `EPOCH_SPENT`
  - `diveRoom()` derived as in §3.4
  - ordering function, pure
- **Depends on:** A for the epoch column and the reopen conditions it writes on
  a stage-1 failure. It does not depend on B: it reads the flag whoever sets it.
- **Tests.**
  - extend `tests/cashPortfolio.test.ts` with ordering fixtures
  - new `tests/cashStagedDive.test.ts`: payer-less → DORMANT with
    `EVIDENCE:payer`; full bar is still required for QUALIFIED; no extra round
    without a new epoch; `MAX_EPOCHS` backstop
  - `tests/validationEnvelopeScreen.test.ts`: the screen profile passes the same
    envelope
  - room is 0 under SHEDDING and never above the grant
- **Acceptance.** `cashDive*`, `cashAutonomousFunnel` and `autonomyChain` pass
  on both backends.

### D. Research engine: reuse, block cause, unreadable ladder, reachability

- **Objective.** §3.5. Independent of Cash.
- **Files (owned).**
  - `server/services/reconcile/coverage.ts`: `projectClaims` adds own citable
    claims
  - `server/repos/research.ts`: `ownCitableAsExisting`, `hostReachability`
  - `server/services/research/submission.ts` and `packetRunner.ts` (the BLOCKED
    writes only): persist `block_cause` and `block_host`
  - `server/services/research/gate.ts`: export the classifier input shape; no
    rule change
  - `server/services/research/repair.ts`: the cause-keyed ladder
  - `server/services/research/prompts.ts`: the reachability note
  - `server/services/research/surfaceRecovery.ts`: an automatic caller, with
    guards unchanged
  - `server/services/russell/coverage.ts`: a marker memo
  - `scripts/cash-report.ts`, the GATE OUTCOMES block only: read the column
  - migrations `118_fragment_block_cause.sql` and pg `109_…`
- **Deliverables.** The five items of §3.5.
- **Depends on:** nothing.
- **Tests.**
  - new `tests/researchReuse.test.ts`: own blocked-fragment claims satisfy a
    requirement when two publishers agree, and not with one
  - `tests/researchBlockCause.test.ts`: every BLOCKED write stores a cause;
    legacy rows still classify
  - `tests/researchUnreadableRepair.test.ts`: the ladder; envelope refusals are
    unchanged
  - automatic surface recovery fires once per (fragment, reading) and never on a
    terminal packet
  - `tests/sharedKnowledge.test.ts` must still pass: the cross-project boundary
    is unchanged
- **Acceptance.**
  - gate tests unchanged
  - the `test:pg` selection is green
  - one archive read per tick per project, asserted by a counter

### E. Operator surface and usefulness metrics

- **Objective.** §3.6.
- **Files (owned).**
  - `server/services/cash/view.ts` and `shared.ts`: standing, blocker groups
    and dormant list; the shared projection is written field by field (§34)
  - `client/src/russell/Cash.tsx`, inside the existing `rs-cash-*` skeleton
    (§36: no new top-level sections; the waiting and dormant groups live in the
    existing portfolio and needs sections)
  - `client/src/russell/cashPage.ts`
  - `scripts/cash-report.ts`: the FUNNEL block (it must not touch D's GATE
    block)
- **Depends on:** A for the standing API, and on B and C only for data, which
  appears when they land.
- **Tests.**
  - `tests/cashSection.test.tsx`: skeleton parity holds; the dormant group
    renders with reasons; the actionable list is unbounded
  - `tests/cashBrowserToDatabase.test.ts`: the standing sentence from a real
    route
  - `tests/sharedCashAccess.test.ts`: no private figure leaks through the new
    fields
  - funnel unknowns print `unknown`
- **Acceptance.** No control renders that the server's capabilities refuse
  (§35/§36).

### F. Integration and production verification

- **Objective.** Merge A–E in order (A, D, then B, C, E), resolve conflicts, and
  run the full gate once on the integrated SHA. Release through the canonical
  pipeline and verify in production.
- **Steps.**
  1. Take production baselines with `cash-report` and `refinement-report`
     before release (§5 denominators).
  2. Wire D's `hostReachability` into B's `SOURCE_HOST` detection, if it was
     stubbed.
  3. Write the integration walk `tests/opportunityReconsiderationWalk.test.ts`.
     It runs: discovery → a stage-1 kill → dormant → a shared capability flips →
     100 pieces reconsidered → re-dive in a new epoch → qualified. Only the
     worker and the provider are simulated, as `cashIntegrationPass` does.
  4. Run the full suite on both backends once, on the integrated SHA. Release
     through `Deploy`.
  5. Read production with `cash-report` (the FUNNEL and GATE blocks) and
     `refinement-report` 24h and 7d after release. Record the readings in a
     closeout document beside the §5 baselines.
  6. Add one CLAUDE.md section recording the rules this introduced:
     - reconsideration is not readiness;
     - blocker keys are shared, and reopen conditions are typed;
     - dives are per epoch;
     - own gated evidence is reusable inside its project.
- **Acceptance.** Every §5 test row is green. Production shows standing on every
  live opportunity, and at least one recorded reconsideration with its outcome.
  If no blocker changed in the window, the closeout says so rather than claiming
  the behaviour.

### Ownership collisions to watch

| Shared file | Owners | Split |
|---|---|---|
| `operate.ts` | B only | C changes `validation.ts`, which `operate` already calls |
| `cash-report.ts` | D (GATE block), E (FUNNEL block) | Separate functions; E merges second |
| `domain/types.ts` | A only | B–E import from it |
| `routes/cash.ts` | A only | E reads existing view routes |

---

## 7. Open questions for the owner (they do not block assignment A)

1. **Cross-project reuse of claims in BLOCKED fragments.** §31 drew the shared
   boundary at the ACCEPTED fragment. This plan reuses them only inside their own
   project. Widening sharing would be a recorded change to §31.
2. **`MAX_EPOCHS`.** 6 is proposed as a loop backstop. It caps re-qualification
   effort per opportunity, not portfolio size.

---

## 8. Proposed Claude Code prompt count: **6**

A, B, C, D, E and F as above: four implementation streams in two waves, then one
integration and production-verification stage.
