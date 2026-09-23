# A hosted campaign against Brain's own repository

What this records: the Software Factory was pointed at `Peyday007/V5` — the
repository it runs in — and took an approved objective through a plan, two unit
stages, an integration, two independently-reviewed verdicts, two repairs and a
delivery, on the hosted plane, with nobody watching. Every claim below resolves
to a row, a commit, a timestamp or a workflow run.

**Four Brain defects were found by running it, and all four are fixed.** Two
of them stopped the campaign dead and are the more useful half of this document,
because in each case every state column read healthy, a fleet with idle capacity
sat beside it, and nothing anywhere said what was wrong. The third said the
opposite of what the rows underneath it said, for twenty-three minutes, while a
worker was doing the work it claimed nobody could be given. The fourth stopped
nothing at all and is the one worth reading last: it handed a stage out twice
for work that was already done, every guard downstream held, nothing false was
recorded, and what it cost was 1291 seconds of one Cowork activation and 28 of
another, spent looking like progress. It was left open when the campaign closed, because all
that had then been established was that something had happened twice.

---

## The surface, read from production

```
fleet show
  account Brain Research A  ENABLED  plan=Max  target=4
    Factory surface 1  ENABLED
      ref     trig_01JN1h6UdhvR3bMpWFvaRbD2
      worker  wkr_f8e118e87fd141689adc
      caps    [repository, repository-write]
      secret  BRAIN_ROUTINE_TOKEN_FACTORY   (present)
```

```
admin routing show
  worker-10  wkr_f8e118e87fd141689adc
    families=[FACTORY]  repositories=[peyday007/v5]
    capabilities=[repository,repository-write]
    set by factory-onboarding:usr_14439966398243339341
```

The `set by factory-onboarding:` prefix is what says this row came from
`onboardRepository` rather than from `admin routing set` — and that function
writes the routing row and the project's path boundary in one call,
deliberately, because two rows that must agree about one repository should not
be written by two people at two times.

**No forge credential.** The deployment carries 24 secrets and
`BRAIN_FORGE_TOKEN` is not one of them. `Peyday007/V5` is public, so `forge.ts`
reads it unauthenticated — which is the stronger form of §27's *"Brain holds no
credential for any repository"* rather than an exception to it.

**The permission grant is where the worker runs.** `.claude/settings.json` on
`production` pre-approves `mcp__factory-brain`, `mcp__factory-brain__*`,
`mcp__factory_brain` and `mcp__factory_brain__*`. Both separator spellings,
because which one a connector name produces is not worth guessing at fire time.
§22's split, unchanged: Brain owns dispatch, the surface owns whether a worker
may act.

## The change request

```
factory submit
  created   fcr_07a0e4e92abc4ec886f7
  base      58c6deccf11f41f41de845129cf1a44b78e72071 on production
  repository https://github.com/Peyday007/V5
  checkout  (none — so execution_mode is derived REMOTE)
  verification npm run typecheck, npm run lint, npm test, npm run build
```

`execution_mode` is derived and never chosen (§27): a contract pinned from a
checkout has a `repositoryRoot` and one pinned through the forge does not, so
the absence of a root *is* the statement that execution is remote.

## The objective

> Close the two gaps the work register leaves a person to fill by hand. First:
> when a campaign a workstream points at opens a pull request, nothing records
> that pull request against the workstream — a person has to notice it and link
> it, so the register says `PR_READY` only when somebody remembered, and says
> `IN_PROGRESS` about work that is actually waiting on a review. Second: the
> register cannot say `MERGED`, `DEPLOYED` or `VERIFIED_LIVE` about anything
> without a person typing an attestation, because Brain holds no forge
> credential and refuses to read a URL as a merge — which is right, and leaves
> the whole right-hand half of the owner's question "what actually shipped?"
> answerable only by hand.
## The first three defects, and how each was found

None of them was found by reading. Each was found by running the factory
against a real repository and then reading the rows it left.

### 1. A bin nobody could be sent for, because `READY` was the wrong word

`bin_43915e4f93ca4e3db111` sat `LEASED gen 1 attempts 1/2` for nineteen hours
with an attempt still in hand, a healthy fleet beside it and nothing anywhere
saying so:

