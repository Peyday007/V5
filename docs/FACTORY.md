# The Software Factory

How Brain turns an objective a person approved into a diff a person can read —
and, the part worth reading twice, why nothing along the way is allowed to
report progress it did not measure or success it did not verify.

The shape is not new. Every step since 5 has needed the same three things: a
claim that is a compare-and-swap on a generation nobody claiming it supplies,
an authorization decision made once in server code rather than trusted from
what a caller says about itself, and a ledger that is rows rather than a
model's account of what it did. The factory does not reinvent any of that. It
is the same machinery, aimed at writing code instead of writing research.

---

## 1. From an approved objective to a reviewable artifact

**A person supplies the objective and the conditions that would convince them
it worked; the factory derives everything else.** `contract.ts` takes the
submission, reads the repository the request names — its current branch, its
head commit, the `scripts` a contributor would actually run — and turns that
into a pinned base sha, a mutation scope, and an ordered list of verification
commands. A person is never asked to configure the factory, for the same
reason a person is never asked to configure Brain's storage backend: a form
that asks for technical defaults is a form filled in wrongly and then trusted.
The objective, the expected outcome and the acceptance conditions become
immutable the moment a person approves them; `contract.ts` is also the module
that refuses a `FACTORY` actor's attempt to touch any of the three, and the
one narrow exception — a plan deriving acceptance conditions into a contract
that was approved with none — is an addition, never a redefinition.

**A proposed decomposition is a proposal, not a plan, until it survives
validation.** The architect breaks the objective into bounded units, but
nothing about a unit is trusted on its say-so: `planner.ts` checks every field
against the contract — verification commands must be ones the contract
already derived, owned paths must narrow inside the approved mutation scope,
dependencies must resolve to units the same plan defines, and the dependency
graph must not contain a cycle. One bad unit refuses the whole plan, because a
partially-installed plan is a dependency graph with holes in it, and a
campaign built on one runs happily and produces something nobody asked for.
Only a plan that survives every check is installed as rows — work units,
dependency edges, and the set of acceptance conditions nothing in the plan
claims to serve, reported rather than silently dropped.

**Scheduling decides who runs next; claiming decides who actually gets to.**
`scheduler.ts` is a pure function over a snapshot of the campaign — candidate
units, live lanes, worker slots, and what the campaign has measured about
itself — so an assignment is always answerable from a recorded input rather
than a re-run against a database that has since moved. Being pure also makes
it useless as a safety mechanism, deliberately: two schedulers can both decide
correctly that a slot is free and a unit is claimable, and both try to take
it. Nothing in the scheduler prevents that, because the exclusion lives one
layer down, in the compare-and-swap the repository layer performs when a unit
is actually claimed. The scheduler can under-assign; it cannot over-assign.

**Execution happens in a worktree that belongs to one attempt.** `dispatch.ts`
opens a session, checks out a branch pinned to the campaign's own base (or to
an integration commit that already contains the unit's dependencies — never to
a sibling's unmerged branch, because nothing uncommitted is ever a channel
between two units), compiles the assignment, and runs it. What comes back is
read as one of exactly four facts: commits landed and the unit is
implemented; nothing landed and the attempt is spent; the provider refused the
work and the unit is deferred with its attempt refunded; or the run errored or
timed out and both the unit and the worker take a strike. A worker's own
narrative about what happened is stored beside this reading and is never
mistaken for it.

**Integration is the only place a unit's success is decided, and it decides
from the repository.** `integrate.ts` asks, in order: did the branch move at
all; is every changed path inside what the unit declared it owns — a diff that
reaches outside is rejected whole, not cherry-picked, because a diff nobody
scoped is a diff nobody reviewed the scope of; is this the same work already
merged, so a redelivered tick does not produce a second merge commit; does the
merge apply without a conflict; and, only once all of that holds, does the
merged tree still pass the unit's own verification commands. A verification
failure rolls the merge back rather than leaving a half-integrated tree behind.
This runs continuously, as each unit lands, rather than once at the end —
because waiting until every lane finishes to discover that two components do
not fit together is how a campaign builds six units on an interface that was
wrong.

**Review reads the change against the objective, not against the report.**
`review.ts` runs a session with no writing tool, detached at the exact commit
being judged, and asks it to compare the integrated diff to the change
request. What its answer is worth depends on who is asking: the module
established §3 of this document explains the whole of that.

**A finding becomes a unit instead of a task someone has to remember.**
`repair.ts` turns every open review finding into a `REPAIR` unit in the same
campaign — one repair per finding, guarded so a tick that runs twice does not
queue the fix twice — with ownership derived from what the reviewer suggested,
held against the approved mutation scope, narrowing it and never widening it.
The repaired unit runs, integrates and is reviewed exactly like any other; a
finding closes as repaired only when its unit reached `INTEGRATED`, never
because a worker said the defect was gone.

**The end of the journey is something a person reads, not something the
factory publishes.** `assemble.ts` produces a branch, a diff, and a body built
from rows — the commits that actually landed, the verdict that actually
judged them, the findings still open — and stops there. It does not push and
it does not open a pull request; those are separately authorized actions a
person performs, and a function that quietly published on the factory's own
initiative would make "the factory may not deploy" depend on nobody ever
calling it. What names the artifact and hands it to a person as something
ready to read is the newer capability described in §5 below.

Sequencing every hop above — deciding when a campaign moves from planning to
executing, from executing to integrating, from reviewing into repairing, and
recognising when it has nothing left to do but be assembled — is the tick, and
every one of its stages has an answering transition rather than a dead end. A
campaign that cannot proceed says so as one of a closed set of blockers —
no healthy execution surface, no eligible reviewer, a dependency cycle, a base
that went stale, a unit that exhausted its attempts — each with a remedy a
person can actually act on.

## 2. What makes a worker's summary not count as evidence

