# Step 9 — field log

**First manual end-to-end research packet.**
2026-08-28 16:37:39Z → 2026-08-29 05:48:38Z. All times UTC, all durations wall clock.

Step 9 set out to run one genuinely useful research packet through the
production Brain. It did that. Most of the time went somewhere else: into the
seventeen things that had to be wrong first for anyone to find out they were
wrong.

| | |
|---|---|
| Elapsed | 13h 11m |
| Commits | 36 |
| Deploys | 21 — 13 green, 8 red |
| Time spent deploying | 1h 49m, of which 41m was failed runs |
| Faults found | 17 |
| Tests | 976 on Postgres, 951 on SQLite |

Every timestamp here is read from git, the GitHub Actions API, or the Brain's
own `work_items` rows. Two entries are marked `~` because they come from a
worker session's own account of itself rather than from a row; everything else
is measured.

---

## The finding

Step 8 connected a real Claude worker and proved it could authenticate, claim,
heartbeat and complete. Step 9 opened by discovering that nothing it learned
could get in.

> The orchestrator was a synchronous in-process loop calling
> `provider.run(prompt)`. A Claude Max worker pulls work off a queue. Both were
> built, both were tested, and they did not meet.

The tempting fix was a work type whose payload is a prompt — the whole
orchestrator would have worked unchanged. The queue's own registry forbids it in
as many words: there is deliberately no work type meaning "run this." So the
shape became typed research work naming *what to research*, structured
submission, and server-side gating through the same functions the in-process
path already used.

---

## The log

| Time | What | Why it mattered |
|---|---|---|
| 28 Aug 16:37:39 | Work items get a subject they cannot carry in a payload | Schema for research-linked work: `orchestration_id`, `fragment_id`, and an append-only checkpoint table. Both migration chains. |
| 28 Aug 20:15:27 | **The research loop is turned inside out** | Ten MCP tools, the packet runner state machine, and one shared acceptance path so the remote route cannot be looser than the local one. |
| 28 Aug 20:31:23 | Tests written as the ways the packet could lie | 43 of them. Inverting the gate showed only one of three assertions failing — they checked the reported count, not the stored flag. **(fault 4)** |
| 28 Aug 20:45:04 | The runner could create a second item for one fragment | A second work item is a second idempotency scope, so it could record a second claim ledger. **(fault 2)** |
| 28 Aug 21:14:34 | Test packets, so the pipeline can be judged before it is paid for | Asked for directly. A fixture path that exercises everything and spends nothing. |
| 28 Aug 21:34:29 | A markdown defect in every packet ever filed | The ledger builder stripped deliberate blank lines. Found only by printing a filed document. **(fault 6)** |
| 28 Aug 22:52:11 | The archive gets read before a proposal becomes research | §13 held on the in-process path and not the worker path. **(fault 9)** |
| 28 Aug 23:00:54 | The test harness had leaked 4,762 data roots — 26 GB | Presents as a hundred unrelated tests dying on "No space left on device". **(fault 8)** |
| 28 Aug 23:50:50 | **The real packet is created** | Business-broker licensing for success-fee intermediation, into Deal Dispatch → Monetization Logic. |
| 29 Aug 00:07:49 | Every deploy starts driving a whole packet | Found that `brain_submit_audit` advertised an adversarial schema its own validator rejects — **no worker-driven packet could ever have reached a verdict**. **(fault 10)** |
| 29 Aug 01:20:37 | A worker claims work and finds the wrong project | The packet was in a third project it had no membership in. From a worker's side, "no work" and "not yours" are the same sentence. **(fault 11)** |
| 29 Aug 02:13:01 | **The planning job is claimed and done** | Twelve fragments in 3m 28s: five licence triggers, five penalties, two boundary fragments the worker added itself. |
| 29 Aug 02:27:25 | Every deploy had been corrupting packets in flight | Boot recovery treated worker-driven packets as dead in-process runs. True since the runner landed. **(fault 12)** |
| 29 Aug 02:38:37 | **The plan is approved — twelve research jobs queued** | The single point where a human decision is load-bearing. |
| ~29 Aug 03:00 | **Real research, and the gate refuses a third of it** | California: 13 claims, 8 accepted, `INSUFFICIENT`. Three different gate conditions on real evidence, for the first time. |
| ~29 Aug 03:20 | The worker's budget runs out mid-verification | It completed the lease instead of releasing it, stopping the packet with real research inside. **(fault 14)** |
| 29 Aug 04:07:39 | Completing research that recorded nothing is refused | An item whose purpose is to record a verification, completed without one, is a contradiction. |
| 29 Aug 04:25:34 | A recovery is built — for the wrong failure | Correct code, thoroughly tested, and not what had gone wrong. |
| 29 Aug 05:12:47 | A "flaky" test turns out to be an ordering bug | Checkpoints ordered by `created_at, id`; ids are random. Reported as unexplained hours earlier rather than called flaky. **(fault 15)** |
| 29 Aug 05:24:54 | The fix takes down the live Brain | `rowid` is rewritten to `seq` on Postgres and that table never had the column. The Postgres suite had been run *before* the change. **(fault 16)** |
| 29 Aug 05:48:38 | **The actual repair path** | §15 was already explicit: a repair is a *new fragment row*. Nothing on the worker path could create one. **(fault 17)** |