```
BIN bin_43915e4f93ca4e3db111  LEASED  gen 1
  attempts   1/2
  heartbeat  2026-09-21T14:47:18.445Z  expires 2026-09-21T15:07:18.445Z
  renewals   37  refusals 0

  DISPATCH
    gen 0  SENT  attempt 1/5  sent 14:32:41.085Z  session cse_014Pf7msAWoGphbTKVGAExXs
    gen 1  SENT  attempt 1/5  sent 15:07:45.726Z  session cse_01AfxfG1J7ZxEmmsqoTnqjvG

  EVENTS
    14:32:36  BIN_READY
    14:32:41  DISPATCH_SENT     cse_014Pf7msAWoGphbTKVGAExXs
    14:33:01  BIN_ASSIGNED      wkr_f8e118e87fd141689adc  session_01VgrsAYk7u8uX6U2S5RRXXD
    14:35:12 … 14:47:18  BIN_HEARTBEAT ×37
    15:07:36  DISPATCH_INTENT   PENDING
    15:07:46  DISPATCH_SENT     cse_01AfxfG1J7ZxEmmsqoTnqjvG
    (nothing, for nineteen hours)
```

Everything there is correct. A worker arrived twenty seconds after the fire,
worked for fourteen minutes, and its Cowork session ended — which is how a
Cowork activation ordinarily ends. The lease lapsed at 15:07:18 and the
dispatcher refired twenty-seven seconds later, exactly as it should. The
session it fired never checked in.

From that point the bin was unreachable, and by a route the intent table makes
unavoidable: `bin_dispatch` is `UNIQUE (bin_id, lease_generation)` with
`ensureDispatchIntent` as `ON CONFLICT DO NOTHING`, so there is no second intent
to be had at generation 1; `claimDispatchIntent` sees only `PENDING` and
`SENDING`, so the `SENT` row is never claimed again; and the generation advances
only when a worker **takes a lease**, which nobody was coming to do.

`reopenNoShowDispatches` exists for exactly this and could not see it, because
it asked `b.state = 'READY'`. This bin is `LEASED`.

§19's rule is that **an expired lease is claimable work**, and
`services/dispatch/loop.ts` says so directly above its own call to
`listDispatchableBins`. `DISPATCHABLE_SQL` has always agreed. The constant that
holds that sentence exists because it had already been written as
`state = 'READY'` four times and its own comment predicted a fifth; this was the
fifth, and the reason the constant did not prevent it is mechanical — the read
sits in a query that aliases `bins`, so a bare string beginning `state =` cannot
be dropped into one, and the author wrote the narrower sentence by hand.

The narrower sentence missed the **worse** half. A session that never arrives
leaves the bin `READY`, which is the rarer case the function was written for. A
session that *arrives*, takes the lease and then ends mid-stage leaves the bin
`LEASED` for ever after, which is the ordinary shape of a Cowork activation.

`claimableStateSql(prefix)` is the predicate as a function of the alias now, and
`DISPATCHABLE_SQL` is composed from it — the only arrangement in which a sixth
reader gets the sentence for free.

**Proven in production**, on the deploy that carried it: the generation-1 intent
went `attempt 1/5 → 3/5 → 4/5` with new sessions and `NO_SHOW` recorded, which
the old code could not do because the bin is `LEASED`. Then a real worker took
it — `07:56:35 BIN_TAKEOVER worker wkr_f8e118e87fd141689adc session
claude-code-session_01YLagxcreyvx7zdLx1oz6hG` — eighteen seconds after the fire.

### 2. The lease was the worker's to choose, and the work is the contract's to demand

That takeover then died, and the reason is a second defect one object along.
`brain_check_in` takes `lease_ms`, `brain_bin_heartbeat` takes it again, and
`heartbeatBin` wrote `lease_expires_at = now + clampBinLeaseMs(leaseMs)` — an
**assignment** rather than an extension, floored at thirty seconds. So a worker
could shorten its own lease below the work it was about to block on, and nothing
related that number to what the bin's own contract demands.

Measured from `factory_sessions` on this campaign, against a
`DEFAULT_BIN_LEASE_MS` of fifteen minutes:

| role | bin | duration |
|---|---|---|
| architect | `bin_78cf47b5592b4ad5b405` | 695s |
| implementer | `bin_e3273471cf304e00af8d` | 1803s |
| integrator | `bin_14d8b43d566f4565acb3` | 1051s |
| reviewer | `bin_0d76003bac5b415cbd0a` | 1011s |

The 1051s integration survived because every heartbeat happened to land. The
next one did not: `bin_43915e4f93ca4e3db111` was taken over at 07:56:35, renewed
four times, and retired `NEEDS_HUMAN` at 08:09:41 — **earlier than takeover plus
fifteen minutes**, which is reachable only if a renewal set a shorter expiry than
the takeover's own. The worker was still working; its next heartbeat is on the
bin's own events at 08:13:01 as `BIN_STALE_WRITE, heartbeat after lease loss`.
Thirteen minutes of a real integration discarded, and the bin's last attempt
with it.

