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
  computed from declared numbers, and unknown where nothing has established it
  yet, never rounded up to a ceiling nobody has observed.

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