---

## Where the time went

| | |
|---|---|
| Packet waiting to be claimed | **2h 22m** |
| Deploys, 21 of them | 1h 49m |
| — of which failed and rerun | 41m |
| Full test suite, per run | 1m 36s |
| Full suite on Postgres | 3m 38s |
| Worker: plan 12 fragments | 3m 28s |

The largest measured block is not work. It is the packet sitting in a queue
waiting for a person to start a worker session — the Brain never reaches out to
Claude, and until scheduling exists, somebody has to say go.

---

## The ledger — seventeen faults, and what found each one

| # | Fault | Found by |
|---|---|---|
| 1 | Nothing could write research at all | Reading the two halves against each other before building |
| 2 | A second work item per fragment — two claim ledgers | Following the guard's own reasoning past the loop it was written for |
| 3 | `RESEARCH_AUDIT` silently dropped unknown payload fields | A test written against the one item where a prompt nears a model |
| 4 | Gate tests asserted the reported count, not the stored flag | Deliberately inverting the gate to see how many tests noticed |
| 5 | Connector scopes omitted every research scope | A connected worker claiming an item and being refused by every write tool |
| 6 | Broken markdown in every packet ever filed | Printing a filed document instead of trusting the writer |
| 7 | A second packet on one layer could not file | A fixture run that hit the duplicate-version refusal |
| 8 | Test harness leaked a data root per file — 26 GB | Root-causing a Postgres run that died mid-way rather than rerunning it |
| 9 | The coverage check never ran on the worker path | Asking which of the two paths §13 actually held on |
| 10 | The adversarial audit schema its own validator rejects | Driving the audit roles end to end for the first time |
| 11 | Work invisible to a worker with no membership | A worker's honest report of an empty queue that was not empty |
| 12 | Every deploy corrupted a packet in flight | Chasing a false "interrupted" banner rather than dismissing it |
| 13 | A fragment naming a sibling it declared no dependency on | Twelve fragments going ready at once when five should have waited |
| 14 | Completing research work that recorded nothing | The live packet stopping with real research inside it |
| 15 | Checkpoints ordered by a random id | CI failing where local passed — reported unexplained, not flaky |
| 16 | A Postgres table missing the column every table carries | The deployed Brain, one deploy later than it should have been |
| 17 | No repair path on the worker-driven side | A recovery button that correctly refused to appear |

---

## What the packet found

- **California** — a licence is required. §10030 defines "business opportunity"
  with no real-property element; §10131(a) catches negotiating its sale for
  compensation "regardless of the form or time of payment"; §10130 makes doing
  so unlicensed unlawful. The finder's exception was checked and forecloses
  itself: an intermediary who takes any part in negotiations is a broker, not a
  finder.
- **Texas** — provisionally no, and marked provisional. Every enumerated broker
  act is done to "real estate", defined as an interest in real property. Three
  claims went in **explicitly unsourced** rather than backfilled from Justia or
  FindLaw mirrors.
