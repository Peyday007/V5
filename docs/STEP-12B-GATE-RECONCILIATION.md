# Step 12B — reconciling A–Q with the frozen acceptance conditions

The owner rejected the completion claim with a specific finding: *"The reporter
at deployed revision `386356f` only allows G and K to return PASS. The other
fifteen gates have no evidence-driven PASS path."*

That was correct, and it was checkable from the source rather than inferred
from the output. Here are the verdict expressions as they stood:

| Gate | Expression | Can it PASS? |
| --- | --- | --- |
| A | `seen.answeredTurns > 0 ? 'PARTIAL' : blocker.verdict` | no |
| B | `judgedCandidates > 0 && auditPasses > 0 ? 'PARTIAL' : blocker.verdict` | no |
| C | `classified === 100 && dedupeFailed.length === 0 ? 'PARTIAL' : 'NOT_RUN'` | no |
| D | `derivationHeld ? 'PARTIAL' : 'NOT_RUN'` | no |
| E | `live && sixAnswers ? 'PARTIAL' : 'NOT_RUN'` | no |
| F | `offersHeld && singleAnswerDoesNotPark ? 'PARTIAL' : 'NOT_RUN'` | no |
| G | `complete === LAB_MODES.length ? 'PASS' : 'PARTIAL'` | **yes** |
| H | `maps && /emptyReason/.test(maps) ? 'PARTIAL' : 'NOT_RUN'` | no |
| I | `failed.length === 0 && workerRefused ? 'PARTIAL' : 'NOT_RUN'` | no |
| J | `… ? 'PARTIAL' : 'NOT_RUN'` | no |
| K | `removalTest ? 'PASS' : 'NOT_RUN'` | **yes** |
| L | `ticking ? 'PARTIAL' : halted ? 'BLOCKED' : blocker.verdict` | no |
| M | `… ? 'PARTIAL' : 'NOT_RUN'` | no |
| N | `trace && trace.steps.length > 1 ? 'PARTIAL' : 'NOT_RUN'` | no |
| O | *(consumed nothing at all)* | no |
| P | `upgrade ? 'PARTIAL' : 'NOT_RUN'` | no |
| Q | `… ? 'PARTIAL' : 'NOT_RUN'` | no |

**This was not a threshold that had not been reached. It was the absence of a
branch.** Every one of those gates ended its detail with a sentence beginning
*"NOT established here: …"*, and that sentence was written as permanent prose
rather than as a condition something could satisfy. A scenario whose unmet
condition is a paragraph is a scenario nobody can finish.

## How a gate is judged now

A scenario **declares what it is made of**, and the verdict is derived.

```
held === true     exercised, and it holds.
held === false    exercised, and it does NOT. That is FAIL, and it is named —
                  never NOT_RUN, which asserts nothing happened and is the
                  opposite of what occurred.
held === null     not exercisable from the environment that ran, and `needs`
                  says which one can. That is PARTIAL, because "we could not
                  look" and "we looked and it is absent" are different facts
                  with different remedies.
held === null     waiting on a person, and `awaits` names them. That is
  + awaits        BLOCKED: still open, still counted, and nothing here can
                  close it.
deferredBy        removed from the denominator, and only ever by an
                  owner-recorded deferral naming who deferred it, when, and
                  where the record is.
```

**`standing: true` used to be the fifth state, and it was a self-granted
exemption.** It meant "out of reach on purpose", and this reporter decided
which conditions carried it — so a requirement nobody had met could be taken
out of scoring by the thing being scored. The owner named it exactly: *"Required
conditions cannot disappear from scoring. That currently excludes unverified
production restart evidence and untested worker measurements. Keep required,
unproved conditions open. Only an actual owner-approved deferral may remove a
requirement from completion."*

It is `deferredBy` now, which no code under `scripts/` writes. The reading it
produced dropped from 7 PASS to 3 the moment the flag stopped exempting
anything, and that drop is the correction working rather than a regression.