**A floor rather than a beat.** CLAUDE.md §27 already paid two production
deploys to learn that one object along: a beat does not rescue a long step,
because the lease ends after the beat was *issued* rather than after it landed.
`server/domain/binLease.ts` is that conclusion at the bin — an hour for the
three factory contracts whose work checks the repository out and runs its
commands, and the unchanged default for every other contract, because an
hour-long lease on a bin whose worker reads rows and submits an answer strands
it for an hour when that worker dies and buys nothing. It is a `Record` over the
whole `CompletionContract` union, so a contract added later is a compile error
until somebody says what its work costs.

It is a **floor**: a worker asking for more still gets more, and can no longer
ask for less than the work Brain is about to demand of it. That is the guard on
the one value in this exchange the claimant had been supplying, which is the
property every compare-and-swap in this codebase rests on.

**Proven in production, and the number is the proof.** The reopened bin's next
integrator ran:

```
SESSION INTEGRATOR  FINISHED  cse_01K5mFLBjJ3an6bQ1n9uPpLq
      worker wkr_f8e118e87fd141689adc  account Brain Research A
      bin bin_43915e4f93ca4e3db111 gen 4
      2026-09-22T12:05:58.072Z -> 2026-09-22T12:28:33.813Z  1356s
      FACTORY_INTEGRATION_V1 v1 evaluated true.
```

**1356 seconds — twenty-two minutes and thirty-six seconds** — against the
fifteen-minute default that killed its predecessor at thirteen. It was assigned
fifty-two seconds after the bin was reopened.

### 3. A blocker that named a bin already answered, for twenty-three minutes

`noteSurfaceBlocker` states the rule in its own doc comment: a blocker is a
derived annotation beside a *truthful* state, and the answering transition is
free, because the condition stops being true and the next tick takes the
sentence away. `blockStage` sits ten lines below it and does the opposite — it
moves `state` to `BLOCKED`, and nothing anywhere moved it back. Every path that
merely waits for a worker returned without writing a word, so whatever the last
block wrote stood for as long as the stage ran.

The integrate bin was answered at 12:05:06:

```
regrant raised=true attempts 2/2 -> 2/6
reopened bin_43915e4f93ca4e3db111 NEEDS_HUMAN -> READY, generation 2 -> 3,
attempts 2/6 unchanged
```

A worker was assigned it fifty-two seconds later. At **12:28:17**, with that
worker twenty-two minutes into a real integration, `factory status` read:

```
campaign fcp_189ea30c7ded4e7b9280 BLOCKED — integration cannot be handed out again
BLOCKER UNIT_EXHAUSTED_ATTEMPTS: Bin bin_43915e4f93ca4e3db111 (FACTORY_INTEGRATE)
is waiting for a person. It has its own answer; until it is given one this stage
is not handed out again, because a second bin beside it would duplicate the work
rather than unblock it.
```

It had been given one, twenty-three minutes earlier. **A status that contradicts
the rows underneath it is worse than no status**: it sends a reader to answer
something already answered, and it teaches them to stop believing the one line
that says a campaign is genuinely stuck. §27 already records the same sentence
about a warning that cries wolf.

`stageIsLive` is the missing half. It writes only over a `BLOCKED` campaign, so
the ordinary path is a no-op and it can never overwrite a state another branch
established. Each of the six sites that waits knows what is true of its own
stage and says it, which is the arrangement `noteSurfaceBlocker` argues for —
clearing centrally would need the guess about which state to restore that its
comment explicitly refuses to make. Two of the six already patched a state and
simply left the blocker behind; they carry `cleared` now, like the
surface-cooloff patch beside them that had it right all along.

**Each fix was run against its own defect before it was trusted.** Restoring
`state = 'READY'` fails the reopen assertion; reopening *any* `LEASED` bin fails
the one that says a live lease is left alone; removing the assignment floor
fails the first lease assertion and removing the heartbeat floor the last;
neutering `stageIsLive` fails with production's exact symptom,
`expected 'BLOCKED' to be 'INTEGRATING'`, while the assertion that a genuinely
parked stage keeps its sentence still passes.

---

## The fourth defect: a stage handed out for work that was already done

This one was left open when the campaign closed, because all that had been
established was that something happened twice. It was investigated afterwards
from the persisted rows, and it is a real defect that occurred **twice in this
one campaign** — once at the integrate stage and once at review.

**The sequence, from rows rather than from reasoning.**