- **The constraint that shapes the rest** — state legislature sites defend
  against automated retrieval. `leginfo` blocked amendment dates;
  `statutes.capitol.texas.gov` serves a JavaScript shell and refuses PDFs.
  Florida, New York and Illinois will do the same.

---

## Measured, for the budget defaults

- **~3 work items per fragment**, not 2 — one fragment consumed research,
  verification and a repair. Twelve fragments is closer to 36 items than the 24
  estimated.
- **3m 28s** for a worker to decompose a goal into twelve declared fragments.
- **2h 22m** between work being queued and a person starting the worker that
  claims it. Until scheduling exists, this is the pipeline's real latency.
- **Allowance consumption is not observable to the Brain** and never will be —
  it belongs to the connected account, not to the platform. It is the one
  measurement that has to be reported by hand.

---

## Closed since

The `brain_propose_fragments` "regression" was never in
`brain_propose_fragments`. `claimWork` takes the highest-priority item *of a
type in a project*, and every deploy had been leaving its packet's planning job
behind — sixteen of them by the morning of the 29th. A run claimed an earlier
packet's plan, proposed fragments into that orchestration, and then read
coverage for its own. Both halves of the contradiction were true; they were
about different packets.

The fix retires earlier packets at the start of the research phase and checks,
on every claim, that the item belongs to this run's packet. The second check
stays even though the first makes it unreachable — a claim that silently
belongs to another packet is the failure that section exists to catch. It also
took the approve button off sixteen packets nobody should have approved, which
is the second open item.

**The accumulation was flagged twice and deferred twice.** It was read as
clutter. It was the bug.

| | |
|---|---|
| Diagnosed and fixed | 29 Aug 06:15 |
| First deploy green on both passes | 29 Aug 06:29 — 145/145, before and after the restart |

## A second batch, found by sweeping rather than by deploying

Five more, collected together and fixed together after the one-fix-per-deploy
cycle was stopped. Four of them were reachable only because a real worker session
had run; the fifth was found by asking which other rules live on one path.

| # | Fault | How it showed |
|---|---|---|
| 18 | A verification could not be completed by a session that had not submitted the claims | `brain_submit_verification` needs a verdict per claim id and refuses a partial answer; nothing handed a worker the ids. Every redelivery and reissue was uncompletable. |
| 19 | A release killed the item | The contract says releasing costs the packet nothing. `releaseWork` failed it with `ATTEMPTS_EXHAUSTED` when the budget was spent — so following the contract on the second occasion destroyed the Texas verification. |
| 20 | A release never advanced the packet | Complete did, fail did, release did not. That is why the packet read `RESEARCHING` with a dead verification and the console offered no recovery. |
| 21 | A fragment behind a failed dependency stalled the packet silently | It is not terminal, so the runner reported "still in progress" forever. The packet could reach neither synthesis nor a person. |
| 22 | §16's pre-synthesis packet check ran on one path only | `assessPacket` was called from `orchestrator.ts` and nowhere else, so a worker-driven packet could be synthesized without covering the goal's mandatory part — invariant 20. |

**The pattern behind 18, 22 and the earlier 9 and 13 is one pattern.** A rule
exists, it is enforced where the in-process loop runs, and the worker path
reaches the same outcome by a different route that never passes the check.
Finding them is not a matter of testing harder — every one of these had tests
that passed. It is a matter of asking, of each rule, *which of the two paths
actually applies it.*

And 18 is the sharper lesson. Every test in `packet.test.ts` read claim ids with
`listClaimsForFragment`, and the hosted harness kept them in a local variable.
Both proved the tool worked. Neither crossed the session boundary the real path
always crosses, so neither could have caught it.

## Faults 23 and 24 — a research item that outlived its own fragment

A worker was handed a `RESEARCH_FRAGMENT` item for `ny-licence-trigger`, a
fragment it had finished minutes earlier and which was already VALIDATING with
twelve claims on it. It recognised the fragment as its own work, released the
item rather than file a second ledger, and reported it.

There was no second work item. It was the *same* item.