`verdictOf` in `scripts/step12b-acceptance.ts` is that rule. `recordConditions`
composes the row's prose **from** the conditions, so what a reader is told and
what the verdict was computed from cannot drift.

### The join is at the condition level, not at the verdict

This is the half that is easy to get wrong, and getting it wrong loses the
answer. A checkout run reports PARTIAL on nine scenarios because one condition
each needs the deployed Brain's rows. A container run reports PARTIAL on those
same nine because `.dockerignore` keeps `tests/`, `docs/` and `client/src` out
of the image. **Joining the verdicts gives PARTIAL agreeing with PARTIAL**,
while the true answer is that between the two runs every condition was
exercised and held.

So `step12b-combine.ts` unions the conditions by name and re-derives the
verdict with the same rule. A condition one run could not reach and the other
could is *answered*. One neither could reach stays unexercised. One that broke
anywhere breaks the scenario, because a defect seen in one environment is a
defect. And a condition both runs exercised with **different** answers is a
`CONFLICT` rather than a tie to break: a condition measured twice with two
answers is not established, and what needs fixing is the measurement.

`tests/step12bProduct.test.ts` pins both readers against one table of cases and
compares the two decisions as normalised source. That test immediately found a
real drift — the reporter was missing `if (judged.length === 0) return 'PASS'`,
which the combiner has — so a scenario made only of standing conditions would
have read NOT_RUN in one reader and PASS in the other. `[].every(...)` is true,
which is how it hid.

## What each gate was missing, and what it does now

`P`/`A`/`T`/`R` refer to the 52 frozen conditions in `docs/STEP-12B-MATRIX.md`.

| Gate | Frozen | Was | Is |
| --- | --- | --- | --- |
| A | P3, P4, A9, R4 | counted `answeredTurns` in somebody else's Brain | drives a thread with no project being routed by Brain itself; a waiting turn explained from its bin; a pending turn with **no bin**, which is the shape the stored sentence covered up and must never read as patience; a person's filing surviving the automatic pass; then closes the database underneath all of it and re-reads |
| B | A1, A3, A4, A5 | counted judged candidates | drives an idea the archive already answers being **refused** with nothing spent, a person's override standing over Russell's judgment with the superseded decision kept, and a later automatic pass declining to re-take it |
| C | P5, A1, A3 | drove the merge; capped on a worker naming a repeat | the same, plus the worker-named repeat read as a production fact rather than written into prose as permanently unmet |
| D | P11 | read the derivation only | drives the two writes P11 names: an item that stops being derived is **resolved, not deleted**, and a person's dismissal is attributed, reasoned and reversible — including the undo |
| E | P17 | `/NEEDS_PERSON/.test(projection.ts)` | simulates a site **as a site**: every delivery through `syncRecords`, the version guard, identical content not being a write, a malformed delivery refused by category, `RESEARCH_FURTHER` creating an idea and not a mission, and `NEEDS_PERSON` derived on the read path |
| F | P8, R3 | already drove park → answer → move | unchanged; it already had a PASS path |
| G | P10, T1–T5 | `complete === LAB_MODES.length` — the **state**, not the content | asks what T3, T4 and T5 name *of the results*: a limit found or honestly bounded, a recommendation with its evidence class, quality reported apart from throughput — plus the two refusals that make pressure safe, driven |
| H | P6, P12 | a regex for `emptyReason`, and node counts quoted as literal prose | builds all six maps over real rows and compares each diagram to its own outline in the same pass; reads the constellation overlap measurement taken at four viewports in the product's own typefaces |
| I | P14, R1, R2 | `/requirePerson\(\)/.test(routes)` — a spelling | puts a worker principal holding every scope and an ADMIN membership through `requirePerson` inside a real request context, checks the refusal body is the one a missing route gives, and checks the same guard admits a person |
| J | P13 | quoted its own findings as literal text | reads `journey.json`, which `visual-qa.ts` now writes: every step, arrival, fit, clipping, unreachable control and constellation reading, stamped with the revision it was taken at — **and what the journey changed**, read back out of the rows in that same journey |
| K | P18, R11 | asserted the removal **test file exists** | runs the suite, and holds the legacy inventory against the client both ways round — every declared archive operation still on `/legacy`, and none of them on the product surface |
| L | A8, A9, R4 | one reading of a state column | the whole chain rather than its last link: `L6 ·` knowledge arriving and being read, `L4 ·` the backlog reranking because of it, `L5 ·` the mission that can start next — plus, from production, one completed mission followed through its own foreign keys to the conclusion it produced, and whether the deployed loop's cursor moved between two readings |
| M | P3, P7, P19 | four readers compared, capped on "over HTTP" | the same four, plus the deployed Brain's own projects read through `projectProgress` for a named denominator and no uncounted percentage |
| N | P9, T7, T8 | one trace beside `file('routing.ts')` | drives a named routing refusal before any surface exists, three capacity readings that are not each other, `fits` **null** because no throughput was observed, and a target raised by writing a policy row |
| O | P20 | consumed nothing; a markdown row read `— pending —` | evaluates a recorded decision bound to this revision **and** to a digest over the render bytes, read from the configured Brain. Nothing in `scripts/` can write that row |
| P | R7, R10, R13 | `file('scripts/upgrade-populated.ts')` | reads what this run itself did: migrated an empty database, checksum-locked every migration, closed and re-opened it underneath a waiting turn — plus both chains checked for a gap or a collision |
| Q | P15, R5, T6, R1 | canary cycle driven; invitation clause blocked | the same, plus the R5 condition it never had: after every lab mode ran in the TECHNICAL scope, that project holds zero knowledge rows, zero documents and zero claims |