A worker returns from an attempt with two things: a diff, and prose about the
diff. Only one of them is allowed to move any state in this system, and it is
never the prose.

**`IMPLEMENTED` means a branch advanced. It does not mean the work was
right.** That is decided later, by integration and by review. A worker that
wrote a confident report and produced no commit has not done the work, however
the report reads — `dispatch.ts` checks the repository's own head, before and
after, and a branch that did not move is a failure whatever the summary claims
happened. The reverse holds too: an attempt that produced commits but whose
worker never wrote a summary at all is still `IMPLEMENTED`, because the
commits are the fact and the summary was only ever a convenience for the next
attempt to read.

**`MERGED` means the diff stayed inside the paths the unit declared, and the
repository's own verification commands passed on the merged tree.** Both
halves matter and neither substitutes for the other. A unit could produce a
correct, narrowly-scoped diff that still fails `npm test` on the merged tree,
and that is not merged. A unit could pass every check while reaching into a
file it does not own, and that is rejected whole regardless of what the check
said — ownership is checked first, precisely so a unit cannot buy its way
past a scope violation by also being correct.

**An integration outcome is a row, not an inference.** `integrate.ts` records
one of `MERGED`, `REJECTED`, `CONFLICT`, `DEFERRED` or `VERIFICATION_FAILED`
for every attempt, with the paths that were rejected (if any) and the
verification results that were actually run, before anything downstream reads
the unit as done. A review verdict is the same kind of fact in a different
shape: `PASS`, `CHANGES_REQUIRED` or `BLOCKED`, matched by exact enum against
what a reviewer returned, never inferred from a sentence that sounded
approving. A reviewer that returns `PASS` while also reporting a `BLOCKER`
finding is refused outright and nothing is recorded — the same cross-check §8
of `CLAUDE.md` applies to a research audit judge, applied here to a code
review, because a verdict that contradicts its own findings is not a verdict
a later reader can trust.

**An unknown outcome is recorded as unknown, and unknown is not the same
number as zero.** A provider refusal is not a failure — it is backpressure,
and the unit's attempt is refunded rather than spent, because charging a unit
for a refusal that was never about the work would walk a healthy unit toward
exhaustion against a condition that had nothing to do with it. A ceiling
nobody has actually observed reads as unknown and stays unknown rather than
being reported as the sum of what was merely declared.

**The ledger is `factory_events`, one append-only table, and every row carries
an evidence class that says how the number attached to it was actually
obtained:**

- **`MEASURED`** — Brain's own clock timed it: a verification command's exit
  code and duration, a session's wall-clock time, the largest number of
  sessions a metrics sweep found genuinely overlapping.
- **`PROVIDER_ENFORCED`** — a provider said no, and the row records the
  provider's word rather than the factory's guess about why.
- **`DERIVED`** — computed from other rows, such as a capacity reading built
  from declared worker concurrency before any campaign has actually run that
  many lanes at once.
- **`UNKNOWN`** — nothing has established the number yet, and the honest
  answer is to say so rather than to default to zero or to the declared
  ceiling.

There is deliberately no separate metrics table sitting beside this ledger.
Two tables that must agree about the same fires is a design where the one
nobody reads is the one that drifts — the fleet paid for exactly that mistake
once already, at a different altitude, and `factory_events` is built so the
same mistake cannot recur here: everything a campaign reports about itself is
counted from this one append-only source, never accumulated separately and
checked against it later.

## 3. How review independence is decided

The threat an independent review exists to defeat is one model context judging
its own work. Whatever the labels on the rows say, that threat is only
actually defeated if the session that reviewed the diff is provably not the
session that produced it — so independence is decided from **recorded
execution lineage**, never from a role a caller could simply declare.

**The lineage is which session, which worker, and which account produced each
pass.** Every attempt at implementation is a session tied to a worker and an
account; every review is a session tied to a worker and an account too. When a
review is about to run, the factory already knows — from rows, not from
anything the reviewer says about itself — exactly which sessions implemented
something in this campaign. The reviewer's own session identity is checked
against that list before its verdict is allowed to count at all.

**The floor is session separation, and the ladder above it is a preference the
factory reports, never claims past what it can show.** A reviewer whose
session matches one of the implementing sessions is refused outright — that
is the one hard rule, and it is checked first. Above the floor, three tiers
are possible and the strongest true one is what gets recorded: the same
worker's different session is `SESSION_SEPARATED`; a different worker on the
same account is `WORKER_SEPARATED`; a genuinely different account is
`ACCOUNT_SEPARATED`. A same-worker review is never described as
worker-separated merely because it would look better, and a same-account
result is never described as cross-account — the tier recorded is the
strongest one the recorded lineage actually earned, and nothing is rounded up
to a stronger one because the campaign would prefer it.

**Unknown lineage fails closed.** A reviewing session with no resolvable
worker or account, or a session identity that is a scheduler's prediction of a
session that has not happened yet rather than one that actually ran, is
refused with the same finality as a session that is known to be the
implementer. "We could not tell whether this was independent" is never read
as "it probably was" — an independence that cannot be established has not been
established, and a review run under it is not recorded as a review at all.

**The reviewer cannot rewrite what it is judging, and that is a property of
how it runs rather than a rule it is asked to follow.** Its worktree is
detached at the exact commit under review, and its tool allowance contains
nothing that writes. A reviewer that wanted to quietly fix what it found wrong
could not, because the execution itself does not give it the means — the same
principle CLAUDE.md states about authorization generally: the boundary that
matters is the one enforced in server code and in how a session is actually
run, never one merely described in a prompt.

## 4. How to add a worker without changing factory code

**A worker is a row, and adding one is registration, not a deployment.** The
registry accepts a worker's kind, its declared capabilities, its declared
concurrency and a reference to where its credential lives — and refuses the
registration outright if the kind names an executor nothing in the factory
implements, or if the declared capabilities are empty. Both refusals happen at
registration rather than being discovered the first time the scheduler tries
to hand the worker something: a registry that accepted a worker nobody could
actually run would be a registry reporting capacity the factory does not have.