A worker that submits a fragment's claims and then releases rather than
completes — which the contract instructs when an allowance runs out — leaves
the item QUEUED while its fragment has moved to VALIDATING. Nothing was stale
about it when it was created, and nothing removed it afterwards, so the queue
kept offering a research assignment for a fragment that had already been
researched.

| # | Fault | Fix |
|---|---|---|
| 23 | Nothing refused a second ledger for one fragment | Step 6 keys the effect from the work item, so a redelivery of the *same* item replays — and a different item is a different scope with no protection at all. The state is now checked inside the executor, so a replay short-circuits before it and only a genuinely new scope is judged. |
| 24 | Queued work outlived the fragment state it served | `advancePacket` retires a QUEUED research item whose fragment has moved past the state that item serves. QUEUED only — an item a worker is holding is not stale, and cancelling underneath it would fail the completion it is about to make. |

**The worker noticing is not a control.** It happened to recognise its own work
from a few minutes earlier; a different session would not have. Being refused at
the write boundary is the floor, and not being offered the work is the fix.

## Faults 25 and 26 — why no verification was ever handed out

Two worker sessions in a row reported the same thing: the queue never offers a
verification job, only research for a fragment that has already been researched.
The first explanation — a released item left claimable — was real and fixed, and
it was not the whole story.

**One fragment's fault stopped the entire packet.** `faultedOut` set the
*orchestration* to NEEDS_HUMAN and returned, aborting the rest of the advance,
and `advancePacket` short-circuits on NEEDS_HUMAN — so every later call did
nothing at all. Texas's verification had died. California, Florida, New York and
Illinois were sitting VALIDATING with real research on them, and the loop that
mints verifications returned at Texas before reaching any of them. Permanently.

A fault belongs to the fragment it happened to. The packet's own end state is
decided where it always was: when everything has finished, or when nothing left
can move.

| # | Fault | Fix |
|---|---|---|
| 25 | One faulted fragment froze the whole packet | Block the fragment, record the event, continue the loop. Four fragments' verifications had been unreachable since the Texas fault. |
| 26 | The §16 coverage check refused packets that had answered their requirements | The coverage table records what the *archive* settled at planning time; nothing rewrites those rows when research lands, so a requirement read MISSING precisely because the packet went and answered it. An ACCEPTED fragment carrying the requirement's id now counts. |

**26 was mine, and it was live for one deploy.** The check went in as a refusal
against a table that only ever answered half the question. The local test that
should have caught it asserted synthesis is queued "once every mandatory
requirement is answered" — against a fixture with no requirements at all, so it
passed vacuously. The deployed harness caught it on the first pass. A test that
cannot fail is worse than no test, because it is counted.


## Faults 27, 28 and 29 — why the packet could not reach synthesis

The packet held seven accepted fragments, an authorization to record unresolved
gaps, and no way forward. Every advance returned the same sentence: *2
fragment(s) are waiting on a dependency that failed.* Three defects on one path,
and each hid the next.

**27 — a stranded fragment was never resolved.** `doomedBy` computed which
fragments could never start and deliberately mutated nothing, on the reasoning
that repairing a dependency un-dooms its dependents. That holds while anything
else can move. It stops holding at the point nothing can, and there the runner
left two fragments QUEUED forever: never offered to a worker, never retryable
(`retryFragment` accepts only a BLOCKED fragment), with the only account of it an
aggregate sentence on the orchestration that the next advance rewrote.

Now, once every unfinished fragment is waiting on something that is not coming,
each is resolved to BLOCKED carrying its own cause. Unconditionally — a fragment
that can never start is a fact, not a decision about scope.

**28 — the gap rule did not cover the case the packet was in.** Recording an
unresolved gap fired only for a fragment that was BLOCKED *and* out of repairs.
The fragment stranding the two dependents was BLOCKED at attempt 1 of 2 — a
verification work item had gone terminal without recording a verdict, and
`faultedFragment` blocks without spending an attempt. So it was repairable in
principle, nothing on the pull path can plan a repair, and its requirement stayed
open, which kept the mandatory-coverage check refusing the synthesis.