## The three conditions that are permanently out of reach

Each is recorded on its own row rather than in a footnote, and each is the
matrix's own position rather than a shortfall being dressed up.

- **O — the owner's approval of the complete design.** A reporter that could
  record the approval it is waiting for would be approving its own work, and a
  test asserts no module under `scripts/` imports the writer but `admin.ts`.
- **G — how much a real Cowork surface holds.** Measuring it means putting real
  pressure on a fleet serving real research against a ceiling nobody set;
  simulating it would produce figures a reader could not tell from
  measurements. The mechanism is complete and the measurement is not taken.
- **Q — a canary against the deployed fleet.** A canary displaces a policy
  version somebody is running on, so driving one here would be the
  contamination R5 forbids, committed by the thing checking for it.

Three more are bounded rather than refused, and say so on their rows: D's five
*asked* lenses need a reader (a Brain that filled them in from a template would
be manufacturing insight); J's journey is portrait, one device pixel ratio,
Chromium; and P's hosted pre/post-restart check belongs to the Deploy workflow,
which a reporter cannot attest to having observed.

## Corrections to the frozen matrix itself

The matrix is frozen in the sense §26 means — the contract does not move once
building starts — but a row that has become **untrue** is a different thing
from a row somebody wants to change, and leaving it is how a document stops
being worth reading.

- **T3, T4 and T5 read `DECLARED AND REFUSED`, and that is stale.** §6 of the
  matrix argues at length that five pressure modes cannot run because they
  would put real pressure on real surfaces. `services/fleet/lab.ts` now runs
  all five against `repos/workQueue.ts` — claiming, leasing, fencing,
  contention and recovery, in-process, in the isolated `TECHNICAL` scope,
  costing nothing external — and every result carries `PROVIDER_UNTESTED`
  because what a real Cowork surface holds is the one thing there that spends
  money. So the honest status is *runs, and bounds the queue rather than the
  provider*, and the reason §6 gave for refusing them remains true of the half
  that is still refused. The correction is recorded rather than applied
  quietly, because the refusal was argued for in detail and the argument was
  half right.