| at | what |
|---|---|
| `12:28:33.813Z` | `bin_43915e4f93ca4e3db111` reaches `COMPLETE`, having integrated `repair-late-link-never-attested` at `95b87eaa12dd` |
| `12:28:35.895Z` | `bin_0b6cdc2502d54b75b8c1` is `READY` — **2.08s later** — titled *Integrate 1 unit(s)* |
| `12:28:39.654Z` | it is assigned to `claude-code-session_01K5mFLBjJ3an6bQ1n9uPpLq`, the same Cowork session that had just finished the first |
| `12:29:23.494Z` | `bin_c19cb071e0054316b540` (REVIEW 2) is taken, on `95b87eaa12dd` — which the review stage reaches only when **every** unit is `INTEGRATED` |
| `12:48:11.332Z` | `BIN_COMPLETION_REFUSED` — *"The report claims to have merged `repair-late-link-never-attested`, which is not one of the units this bin was given"* |
| `12:48:56.297Z` | refused again, identically |
| `12:50:04.292Z` | the worker resubmits; the bin records the result `CORRECTED` |
| `12:50:10.235Z` | the bin completes. **No unit moved** — the ingest finds nothing `IMPLEMENTED` and records nothing — so it integrated nothing, in **1291 seconds** |

**Which unit the second bin was made for is settled by elimination**, not by
guessing. Its title says one unit was `IMPLEMENTED` at `12:28:35.895Z`.
`pr-merge-observation` and `writeback-pr-link` had been `INTEGRATED` the
previous day at 13:19:53; `repair-merge-observer-has-no-caller` was not
implemented until 13:18:49 **that same afternoon** — fifty minutes *after* the
bin in question was made — so at 12:28:35 it had no branch at all. The
one remaining unit is the one `bin_43915e4f93ca4e3db111` had carried 2.08
seconds earlier. The worker's own report names it, and Brain's refusal of that
report — `evaluateFactoryIntegration` re-derives the unit set from what is
`IMPLEMENTED` *now* — is what proves it had genuinely become `INTEGRATED` in
between.

**And the review stage did the same thing.** `bin_c19cb071e0054316b540` ended
`12:50:37.416Z`; `bin_5fb255777c7d4997878a` was `READY` at `12:50:42.133Z` —
**4.7s later** — assigned 1.7s after that to the same session, and completed in
28 seconds having produced no third review. Same signature, different stage.

**The cause.** `runRemoteTick` reads the bins twice: once at the top, so every
`COMPLETE` one is offered to its ingest, and again afterwards, to decide what
the campaign now needs. A worker completing a bin between those two reads falls
through the gap — *"this bin is no longer live"* becomes true in the second read
while *"this bin's report has been read"* is still false — so the stage is
offered again for work the completed bin had just done.

The completion's own compensating advance cannot close it, and that is why the
fix is at this seam rather than in `advanceFactoryAfter`. `finishBin` ticks the
campaign after recording completion; that tick takes the same campaign
compare-and-swap, so with a pass already in flight it declines and, by its own
comment, leaves the work to "the loop twenty seconds later". The pass already in
flight is the one between its two reads.

**What it is not.** Not an idempotency failure: the branch moved once, the unit
was integrated once, and no effect was performed twice. Not duplicate stage
creation: the stage guard was correct about what it had read. Not stale campaign
state: every column was accurate. It is a read-ordering defect inside one pass,
and **every guard downstream held** — which is exactly why it was invisible.

**What it cost, stated precisely.** Both extra bins were taken by the session
that had just finished the previous one — the same Cowork activation rather than
a second fire, which is what the shared ULID suffix in
`cse_01K5mFLBjJ3an6bQ1n9uPpLq` and `claude-code-session_01K5mFLBjJ3an6bQ1n9uPpLq`
says. So it spent 1291 seconds of one activation and 28 of another, out of a
fixed subscription allowance, looking like progress throughout.

**The fix** is `binsThisPassMayJudge` in `services/factory/remote.ts`, beside
`liveBinOfKind` because it answers the same question: a bin that was not
`COMPLETE` when this pass offered bins to the ingest is reported as this pass
saw it then — the row it actually read, never a state composed for it. It is
bounded by construction: on the next pass that bin *is* `COMPLETE` at the top,
so it is offered to the ingest and nothing is carried forward, which is what
stops it becoming a stage that is never handed out again.

**The regression reproduces the production precondition rather than assuming
it.** `tests/factoryExecutionPlane.test.ts` holds the campaign tick as another
dispatcher, completes a real integration bin so that `advanceFactoryAfter`
genuinely declines, and then asserts against real repository reads that the
report is unread, the unit is still `IMPLEMENTED`, the ledger is empty, and the
newest read of the table alone reports the stage free — the defect, named. Run
against a neutered rule it fails with `expected undefined to be
'bin_…'`. A second test pins the bound in the other direction, so the fix
cannot become a stage that is never offered again.