**The row never holds a credential — only the name of one, and a digest.** The
actual secret a worker authenticates with lives wherever that worker's surface
already keeps it; the factory records which secret to use and a hash taken
once, the same shape Brain already uses for a session credential or a queue
worker's token. Nothing about that hash can be turned back into the value it
was taken from, and nothing in a capacity report — including the one an
operator reads to decide whether to add more workers — ever has the value to
leak.

**What decides whether a worker actually runs is a row an operator changes,
never a code change.** Availability, quarantine and the target number of
lanes a campaign runs are all read fresh from the registry and its capacity
tables on every scheduling decision. An operator pausing a worker, lifting a
worker out of quarantine, or raising how many lanes a campaign is allowed to
run are all writes to those rows. None of it touches `scheduler.ts`,
`dispatch.ts`, or anything else that decides how work moves — the same
separation Brain already keeps between a fleet's policy and the code that
reads it, at every earlier step that built a fleet.

**A worker that fails is quarantined; a worker that was merely refused is
not.** A provider's rate limit is backpressure, not evidence the worker is
broken, and recording it as a failure would walk a healthy worker toward
quarantine for a condition that was never about its own reliability. Only
genuine failures and no-shows move a worker toward quarantine, and a refusal —
however many of them arrive — never does.

**Capacity is counted, not multiplied from a label.** An account's declared
plan power is exactly that: a label. The factory's own reading of what it can
actually run comes from registered workers, their declared concurrency, and
the sessions genuinely occupying a slot right now — never from multiplying a
subscription tier by a guess about what it should mean. A fleet with nowhere
healthy to run says so in exactly those words, `NO_HEALTHY_EXECUTION_SURFACE`,
naming an operational fact with an operational remedy rather than blaming a
missing account or a specific person.

## 5. The five capabilities this campaign adds

Everything above is the seed kernel: it already plans, schedules, isolates,
dispatches, integrates, reviews and repairs. What it could not yet do before
this campaign is describe itself honestly, survive its own process dying,
write its outcome back into Brain, and hand a person something they can
actually read and act on. Five modules close that gap, each responsible for
exactly one guarantee:

- **`projections`** guarantees that what a person watching a campaign sees —
  its objective, its current stage, what is actually running right now, the
  blocker if it has one, and its result — is read from the same rows every
  other capability in this document reads from, and contains no progress
  percentage or completion estimate that nothing in the campaign actually
  measured. A person reading it never sees a number invented to make a status
  screen feel more finished than the campaign is.

- **`throughput`** guarantees that a claim about the factory's own speed or
  capacity — how many units it merges per hour, how many lanes it has
  genuinely run at once — carries the same evidence class discipline as every
  row in `factory_events`: measured where Brain timed it, derived where it was
  computed from other measured numbers, and unknown where nothing has
  established it yet. Unlike `registry`'s capacity reading, a declared number
  — a campaign's `laneTarget`, a worker's declared `maxConcurrency` — is never
  the input to a `throughput` figure; it is shown beside what was actually
  observed, always labelled `UNKNOWN`, and never rounded up to a ceiling
  nobody has observed.

- **`recovery`** guarantees that a campaign whose process died mid-unit is not
  a campaign that is stuck. Leases expire, units that were mid-flight become
  claimable again, and whatever a dead attempt managed to check in stays
  readable to whichever attempt picks the unit up next — so the next tick
  resumes the campaign rather than a person having to notice it stalled and
  restart it by hand.

- **`writeback`** guarantees that a campaign's outcome becomes part of Brain's
  own project history exactly once, and only from the rows that already
  decided it: the review verdict that was actually recorded, the integration
  commit that actually merged, and the limitations that are actually still
  open — never a paraphrase of a worker's own account of what it accomplished.

- **`pullRequest`** guarantees that what a campaign hands to a person at the
  end is something with a title and a body specifically composed for a human
  reviewer to read, built from the same commits, verdicts and findings the
  rest of this document describes — and that producing it is still not
  publishing it. Turning that artifact into an actual pull request against a
  real remote stays a separately authorized action a person performs, exactly
  as it already is for the diff and body `assemble.ts` produces.

---

## The execution plane: a factory with no checkout of its own

Everything above describes the factory's **control plane** — the contract, the
plan, the ownership of a mutation surface, the independent review, the repair of
a finding, the evidence class on every number. None of it changes in this
section. What changes is *where the work happens*, and the reason it had to is
one fact about the deployed Brain: **it has no `.git`, deliberately.** The image
is copied to registries and pulled by machines nobody here controls, so the
repository is not in it. The first executor handed a worker the Brain's own
checkout, which works exactly once — on a laptop — and the hosted factory could
therefore only refuse an objective. That refusal was an honest diagnosis and a
dead end.

The way out is not to give production a checkout. It is that Brain already has a
machinery for *work a permanent worker does somewhere else*: Step 10's bins.

### Two planes, and which one a campaign is on

`factory_campaigns.execution_mode` says which, and it is **derived rather than
chosen**. A contract pinned from a checkout has a `repositoryRoot`; one pinned
through the forge does not, because the checkout belongs to whichever worker
takes the work. So the absence of a root *is* the statement that execution is
remote, and both entrances — the HTTP route and the operator command — read it
from `executionModeFor` rather than each deciding for itself.

| | `LOCAL` | `REMOTE` |
|---|---|---|
| pin comes from | `inspectRepository` on a checkout | the forge, over HTTPS |
| work is handed out as | a unit assigned to a `factory_workers` row | a **bin** the Step 10/11 dispatcher fires |
| the worker's checkout | a worktree Brain created | the worker's own, on its own machine |
| `IMPLEMENTED` is proved by | a diff Brain read | the forge's account of the branch |
| integration | a merge Brain performed | a push Brain confirmed |
| the pull request | composed and **not** published | composed here, opened by the worker |