A second category now exists: a fragment BLOCKED because a prerequisite of its
own ended without acceptance, whatever its attempt count, together with the
prerequisite that stranded it. A packet cannot declare the penalty question out
of scope while holding open the trigger question that is the only reason the
penalty is unanswerable.

**29 — a pass that faulted a fragment kept reading the array it started with.**
`faultedFragment` blocks a fragment in the database while `fragments` is the
snapshot the pass began from, and everything after those loops reads that
snapshot. So the blocked fragment still looked VALIDATING, its dependents were
not yet doomed, and the pass concluded the packet was making progress.

This is why the state was *absorbing* rather than merely wrong. The failing
verification advanced the packet, the fault blocked the trigger fragment, and the
same call then decided its dependents were "still in progress" — and since the
packet had no other work, nothing ever called the runner again to notice. A pass
that changed a fragment's status now re-derives from the rows.

| # | Fault | Fix |
|---|---|---|
| 27 | A fragment stranded by a failed prerequisite stayed QUEUED forever | Resolve it to BLOCKED with the precise cause once nothing else can move. BLOCKED, not CANCELLED, so `retryFragment` still accepts it. |
| 28 | An unresolved gap was only recorded for exhausted repairs | A dependency that ended without acceptance is the second way research becomes impossible; the stranded subtree is declared together, under the same per-packet authorization. |
| 29 | An advance reasoned on from a snapshot it had already invalidated | Re-derive after a fault, carrying forward whatever the pass already enqueued so nothing is minted twice. |

A fourth thing fell out of 29 while fixing it: one pass can both fault a fragment
and mint work for a healthy one, and the "this packet is running again" status
update lived only on the path the re-derive skips. A packet could come out of an
advance holding a claimable item and still reading NEEDS_HUMAN. The update is now
written before the re-derive.

**And a test that could not fail.** The rule "a fragment with a repair attempt
left is not written off" had a test that never set the gap authorization, so the
packet was skipped whatever the attempt count was. It is the second vacuous test
in this step. Both were found by asking what the test would do if the rule were
deleted; both should have been found by writing them that way.

## Fault 31 — the repair budget was the wrong line

Deploying 27-29 moved the packet a long way and stopped it one requirement short.
The rows said why: `extraterritorial-nexus`, BLOCKED at attempt 1 of 2, no
dependencies, nothing waiting behind it, holding the last open mandatory
requirement — and an empty queue that no worker session could ever refill.

The rule that spared it was mine, from that same batch: *a fragment that has
failed once still has a real repair available and is left alone.* The repair it
means is `retryFragment`, which is an operator pressing a control. The runner
has no repair planner on this path at any attempt count — `repair.ts` chooses
the strategy and is wired only to the in-process path — so the sentence was true
about a person and false about the code enforcing it. I had reasoned about the
budget rather than about what the packet could actually do with it.

So the condition is now what it should always have been: BLOCKED, and no further
attempt this path can plan. What keeps it narrow moved to where the question is
really asked — the pass already required nothing live and nothing awaiting
approval, and now also requires nothing startable, because research that has not
been attempted may yet answer the requirement a blocked fragment failed on.

| # | Fault | Fix |
|---|---|---|
| 31 | An authorized packet was held open by a fragment nothing could restart | Write off a BLOCKED fragment whose repair this path cannot plan, at any attempt count, and record which of the four reasons applies. Guard the pass on nothing being startable rather than on the attempt count. |

The gap event follows the narrowing rather than the advance: a packet that
narrows in two waves records two, and a pass that closes nothing records none.

## Fault 32 — the synthesis could not be written by the worker it was for

Caught by reading the code before the worker got there, which is the only reason
it did not cost another hour.

`brain_submit_synthesis` refuses a report whose citations do not resolve to
accepted claims — the whole report, not the offending sentence. Nothing on the
tool surface hands a worker those ids. A synthesis work item has no fragment, so
`assignmentFor` returned the orchestration, the sibling keys, and `claimsToVerify:
null`. There is no `brain_list_claims`. The report was therefore writable only by
a session that had submitted the claims itself and still had the ids in front of
it.