**The other half was reported here as an open reading and has since been
repaired; the deferral is left standing above its correction rather than edited
out.** Two readings leave a completed integration bin unread at the moment the
stage is decided: the one above, and an ingest that ran and returned `false`
silently. The argument for leaving the second was *a remedy for a condition that
was never established is worse than none* — a rule about changing behaviour on a
guess, which this was not. Nothing about the condition was a hypothesis: the
ingest already knew it, said so in a tick note that lives as long as the process,
and wrote it down nowhere.

Reading all of them for the record rather than the two that had been named found
**four**, not two: a repository this Brain cannot address, a report it cannot
read, a forge that will not confirm, and an acceptance that moves no unit.
`INGEST_REFUSALS` is the closed set and `INGEST_REFUSAL_NOTES` is a `Record` over
it, so a fifth is a compile error until somebody says what it means. Each writes
one `INTEGRATION_NOT_INGESTED` row per `(bin, reason)` carrying the evidence —
the forge's own problems, the errors that made a report unreadable, the units
that did not move — and **every caller still returns `false`**, so the bin stays
un-ingested and the next tick tries again. The kind is read by neither
`integrationAlreadyIngested`, which would turn one forge outage into a report
nothing ever reads again, nor `surfaceBlockedIntegrations`, which would retire a
stage for a condition that was never about the work.

Writing the regressions established something the reading had not: three are
ordinary and the fourth is reachable **only as a race**. The parser refuses an
`IMPLEMENTED` report that merged nothing and `verdict.ok` means every merge it
named cleared the forge, so `carried` is never empty where `NO_UNIT_MOVED`
fires — and `markIntegrated` is guarded on the same `IMPLEMENTED` the pass
filtered on moments earlier. So the test injects the race at the one instant it
can happen, moving the unit while the forge answers the compare call that sits
between the filter and the write. Each regression was run against its own defect
first: removing the record fails with `expected undefined to be
'FORGE_DID_NOT_CONFIRM'`, and removing the once-per-reason bound fails with
`expected [ … ] to have a length of 1 but got 3`.

---

## The stages, as bins

Every one of these is a bin Brain made, a fire Brain sent, a session that
arrived, and a result Brain validated against the forge rather than against what
the worker said about itself.

| bin | stage | contract | session | duration |
|---|---|---|---|---|
| `bin_78cf47b5592b4ad5b405` | PLAN | `FACTORY_PLAN_V1` | `cse_01BSoDbYL7iYzRFx5nDRwzfU` | 695s |
| `bin_e3273471cf304e00af8d` | UNITS | `FACTORY_UNITS_V1` | `cse_01NGWBApXFErWGm5JGbLSaGy` | 1803s |
| `bin_f62f17cecd694c138d49` | UNITS | `FACTORY_UNITS_V1` | `cse_01NuQfHMAKz2hUdSuGLKoAQi` | 68s |
| `bin_14d8b43d566f4565acb3` | INTEGRATE | `FACTORY_INTEGRATION_V1` | `session_01NGWBApXFErWGm5JGbLSaGy` | 1051s |
| `bin_0d76003bac5b415cbd0a` | REVIEW 1 | `FACTORY_UNITS_V1` | `cse_01VgrsAYk7u8uX6U2S5RRXXD` | 1011s |
| `bin_2466314735054b9fa3bf` | UNITS (repair 1) | `FACTORY_UNITS_V1` | `cse_01Ave4RfVzuNqGdcAK1rU99s` | 63s |
| `bin_43915e4f93ca4e3db111` | INTEGRATE (repair 1) | `FACTORY_INTEGRATION_V1` | `cse_01K5mFLBjJ3an6bQ1n9uPpLq` | **1356s** |
| `bin_0b6cdc2502d54b75b8c1` | INTEGRATE | `FACTORY_INTEGRATION_V1` | `claude-code-session_01K5mFLBjJ3an6bQ1n9uPpLq` | 1291s |
| `bin_c19cb071e0054316b540` | REVIEW 2 | `FACTORY_UNITS_V1` | `cse_01Dj1TRGKdG6v2PFafw1tZKZ` | 1274s |
| `bin_5fb255777c7d4997878a` | REVIEW | `FACTORY_UNITS_V1` | `claude-code-session_01Dj1TRGKdG6v2PFafw1tZKZ` | 28s |
| `bin_5208b5b4a2fc42caa97c` | UNITS (repair 2) | `FACTORY_UNITS_V1` | `cse_01KvTCWXUSEPWdXkaT3k9nvR` | **1622s** |
| `bin_fb9239718e6440c79952` | INTEGRATE (repair 2) | `FACTORY_INTEGRATION_V1` | `cse_01RR9ZXXNuHeVrMSbogxxGa9` | 1153s |
| `bin_08da85a3ee5b4ca0bf31` | DELIVER | `FACTORY_DELIVERY_V1` | `cse_01M3nS1wYuVGfkmabUnqX522` | 98s |