### How a worker is kept honest without a diff

§25's rule is that a worker's summary is never evidence. Brain cannot read a
diff it does not have, so the rule is kept by asking the **forge**:
`services/factory/forge.ts` is a read-only client over the repository's own API,
and every belief in this plane resolves to one of its answers.

- **The branch is at the commit reported.** `resolveBranch`. A report that
  disagrees with the repository loses; the message says so in those words.
- **The files that moved are inside the unit's declared paths.**
  `compareCommits` over the range, held against `ownedPaths`. The worker's own
  file list is parsed, stored, and then *not used* for the decision — it is kept
  so a later reader can see whether the worker knew what it had done.
- **A truncated file list fails closed.** The compare endpoint caps its list at
  300 files, and a capped list cannot prove a diff stayed inside a scope.
  Treating it as clean would invent the one guarantee the check exists to give.
- **An integration really carries the work it names.** `compareCommits` between
  a unit's verified head and the integration commit: the forge's own `identical`
  or `ahead` is containment, and anything else is refused by name.
- **Who produced a result.** `finishBin` clears the worker, the lease and the
  credential in the statement that finishes a bin, so a completed bin can no
  longer say who produced its results. `worker_sessions` can, and it is written
  from Brain's own dispatch row rather than from anything the worker said about
  itself — which is why it, and not the bin, is what every factory event and the
  review-independence floor are read from.
- **The tests really passed.** The repository's own continuous integration is
  read for the integrated commit (`readChecks`). Its three answers are kept
  apart, because they have different consequences: a failure is a refusal, a
  pending run is *not yet*, and **no check at all is an absence** recorded as
  `UNKNOWN` rather than as a pass.
- **The pull request really exists, at this commit.** `readPullRequest` after
  the worker says it opened or updated one.

A repository Brain cannot read is a refusal, never an assumption. There is no
path here by which an unverifiable push becomes an integrated unit.

### The five stages, as bins

One bin per stage, at most one live bin per stage per campaign, and every step
idempotent **by its own rows** rather than by a cursor or a flag — a flag can be
set by a tick that then dies, rows cannot.

1. **`FACTORY_PLAN`** — read the pinned repository and propose a decomposition.
   Authorized to read and to run read-only commands; explicitly prohibited from
   writing anything, because a plan is a proposal. `validatePlan` judges it at
   the bin boundary *and again* before installing it, since an amendment between
   the two would make the installed plan answer a contract nobody approved.
2. **`FACTORY_UNITS`** — implement the units whose dependencies have landed.
   Every unit branches from the same commit and owns paths no sibling owns, so
   they may be implemented concurrently. Prohibited from touching the
   integration branch or any pull request.
3. **`FACTORY_INTEGRATE`** — the campaign's one branch, moved once, by a session
   that implemented none of it. Merge the verified unit branches in Brain's
   order, run the contract's commands on the merged tree, and **push only if
   they pass.** A conflict or a red command is reported `BLOCKED` and nothing is
   pushed — the remote shape of the local integrator rolling a failed merge
   back, and for the same reason: a branch carrying a tree the contract rejects
   is worse than a branch that did not move.
4. **`FACTORY_REVIEW`** — judged against the objective as approved. Its
   independence is **derived from recorded lineage and enforced twice**: the bin
   is refused at assignment to any session that implemented part of this campaign
   (before the lease, so the refusal costs no attempt), and the verdict is checked
   again before it is stored, because a lease can expire and be retaken. The
   session identity used for that decision is the *credential the request
   authenticated with*, never the `session_ref` a worker sends — that field is
   telemetry and its own tool says so, and a decision taken on it would be a
   worker declaring itself independent. The tier recorded is the one the lineage
   supports: `SESSION_SEPARATED` at the floor, `WORKER_SEPARATED` when the fleet
   supplies it, never rounded up. Unknown lineage is a refusal.
5. **`FACTORY_DELIVER`** — open or update exactly one pull request, using a
   title and body Brain composed from rows. The worker performs it because the
   credential that may write to the repository lives where the worker runs; it
   is prohibited from merging, approving, closing or changing a single file. A
   bin that *finished* and still left no request Brain can confirm blocks the
   campaign with the reason rather than reading as patience — the contract
   verified the request before letting the bin complete, so a completed bin means
   it was right then and is not right now. The block clears by itself: ingestion
   runs at the top of every tick.

A campaign is COMPLETE only when a review passed, nothing is gating, **and** the
forge confirms a pull request carrying the integrated commit.

Two capabilities decide which surface Brain *fires* for a factory bin:
`repository` is reading and running, `repository-write` is pushing a branch, and
only the three bins that write require it.

**Nothing gates the assignment, and that is the end of two corrections.** Reading
`requiredCapabilities` again when deciding which bin an arriving worker may be
handed is tempting — any authenticated worker is offered the oldest ready bin in
its scopes — and it was added, and it refused the only surface that could do the
work twice. Failing closed on unknown lineage made it unreachable, because an
arrival has no lineage until it takes a bin. Reading the static worker → Routine
binding attributed the arrival to whichever Routine is enabled, which in a fleet
sharing one worker identity is the wrong one. And the observed lineage cannot
help either: `worker_sessions` is keyed by the credential, and **the credential is
per-connector rather than per-session**, so the row describes the fleet.

Brain therefore cannot tell which surface has turned up before handing out work.
Admitting one that cannot push costs a fire and an attempt, and the worker reports
BLOCKED naming the refused operation. Refusing wrongly cost a campaign that could
never move. Between a gate that sometimes wastes a fire and one that sometimes
stops all work, only the first is tolerable.