- **The design gate's own row reads `— pending —` beside four sub-decisions
  marked `APPROVED 2026-09-12`, and I first called that a contradiction. It is
  not, and the correction matters more than the original observation.** They
  are records of two different things. The four are direction decisions taken
  against a hand-drawn preview which states of itself *"Nothing in it is
  implemented. It is a proposal to approve."* The pending row is the approval
  of the complete design. **No approval of the complete design is recorded at
  either stage**, and the row is an accurate record rather than an oversight.

  Four approved sub-decisions are not an overall approval, and nothing may
  infer one from them: a person choosing between two drawn rail layouts has
  said something about rail layouts, not that the product looks right. The four
  were the questions the preview called out as genuinely a person's, never the
  whole of what a design approval covers.

  The distinction is now structural rather than a convention.
  `design_approvals` binds every row to a revision and to a digest over an
  enumerated set of renders **of the built product**; a direction sub-decision
  has no render set, so the table cannot hold one.

## What a checkout run reports now

All seventeen scenarios derive their verdict from declared conditions, and
none of them has a branch it cannot reach.

    7 PASS · 0 FAIL · 9 PARTIAL · 1 BLOCKED · 0 NOT_RUN

Every PARTIAL names a condition only the deployed Brain's rows can answer,
which is precisely what the combiner joins. The BLOCKED one is O, and it is
the owner's.

## What the owner's source review of `ea3b984` changed

Five findings, all correct, and three of them were about a gate reporting
something adjacent to what it claimed.

**1. The port lottery.** `tests/factoryPersistence.test.ts` drew a port from
6600–6699, which contains 6665–6669, 6679 and 6697 — all on the WHATWG bad-port
list, which Node's `fetch` refuses before opening a socket. A server can answer
HTTP normally while `fetch` refuses it, and the harness's `catch` hid the cause.
Reproduced, and the historical failures confirmed: the three failing runs drew
6665, 6668 and 6666. Two earlier hypotheses of mine — starvation, and a dead
child — were both wrong, **and so was the TCP probe I had added to settle it**,
which would have connected and given a fourth wrong answer. Every suite now
allocates through `tests/helpers/ports.ts`, `deploymentOwnership` refuses the
old pattern, and `scripts/visual-qa.ts` — which had the same defect in
6400–6599 — goes through the same helper.

**2. The scoring exemption.** Above.

**3. J's journey demonstrated navigation.** It walks a *sequence* now, and
asserts its effects: the standing authority approved on the phone; Russell's
priority overruled by a person with Russell's own judgment kept beside it; a
wait while Russell launches that idea and its packet stops outside the
preauthorized envelope; the resulting decision answered with a thumb; and the
same mission carrying on. The production mission count is **gone** from J — it
is true, worth knowing, and about a different claim.

Driving it found a real defect that reading had not: **a person's override was
half a transition.** `judgeCandidate` writes the compiled specification under
`missionSpec` only for a verdict that could launch one, and `nextLaunchable`
reads that key alone — so an idea Brain parked for want of a standing
authority, which a person then promoted to Must do, went into the queue Russell
launches from and could never leave it. Fixed in `attachMissionSpec` (the
guard: already `QUEUED`, and `override_user_id` names who put it there) and
`specifyOverriddenCandidate` (the specification, from the same compiler,
touching no verdict), driven from rows on the tick rather than hooked to the
override.

**4. L's chain was scored at its last link.** It takes all four now, and each
is read where it is honest. Completed mission → knowledge is **production**: one
row followed through its foreign keys to the document with bytes, the audit that
judged it, and the knowledge row citing both. Knowledge → rerank → next
authorized mission is the **canary**: a document a person imported, read by the
extraction pipeline and inventoried mechanically, changing what Brain decides
about a new idea. The boundary between them is the product's own and is named
rather than blurred.

**5. P consumes executed evidence.** `docs/evidence/step12b-upgrade/{sqlite,
postgres}.json` are what `npm run upgrade:populated` actually did on each
backend — schema 40→50 and 31→41, eight pre-existing rows across fourteen tables
byte-identical, six new tables readable, a second restart settling — and the
condition re-checks that `server/db` has not moved since. The hosted pre/post-
restart half is the Deploy workflow's record, keyed to an exact revision, and it
is **open until a deploy of that revision produces one**.