**Three of those durations are the lease floor earning its keep** — 1356s, 1622s
and 1291s, each longer than the fifteen-minute default that killed the attempt
before the fix.

Branches on the forge, each one a `git ls-remote` reading rather than a report:

```
6f92e7968fa5b92711148c88292b11416db74014  factory/campaign/fcp_189ea30c7ded4e7b9280
99d6933e01c3b9e05a6b19e2d1739b727eb5522d  factory/…/pr-merge-observation/a1
d79c1c1972c0ce4a1fdeed8f7c0f266fce353411  factory/…/writeback-pr-link/a1
95b87eaa12dd6340e593c465794f32a9fcbf6247  factory/…/repair-late-link-never-attested/a1
1b555f41e45d5cc9b1a43cea6424a793f2820b9a  factory/…/repair-merge-observer-has-no-caller/a1
```

## Review independence, refused once and earned twice

**Round 1 refused a session by name, before the lease.** The review bin recorded
it, and it is the whole of what the floor is for:

```
bin_0d76003bac5b415cbd0a  FACTORY_REVIEW
  refused  session_01NGWBApXFErWGm5JGbLSaGy x1 until 2026-09-21T13:21:56.045Z:
    Session session_01NGWBApXFErWGm5JGbLSaGy implemented part of this campaign,
    so its verdict on the same work is not an independent review. Nothing is
    recorded.
```

`cse_01NGWBApXFErWGm5JGbLSaGy` is the session Brain fired at
`bin_e3273471cf304e00af8d`, the units bin — the same suffix, which is what says
the session the worker reported and the session Brain's own `bin_dispatch` row
names are one session rather than two that agree. It came back for the review and
was turned away **before the lease**, so it cost the bin no attempt, no lease and
no generation (§23).

**The two verdicts, as recorded:**

```
REVIEW round 1 CAMPAIGN CHANGES_REQUIRED on 4b63f5c430ff — independence WORKER_SEPARATED
      session claude-code-session_01VgrsAYk7u8uX6U2S5RRXXD  2026-09-21T14:10:09.473Z

REVIEW round 2 CAMPAIGN PASS        on 95b87eaa12dd — independence SESSION_SEPARATED
      session claude-code-session_01Dj1TRGKdG6v2PFafw1tZKZ  2026-09-22T12:51:13.495Z
```

This said both tiers were the ones the lineage supports and neither was
rounded up. **Round 1's was.** Every session on this campaign ran as one worker,
`wkr_f8e118e87fd141689adc`; the round-1 tier compared the reviewer against the
implementing rows, and a row the hosted acceptance had recorded with the
sentinel `unknown-worker` — a finished bin cannot always say who finished it —
counted as a different worker. The correct tier is `SESSION_SEPARATED`, which
round 2 recorded. The row keeps what it said, because history is not edited;
`reviewLineage` no longer credits worker separation past an implementer whose
worker is unknown, pinned in `tests/factoryExecutionPlane.test.ts`. The floor
held throughout: the reviewer's session implemented nothing.

## What the reviews actually found

Both rounds found a real defect, and the second one found this codebase's own
most-recorded failure mode in code the factory had just written:

```
FINDING BLOCKER  REPAIRED  late-link-never-attested (correctness)
  A workstream linked to a campaign after that campaign's outcome event has
  already been recorded never receives the PULL_REQUEST/EVIDENCE attestation
  through any automatic (production tick loop) path, contradicting A01 and the
  module's own stated guarantee.
  resolved: Repaired by repair-late-link-never-attested at 95b87eaa12dd… and
  verified on the merged tree.

FINDING MAJOR    REPAIRED  merge-observer-has-no-caller (reachability)
  observeCampaignPullRequestMerge (server/services/register/
  pullRequestMergeObservation.ts) is fully implemented and tested but is invoked
  from nowhere else in the repository -- no route, periodic tick, or script calls
  it -- so it is dead code in production and the register cannot yet
  automatically move a PULL_REQUEST link from PR_READY to MERGED.
  resolved: Repaired by repair-merge-observer-has-no-caller at 6f92e7968fa5… and
  verified on the merged tree.
```

**A finding is `REPAIRED` because its unit reached `INTEGRATED`** — the diff was
inside the unit's declared ownership and the contract's commands passed on the
merged tree — and never because a worker said so. §27 records the defect where
`reconcileRepairs` had one caller and a delivered pull request still listed a
repaired finding under *remaining limitations*; this request's body reads
**"Remaining limitations: None recorded."**, which is that fix working on the
hosted plane.

## Where it ended