**That holds for capabilities and not for scope, and the difference is the subject
of the sentence.** Brain cannot identify the arriving *Routine*, for the three
reasons above. It can identify the arriving *worker*, because that is the
authenticated principal — the one identity in the exchange the caller does not
supply. So what a worker may be handed is decided from `worker_routing`, a row
Brain wrote, by `services/bins/routing.ts`, and a factory bin is offered only to a
worker registered for the repository its manifest names. Registration is three
deliberate acts — the envelope grant, the routing row, and push access where the
worker runs — and any one of them missing authorizes nothing. See
`docs/ROUTING.md`; the defect it was written from is in
`docs/OAKWOOD-RETIREMENT.md`.

**And the report it produces has to be submittable.** `headSha` was required of
every unit and integration report, on the reasoning that a worker which got far
enough to push has a commit. Some do. A worker blocked *before* pushing — no
credential, a refused host, a conflict it was told not to resolve — has nothing to
name, so the contract left it a choice between inventing a sha and being refused
for ever. It chose correctly and was refused twice: bin
`bin_f55fb62ee22a4708b2f4` reported `BLOCKED` with the operation the surface had
refused, the parser demanded a 40-character commit for a branch it had
deliberately not pushed, and the bin retired at `NEEDS_HUMAN` having said exactly
the right thing on both attempts. **An honest blocker is a result, and a contract
that cannot accept one turns it into an exhausted bin.** The sha is required of an
`IMPLEMENTED` outcome and optional of a `BLOCKED` one; a sha that is present and
malformed is still refused, and every consumer reads the outcome before the sha.
The correction is recorded rather than quietly applied, because the original
reasoning was half right and the half that was wrong is the half worth keeping.

**And a blocker about the surface is not a blocker about the work.** A `BLOCKED`
integration refused every implemented unit and charged each one an attempt,
whatever had gone wrong. That is right for a conflict or a command that exited
non-zero on the merged tree: the branches disagree, or the contract rejects the
tree they make, and the thing that has to change is the code. It is wrong for a
blocker the integrator hit *before* judging anything, because nothing examined
the work — so two forge-confirmed commits were being charged for a condition that
was never about them. §23's correction, one altitude down: **a refusal is not
misconduct.**

Which one it is, is **derived from the rows rather than read out of the sentence
about it**: no conflict and no non-zero exit code means nothing judged the tree. A
worker cannot declare itself surface-blocked to escape a failed verification,
because the exit codes it reported about what it ran are what decide. A surface
block leaves every unit `IMPLEMENTED`, spends no attempt, and offers the stage
again so a surface that *can* push may take it — bounded at three, after which the
campaign is `EXTERNAL_CREDENTIAL_REQUIRED` with the remedy named: grant the
repository where the workers run. Brain holds no credential and must not.

**The bound is load-bearing, and so is its twin one move along.** A work-related
block stops by itself, because refusing the units spends their attempts. A surface
block deliberately spends nothing, so without a ceiling the stage would be handed
out for ever to surfaces that cannot perform it.

And returning a unit to `READY` is exactly the state the implementation ingest
acts on. **An acceptance is not idempotent by its own effect**, and believing it
was is the same mistake the refusal already taught: the guard "the unit is no
longer READY" holds only while nothing else can write that state, and a refused
integration writes it. The completed implementation bin still held the report
Brain had believed, so the next tick read it again and put the unit straight back
to `IMPLEMENTED` at the commit the integration had just refused — refuse,
re-accept, integrate, refuse, for ever. **A loop that looks like progress is worse
than a stop.** Both answers are now idempotent by the **bin**, which cannot
change, rather than by a state two other transitions can write.

**And the stage above it needed the same guard for the same reason.** A confirmed
integration moves its units to `INTEGRATED`, so the bin is skipped next pass by
its own effect; a surface block deliberately changes nothing, which is the point
of it — so by that test the same completed bin was read again on every tick and
recorded a fresh refusal nothing new had happened to produce. The ledger filled
with rejections, and the ceiling counted from them tripped on its own. Keyed on
the bin now, both ways.

**A surface block defers the stage; it does not stop it.** The first version of
this was a hard ceiling at three, and that was wrong in a way worth recording
rather than quietly fixing. Brain cannot tell which surface will arrive — the MCP
credential is per-connector rather than per-session — so a stage only some
surfaces can perform is offered to whichever one turns up. On a fleet where the
surface Brain can *fire* cannot push and the ones that can push arrive on their
own schedule, a ceiling counted in surface blocks is reached by the wrong surface
within minutes, and the stage is then blocked before the right surface has had a
single turn. **That is not a ceiling, it is a livelock with a tidy blocker row on
it.** So the newest surface block defers the stage for a cool-off: the waste falls
to one fire per cool-off instead of one per tick, and the stage is still there
when a surface that can push asks for work. The stage detail says so in those
words, because a campaign quietly waiting is the thing a person needs to see.

**The ceiling that remains is far above anything ordinary, and it needed a way
out, because a count that only rises is not one.** Granting the repository to a
worker surface is the remedy the blocker names, and it happens somewhere else
entirely — it cannot change a number in this database. So the count, and the
cool-off with it, are taken from the newest `FACTORY_STAGE_REAUTHORIZED` row: a
person says the operational condition is fixed, with a reason from a closed set
and their id on the row, and the next tick re-derives everything as usual. If it
was *not* fixed the stage defers again with the same words, which is the
difference between a way out and an override. It re-authorizes a stage and never
the work: no unit, commit, finding, verdict or attempt counter moves. §24's
sentence for the fifth time.

The rows are read in the ledger's own `at, rowid` order rather than re-sorted by
timestamp, because two rows written in the same millisecond are a tie a timestamp
cannot break — and a re-authorization that sorted before the refusals it answers
would count for nothing.