**This is the verification deadlock again, one stage later, and it hid the same
way.** Every test in `packet.test.ts` reads ids with `listClaimsForFragment` —
the database, which a worker does not have — and the hosted harness keeps them
in a local variable left over from its own `brain_submit_claims`. Neither
crosses the session boundary, so neither could see the gap. Third time.

The assignment for a synthesis now carries `claimsToCite`: every accepted claim
in the packet, with the id to cite it by, the sentence, its source and the
fragment that established it. Never truncated — a report may only cite what the
gate accepted, so an omitted claim is evidence the packet gathered and then left
out of its own conclusion.

The test that catches it is the one whose shape matters: it reads **nothing**
from the database. Every id it cites comes out of `brain_get_assignment`. That
is the shape every worker-path test should have had from the start.

| # | Fault | Fix |
|---|---|---|
| 32 | A synthesis assignment carried no claims and no ids, so no worker could write a citable report | `claimsToCite` on the assignment, populated from `acceptedClaims` for `RESEARCH_SYNTHESIZE` only, plus a test that uses only what the assignment carries. |

## Fault 33 — a report that had not read the thing it reported on

The packet reached COMPLETE with its canonical artifact reading zero bytes, and
that reading was produced entirely by the diagnostic script written to find it.

`getStorage()` falls back to a local provider when nothing has been initialised.
That is deliberate and documented — it is for unit tests that never boot — and
it is safe precisely because cloud mode goes through `initStorage`, which
verifies with a real operation and stops the process if the bucket does not
answer. `packet-report.ts` opened the database and never opened the store, so it
inherited the fallback, looked on the machine's own disk, and found nothing.

What it printed was `store local · /app/data` beside rows each saying
`storage_provider SUPABASE` — a reading indistinguishable from the §18
cloud-fallback failure, and one I came close to reporting as exactly that. It
cost three deploys of diagnostics to disprove something that was never true.

The rows had been right the whole time: `file_size 28261` against an extraction
that read 27,881 characters is a document written and read back correctly, and
with the store open the same script reads 28,261 bytes out of the bucket.

| # | Fault | Fix |
|---|---|---|
| 33 | A diagnostic reported every document in the project missing, because it read documents without opening the store | `initStorage()` beside `initDatabase()`, as `verify-hosted.ts` and the server's own boot both do. Reaching the first read is now itself proof the configured store answers. |

The general lesson is one this codebase already draws about documents, in §9: a
tool that has not read the thing it is reporting on must say so rather than
return an empty answer. A reader that silently falls back to the wrong store is
the same failure wearing a different hat, and the place it did damage was a
script rather than the Brain only by luck.

## How it ended

The packet is terminal. Synthesis, the three audit roles in order, and the
judge's verdict were all claimed and completed by an unattended Cowork scheduled
task; the filed report is 28,261 bytes in the bucket and reads back whole after
three further machine restarts. The closure matrix is in
[`STEP-9-EVIDENCE.md`](STEP-9-EVIDENCE.md).

Nine faults were found between the first live packet and closure. Six were one
shape — a rule enforced where `orchestrator.ts` runs, reached by the worker path
through a route that never passes the check. Three were one blind spot in the
tests — ids read from the database, which a worker does not have, so a deadlock
at the session boundary could not show. Both are worth remembering as *classes*
rather than as nine separate stories.

## Still open

- **The research itself is thin, and that is a real outcome rather than a
  process failure.** Two of twelve fragments cleared the gate; ten requirements
  are filed as declared gaps. The judge said `MORE_RESEARCH` and was right. The
  question this packet was asked has a New York answer and nothing else, and the
  reason is in the rejection notes: legislature sites defend against automated
  retrieval, and the gate refused what came back from the mirrors.
- **A repair on the pull path.** §15's ladder — search differently from every
  earlier attempt — lives in `repair.ts` and is wired only to the in-process
  path. That is why a blocked fragment is written off rather than retried here,
  and it is the largest single thing standing between this packet's result and a
  good one.
- The budget system itself — packets per goal, fragments across them, a time
  limit, external spend fixed at zero — specified and deliberately not built.
  The numbers it needs are now measured rather than guessed: three work items
  per fragment, not two.