```
factory campaigns
  fcp_189ea30c7ded4e7b9280 REMOTE COMPLETE #31 — Close the two gaps the work
                            register leaves a person to fill by hand.
      reviewed and confirmed by the forge
```

```
factory status --campaign fcp_189ea30c7ded4e7b9280
  base 58c6deccf11f -> 6f92e7968fa5 on factory/campaign/fcp_189ea30c7ded4e7b9280
  units: 4/4 integrated, 0 ready, 0 leased, 0 failed
  reviews 2, findings 2 (0 open, 2 repaired)
  paid-API executions recorded: 0
    INTEGRATED  repair-late-link-never-attested      @ 95b87eaa12dd
    INTEGRATED  writeback-pr-link                    @ 4b63f5c430ff
    INTEGRATED  pr-merge-observation                 @ 4b63f5c430ff
    INTEGRATED  repair-merge-observer-has-no-caller  @ 6f92e7968fa5
```

**Pull request #31** — `factory/campaign/fcp_189ea30c7ded4e7b9280` @ `6f92e796`
into `production` @ `5a9b6f85`, opened by the delivery bin at 2026-09-22
13:48:50Z, body composed from rows: five acceptance conditions each MET with the
reason, four units with their integrated commits, the round 2 verdict and its
independence tier, both repairs named, and no remaining limitations.

**Merged** at `74c9e5753d791f0f13ececf8c4c9187b4f3815ea`. The factory opened it
and a person merged it — §27's boundary, which `assemble.ts` keeps by producing
the branch, the patch and the body and then stopping.

## Nothing is left stranded

`factory bins --campaign fcp_189ea30c7ded4e7b9280`, read from production after
the merge and the deploy. **Thirteen bins, all `COMPLETE`**, none leased, none
parked, none out of attempts:

```
bin_08da85a3ee5b4ca0bf31 FACTORY_DELIVER   COMPLETE gen 2 attempts 1/2
bin_fb9239718e6440c79952 FACTORY_INTEGRATE COMPLETE gen 2 attempts 1/2
bin_5208b5b4a2fc42caa97c FACTORY_UNITS     COMPLETE gen 2 attempts 1/2
bin_5fb255777c7d4997878a FACTORY_REVIEW    COMPLETE gen 2 attempts 1/2
bin_c19cb071e0054316b540 FACTORY_REVIEW    COMPLETE gen 2 attempts 1/2
bin_0b6cdc2502d54b75b8c1 FACTORY_INTEGRATE COMPLETE gen 2 attempts 1/2
bin_43915e4f93ca4e3db111 FACTORY_INTEGRATE COMPLETE gen 5 attempts 3/6
bin_2466314735054b9fa3bf FACTORY_UNITS     COMPLETE gen 3 attempts 2/2
bin_0d76003bac5b415cbd0a FACTORY_REVIEW    COMPLETE gen 3 attempts 2/2
bin_14d8b43d566f4565acb3 FACTORY_INTEGRATE COMPLETE gen 2 attempts 1/2
bin_f62f17cecd694c138d49 FACTORY_UNITS     COMPLETE gen 2 attempts 1/2
bin_e3273471cf304e00af8d FACTORY_UNITS     COMPLETE gen 2 attempts 1/2
bin_78cf47b5592b4ad5b405 FACTORY_PLAN      COMPLETE gen 2 attempts 1/2
```

**And the bin this whole document is about carries the first fix's proof on its
own row**, which is better evidence than any assertion about the code:

```
bin_43915e4f93ca4e3db111 FACTORY_INTEGRATE COMPLETE gen 5 attempts 3/6
    dispatch gen 0 SENT attempt 1/5 session=cse_014Pf7msAWoGphbTKVGAExXs
    dispatch gen 1 SENT attempt 4/5 session=cse_01YLagxcreyvx7zdLx1oz6hG
      NO_SHOW: Fired, and no worker ever claimed the bin before the in-flight
      window closed.
    dispatch gen 3 SENT attempt 1/5 session=cse_01K5mFLBjJ3an6bQ1n9uPpLq
```

The generation-1 intent reached **attempt 4 of 5** with `NO_SHOW` recorded. That
intent was reopened three times *while the bin was `LEASED`*, which is precisely
what `reopenNoShowDispatches` could not do while it asked `b.state = 'READY'` —
it had exactly one `SENT` row and no way to get a second. Generation 3 is the
reopened bin, and `cse_01K5mFLBjJ3an6bQ1n9uPpLq` is the session that then ran the
1356-second integration. `attempts 3/6` is the regrant, raised and never reset.

## Where production ended up