**A contract that lies about its own inputs refuses work and says nothing.**
`brain_check_in`'s `session_ref` is an optional argument and its schema said it was
"never used to decide anything" — while the review-independence floor decided on
it, because the MCP credential is per-connector and the provider session id is the
finest identity this surface exposes. A worker that omitted the field was refused
every review, silently: `bin_session_refusals` is keyed by the session, so the
missing one left no row to read. Production showed it exactly: Brain chose the
right surface, fired it, the provider created the session, the review bin stayed
`READY` at nought attempts, and nothing anywhere named a reason.

Brain knew which session it had fired the whole time — `bin_dispatch` carries it —
so `dispatchedSessionForBin` is the fallback. That is **stronger** than the
reported value rather than a relaxation: it is Brain's own record of the fire,
which is where §24 says a session identity comes from. The worker's value is still
preferred, because a scheduled arrival Brain did not fire has no dispatch row, and
when neither exists the floor fails closed as before. The schema now says what the
field is for.

**A prohibition in a prompt is not a control, and Brain cannot make one.** Every
units bin's manifest prohibits pushing to, merging into or otherwise moving the
campaign's integration branch, names the branch, and says integrating is a
separate bin judged by a session that implemented none of it. In production a unit
worker pushed its commit to its own branch **and** fast-forwarded the campaign
branch onto it. The content was exactly what the unit declared and exactly what
Brain would have integrated; the route was one nothing had reviewed. Push access
is granted where the worker runs — that is §22's rule and the reason Brain holds
no repository credential — so Brain cannot prevent this. It can notice.

`integrationBranchDrift` reads the branch before the integration stage is handed
out and records both commits on the campaign's own ledger as
`STALE_BASE_DETECTED`, and the integrator is told in its manifest so it can say
what it found rather than discover a merge that is already up to date and have no
words for why. **It deliberately does not refuse.** The integration that follows
still judges the whole range from the base Brain recorded against the union of
declared paths, so content that arrived by another route is held to exactly the
same bar; and delivery still refuses a pull request whose head is not the commit
Brain integrated, which is the guard that actually protects the artifact. Stopping
the campaign instead would punish it for a procedural overreach the evidence says
changed nothing about the tree.

**A timer is the wrong place to answer a question somebody is asking right now.**
A factory stage becomes available only when a tick reads what the last one
finished, and the loop ticks every twenty seconds — `index.ts` says that interval
exists precisely so a stage becoming ready inside an activation is taken by the
worker that is still there. **The worker did not wait twenty seconds.** In
production it integrated two units, pushed, completed its bin, checked in again
inside the same minute, was told there was no work because the tick had not run
yet, and ended — its own summary reading *"awaiting next Brain check-in"*. The
next stage became ready seconds later and sat there until the next hourly
activation. Nothing was broken and nothing was lost; the campaign simply took an
hour per stage for want of twenty seconds.

So `checkIn` derives before it answers: only after an assignment found nothing,
only for the caller's own scopes, only once, and only the same idempotent tick the
loop runs — guarded by its own compare-and-swap, so a tick already in flight
declines rather than colliding. Then the assignment is retried. A derivation that
creates nothing returns false, which is what stops this becoming a second attempt
at the same empty answer, and a failure inside it is the same answer as "there is
none" — the loop's own timer will try again, so it is a missed opportunity rather
than a lost transition.

**A tick also has to describe the campaign it just changed.** `report.state` was
read once at the start of the pass and updated again only on the paths that
*block*, so every pass that made progress reported the state from before its own
work: a tick that created an integration bin announced `BLOCKED` because that is
what the row had said a second earlier. One re-read, at the single place every
path returns through.

The split itself is what makes
an independent review possible on a fleet where only some surfaces can push.
`repository` is reading and running; `repository-write` is pushing a branch, and
only the three bins that actually write require it. Collapsing them would force
every factory bin onto the pushing surfaces, and with one such surface that makes
the reviewer the implementer — the single property review independence exists to
prevent.

### Why a dependency is still satisfied by integration

A unit confirmed on its own branch is `IMPLEMENTED`, never `INTEGRATED`. Nothing
downstream starts until those branches have been brought together on one tree
and the contract's commands have passed on it — the same rule the local plane
keeps, enforced in the one place the campaign's head is allowed to move. The
head moves in `acceptIntegration` and nowhere else, so there is no path by which
a pull request carries a commit no integration produced.

### Updating a pull request rather than duplicating it

**A campaign pinned at a branch that is already an open pull request's head
continues that request.** It is derived from the forge
(`findPullRequestForBranch`) and never supplied: a number in a request body
would be a caller choosing which open request the factory writes into, and an
open request is somebody's reading surface. A branch that is nobody's head means
open a new one.

That is also what makes continuing one possible without a special case —
continuing it means landing the work on the branch it already points at, so the
campaign's integration branch *is* that branch, and the request updates because
its head moved. The one check that applies to an opening and not to an update is
the base: the factory must never retarget somebody else's open request.

### Where repository access comes from, and where it does not

**Brain holds no credential for any repository.** The manifest names a remote and
never a secret, and every bin's first authorized action says where the access
comes from: *obtain access to the repository named above through your own
execution surface — Brain holds no credential for it and will never send you
one.* That is §22's rule applied to a repository, and it is also the cheapest
possible answer to "credentials must never appear in prompts, logs, database
content or browser output": there is nothing on this side to put anywhere.

`services/factory/repositoryEnvelope.ts` is the other half. It is a list in
code, named by id, of the repositories this factory may be pointed at — the same
shape and the same argument as `services/russell/probeEnvelope.ts`: nobody
supplies the limits their own work is judged against, and a list in a table is a
list a caller with write access could extend. It is **not** a security boundary
and must not be read as one: Brain holds no credential, so it cannot grant
access and removing an entry cannot revoke it. What it does is stop a campaign
being *created* against a repository nobody authorized, which is the moment the
decision is cheap and reversible. Each grant also carries `forbiddenPaths`,
which `validatePlan` applies — a different authority from the contract's
mutation scope, kept apart so that a contract cannot widen it by asking.