| | |
|---|---|
| `production` | `f5686abf68857f80ea217ca0b898f6b46369803f` |
| `deployed/production` | `f5686abf68857f80ea217ca0b898f6b46369803f` |
| campaign | `fcp_189ea30c7ded4e7b9280` **COMPLETE** — *reviewed and confirmed by the forge* |
| pull request | **#31 merged** at `74c9e5753d791f0f13ececf8c4c9187b4f3815ea` |
| bins | 13, all `COMPLETE` |
| `/healthz` | 200 |

## What is proven here, and what is not

**Proven, from production rows:**

- A campaign against `Peyday007/V5` was submitted through the forge, approved by
  a person, and executed entirely on the hosted plane with `execution_mode`
  derived rather than chosen.
- **Every stage ran to its terminal outcome**: a plan, two unit stages, three
  integrations, two independent reviews, two repairs, and a delivery. Thirteen
  bins, thirteen fires, thirteen sessions. Every unit result was confirmed
  against the repository's own account of itself — the branch at the commit
  reported — rather than against the worker's file list.
- **Review independence was refused in production**, by recorded lineage, before
  the lease, at no cost to the bin; and the two verdicts were recorded at the
  tiers their lineage supports.
- **Both reviews found real defects and both were repaired and verified**, the
  second one being dead code the factory itself had written.
- **A pull request was opened by the factory and merged by a person**, with a
  body every line of which resolves to a row.
- **`paid-API executions recorded: 0`**, from the first stage to the last. The
  workers authenticated the way the session that launched them does, against the
  subscription already in place.
- Brain held no credential for the repository at any point. There is no
  `BRAIN_FORGE_TOKEN` among the deployment's secrets.
- **Four Brain defects were found by running this and all four are fixed**, each
  with a regression run against its own defect before it was trusted. Three
  stopped the campaign; the fourth cost it two activations and stopped nothing,
  and was established from the rows only after the campaign had closed.

**Not proven, and not rounded up:**

- **Concurrency of 2 is what overlapped, not a ceiling.** §27's rule holds: a
  ceiling nobody has observed reads `UNKNOWN`. Two sessions overlapped once — an
  integration and a review between 12:29 and 12:50 — and the rest of the campaign
  ran one at a time.
- **Two sessions are recorded with `account UNKNOWN`.** That is §24's attribution
  gap behaving as designed rather than a fault: a session Brain did not fire from
  a `bin_dispatch` row it wrote has no resolvable account, and *we could not tell*
  is recorded as such rather than as *we checked*.
- **One integration stage ran twice — since investigated, established and
  fixed. See *The fourth defect* below.** This bullet used to guess at a race
  between a worker's completion committing and a check-in-triggered tick. The
  bin events were then examined and that guess was wrong in its particulars,
  which is why it was never acted on while it was only a reading.
- **One restart boot took eleven and a half minutes and the next took two, and
  neither is explained.** Measured on the deploy that carried the lease floor: the
  machine restarted at 11:44:20, `Machine started in 2.603s`, and the Brain's
  banner printed at 11:56:00 with no error anywhere — while the boot immediately
  before it printed within seconds. The slow one reported `29 backend(s) connected
  now` against the fast one's `9`. **The very next deploy then came back in 2m21s**
  (restart 15:24:14, answering 15:26:35), which is what stops this being *"the
  restart boot is slow"*: it is one long boot among short ones, and the correlation
  with the backend count is two points. No mechanism is claimed and none should be
  read in.
- **The Brain goes intermittently unresponsive under the hosted verification.**
  Health-check transitions during the pre-restart verification: failed 11:27:32,
  passing 11:28:02, failed 11:29:37, passing 11:30:07, failed 11:35:14, passing
  11:35:44, failed 11:36:49, passing 11:37:19 — each recovering in about thirty
  seconds, and the same pattern began again during the post-restart run.
- **An earlier reading of mine proposed that a transient Supabase 429 at boot
  left the app permanently serving the migration error, and it is withdrawn.**
  One log line from a previous deploy showed a 429; nothing establishes that it
  persisted, and this deploy's outage — which looked identical from outside —
  was a slow boot with no error at all.

## The gates

| gate | result | tree |
|---|---|---|
| `npm run typecheck` | clean | `390b4932` (the blocker fix) |
| `npm test` (SQLite) | 208 files, 4420 passed, 44 skipped | `390b4932` |
| Postgres suite (CI run 320) | success | `390b4932` |
| `npm run typecheck` | clean | production + repair unit 1 |
| `npm test` (SQLite) | 208 files, 4431 passed, 44 skipped | production + repair unit 1 |
| `npm run typecheck` | clean | `55823c67` = fix + campaign head |
| `npm test` (SQLite) | 208 files, **4434 passed**, 44 skipped | `55823c67` |

The last two are the tree merging produces, run before the merge rather than
after it.