**`V5` is deliberately absent.** The factory lives in it, and a campaign that
could rewrite the machinery executing it is the one campaign whose failure mode
is not contained by declining a pull request.

### Onboarding a repository, and the half of it Brain cannot do

Authorizing a repository is three things, and any one of them missing authorizes
nothing: the grant above, a worker Brain will hand `FACTORY` work *for that
repository*, and push access where that worker runs. The first is a merge; the
third is granted on the surface. The second used to be an operator composing a
scope set, a membership, an identity and a `worker_routing` row by hand on a
terminal — four things with a wrong answer each, and every wrong answer failing
silently, because a worker with the wrong scopes is refused with the same 404 a
missing project gives.

`services/factory/onboard.ts` is that middle act, and it is `connectSite`'s
shape for `connectSite`'s reason. One action on the Build surface, behind
`requirePerson` and `decideProjectAccess` at `ADMIN` — the level a membership
grant already carries, and a level no worker principal can reach by type. Brain
creates or reuses one worker per grant, writes `FACTORY_WORKER_SCOPES` and an
exhaustive routing row **from constants rather than from anything the caller
sent**, revokes any prior invitation and issues exactly one. Nothing is asked
that has a wrong answer.

It issues **no credential**. A factory worker reaches Brain through the Cowork
connector, which authenticates with OAuth, so what it needs is not a secret to
paste but a way for the consent screen to name it: a single-use, expiring worker
invitation that on its own cannot read anything, call a tool or obtain a token.
The invitation id is what reaches `identity_events`; the token reaches the reply
once and nothing reads it back.

And it **cannot register the surface**, which is the honest boundary rather than
an omission — §22's split says the surface owns whether a worker may act. So
readiness is derived on every read, in three answers with different remedies:

| Readiness | What it means | What is left |
| --- | --- | --- |
| `NOT_ONBOARDED` | no worker is registered for this repository | press the one button |
| `AWAITING_SURFACE` | Brain's half is done | connect it in Claude, then register a Routine |
| `READY` | an enabled Routine is bound to that worker | nothing |

Alongside it the card reports **how much work is already waiting on this
repository**, counted from rows: while a grant has no surface, routing keys on
the repository, so a `READY` bin naming it is work nothing can be handed. That
number is the point of the setup task, and it carries the promise that makes
deferring different from failing — the work resumes by itself, and nothing has
to be submitted again.

### A stage with nobody to give it to waits, and is put back

**Every routing refusal is a wait, and none of them exhausts.** That is a
statement about what routing is rather than a softening: routing answers "can any
surface take this now", which is never a decision about whether the work may
happen. `REFUSAL_WAIT` in `services/dispatch/router.ts` classifies the whole
union into two kinds and there is no third:

| Kind | Refusals | Resolved by |
| --- | --- | --- |
| `CAPACITY` | `FLEET_TARGET_REACHED`, `ACCOUNT_TARGETS_REACHED`, `ALL_SURFACES_RATE_LIMITED`, `FLEET_PAUSED` | itself — an activation finishes, a limit lapses |
| `OPERATOR` | `NO_SURFACE_SERVES_THIS_FAMILY`, `NO_SURFACE_SERVES_THIS_REPOSITORY`, `NO_CAPABLE_SURFACE`, `NO_ROUTINES_REGISTERED`, `ALL_SURFACES_INELIGIBLE` | somebody registering, onboarding, or lifting a quarantine |

It is a `Record` keyed by the union rather than two sets, because two sets that
had to be total between them were not — and a refusal in neither fell silently
into the exhausting branch, which is how `NO_ROUTINES_REGISTERED` and
`ALL_SURFACES_INELIGIBLE` came to abandon a bin over conditions `fleet
register-routine` and `fleet set-state` answer. Exhausting spends the bin's five
dispatch attempts in five minutes, and an abandoned stage counts against the
campaign's per-stage ceiling: a campaign submitted before its repository was
onboarded had destroyed its own planning stage by the time the worker existed.

What still exhausts a dispatch intent is not a routing refusal: `SUPERSEDED`,
when the bin has moved on, and a fire the provider refused unretryably, which
quarantines the surface by name. And the **permanent** refusals are somewhere
else entirely — `decideRepository` before a campaign exists,
`services/bins/routing.ts` ahead of the compare-and-swap so it costs nothing, and
`services/identity/policy.ts` with the same 404 a missing project gives. None of
those produces a `RoutingRefusal`, so none of them is reached by any of this.

A fleet that is merely switched off says so. Every candidate refused on its own
state used to `continue` before any scope question was asked, so the flags those
questions set stayed false and the first check after the loop claimed the
refusal — a quarantined fleet reported `NO_SURFACE_SERVES_THIS_FAMILY`, sending
an operator to write a routing row when the answer was `fleet set-state`.

Putting deferred work back is derived rather than scheduled, for the reason
§23's re-arm already gives: a backoff is a timestamp, and the condition it stands
for stops being true long before it lapses. `rearmSurfaceDeferredIntents` watches
`worker_routing` as well as `fleet_routines` — onboarding writes the first — and
re-checks each candidate with `routeBin` **itself** before putting it back, so
registering a factory surface wakes that surface's work and leaves a research
packet nothing serves exactly where it was. Its filter is the same
`REFUSAL_WAIT` table composed with the three fire failures an operator resolves,
passed in as a required argument: the repository layer used to keep its own copy,
and the moment the router grew a refusal the two disagreed. The attempt count is
untouched: a re-arm is not a retry.

### Two repositories, and the dimensions that keep them apart

The fire router scopes by **repository** as well as by family and capability, and
that is a correction to what this file said before. The argument for leaving it
out was §27's — Brain cannot tell which surface has *arrived*, because
`worker_sessions` is keyed by a per-connector credential — and it is still true
and was never about the fire. Choosing which Routine to fire is Brain's own
decision over rows Brain wrote: `fleet_routines.worker_id` names the worker, and
that worker's `worker_routing` row names its repositories.

Left out, two onboarded repositories in one family were interchangeable to the
router, which picked between them on headroom. Onboarding A registered a surface
Brain would fire for B's bin; the assigner refused it with
`REPOSITORY_NOT_AUTHORIZED`, so nothing false was recorded — what was spent was an
activation, one of the bin's attempts, and the chance to try the surface that
could have done it. The refusal is `NO_SURFACE_SERVES_THIS_REPOSITORY`, named
rather than reported as the nearest available one, because its remedy is
onboarding *that* repository.

A `worker_routing` row with no explicit entry is unknown rather than empty and
stays eligible, exactly as the family dimension does — and cannot reach here
anyway, since the derived default serves no repository family at all.

The campaign says the same thing in a place a person looks. A ready stage whose
current-generation intent is deferred on one of those two refusals sets
`blockerKind = NO_HEALTHY_EXECUTION_SURFACE` with a sentence naming the remedy —
and leaves `state` alone, because the campaign *is* planning, and saying BLOCKED
would throw away what happens when the surface arrives. The blocker clears on the
tick after the condition stops holding.

### Fireable now, rather than on the hour

A stage becoming available inside an activation used to wait for the next
dispatch tick, and a stage becoming available *between* activations used to wait
for the next scheduled one. Neither is a decision; both are a timer standing in
for one. So a factory bin's completion advances **its own** campaign and then
dispatches what that created, and the twenty-second remote loop dispatches what
it created too. Both are ordinary idempotent paths — the intent is one row per
(bin, generation) and `ON CONFLICT DO NOTHING` — so a duplicate tick, a restart
mid-flight and two instances all produce exactly one fire.

### What recovers, and how

Nothing here needs a new recovery mechanism, which is the point of having built
it on bins.

- **A worker dies.** Its bin lease expires and the bin is claimable work again;
  the next session takes it over from its checkpoint. No sweeper is required for
  correctness.
- **Brain restarts.** The tick is a pure function of rows. An interrupted stage
  is a bin in some state and a campaign in some state, and both are read fresh.
- **Two dispatchers tick one campaign.** `claimCampaignTick` is the same
  compare-and-swap the local loop takes, and the loser is refused rather than
  retried.
- **A response is lost.** The stage is decided from bins and units, so a report
  that arrived and a report that did not look different in rows.
- **The provider refuses the fire.** Step 11's router defers and the fleet keeps
  every bin; an account at its ceiling is busy rather than broken.
- **Two loops tick nothing twice.** A campaign in `REMOTE` mode is refused by
  the local loop before it even claims the tick, in those words rather than as a
  git error about a worktree on a machine with no checkout — and it costs the
  campaign nothing, because the remote loop is already ticking it.
- **A stage cannot be done as specified.** `MAX_BINS_PER_STAGE` stops the loop
  handing it out forever — `liveBinOfKind` deliberately ignores a FAILED bin, so
  without the cap a stage would be re-created on the very next tick, and a
  campaign spinning is harder to notice than one that stopped. The campaign goes
  BLOCKED with the reason and is re-examined every tick, so cancelling the stuck
  bins or amending the contract starts it moving again.
- **A refused unit report costs an attempt.** Locally an attempt is charged when
  a worker is handed the unit, because the process doing the work *is* the
  claim. Remotely the unit row is not claimed until a report comes back and is
  believed, so without `advanceUnitAttempt` a refusal would cost nothing and the
  next round would hand out the identical branch name over commits Brain had
  already rejected.
- **The branch a unit pushes to is read back from the bin, never derived.** It
  was derived from the unit's attempt, and accepting a report claims the unit,
  which increments the attempt — so every acceptance invalidated the name it had
  just accepted and the next tick refused its own work. The ingest also acts only
  on a unit still waiting for a report: skipping INTEGRATED alone left IMPLEMENTED,
  the state a successful acceptance produces, being judged a second time.
- **And it costs exactly one.** An accepted report is idempotent by its own
  effect; a refused one leaves the unit READY, which is the state the next tick
  offers the same completed bin for again. `UNIT_FAILED` carries the bin id, so a
  bin's report for a unit is refused once however many ticks read it.
- **A unit out of attempts blocks the campaign before the review stage**, with the
  unit's own recorded reason. `outstanding` excludes FAILED because nothing more
  will happen to it, and without this that meant a reviewer being asked to judge
  the base commit against a contract nothing had implemented.

### `COWORK_ROUTINE`, and why the handshake is not an executor

The `COWORK_ROUTINE` executor used to be a refusal that said the unit-level
handshake did not exist. It exists now, and it is **not an executor** — the
correction is recorded in that file rather than by deleting it.

An `Executor` is a function Brain *calls* and waits on, holding a worktree path
it can see. A Routine activation is not a call: it is a fire that may be
refused, may arrive minutes later, may be taken over by a different session, and
must survive Brain restarting in the middle. Squeezing that into
`execute(request): Promise<ExecutionResult>` would have meant either a
long-lived promise nothing could recover or a fake synchronous answer. A bin has
all four properties already — durable, leased, fenced, resumable. So the
permanent subscription-backed executor *is* the fleet, reached through the
dispatcher, and the executor's `probe` answers the question that actually
matters: whether any enabled Routine with a present deployment secret could take
repository work. A Brain with none reports no capacity rather than claiming some.

### The surface a person uses

`/build` in the Russell shell. A person says what should become true, picks one
of the authorized repositories, sees the commit that is about to be pinned, and
approves — which is what freezes the objective and starts the campaign. There is
no control there for decomposition, worker count, branches, retries, integration
order, review rounds or repairs, because none of them is a decision a person
should be asked to take. The two decisions it does offer are the two the server
guards by principal type. It is not `/operator`, which remains deleted.
